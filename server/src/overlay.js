// In-memory overlays (deliberately not persisted):
//  - per-session synthesized events (approval results — audit A7) that
//    readConversation appends so decisions leave a visible trace in the chat;
//  - short-lived project "rejected" markers (audit A14) that snapshot.js uses
//    to surface a rejected state for ~10 min or until new activity.
// Kept dependency-free so both approvals.js (writer) and claude-data.js /
// snapshot.js (readers) can import it without cycles.

// ---- per-session synthesized events (A7) ----
const sessionEvents = new Map(); // sessionId -> [event]
const MAX_EVENTS_PER_SESSION = 50;

export function pushSessionEvent(sessionId, event) {
  if (!sessionId || !event) return;
  const list = sessionEvents.get(sessionId) || [];
  list.push(event);
  if (list.length > MAX_EVENTS_PER_SESSION) list.splice(0, list.length - MAX_EVENTS_PER_SESSION);
  sessionEvents.set(sessionId, list);
}

export function sessionOverlayEvents(sessionId) {
  return sessionEvents.get(sessionId) || [];
}

// ---- rejected project marker (A14) ----
const rejected = new Map(); // projectKey (cwd) -> rejectedAt ms
const REJECTED_TTL_MS = 10 * 60_000;
// The deny itself makes Claude write to the transcript (mtime bumps right after
// rejection) — that must NOT clear the marker, so "new activity" only counts
// beyond this grace window.
const REJECTED_GRACE_MS = 120_000;

export function markRejected(projectKey) {
  if (projectKey) rejected.set(projectKey, Date.now());
}

/// True while the project should show status 'rejected' (10 min TTL, cleared
/// early by genuinely new activity).
export function isRejected(projectKey, lastEventAt) {
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
