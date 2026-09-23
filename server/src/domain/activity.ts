/** 记录短期活动状态，补足磁盘记录更新晚于实时执行的时间差。 */
// In-memory live-activity registry. Hooks mark a session active so its project
// shows "running" instantly. (The file watcher also detects activity, but a hook
// fires a touch sooner.)
//
// Also tracks explicit Stop/SessionEnd signals (audit A12) so snapshot can force
// a project to "done" immediately instead of waiting ~95s for the watcher settle.
const live = new Map<string | null, number>(); // sessionId -> lastSeenMs
const stopped = new Map<string | null, number>(); // sessionId -> stoppedAtMs

/**
 * 记录最新活动并清除结束标记，让列表立即恢复运行状态。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 无返回值。
 */
export function noteActivity(sessionId: string) {
  if (!sessionId) return;
  live.set(sessionId, Date.now());
  stopped.delete(sessionId); // any fresh activity cancels the stop marker
}

/**
 * 用短期活动窗口弥补文件监听的延迟。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 会话是否仍处于活动窗口。
 */
export function isLive(sessionId: string | null) {
  const at = live.get(sessionId);
  return at != null && Date.now() - at < 120_000;
}

/// Mark a session as explicitly finished (Stop / SessionEnd hook).
/**
 * 记录明确结束信号，避免等文件静默后才显示完成。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 无返回值。
 */
export function noteStop(sessionId: string) {
  if (!sessionId) return;
  stopped.set(sessionId, Date.now());
  live.delete(sessionId);
}

/**
 * 在有效期内保留明确结束状态，后续活动会清除此标记。
 * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
 * @returns 会话是否具有有效结束标记。
 */
export function isStopped(sessionId: string | null) {
  const at = stopped.get(sessionId);
  return at != null && Date.now() - at < 10 * 60_000;
}
