// In-memory live-activity registry. Hooks mark a session active so its project
// shows "running" instantly. (The file watcher also detects activity, but a hook
// fires a touch sooner.)
//
// Also tracks explicit Stop/SessionEnd signals (audit A12) so snapshot can force
// a project to "done" immediately instead of waiting ~95s for the watcher settle.
const live = new Map(); // sessionId -> lastSeenMs
const stopped = new Map(); // sessionId -> stoppedAtMs

export function noteActivity(sessionId) {
  if (!sessionId) return;
  live.set(sessionId, Date.now());
  stopped.delete(sessionId); // any fresh activity cancels the stop marker
}

export function isLive(sessionId) {
  const at = live.get(sessionId);
  return at != null && Date.now() - at < 120_000;
}

/// Mark a session as explicitly finished (Stop / SessionEnd hook).
export function noteStop(sessionId) {
  if (!sessionId) return;
  stopped.set(sessionId, Date.now());
  live.delete(sessionId);
}

export function isStopped(sessionId) {
  const at = stopped.get(sessionId);
  return at != null && Date.now() - at < 10 * 60_000;
}
