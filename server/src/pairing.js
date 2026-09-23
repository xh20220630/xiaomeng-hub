import { Router, json, static as serveStatic } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

export function createPairing({ db, authToken, onRevoke = () => {}, now = Date.now, ttlMs = 120000,
  interfaces = os.networkInterfaces, listenHost = process.env.HOST || '0.0.0.0', getAgents = () => [] }) {
  db.exec(`CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, authority_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  if (!db.prepare('PRAGMA table_info(paired_devices)').all().some((column) => column.name === 'installation_hash')) {
    db.exec('ALTER TABLE paired_devices ADD COLUMN installation_hash TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS paired_device_installation ON paired_devices(authority_hash, installation_hash) WHERE installation_hash IS NOT NULL');
  const authority = digest(authToken);
  const sessions = new Map();
  const findToken = db.prepare('SELECT id, installation_hash FROM paired_devices WHERE token_hash = ? AND authority_hash = ?');
  const findInstallation = db.prepare('SELECT id FROM paired_devices WHERE authority_hash = ? AND installation_hash = ?');
  const listDevices = db.prepare('SELECT id, name, platform, created_at AS createdAt FROM paired_devices WHERE authority_hash = ? ORDER BY created_at DESC');
  const insertDevice = db.prepare('INSERT INTO paired_devices (id, name, platform, token_hash, authority_hash, created_at, installation_hash) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const deleteDevice = db.prepare('DELETE FROM paired_devices WHERE id = ? AND authority_hash = ?');
  const authorizeDevice = (token) => !!authToken && typeof token === 'string' && token.length < 256 && !!findToken.get(digest(token), authority);
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  router.use(json({ limit: '8kb' }));

  function prune() {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
  }

  // Only the temporary secret crosses the QR boundary; the administrator token never leaves this host.
  router.post('/exchange', (req, res) => {
    if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '请使用小梦 APP 扫码绑定' });
    if (!authToken) return res.status(503).json({ error: '宿主机尚未设置 AUTH_TOKEN' });
    prune();
    const { code, clientNonce, installationId, existingToken, deviceName, platform } = req.body || {};
    if (typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(installationId)) {
      return res.status(426).json({ errorCode: 'CLIENT_UPDATE_REQUIRED', error: '请升级小梦 APP 后绑定；旧版不支持设备去重' });
    }
    if (typeof code !== 'string' || typeof clientNonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(clientNonce)
      || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 60
      || !['android', 'ios', 'other'].includes(platform)) return res.status(400).json({ error: '绑定信息不完整，请重新扫码' });
    const session = [...sessions.values()].find((item) => item.codeHash === digest(code));
    if (!session) return res.status(410).json({ error: '二维码已过期或已刷新，请重新扫码' });
    const installationHash = digest(installationId);
    if (session.result) {
      // A lost HTTP response may be retried by the same phone without enrolling a second device.
      if (session.clientNonce === clientNonce && session.installationHash === installationHash && authorizeDevice(session.result.token)) return res.json(session.result);
      return res.status(409).json({ error: '二维码已被使用，请在电脑上生成新的二维码' });
    }
    if (findInstallation.get(authority, installationHash)) {
      return res.status(409).json({ errorCode: 'DEVICE_ALREADY_PAIRED', error: '这台设备已绑定此宿主机，无需重复绑定。需要重新绑定时，请先在电脑上解除绑定。' });
    }
    // Adopt a pre-identity enrollment only when the phone proves ownership of its existing token.
    const legacy = typeof existingToken === 'string' && existingToken.length < 256
      ? findToken.get(digest(existingToken), authority) : null;
    if (legacy && legacy.installation_hash === null) {
      db.prepare('UPDATE paired_devices SET installation_hash = ? WHERE id = ?').run(installationHash, legacy.id);
      return res.status(409).json({ errorCode: 'DEVICE_ALREADY_PAIRED', error: '这台设备已绑定此宿主机，已保留原有连接，无需再次绑定。' });
    }
    const token = `xm_device_${secret()}`;
    const id = randomUUID();
    insertDevice.run(id, deviceName.trim(), platform, digest(token), authority, now(), installationHash);
    session.installationHash = installationHash;
    session.clientNonce = clientNonce;
    session.deviceName = deviceName.trim();
    session.result = { deviceId: id, token, serverUrl: session.serverUrl, hostName: os.hostname() };
    res.status(201).json(session.result);
  });

  // Check the socket AND Host/Origin to prevent a remote website from rebinding DNS to localhost.
  router.use((req, res, next) => {
    const host = req.headers.host || '';
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
    if (!loopbacks.has(req.socket.remoteAddress) || !localHost
      || (req.headers.origin && req.headers.origin !== `http://${host}`)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      return res.status(403).type('text').send('请在宿主机上打开 http://localhost:端口/pair/ 管理绑定。');
    }
    next();
  });

  function addresses(req) {
    const bound = req.socket.localAddress?.replace('::ffff:', '');
    const listeningHost = listenHost;
    if (loopbacks.has(listeningHost)) return [];
    const priority = (entry) => {
      const ip = new URL(entry.url).hostname;
      const virtual = /virtual|vethernet|vmware|wsl|mihomo|clash|tun|vpn|docker|tailscale|zerotier/i.test(entry.name);
      const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      return (virtual ? 10 : 0) + (privateIp ? 0 : 2);
    };
    return Object.entries(interfaces()).flatMap(([name, entries]) => entries
      .filter((entry) => entry.family === 'IPv4' && !entry.internal
        && (['0.0.0.0', '::'].includes(listeningHost) || entry.address === bound))
      .map((entry) => ({ name, url: `http://${entry.address}:${req.socket.localPort}` })))
      .sort((a, b) => priority(a) - priority(b));
  }

  router.get('/info', (req, res) => res.json({
    hostName: os.hostname(), platform: os.platform(), addresses: addresses(req),
    authEnabled: !!authToken, devices: listDevices.all(authority),
    agents: getAgents().map(({ agentId, name, provider, online }) => ({ agentId, name, provider, online })),
  }));
  router.post('/sessions', async (req, res, next) => {
    try {
      if (!authToken) return res.status(503).json({ error: '请先为后端设置 AUTH_TOKEN，再重启服务' });
      const serverUrl = req.body?.serverUrl;
      if (!addresses(req).some((entry) => entry.url === serverUrl)) return res.status(400).json({ error: '请选择本机可用的局域网地址' });
      prune();
      if (sessions.size >= 100) return res.status(429).json({ error: '生成过于频繁，请稍后重试' });
      const id = randomUUID();
      const code = secret();
      const expiresAt = now() + ttlMs;
      const payload = `xiaomeng://pair?${new URLSearchParams({ v: '1', server: serverUrl, name: os.hostname(), code, expires: String(expiresAt) })}`;
      const svg = await QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 280 });
      for (const [key, session] of sessions) if (!session.result) sessions.delete(key);
      sessions.set(id, { codeHash: digest(code), expiresAt, serverUrl });
      res.status(201).json({ id, payload, expiresAt, qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
    } catch (error) { next(error); }
  });
  router.get('/sessions/:id', (req, res) => {
    prune();
    const session = sessions.get(req.params.id);
    if (!session) return res.json({ status: 'expired' });
    res.json({ status: session.result ? 'paired' : 'waiting', expiresAt: session.expiresAt, deviceName: session.deviceName });
  });
  router.delete('/devices/:id', (req, res) => {
    deleteDevice.run(req.params.id, authority);
    onRevoke();
    res.json({ ok: true });
  });
  router.use(serveStatic(fileURLToPath(new URL('../public/pair/', import.meta.url))));
  return { router, authorizeDevice };
}
