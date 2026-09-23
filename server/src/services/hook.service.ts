/** 将 Claude hooks 转为活动状态和审批决定，不持有 HTTP 响应对象。 */
import type { HookPayload } from '../types/claude.js';
import { asError } from '../utils/errors.js';
// Hook intake.
//   POST /hooks/event — liveness nudge + instant done broadcast on Stop/SessionEnd
//                       (audit A12; the watcher's 95s settle stays as fallback).
//   POST /hooks/gate  — remote-approval gate for PreToolUse/PermissionRequest:
//                       HOLDS the response until the app approves/denies, then
//                       returns the decision JSON that controls Claude Code.
//                       GATE_IGNORE'd cwds (always including D:\cc_project) are
//                       passed through immediately — the gate must NEVER hang a
//                       dev session on this machine (audit A1).
import path from 'node:path';
import {
  needsApproval,
  createGateApproval,
  awaitDecision,
  rememberAllow,
  allowKeyForPayload,
} from './approval.service.js';
import { noteActivity, noteStop } from '../domain/activity.js';
import { listProjects } from '../adapters/claude/transcript.js';
import { buildProjectByDir } from './snapshot.service.js';
import { broadcast } from '../events/hub-events.js';

/**
 * 归一化目录大小写及尾部分隔符，用于稳定匹配忽略范围。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 规范化绝对目录。
 */
function normalizeDir(p: string) {
  return path
    .resolve(String(p))
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

const GATE_IGNORE = [
  ...(process.env.GATE_IGNORE || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  'D:\\cc_project', // hard default — never gate ourselves
].map(normalizeDir);

/**
 * 检查目录自身及子目录，防止监控服务阻塞自己的开发会话。
 * @param cwd 主机执行任务的工作目录。
 * @returns 是否应交回 Claude 本地审批流程。
 */
function isIgnoredCwd(cwd?: string) {
  if (!cwd) return false;
  const n = normalizeDir(cwd);
  return GATE_IGNORE.some((ig) => n === ig || n.startsWith(ig + path.sep));
}

/**
 * 在明确结束 hook 到达时立即更新项目，保留待审批优先级。
 * @param p 原始 hook 或模拟事件负载。
 * @returns 操作完成的异步信号。
 */
async function broadcastDone(p: HookPayload) {
  const projects = await listProjects();
  const proj =
    (p.cwd && projects.find((x) => x.cwd === p.cwd)) ||
    projects.find((x) => (x.sessions || []).some((s) => s.session_id === p.session_id));
  if (!proj) return;
  const project = await buildProjectByDir(proj.projectId);
  if (!project) return;
  const status = project.status === 'needs_approval' ? project.status : 'done';
  broadcast({ type: 'project.update', project: { ...project, status } });
  console.log(`[hooks] ${p.hook_event_name} -> project.update done (${proj.projectId})`);
}

/**
 * 把轻量 hook 通知转换为即时活动或结束信号。
 * @param payload 当前操作、事件或 hook 的负载。
 * @returns 无返回值。
 */
export function noteHook(payload: HookPayload): void {
  const event = payload.hook_event_name;
  if (event === 'Stop' || event === 'SessionEnd') {
    if (payload.session_id) noteStop(payload.session_id);
    void broadcastDone(payload).catch((error: Error) =>
      console.error('[hooks:stop]', error.message),
    );
  } else if (payload.session_id) noteActivity(payload.session_id);
}

/**
 * 协调审批长轮询；失败或超时沿用原来的本地权限处理语义。
 * @param payload 当前操作、事件或 hook 的负载。
 * @returns Claude hook 决策正文。
 */
export async function gateHook(payload: HookPayload) {
  if (payload.session_id) noteActivity(payload.session_id);
  try {
    // A1 guard: gated cwd on the ignore list -> step aside instantly (empty 2xx
    // = no decision; Claude Code's normal local permission flow continues).
    if (isIgnoredCwd(payload.cwd)) return {};
    if (!needsApproval(payload)) return {}; // 2xx empty = allow
    const approval = createGateApproval(payload); // broadcasts approval.request
    console.log(
      `[gate] hold ${approval.approvalId.slice(0, 8)} ${approval.kind} ${payload.tool_name || ''} (${payload.hook_event_name || '?'})`,
    );
    const { decision, scope, reason } = await awaitDecision(approval.approvalId);
    console.log(
      `[gate] release ${approval.approvalId.slice(0, 8)} -> ${decision}/${scope || 'once'}`,
    );
    if (decision === 'passthrough') return {}; // timeout: fail-open
    // A4 (PreToolUse only): scope=always -> remember in the per-session allow
    // list so needsApproval skips this tool+command next time. PermissionRequest
    // uses updatedPermissions instead (Claude Code persists it in-session).
    if (
      decision === 'approve' &&
      scope === 'always' &&
      payload.hook_event_name !== 'PermissionRequest'
    ) {
      rememberAllow(payload.session_id, allowKeyForPayload(payload));
    }
    return decisionJson(payload, decision, scope, reason);
  } catch (cause) {
    const e = asError(cause);
    console.error('[gate] error:', e.message);
    return {}; // fail-open on internal error
  }
}

/**
 * 区分 PermissionRequest 与 PreToolUse 的返回协议。
 * @param payload 当前操作、事件或 hook 的负载。
 * @param decision 用户选择的批准或拒绝决定。
 * @param scope 授权有效范围，通常为 once。
 * @param reason 向用户或主机解释决定的原因。
 * @returns Claude 可识别的决策对象。
 */
function decisionJson(payload: HookPayload, decision: string, scope: string, reason?: string) {
  const allow = decision === 'approve';
  if (payload.hook_event_name === 'PermissionRequest') {
    const d: {
      /** Claude 权限协议中的 allow 或 deny。 */
      behavior: string;
      /** 明确选择持续授权后交给主机保存的权限规则。 */
      updatedPermissions?: {
        /** 决定负载解释方式的协议类别。 */
        type: string;
        /** 本次新增的会话权限规则。 */
        rules: {
          /** 权限规则或活动对应的工具名称。 */
          toolName: string;
        }[];
        /** Claude 权限协议中的 allow 或 deny。 */
        behavior: string;
        /** 规则的有效范围，此处限于会话。 */
        destination: string;
      }[];
      /** 供用户或等待方理解的说明。 */
      message?: string;
    } = { behavior: allow ? 'allow' : 'deny' };
    if (allow && scope === 'always' && payload.tool_name) {
      // A4: persist the permission for the rest of the session inside Claude
      // Code itself, so it won't ask again for this tool.
      d.updatedPermissions = [
        {
          type: 'addRules',
          rules: [{ toolName: payload.tool_name }],
          behavior: 'allow',
          destination: 'session',
        },
      ];
    }
    if (!allow) d.message = reason || '已在手机端拒绝';
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: d,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: reason || (allow ? 'Approved from phone' : 'Rejected from phone'),
    },
  };
}
