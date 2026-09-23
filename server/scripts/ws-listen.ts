/** 开发与运维入口：观察中心实时消息以便联调。 */
// Tiny WebSocket client to verify broadcasts. Prints every message it receives.
//   npx tsx scripts/ws-listen.ts                       -> ws://localhost:4820/ws
//   URL=ws://192.168.0.194:4820/ws npx tsx scripts/ws-listen.ts
import { WebSocket } from 'ws';

const URL = process.env.URL || 'ws://localhost:4820/ws';
const ws = new WebSocket(URL);

ws.on('open', () => console.log('[ws] connected to', URL));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'snapshot') {
    console.log(`[ws] snapshot: ${msg.sessions.length} session(s)`);
  } else if (msg.type === 'event') {
    const e = msg.event;
    console.log(`[ws] event: ${e.hook_event_name} -> ${e.status} | ${e.summary}`);
  } else {
    console.log('[ws]', JSON.stringify(msg));
  }
});
ws.on('error', (e) => console.error('[ws] error:', e.message));
ws.on('close', () => console.log('[ws] closed'));
