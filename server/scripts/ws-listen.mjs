// Tiny WebSocket client to verify broadcasts. Prints every message it receives.
//   node scripts/ws-listen.mjs                       -> ws://localhost:4820/ws
//   URL=ws://192.168.0.194:4820/ws node scripts/ws-listen.mjs
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
