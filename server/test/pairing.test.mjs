import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import WebSocket from 'ws';
import { createPairing } from '../src/pairing.js';
import { initWs, disconnectUnauthorizedClients } from '../src/ws.js';

test('QR pairing protects enrollment, persists device access and revokes live connections', async (t) => {
  const db = new DatabaseSync(':memory:');
  let time = Date.now();
  const options = { db, authToken: 'test-master-never-in-qr', now: () => time,
    getAgents: () => [{ agentId: 'codex-test', name: 'Codex', provider: 'codex', online: true }],
    listenHost: '0.0.0.0', interfaces: () => ({ WiFi: [{ address: '192.168.1.22', family: 'IPv4', internal: false }] }),
    onRevoke: () => disconnectUnauthorizedClients(authorize),
  };
  const pairing = createPairing(options);
  const authorize = (token) => token === options.authToken || pairing.authorizeDevice(token);
  const app = express();
  app.use('/pair', pairing.router);
  app.get('/api/agents', (req, res) => res.status(authorize((req.headers.authorization || '').slice(7)) ? 200 : 401).json([]));
  const server = http.createServer(app);
  const wss = initWs(server, async () => ({ projects: [] }), () => {}, { authorizeToken: authorize });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = `http://192.168.1.22:${server.address().port}`;
  async function request(path, { body, status = 200, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, status, `${path}: ${response.status}`);
    return response;
  }
  const makeSession = async () => (await request('/pair/sessions', { body: { serverUrl: target }, status: 201 })).json();
  const makeBody = (session) => ({ code: new URL(session.payload).searchParams.get('code'),
    clientNonce: randomBytes(32).toString('base64url'), installationId: randomBytes(32).toString('base64url'), deviceName: 'My phone', platform: 'android' });
  const exchange = async (body, status = 201) => (await request('/pair/exchange', { body, status })).json();

  await t.test('console is local, same-origin, uncached and blocks DNS rebinding', async () => {
    const page = await request('/pair/');
    assert.match(await page.text(), /扫码绑定宿主机/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    const reboundStatus = await new Promise((resolve, reject) => {
      const req = http.get(origin + '/pair/info', { headers: { Host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    await request('/pair/info', { status: 403, headers: { Origin: 'https://attacker.example' } });
    await request('/pair/sessions', { status: 403, headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { serverUrl: target } });
    await request('/pair/sessions', { status: 400, body: { serverUrl: 'http://attacker.example' } });
    await request('/pair/exchange', { status: 403, headers: { Origin: origin }, body: {} });
    const info = await (await request('/pair/info')).json();
    assert.equal(info.addresses[0].url, target);
    assert.deepEqual(info.agents, [{ agentId: 'codex-test', name: 'Codex', provider: 'codex', online: true }]);
  });

  let credentials;
  let firstBody;
  let firstSession;
  await t.test('QR contains a temporary secret; exchange issues an independent token exactly once', async () => {
    firstSession = await makeSession();
    assert.ok(firstSession.qrDataUrl.startsWith('data:image/svg+xml;base64,'));
    assert.equal(JSON.stringify(firstSession).includes(options.authToken), false);
    firstBody = makeBody(firstSession);
    await exchange({ ...firstBody, clientNonce: 'short' }, 400);
    credentials = await exchange(firstBody);
    assert.notEqual(credentials.token, options.authToken);
    assert.equal(pairing.authorizeDevice(credentials.token), true);
    assert.equal(pairing.authorizeDevice('invalid'), false);
    assert.deepEqual(await exchange(firstBody, 200), credentials);
    await exchange(makeBody(firstSession), 409);
    const stored = db.prepare('SELECT * FROM paired_devices').get();
    assert.equal(JSON.stringify(stored).includes(credentials.token), false);
    const status = await (await request(`/pair/sessions/${firstSession.id}`)).json();
    assert.equal(status.status, 'paired');
    const info = await (await request('/pair/info')).json();
    assert.equal(info.devices.length, 1);
    assert.equal(JSON.stringify(info).includes(credentials.token), false);
    await request('/api/agents', { headers: { Authorization: `Bearer ${credentials.token}` } });
    await request('/api/agents', { status: 401, headers: { Authorization: 'Bearer invalid' } });
  });

  await t.test('the same installation cannot enroll twice even with a new QR, nonce or device name', async () => {
    const session = await makeSession();
    const duplicate = await exchange({ ...makeBody(session), installationId: firstBody.installationId, deviceName: 'Renamed phone' }, 409);
    assert.equal(duplicate.errorCode, 'DEVICE_ALREADY_PAIRED');
    assert.equal(db.prepare('SELECT count(*) AS n FROM paired_devices').get().n, 1);
    assert.equal(pairing.authorizeDevice(credentials.token), true);
    const other = await exchange(makeBody(session));
    assert.notEqual(other.deviceId, credentials.deviceId);
    await request(`/pair/devices/${other.deviceId}`, { method: 'DELETE' });
    const legacyClient = { ...makeBody(await makeSession()) };
    delete legacyClient.installationId;
    assert.equal((await exchange(legacyClient, 426)).errorCode, 'CLIENT_UPDATE_REQUIRED');
  });

  await t.test('old enrollments are adopted using their own token, never merged by display name', async () => {
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    const oldToken = 'xm_device_' + randomBytes(32).toString('base64url');
    const authority = hash(options.authToken);
    db.prepare('INSERT INTO paired_devices (id,name,platform,token_hash,authority_hash,created_at) VALUES (?,?,?,?,?,?)')
      .run('legacy-phone', 'My phone', 'android', hash(oldToken), authority, time);
    const body = { ...makeBody(await makeSession()), existingToken: oldToken };
    assert.equal((await exchange(body, 409)).errorCode, 'DEVICE_ALREADY_PAIRED');
    const adopted = db.prepare('SELECT installation_hash FROM paired_devices WHERE id=?').get('legacy-phone');
    assert.equal(adopted.installation_hash, hash(body.installationId));
    assert.equal(pairing.authorizeDevice(oldToken), true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM paired_devices').get().n, 2);
    assert.throws(() => db.prepare('UPDATE paired_devices SET installation_hash=? WHERE id=?').run(adopted.installation_hash, credentials.deviceId), /UNIQUE/);
    await request('/pair/devices/legacy-phone', { method: 'DELETE' });
    const rebound = await exchange({ ...body, ...makeBody(await makeSession()), installationId: body.installationId });
    assert.notEqual(rebound.deviceId, 'legacy-phone');
    await request(`/pair/devices/${rebound.deviceId}`, { method: 'DELETE' });
  });

  await t.test('refresh invalidates pending codes and server time enforces expiration', async () => {
    const stale = await makeSession();
    const fresh = await makeSession();
    await exchange(makeBody(stale), 410);
    time += 120001;
    await exchange(makeBody(fresh), 410);
    const status = await (await request(`/pair/sessions/${fresh.id}`)).json();
    assert.equal(status.status, 'expired');
  });

  await t.test('credentials survive service recreation; rotating the master invalidates old devices', () => {
    assert.equal(createPairing(options).authorizeDevice(credentials.token), true);
    assert.equal(createPairing({ ...options, authToken: 'rotated-master' }).authorizeDevice(credentials.token), false);
    assert.equal(createPairing({ ...options, authToken: '' }).authorizeDevice(credentials.token), false);
  });

  await t.test('revocation disconnects WebSocket immediately and rejects subsequent REST / WS access', async () => {
    const wsUrl = origin.replace('http:', 'ws:') + '/ws?token=' + credentials.token;
    const socket = new WebSocket(wsUrl);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    await request(`/pair/devices/${credentials.deviceId}`, { method: 'DELETE' });
    assert.equal((await closed)[0], 1008);
    assert.equal(pairing.authorizeDevice(credentials.token), false);
    await request('/api/agents', { status: 401, headers: { Authorization: `Bearer ${credentials.token}` } });
    const denied = new WebSocket(wsUrl);
    const error = await new Promise((resolve) => denied.once('error', resolve));
    assert.match(error.message, /401/);
  });

  await t.test('revocation cannot be undone by retrying the same code', async () => {
    const session = await makeSession();
    const body = makeBody(session);
    const device = await exchange(body);
    await request(`/pair/devices/${device.deviceId}`, { method: 'DELETE' });
    await exchange(body, 409);
  });
});

test('real server accepts paired REST/WS credentials without granting agent enrollment', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-pairing-test-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true,
    env: { ...process.env, HOST: '0.0.0.0', PORT: '0', LOCAL_CLAUDE: '0',
      AUTH_TOKEN: 'real-server-test-master', DB_PATH: path.join(directory, 'test.db') },
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    const resolved = path.resolve(directory);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('xiaomeng-pairing-test-')) {
      await rm(resolved, { recursive: true, force: true });
    }
  });
  const port = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 5000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/listening on 0.0.0.0:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const info = await (await fetch(origin + '/pair/info')).json();
  if (!info.addresses.length) return t.skip('No LAN interface is available on this runner');
  const session = await (await fetch(origin + '/pair/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverUrl: info.addresses[0].url }) })).json();
  const result = await fetch(origin + '/pair/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: new URL(session.payload).searchParams.get('code'), clientNonce: randomBytes(32).toString('base64url'), installationId: randomBytes(32).toString('base64url'), deviceName: 'Integration phone', platform: 'ios' }) });
  assert.equal(result.status, 201);
  const credentials = await result.json();
  const headers = { Authorization: `Bearer ${credentials.token}` };
  assert.equal((await fetch(origin + '/api/agents', { headers })).status, 200);
  assert.equal((await fetch(origin + '/agent/register', { method: 'POST', headers })).status, 401);
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws?token=' + credentials.token);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  assert.equal((await fetch(origin + '/pair/devices/' + credentials.deviceId, { method: 'DELETE' })).status, 200);
  assert.equal((await closed)[0], 1008);
  assert.equal((await fetch(origin + '/api/agents', { headers })).status, 401);
});
