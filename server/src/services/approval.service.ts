/** 业务服务协调审批决策及等待生命周期，通过仓储和适配器访问外部状态。 */
import type { HookPayload, GateDecision } from '../types/claude.js';
import type { ApprovalView } from '../types/domain.js';
// Remote-approval coordinator: bridges the held PreToolUse/PermissionRequest
// HTTP hook (long-poll) and the App's approval.respond (over WS or REST).
//
// The gate endpoint HOLDS the hook's HTTP response; when the app responds we
// resolve the waiter and the gate returns the decision JSON that controls
// Claude Code. Idempotent + timeout-bounded (30 min, then the gate steps aside
// — fail-open pass-through, marked 'expired' + broadcast resolved{by:'timeout'}).
import { randomUUID } from 'node:crypto';
import {
  insertApproval,
  resolveApprovalRow,
  getApprovalRow,
  expireApprovals,
} from '../repositories/local.repository.js';
import { isDangerousCommand, rawToolInput } from '../domain/hook-state.js';
import { broadcast } from '../events/hub-events.js';
import { diffForToolInput } from '../domain/diff.js';
import { pushSessionEvent, markRejected } from '../repositories/overlay.repository.js';

// approvalId -> { resolve(decision, scope) }
const waiters = new Map<string, (decision: string, scope: string) => void>();

const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS || `${30 * 60 * 1000}`, 10);
const GATE_ALWAYS = process.env.GATE_ALWAYS === '1';
// GATE_MODE: which commands get gated — 'dangerous' (default, DANGER_RE only)
// or 'all' (every gated tool call goes to the phone).
const GATE_MODE = (process.env.GATE_MODE || 'dangerous').toLowerCase();

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * 从 hook 工作目录推导项目，缺失时用会话 ID 隔离。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 本机项目聚合键。
 */
function projectIdForPayload(p: HookPayload) {
  return p.cwd && p.cwd.length ? p.cwd : p.session_id || 'unknown';
}

// ---- per-session "always allow" list (audit A4, PreToolUse scope=always) ----
// Key = tool name for edit tools, `${tool}:${firstWord}` for command tools.
const sessionAllow = new Map<string, Set<string>>(); // sessionId -> Set<allowKey>

/**
 * 按工具和命令首词生成会话内授权键，避免扩大授权范围。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 本次工具请求的授权键。
 */
export function allowKeyForPayload(p: HookPayload) {
  const tool = p.tool_name || 'Tool';
  if (EDIT_TOOLS.includes(tool)) return tool;
  const raw = rawToolInput(p.tool_input) || '';
  const first = raw.trim().split(/\s+/)[0] || '';
  return first ? `${tool}:${first}` : tool;
}

/**
 * 仅在当前会话记住明确选择的持续授权。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param allowKey 仅在当前会话生效的授权键。
 * @returns 无返回值。
 */
export function rememberAllow(sessionId: string | undefined, allowKey: string) {
  if (!sessionId || !allowKey) return;
  if (!sessionAllow.has(sessionId)) sessionAllow.set(sessionId, new Set());
  sessionAllow.get(sessionId)!.add(allowKey);
  console.log(`[gate] session ${String(sessionId).slice(0, 8)} always-allow: ${allowKey}`);
}

/**
 * 检查本次工具请求是否已有会话内授权。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 是否可跳过重复审批。
 */
function isSessionAllowed(p: HookPayload) {
  const set = sessionAllow.get(p.session_id || '');
  return !!set && set.has(allowKeyForPayload(p));
}

/// Decide whether a gated tool call needs human approval (audit A2).
///  - PermissionRequest (Claude explicitly asking for permission): always.
///  - Session "always allow" list (from a previous scope=always): skip.
///  - File edits (EDIT_TOOLS): always reviewed.
///  - Commands: DANGER_RE hits always; the rest per GATE_MODE (dangerous|all).
/**
 * 按权限请求、编辑工具及危险命令规则决定是否等待人工选择。
 * @param payload 当前操作、事件或 hook 的负载。
 * @returns 是否需要创建远程审批。
 */
export function needsApproval(payload: HookPayload) {
  if (payload.hook_event_name === 'PermissionRequest') return true;
  if (isSessionAllowed(payload)) return false;
  if (GATE_ALWAYS) return true;
  if (EDIT_TOOLS.includes(payload.tool_name || '')) return true;
  const raw = rawToolInput(payload.tool_input);
  if (isDangerousCommand(raw)) return true;
  return GATE_MODE === 'all';
}

/**
 * 把 hook 转换为可审阅的请求，并为编辑工具生成差异。
 * @param payload 当前操作、事件或 hook 的负载。
 * @returns 带明确期限的审批对象。
 */
function buildApproval(payload: HookPayload): ApprovalView {
  const tool = payload.tool_name || 'Tool';
  const isEdit = EDIT_TOOLS.includes(tool);
  const subject = rawToolInput(payload.tool_input);
  const now = Date.now();
  return {
    approvalId: randomUUID(),
    sessionId: payload.session_id || 'unknown',
    projectId: projectIdForPayload(payload),
    kind: isEdit ? 'file_edit' : 'command',
    title: isEdit ? '修改文件' : '执行命令',
    command: isEdit ? null : subject,
    filePath: isEdit
      ? payload.tool_input?.file_path || payload.tool_input?.notebook_path || subject
      : null,
    // A3: generate a real unified diff server-side (Edit: old/new strings,
    // Write: all lines as additions) — tool_input never carries one itself.
    diff: isEdit ? diffForToolInput(tool, payload.tool_input) : null,
    risk: !isEdit && isDangerousCommand(subject) ? 'danger' : 'normal',
    options: ['once', 'always', 'reject'],
    createdAt: now,
    expiresAt: now + APPROVAL_TIMEOUT_MS,
  };
}

/// Synchronously create + persist + broadcast an approval. Returns the object.
/**
 * 先保存审批再广播，确保手机收到请求后可以立即查询。
 * @param payload 当前操作、事件或 hook 的负载。
 * @returns 已保存的审批对象。
 */
export function createGateApproval(payload: HookPayload): ApprovalView {
  const approval = buildApproval(payload);
  insertApproval(approval);
  broadcast({ type: 'approval.request', approval });
  return approval;
}

/// Returns a Promise resolving to { decision, scope, reason } when the app
/// responds. On timeout (30 min) the approval is marked 'expired', resolved is
/// broadcast with by:'timeout', and the gate resolves 'passthrough' — it steps
/// aside so Claude Code's own local permission flow takes over (fail-open,
/// never a silent auto-approve of a dangerous action).
/**
 * 有界等待手机决策，超时交回 Claude 本地权限流程。
 * @param approvalId 待处理审批的标识。
 * @returns 审批决定、范围及可选原因。
 */
export function awaitDecision(approvalId: string): Promise<GateDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(approvalId);
      if (resolveApprovalRow(approvalId, 'expired', 'timeout')) {
        broadcast({ type: 'approval.resolved', approvalId, by: 'timeout' });
      }
      resolve({ decision: 'passthrough', scope: 'once', reason: '审批超时' });
    }, APPROVAL_TIMEOUT_MS);
    waiters.set(approvalId, (decision, scope) => {
      clearTimeout(timer);
      waiters.delete(approvalId);
      resolve({ decision, scope });
    });
  });
}

/// Called by upstream WS (approval.respond) or REST. Persists + broadcasts +
/// resolves any holding gate. Idempotent (audit A5): a second respond for the
/// same approvalId returns the existing outcome and does NOT broadcast again.
/// Returns { ok, status, already?, error? }.
/**
 * 幂等处理手机决策，并在会话中留下可读的审批痕迹。
 * @param approvalId 待处理审批的标识。
 * @param decision 用户选择的批准或拒绝决定。
 * @param scope 授权有效范围，通常为 once。
 * @param by 审批决定的来源标识。
 * @returns 已确定状态或可解释的失败原因。
 */
export function respond(approvalId: string, decision: string, scope: string, by: string) {
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: 'bad_decision' };
  }
  const row = getApprovalRow(approvalId);
  if (!row) return { ok: false, error: 'not_found' };
  const status = decision === 'approve' ? 'approved' : 'denied';
  const changed = resolveApprovalRow(approvalId, status, by || 'app');
  if (!changed) return { ok: true, already: true, status: row.status }; // idempotent replay
  console.log(
    `[approval] ${String(approvalId).slice(0, 8)} -> ${status} by ${by || 'app'} (scope=${scope || 'once'})`,
  );
  broadcast({ type: 'approval.resolved', approvalId, by: 'app' });

  // A7: leave a visible trace of the decision in the conversation.
  const event = {
    hook_event_name: 'ApprovalResolved',
    ok: decision === 'approve',
    status: 'done',
    summary: decision === 'approve' ? '已批准' : '已拒绝',
    detail: row.command || row.file_path || row.title || null,
    session_id: row.session_id,
    created_at: Date.now(),
  };
  if (row.session_id) {
    pushSessionEvent(row.session_id, event);
    broadcast({ type: 'event.append', sessionId: row.session_id, event });
  }

  // A14: a rejected project shows 'rejected' for a while (snapshot overlay).
  if (decision === 'reject') markRejected(row.project_id);

  const w = waiters.get(approvalId);
  if (w) w(decision, scope || 'once');
  return { ok: true, status };
}

/// Background sweep: expire stale pending approvals not held by a live gate
/// (e.g. rows left pending across a server restart).
/**
 * 清理重启后遗留的待审批记录，并释放对应等待方。
 * @returns 无返回值。
 */
export function startExpiryLoop() {
  setInterval(() => {
    for (const id of expireApprovals()) {
      const w = waiters.get(id);
      if (w) w('passthrough', 'once');
      broadcast({ type: 'approval.resolved', approvalId: id, by: 'timeout' });
    }
  }, 30000).unref?.();
}
