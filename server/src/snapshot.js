// Composes the project list the app sees: REAL projects (from transcript files)
// overlaid with live PENDING approvals (from the DB), live hook activity, the
// explicit stop signal (A12) and the short-lived rejected marker (A14).
import { listProjects, getProjectByDir } from './claude-data.js';
import { getPendingApprovals, approvalRowToJson } from './db.js';
import { isLive, isStopped } from './live.js';
import { isRejected } from './overlay.js';
import { listRemoteProjects } from './agent-platform.js';
import { withLocalAgent } from './local-agent.js';

function overlay(projects) {
  const pending = getPendingApprovals();
  const byCwd = new Map();
  const bySession = new Map();
  for (const a of pending) {
    if (a.project_id) byCwd.set(a.project_id, a);
    if (a.session_id) bySession.set(a.session_id, a);
  }
  return projects.map((p) => {
    const ap = byCwd.get(p.cwd) || bySession.get(p.activeSessionId) || null;
    if (ap) {
      return {
        ...p,
        status: 'needs_approval',
        pendingApproval: approvalRowToJson(ap),
        activeSessionId: ap.session_id || p.activeSessionId,
      };
    }
    // A14: app rejected an approval -> show 'rejected' for ~10 min or until
    // genuinely new activity.
    if (isRejected(p.cwd, p.lastEventAt)) return { ...p, status: 'rejected' };
    // A12: Stop/SessionEnd hook fired -> done now (mtime would still say running).
    if (isStopped(p.activeSessionId)) return { ...p, status: 'done' };
    if (isLive(p.activeSessionId)) return { ...p, status: 'running' };
    return p;
  });
}

export async function buildProjects() {
  const local = process.env.LOCAL_CLAUDE === '0' ? [] : overlay(await listProjects()).map(withLocalAgent);
  return [...local, ...listRemoteProjects()].sort((a, b) => b.lastEventAt - a.lastEventAt);
}

export async function buildProjectByDir(projectId) {
  const p = await getProjectByDir(projectId);
  return p ? withLocalAgent(overlay([p])[0]) : null;
}
