// Hook intake.
//   POST /hooks/event — liveness nudge + instant done broadcast on Stop/SessionEnd
//                       (audit A12; the watcher's 95s settle stays as fallback).
//   POST /hooks/gate  — remote-approval gate for PreToolUse/PermissionRequest:
//                       HOLDS the response until the app approves/denies, then
//                       returns the decision JSON that controls Claude Code.
//                       GATE_IGNORE'd cwds (always including D:\cc_project) are
//                       passed through immediately — the gate must NEVER hang a
//                       dev session on this machine (audit A1).
import { Router } from 'express';
import path from 'node:path';
import {
  needsApproval,
  createGateApproval,
  awaitDecision,
  rememberAllow,
  allowKeyForPayload,
} from './approvals.js';
import { noteActivity, noteStop } from './live.js';
import { listProjects } from './claude-data.js';
import { buildProjectByDir } from './snapshot.js';
import { broadcast } from './ws.js';

const router = Router();

// ---- A1: gate ignore list (env GATE_IGNORE, comma separated). The monitor's
// own project dir is ALWAYS ignored regardless of env, so a misconfiguration
// can never suspend the machine's own development session.
function normalizeDir(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

const GATE_IGNORE = [
  ...(process.env.GATE_IGNORE || '').split(',').map((s) => s.trim()).filter(Boolean),
  'D:\\cc_project', // hard default — never gate ourselves
].map(normalizeDir);

function isIgnoredCwd(cwd) {
  if (!cwd) return false;
  const n = normalizeDir(cwd);
  return GATE_IGNORE.some((ig) => n === ig || n.startsWith(ig + path.sep));
}

router.post('/event', (req, res) => {
  res.status(200).json({}); // ack first — never block Claude Code
  const p = req.body;
  if (!p) return;
  const ev = p.hook_event_name;
  if (ev === 'Stop' || ev === 'SessionEnd') {
    // A12: don't wait ~95s for the watcher settle — push 'done' right now.
    if (p.session_id) noteStop(p.session_id);
    broadcastDone(p).catch((e) => console.error('[hooks:stop]', e.message));
  } else if (p.session_id) {
    noteActivity(p.session_id);
  }
});

// Find the project dir for the hook's cwd/session and broadcast it as done.
// (The Stop hook itself just bumped the transcript mtime, so the file-based
// status would still say 'running' — force 'done' unless an approval pends.)
async function broadcastDone(p) {
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

router.post('/gate', async (req, res) => {
  const payload = req.body || {};
  if (payload.session_id) noteActivity(payload.session_id);
  try {
    // A1 guard: gated cwd on the ignore list -> step aside instantly (empty 2xx
    // = no decision; Claude Code's normal local permission flow continues).
    if (isIgnoredCwd(payload.cwd)) return res.status(200).json({});
    if (!needsApproval(payload)) return res.status(200).json({}); // 2xx empty = allow
    const approval = createGateApproval(payload); // broadcasts approval.request
    console.log(
      `[gate] hold ${approval.approvalId.slice(0, 8)} ${approval.kind} ${payload.tool_name || ''} (${payload.hook_event_name || '?'})`,
    );
    const { decision, scope, reason } = await awaitDecision(approval.approvalId);
    console.log(`[gate] release ${approval.approvalId.slice(0, 8)} -> ${decision}/${scope || 'once'}`);
    if (decision === 'passthrough') return res.status(200).json({}); // timeout: fail-open
    // A4 (PreToolUse only): scope=always -> remember in the per-session allow
    // list so needsApproval skips this tool+command next time. PermissionRequest
    // uses updatedPermissions instead (Claude Code persists it in-session).
    if (decision === 'approve' && scope === 'always' && payload.hook_event_name !== 'PermissionRequest') {
      rememberAllow(payload.session_id, allowKeyForPayload(payload));
    }
    return res.status(200).json(decisionJson(payload, decision, scope, reason));
  } catch (e) {
    console.error('[gate] error:', e.message);
    return res.status(200).json({}); // fail-open on internal error
  }
});

// Exact hook decision JSON (PreToolUse vs PermissionRequest schema).
function decisionJson(payload, decision, scope, reason) {
  const allow = decision === 'approve';
  if (payload.hook_event_name === 'PermissionRequest') {
    const d = { behavior: allow ? 'allow' : 'deny' };
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

export default router;
