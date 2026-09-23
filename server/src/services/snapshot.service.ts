/** 业务服务协调统一项目快照，通过仓储和适配器访问外部状态。 */
import type { ApprovalRow } from '../types/storage.js';
import type { ProjectView } from '../types/domain.js';
// Composes the project list the app sees: REAL projects (from transcript files)
// overlaid with live PENDING approvals (from the DB), live hook activity, the
// explicit stop signal (A12) and the short-lived rejected marker (A14).
import { listProjects, getProjectByDir } from '../adapters/claude/transcript.js';
import { getPendingApprovals, approvalRowToJson } from '../repositories/local.repository.js';
import { isLive, isStopped } from '../domain/activity.js';
import { isRejected } from '../repositories/overlay.repository.js';
import { listRemoteProjects } from './agent.service.js';
import { withLocalAgent } from '../adapters/claude/local-agent.js';

/**
 * 将待审批、明确结束和短期拒绝信号覆盖到文件摘要上。
 * @param projects 参与聚合的项目列表。
 * @returns 具有即时状态的项目列表。
 */
function overlay(projects: ProjectView[]): ProjectView[] {
  const pending = getPendingApprovals();
  const byCwd = new Map<string, ApprovalRow>();
  const bySession = new Map<string | null, ApprovalRow>();
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

/**
 * 统一组合本机与远程项目，供 HTTP 和 WebSocket 共用。
 * @returns 按最近活动排序的完整项目列表。
 */
export async function buildProjects() {
  const local =
    process.env.LOCAL_CLAUDE === '0' ? [] : overlay(await listProjects()).map(withLocalAgent);
  return [...local, ...listRemoteProjects()].sort((a, b) => b.lastEventAt - a.lastEventAt);
}

/**
 * 重新读取单个本机项目并应用即时状态。
 * @param projectId 目标项目标识。
 * @returns 项目视图，不存在时为 null。
 */
export async function buildProjectByDir(projectId: string) {
  const p = await getProjectByDir(projectId);
  return p ? withLocalAgent(overlay([p])[0]) : null;
}
