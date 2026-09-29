import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { AgentClient } from '../src/sdk/agent-client.js';
import { HostResources } from '../src/resources/host-resources.js';
import { resourceHandlers } from '../src/resources/agent-resources.js';

test('resource API authenticates, isolates owners and agents, transfers bytes and cancels revoked reads', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'xm-resource-api-'));
  process.env.DB_PATH = path.join(temporary, 'test.db');
  process.env.AUTH_TOKEN = 'resource-enrollment';
  process.env.AGENT_TOKEN = 'resource-enrollment';
  process.env.LOCAL_CLAUDE = '0';
  const { createResourceRouter } = await import('../src/routes/resource.routes.js');
  const { default: agentRouter } = await import('../src/routes/agent.routes.js');
  const { hubEvents } = await import('../src/events/hub-events.js');
  const { default: db } = await import('../src/infrastructure/database.js');
  const { errorHandler } = await import('../src/middleware/http.js');
  const tokens = new Set(['phone-a', 'phone-b']);
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createResourceRouter(true, (token) => tokens.has(token)),
  );
  app.use(
    '/anonymous',
    createResourceRouter(false, () => true),
  );
  app.use('/agent', agentRouter);
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: AgentClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const broadcasts: Record<string, unknown>[] = [];
  const listen = (event: Record<string, unknown>) => broadcasts.push(event);
  hubEvents.on('broadcast', listen);
  t.after(() => hubEvents.off('broadcast', listen));
  async function request(endpoint: string, body?: unknown, token = 'phone-a') {
    return fetch(origin + endpoint, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  }
  async function resolve(session: string, reference: string, baseResourceId?: string) {
    const response = await request(`/api/sessions/${session}/resources/resolve`, {
      reference,
      baseResourceId,
    });
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  }
  const sessions: string[] = [];
  const contexts: { sessionId: string; cwd: string }[] = [];
  const image = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#2680c0' },
  })
    .png()
    .toBuffer();
  for (const name of ['A', 'B']) {
    const cwd = path.join(temporary, name);
    await mkdir(cwd);
    await mkdir(path.join(cwd, 'docs'));
    await writeFile(path.join(cwd, 'docs', 'readme.md'), `# Host ${name}\n![image](../image.png)`);
    await writeFile(path.join(cwd, 'image.png'), image);
    const context = { cwd, sessionId: 'same-local-session' };
    contexts.push(context);
    let client: AgentClient;
    client = new AgentClient({
      hubUrl: origin,
      enrollmentToken: process.env.AUTH_TOKEN,
      nodeId: 'same-untrusted-node-id',
      nodeName: `Host ${name}`,
      agentKey: name,
      name,
      stateFile: path.join(temporary, `${name}.json`),
      onError: () => {},
      handlers: resourceHandlers(
        new HostResources({ cacheRoot: path.join(temporary, `cache-${name}`) }),
        (id) => {
          assert.equal(id, context.sessionId);
          return context;
        },
        (id, bytes, type) => client.uploadResource(id, bytes, type),
      ),
    });
    clients.push(client);
    await client.connect();
    const session = await client.session(
      { id: 'same-project', name: 'same project', cwd: '/same/display/path' },
      { id: context.sessionId, cwd: '/same/display/path', status: 'done', capabilities: [] },
    );
    sessions.push(session.sessionId);
  }

  await t.test('anonymous, invalid and URL-only credentials cannot read', async () => {
    const body = { reference: 'docs/readme.md' };
    assert.equal(
      (await request(`/api/sessions/${sessions[0]}/resources/resolve`, body, '')).status,
      401,
    );
    assert.equal(
      (await request(`/api/sessions/${sessions[0]}/resources/resolve?token=phone-a`, body, ''))
        .status,
      401,
    );
    assert.equal(
      (await request(`/anonymous/sessions/${sessions[0]}/resources/resolve`, body)).status,
      503,
    );
    const response = await fetch(`${origin}/agent/resources/transfers/missing`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clients[0].credentials!.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: image,
    });
    assert.equal(response.status, 410);
  });
  let metadata: Awaited<ReturnType<typeof resolve>>;
  await t.test('same path and node label route to the actual owning Agent', async () => {
    for (let i = 0; i < sessions.length; i++) {
      const m = await resolve(sessions[i], 'docs/readme.md');
      const response = await request(`/api/resources/${m.resourceId}/text?version=${m.version}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const data = await response.json();
      assert.ok(data.text.startsWith(`# Host ${i === 0 ? 'A' : 'B'}`));
      if (i === 0) metadata = m;
    }
    assert.equal(
      (await request(`/api/resources/${metadata.resourceId}`, undefined, 'phone-b')).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/sessions/${sessions[1]}/resources/resolve`, {
          reference: '../image.png',
          baseResourceId: metadata.resourceId,
        })
      ).status,
      403,
    );
  });
  await t.test(
    'relative image bytes are bounded, private and absent from stored receipts',
    async () => {
      const m = await resolve(sessions[0], '../image.png', metadata.resourceId);
      const response = await request(`/api/resources/${m.resourceId}/content?version=${m.version}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
      const thumb = await request(`/api/resources/${m.resourceId}/thumbnail?version=${m.version}`);
      assert.equal(thumb.headers.get('content-type'), 'image/webp');
      assert.equal(
        broadcasts.some((e) => e.type === 'command.result'),
        false,
      );
      const rows = db
        .prepare("SELECT result FROM lan_commands WHERE type LIKE 'resources.%'")
        .all();
      assert.ok(rows.length > 0);
      assert.ok(
        rows.every((r) => !String(r.result).includes('base64') && String(r.result).length < 100),
      );
      await writeFile(path.join(contexts[0].cwd, 'docs', 'readme.md'), 'changed content');
      const stale = await request(
        `/api/resources/${metadata.resourceId}/text?version=${metadata.version}`,
      );
      assert.equal((await stale.json()).code, 'RESOURCE_CHANGED');
    },
  );
  await t.test('revoking a device during a pending read returns no file bytes', async () => {
    const m = await resolve(sessions[1], 'docs/readme.md');
    const original = clients[1].handlers['resources.read']!;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    clients[1].handlers['resources.read'] = async (...args) => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return original(...args);
    };
    const pending = request(`/api/resources/${m.resourceId}/text?version=${m.version}`);
    await ready;
    tokens.delete('phone-a');
    const response = await pending;
    const body = await response.text();
    assert.notEqual(response.status, 200);
    assert.ok(!body.includes('# Host B'));
    assert.equal((await request(`/api/resources/${m.resourceId}`)).status, 401);
  });
});
