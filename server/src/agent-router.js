import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import * as agents from './agent-platform.js';
import { agentNotifications } from './agent-notify.js';

const router = Router();
const tokenFrom = (req) => String(req.headers.authorization || '').replace(/^Bearer /, '');
const route = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

router.post('/register', route((req, res) => {
  const expected = process.env.AGENT_TOKEN || process.env.AUTH_TOKEN || '';
  if (!process.env.AUTH_TOKEN) agents.fail(503, 'Set AUTH_TOKEN before enrolling LAN agents');
  const supplied = tokenFrom(req);
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) agents.fail(401, 'Invalid enrollment token');
  res.status(201).json(agents.registerAgent(req.body || {}));
}));

router.use((req, _res, next) => {
  try {
    req.agentId = agents.authenticateAgent(tokenFrom(req));
    agents.heartbeat(req.agentId);
    next();
  } catch (error) { next(error); }
});
router.post('/heartbeat', route((req, res) => res.json(agents.heartbeat(req.agentId))));
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const wake = () => res.write('data: commands\n\n');
  agentNotifications.on(req.agentId, wake);
  wake();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 5000);
  res.on('close', () => { clearInterval(heartbeat); agentNotifications.off(req.agentId, wake); });
});
router.post('/profile', route((req, res) => res.json(agents.configureAgent(req.agentId, req.body || {}))));
router.post('/sessions', route((req, res) => res.json(agents.upsertRemoteSession(req.agentId, req.body || {}))));
router.post('/projects', route((req, res) => res.json(agents.upsertRemoteProject(req.agentId, req.body || {}))));
router.post('/events', route((req, res) => res.json(agents.appendRemoteEvent(req.agentId, req.body || {}))));
router.post('/approvals', route((req, res) => res.json(agents.requestRemoteApproval(req.agentId, req.body || {}))));
router.post('/approvals/:id/resolve', route((req, res) => res.json(agents.closeRemoteApproval(req.agentId, req.params.id, req.body?.status))));
router.get('/commands', route((req, res) => res.json(agents.takeCommands(req.agentId))));
router.post('/commands/:id/result', route((req, res) => res.json(agents.completeCommand(req.agentId, req.params.id, req.body || {}))));

export default router;
