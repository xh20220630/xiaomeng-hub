import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import type { EventInput } from '../src/types/domain.js';

test('Codex live/history and Claude transcript preserve immutable image references', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'xm-attachments-'));
  process.env.RESOURCE_CACHE_DIR = path.join(temporary, 'cache');
  process.env.CLAUDE_PROJECTS_DIR = path.join(temporary, 'claude');
  process.env.DB_PATH = path.join(temporary, 'test.db');
  const { createTestAgent } = await import('./fixtures/agent.js');
  const { readConversation } = await import('../src/adapters/claude/transcript.js');
  const { default: db } = await import('../src/infrastructure/database.js');
  t.after(async () => {
    db.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const bytes = await sharp({
    create: { width: 20, height: 10, channels: 3, background: '#c5ee79' },
  })
    .png()
    .toBuffer();
  const data = bytes.toString('base64');
  const item = {
    id: 'image-tool',
    type: 'mcpToolCall',
    tool: 'screenshot',
    status: 'completed',
    result: {
      content: [
        { type: 'text', text: '截图' },
        { type: 'image', data, mimeType: 'image/png' },
      ],
    },
  };
  const events: EventInput[] = [];
  const adapter = createTestAgent({
    projects: [temporary],
    rpc: { request: async () => ({ data: [{ turnId: 'turn', item }], nextCursor: null }) },
    client: {
      event: async (_session: string, type: string, fields: EventInput) =>
        events.push({ type, ...fields }),
    },
  });
  adapter.threads.set('thread', { id: 'thread', cwd: temporary });
  await adapter.item('thread', 'turn', item, true);
  const history = await adapter.readHistory({ sessionId: 'thread' });
  assert.deepEqual(events[0].attachments, history.events[0].attachments);
  assert.equal(events[0].attachments?.[0].snapshot, true);
  assert.ok(!JSON.stringify(events).includes(data));
  const m = await adapter.resources.resolve(
    { sessionId: 'thread', cwd: temporary },
    events[0].attachments![0].reference,
  );
  assert.deepEqual(
    (
      await adapter.resources.image(
        { sessionId: 'thread', cwd: temporary },
        m.resourceId,
        m.version,
        false,
      )
    ).bytes,
    bytes,
  );

  const sessionId = '11111111-1111-4111-8111-111111111111';
  const project = path.join(process.env.CLAUDE_PROJECTS_DIR, 'fixture');
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, `${sessionId}.jsonl`),
    [
      {
        type: 'user',
        sessionId,
        cwd: temporary,
        timestamp: new Date().toISOString(),
        message: {
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
        },
      },
      {
        type: 'assistant',
        sessionId,
        cwd: temporary,
        message: { content: [{ type: 'tool_use', id: 'tool', name: 'Screenshot' }] },
      },
      {
        type: 'user',
        sessionId,
        cwd: temporary,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
              ],
            },
          ],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const transcript = await readConversation(sessionId);
  assert.equal(transcript.filter((event) => event.attachments?.length).length, 2);
  assert.equal(
    transcript.find((event) => event.hook_event_name === 'PostToolUse')?.attachments?.[0].snapshot,
    true,
  );
  assert.ok(!JSON.stringify(transcript).includes(data));
});
