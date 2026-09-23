// WebSocket fan-out + upstream intake.
// On connect the client gets a legacy `snapshot` (sessions) and a v2
// `projects.snapshot`. Client frames (approval.respond / message.send /
// session.control) are dispatched to the injected `onClientMessage` handler
// (wired in index.js) — kept dependency-free to avoid an import cycle.
//
// The handshake checks ?token=<t> before upgrade; revocation also closes live sockets.
// Observability (audit A13): connect/disconnect are logged with the remote IP
// and the resulting client count.
import { WebSocketServer } from 'ws';

let wss = null;

export function initWs(server, getSnapshot, onClientMessage, { authToken = '', authorizeToken = (token) => !authToken || token === authToken } = {}) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 1024 * 1024,
    verifyClient: (info) => {
      try {
        const u = new URL(info.req.url, 'http://localhost');
        return authorizeToken(u.searchParams.get('token') || '');
      } catch {
        return false;
      }
    },
  });
  wss.on('connection', async (socket, req) => {
    socket.accessToken = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    // Accept controls while the initial snapshot is still being read.
    socket.on('message', (raw) => {
      if (!authorizeToken(socket.accessToken)) return socket.close(1008, 'Device access revoked');
      if (!onClientMessage) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        Promise.resolve(onClientMessage(msg, socket)).catch((e) => console.error('[ws] client message error:', e.message));
      } catch (e) {
        console.error('[ws] client message error:', e.message);
      }
    });
    socket.on('error', (error) => console.error('[ws]', error.message));
    const ip = req?.socket?.remoteAddress || '?';
    const ua = (req?.headers?.['user-agent'] || '?').slice(0, 40);
    console.log(`[ws] connect ${ip} (clients=${wss.clients.size}) ua="${ua}"`);
    socket.on('close', (code, reason) =>
      console.log(`[ws] disconnect ${ip} (clients=${wss.clients.size}) code=${code} reason="${String(reason || '').slice(0, 40)}" ua="${ua}"`),
    );
    try {
      const snap = await getSnapshot();
      socket.send(JSON.stringify({ type: 'agents.snapshot', agents: snap.agents || [], ts: Date.now() }));
      socket.send(JSON.stringify({ type: 'approvals.snapshot', approvals: snap.approvals || [], ts: Date.now() }));
      socket.send(JSON.stringify({ type: 'projects.snapshot', projects: snap.projects, ts: Date.now() }));
      socket.send(JSON.stringify({ type: 'snapshot', sessions: snap.sessions || [], ts: Date.now() }));
    } catch {
      /* socket may have closed immediately */
    }

  });
  return wss;
}

export function broadcast(obj) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(data);
    }
  }
}

export function clientCount() {
  return wss ? wss.clients.size : 0;
}

export function disconnectUnauthorizedClients(authorizeToken) {
  for (const client of wss?.clients || []) {
    if (!authorizeToken(client.accessToken)) client.close(1008, 'Device access revoked');
  }
}
