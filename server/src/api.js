import { Router } from 'express';
import { buildProjects } from './snapshot.js';
import { listAgents, commandInfo } from './agent-platform.js';
import { localAgent } from './local-agent.js';
import * as operations from './operations.js';

const router = Router();
const route = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
export const allAgents = () => [...(process.env.LOCAL_CLAUDE === '0' ? [] : [localAgent()]), ...listAgents()];

router.get('/agents', (_req, res) => res.json(allAgents()));
router.get('/agents/:id/catalog', route(async (req, res) => res.json(await operations.agentCatalog(req.params.id, req.query.sessionId))));
router.post('/agents/:id/actions', route(async (req, res) => res.json(await operations.agentAction(req.params.id, req.body?.sessionId, req.body?.name, req.body?.arguments, req.body?.requestId))));
router.post('/sessions/:id/configure', route(async (req, res) => res.json(await operations.configureSession(req.params.id, req.body?.settings, req.body?.requestId))));
router.post('/sessions/:id/compact', route(async (req, res) => res.json(await operations.compactSession(req.params.id, req.body?.requestId))));
router.get('/projects', route(async (_req, res) => res.json(await buildProjects())));
router.get('/projects/:id/sessions', route(async (req, res) => res.json(await operations.projectSessions(req.params.id))));
router.post('/projects/:id/sessions', route(async (req, res) => {
  res.status(202).json(await operations.createSession(req.params.id, req.body?.text, req.body?.requestId));
}));
router.get('/sessions', route(async (_req, res) => {
  const projects = await buildProjects();
  res.json(projects.flatMap((project) => project.sessions ?? []));
}));
router.get('/sessions/:id/events', route(async (req, res) => res.json(await operations.sessionEvents(req.params.id))));
router.get('/sessions/:id/history', route(async (req, res) => {
  const limit = req.query.limit == null ? 40 : Number(req.query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (req.query.cursor != null && (typeof req.query.cursor !== 'string' || req.query.cursor.length > 4096))) {
    return res.status(400).json({ error: 'Invalid history pagination' });
  }
  res.json(await operations.sessionHistory(req.params.id, req.query.cursor, limit));
}));
router.post('/sessions/:id/message', route(async (req, res) => {
  res.status(202).json(await operations.sendMessage(req.params.id, req.body?.text, req.body?.requestId));
}));
router.post('/sessions/:id/control', route(async (req, res) => {
  res.status(202).json(await operations.controlSession(req.params.id, req.body?.action, req.body?.requestId));
}));
router.post('/sessions/:id/steer', route((req, res) => {
  res.status(202).json(operations.steerMessage(req.params.id, req.body?.text, req.body?.requestId));
}));
router.get('/approvals', (_req, res) => res.json(operations.pendingApprovals()));
router.post('/approvals/:id', route((req, res) => {
  res.json(operations.resolveApproval(req.params.id, req.body?.decision, req.body?.scope, req.body?.answers));
}));
router.get('/commands/:id', route((req, res) => res.json(commandInfo(req.params.id))));

export default router;
