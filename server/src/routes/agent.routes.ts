/** 将 URL 绑定到控制器，业务规则由服务层维护。 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import * as controller from '../controllers/agent.controller.js';

import { authenticateAgent } from '../middleware/agent-auth.js';

const router = Router();
router.post('/register', asyncHandler(controller.register));
router.use(authenticateAgent);
router.post('/heartbeat', asyncHandler(controller.heartbeat));
router.get('/stream', asyncHandler(controller.stream));
router.post('/profile', asyncHandler(controller.profile));
router.post('/sessions', asyncHandler(controller.session));
router.post('/projects', asyncHandler(controller.project));
router.post('/events', asyncHandler(controller.event));
router.post('/approvals', asyncHandler(controller.approval));
router.post('/approvals/:id/resolve', asyncHandler(controller.resolveApproval));
router.get('/commands', asyncHandler(controller.commands));
router.post('/commands/:id/result', asyncHandler(controller.commandResult));
export default router;
