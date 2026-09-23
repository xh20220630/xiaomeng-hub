/** 仓储封装尚未写入主机记录的即时事件的存取，集中维护 SQL 与存储字段约定。 */
import type { TaskEvent } from '../types/domain.js';
// In-memory overlays (deliberately not persisted):
//  - per-session synthesized events (approval results — audit A7) that
//    readConversation appends so decisions leave a visible trace in the chat;
//  - short-lived project "rejected" markers (audit A14) that snapshot.js uses
//    to surface a rejected state for ~10 min or until new activity.
// Kept dependency-free so both approvals.js (writer) and claude-data.js /
// snapshot.js (readers) can import it without cycles.

// ---- per-session synthesized events (A7) ----
const sessionEvents = new Map<string, TaskEvent[]>(); // sessionId -> [event]
const MAX_EVENTS_PER_SESSION = 50;

/**
 * 为审批决策保留短期会话痕迹，并限制单会话容量。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @param event 准备发布的领域事件。
 * @returns 无返回值。
 */
export function pushSessionEvent(sessionId: string, event: TaskEvent) {
  if (!sessionId || !event) return;
  const list = sessionEvents.get(sessionId) || [];
  list.push(event);
  if (list.length > MAX_EVENTS_PER_SESSION) list.splice(0, list.length - MAX_EVENTS_PER_SESSION);
  sessionEvents.set(sessionId, list);
}

/**
 * 读取尚未写入主机 JSONL 的合成事件。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 该会话的内存事件列表。
 */
export function sessionOverlayEvents(sessionId: string) {
  return sessionEvents.get(sessionId) || [];
}

// ---- rejected project marker (A14) ----
const rejected = new Map<string, number>(); // projectKey (cwd) -> rejectedAt ms
const REJECTED_TTL_MS = 10 * 60_000;
// The deny itself makes Claude write to the transcript (mtime bumps right after
// rejection) — that must NOT clear the marker, so "new activity" only counts
// beyond this grace window.
const REJECTED_GRACE_MS = 120_000;

/**
 * 短期标记拒绝结果，让客户端立即显示明确状态。
 * @param projectKey 按工作目录归一化的项目键。
 * @returns 无返回值。
 */
export function markRejected(projectKey: string | null) {
  if (projectKey) rejected.set(projectKey, Date.now());
}

/// True while the project should show status 'rejected' (10 min TTL, cleared
/// early by genuinely new activity).
/**
 * 在拒绝有效期内覆盖状态，避开主机随后写盘造成的假活动。
 * @param projectKey 按工作目录归一化的项目键。
 * @param lastEventAt 项目最近事件的毫秒时间戳。
 * @returns 是否应继续显示已拒绝。
 */
export function isRejected(projectKey: string, lastEventAt: number) {
  const at = rejected.get(projectKey);
  if (!at) return false;
  if (Date.now() - at > REJECTED_TTL_MS) {
    rejected.delete(projectKey);
    return false;
  }
  if ((lastEventAt || 0) > at + REJECTED_GRACE_MS) {
    rejected.delete(projectKey); // new activity -> back to normal states
    return false;
  }
  return true;
}
