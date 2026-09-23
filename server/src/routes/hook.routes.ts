/** Claude hook 入口，认证由应用装配层统一挂载。 */
import { Router } from 'express';
import * as controller from '../controllers/hook.controller.js';
import { asyncHandler } from '../middleware/async-handler.js';
const router = Router();
router.post('/event', asyncHandler(controller.event));
router.post('/gate', asyncHandler(controller.gate));
export default router;
