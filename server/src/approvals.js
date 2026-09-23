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
} from './db.js';
import { isDangerousCommand, rawToolInput } from './state.js';
import { broadcast } from './ws.js';
import { diffForToolInput } from './diff.js';
import { pushSessionEvent, markRejected } from './overlay.js';

// approvalId -> { resolve(decision, scope) }
const waiters = new Map();

const APPROVAL_TIMEOUT_MS = parseInt(process.env.APPROVAL_TIMEOUT_MS || `${30 * 60 * 1000}`, 10);
const GATE_ALWAYS = process.env.GATE_ALWAYS === '1';
// GATE_MODE: which commands get gated — 'dangerous' (default, DANGER_RE only)
// or 'all' (every gated tool call goes to the phone).
const GATE_MODE = (process.env.GATE_MODE || 'dangerous').toLowerCase();

export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function projectIdForPayload(p) {
  return p.cwd && p.cwd.length ? p.cwd : p.session_id || 'unknown';
}

// ---- per-session "always allow" list (audit A4, PreToolUse scope=always) ----
// Key = tool name for edit tools, `${tool}:${firstWord}` for command tools.
const sessionAllow = new Map(); // sessionId -> Set<allowKey>

export function allowKeyForPayload(p) {
  const tool = p.tool_name || 'Tool';
  if (EDIT_TOOLS.includes(tool)) return tool;
  const raw = rawToolInput(p.tool_input) || '';
  const first = raw.trim().split(/\s+/)[0] || '';
  return first ? `${tool}:${first}` : tool;
}

export function rememberAllow(sessionId, allowKey) {
  if (!sessionId || !allowKey) return;
  if (!sessionAllow.has(sessionId)) sessionAllow.set(sessionId, new Set());
  sessionAllow.get(sessionId).add(allowKey);
  console.log(`[gate] session ${String(sessionId).slice(0, 8)} always-allow: ${allowKey}`);
}

function isSessionAllowed(p) {
  const set = sessionAllow.get(p.session_id);
  return !!set && set.has(allowKeyForPayload(p));
}

/// Decide whether a gated tool call needs human approval (audit A2).
///  - PermissionRequest (Claude explicitly asking for permission): always.
///  - Session "always allow" list (from a previous scope=always): skip.
///  - File edits (EDIT_TOOLS): always reviewed.
///  - Commands: DANGER_RE hits always; the rest per GATE_MODE (dangerous|all).
export function needsApproval(payload) {
  if (payload.hook_event_name === 'PermissionRequest') return true;
  if (isSessionAllowed(payload)) return false;
  if (GATE_ALWAYS) return true;
  if (EDIT_TOOLS.includes(payload.tool_name)) return true;
  const raw = rawToolInput(payload.tool_input);
  if (isDangerousCommand(raw)) return true;
  return GATE_MODE === 'all';
}

function buildApproval(payload) {
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
    filePath: isEdit ? payload.tool_input?.file_path || payload.tool_input?.notebook_path || subject : null,
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
export function createGateApproval(payload) {
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
export function awaitDecision(approvalId) {
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
export function respond(approvalId, decision, scope, by) {
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, error: 'bad_decision' };
  }
  const row = getApprovalRow(approvalId);
  if (!row) return { ok: false, error: 'not_found' };
  const status = decision === 'approve' ? 'approved' : 'denied';
  const changed = resolveApprovalRow(approvalId, status, by || 'app');
  if (!changed) return { ok: true, already: true, status: row.status }; // idempotent replay
  console.log(`[approval] ${String(approvalId).slice(0, 8)} -> ${status} by ${by || 'app'} (scope=${scope || 'once'})`);
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
export function startExpiryLoop() {
  setInterval(() => {
    for (const id of expireApprovals()) {
      const w = waiters.get(id);
      if (w) w('passthrough', 'once');
      broadcast({ type: 'approval.resolved', approvalId: id, by: 'timeout' });
    }
  }, 30000).unref?.();
}
