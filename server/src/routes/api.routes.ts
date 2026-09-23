/** 将 URL 绑定到控制器，业务规则由服务层维护。 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import * as controller from '../controllers/api.controller.js';

const router = Router();
router.get('/agents', asyncHandler(controller.listAgents));
router.get('/agents/:id/catalog', asyncHandler(controller.agentCatalog));
router.post('/agents/:id/actions', asyncHandler(controller.agentAction));
router.post('/sessions/:id/configure', asyncHandler(controller.configureSession));
router.post('/sessions/:id/compact', asyncHandler(controller.compactSession));
router.get('/projects', asyncHandler(controller.listProjects));
router.get('/projects/:id/sessions', asyncHandler(controller.projectSessions));
router.post('/projects/:id/sessions', asyncHandler(controller.createSession));
router.get('/sessions', asyncHandler(controller.listSessions));
router.get('/sessions/:id/events', asyncHandler(controller.sessionEvents));
router.get('/sessions/:id/history', asyncHandler(controller.sessionHistory));
router.post('/sessions/:id/message', asyncHandler(controller.sendMessage));
router.post('/sessions/:id/control', asyncHandler(controller.controlSession));
router.post('/sessions/:id/steer', asyncHandler(controller.steerMessage));
router.get('/approvals', asyncHandler(controller.pendingApprovals));
router.post('/approvals/:id', asyncHandler(controller.resolveApproval));
router.get('/commands/:id', asyncHandler(controller.commandInfo));
export default router;
