import { EventEmitter } from 'node:events';

export const agentNotifications = new EventEmitter();
agentNotifications.setMaxListeners(0);
