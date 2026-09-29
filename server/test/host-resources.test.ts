import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { HostResources, parseReference, within } from '../src/resources/host-resources.js';
import { collectAttachments } from '../src/resources/attachments.js';

test('host resources enforce roots, file versions, text paging and image limits', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'xm-resource-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const cwd = path.join(temporary, 'project');
  const outside = path.join(temporary, 'project-other');
  await mkdir(cwd);
  await mkdir(outside);
  const store = new HostResources({ cacheRoot: path.join(temporary, 'cache'), extraRoots: [] });
  const context = { sessionId: 'session-a', cwd };
  const file = path.join(cwd, '中文 文件.md');
  await writeFile(file, Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n'));
  await writeFile(path.join(outside, 'private.txt'), 'private');

  await t.test('encoded names, file URLs and line references', async () => {
    assert.deepEqual(parseReference('src/main.ts:120:8'), { reference: 'src/main.ts', line: 120 });
    const metadata = await store.resolve(context, `${encodeURIComponent('中文 文件.md')}#L201`);
    assert.equal(metadata.kind, 'markdown');
    assert.equal(metadata.line, 201);
    const first = await store.text(context, metadata.resourceId, metadata.version);
    assert.equal(first.text.split('\n').length, 200);
    assert.equal(first.nextLine, 201);
    const next = await store.text(context, metadata.resourceId, metadata.version, first.nextLine!);
    assert.ok(next.text.startsWith('line 201\n'));
    assert.equal(next.nextLine, 401);
    assert.equal((await store.resolve(context, pathToFileURL(file).href)).name, '中文 文件.md');
    assert.equal((await store.resolve(context, '#L4', metadata.resourceId)).line, 4);
    await assert.rejects(
      store.text({ ...context, sessionId: 'other' }, metadata.resourceId, metadata.version),
      { code: 'RESOURCE_EXPIRED' },
    );
  });

  await t.test('traversal, special paths and symlink escapes are rejected', async () => {
    assert.equal(within(cwd, outside), false);
    for (const reference of [
      '../project-other/private.txt',
      '%2e%2e%2fproject-other%2fprivate.txt',
    ]) {
      await assert.rejects(store.resolve(context, reference), { code: 'OUTSIDE_ROOT' });
    }
    for (const value of [
      '\\\\server\\share\\file.txt',
      '\\0',
      'file.txt%00',
      'https://example.com/file',
      'file.txt:0',
    ]) {
      assert.throws(() => parseReference(value.replace('\\0', '\0')));
    }
    if (process.platform === 'win32')
      assert.throws(() => parseReference('file.txt:secret'), { code: 'OUTSIDE_ROOT' });
    const link = path.join(cwd, 'linked');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.resolve(context, 'linked/private.txt'), { code: 'OUTSIDE_ROOT' });
    const directory = await store.resolve(context, '.');
    assert.equal(
      (await store.list(context, directory.resourceId)).entries.some((e) => e.name === 'linked'),
      false,
    );
  });

  await t.test('changed, replaced and deleted files never return old grants', async () => {
    const metadata = await store.resolve(context, '中文 文件.md');
    await writeFile(file, 'changed');
    await assert.rejects(store.text(context, metadata.resourceId, metadata.version), {
      code: 'RESOURCE_CHANGED',
    });
    const fresh = await store.resolve(context, '中文 文件.md');
    await unlink(file);
    await assert.rejects(store.text(context, fresh.resourceId, fresh.version), { code: 'ENOENT' });
  });

  await t.test('UTF-16, binary rejection, prefix and giant-line truncation', async () => {
    await writeFile(
      path.join(cwd, 'unicode.txt'),
      Buffer.concat([Buffer.from([255, 254]), Buffer.from('你好\n世界', 'utf16le')]),
    );
    let m = await store.resolve(context, 'unicode.txt');
    assert.equal((await store.text(context, m.resourceId, m.version)).text, '你好\n世界');
    await writeFile(path.join(cwd, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
    m = await store.resolve(context, 'binary.txt');
    await assert.rejects(store.text(context, m.resourceId, m.version), {
      code: 'UNSUPPORTED_TYPE',
    });
    await writeFile(path.join(cwd, 'huge.log'), 'a'.repeat(5 * 1024 * 1024));
    m = await store.resolve(context, 'huge.log');
    const text = await store.text(context, m.resourceId, m.version);
    assert.equal(text.truncated, true);
    assert.equal(text.nextLine, null);
    assert.ok(text.text.length <= 60000);
  });

  await t.test('static raster thumbnails and immutable per-session attachments', async () => {
    const image = await sharp({
      create: { width: 1600, height: 800, channels: 3, background: '#267fd3' },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(cwd, 'design.png'), image);
    const m = await store.resolve(context, 'design.png');
    const thumbnail = await store.image(context, m.resourceId, m.version, true);
    assert.equal(thumbnail.mimeType, 'image/webp');
    assert.equal((await sharp(thumbnail.bytes).metadata()).width, 1024);
    assert.deepEqual((await store.image(context, m.resourceId, m.version, false)).bytes, image);
    const blocks = [{ type: 'image', data: image.toString('base64'), mimeType: 'image/png' }];
    const attachments = await collectAttachments(store, context, blocks);
    assert.equal(attachments[0].snapshot, true);
    assert.deepEqual(await collectAttachments(store, context, blocks), attachments);
    const attachment = await store.resolve(context, attachments[0].reference);
    assert.deepEqual(
      (await store.image(context, attachment.resourceId, attachment.version, false)).bytes,
      image,
    );
    await assert.rejects(
      store.resolve({ ...context, sessionId: 'other' }, attachments[0].reference),
    );
    await writeFile(path.join(cwd, 'invalid.png'), '<svg><script>bad()</script></svg>');
    const invalid = await store.resolve(context, 'invalid.png');
    await assert.rejects(store.image(context, invalid.resourceId, invalid.version, true));
    await writeFile(
      path.join(cwd, 'oversize.png'),
      await sharp({ create: { width: 6000, height: 5000, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    );
    const oversize = await store.resolve(context, 'oversize.png');
    await assert.rejects(store.image(context, oversize.resourceId, oversize.version, true));
  });
  await t.test('snapshot disk budget applies across sessions', async () => {
    const smallStore = new HostResources({
      cacheRoot: path.join(temporary, 'small-cache'),
      snapshotQuotaBytes: 6,
    });
    const a = await smallStore.snapshot(
      context,
      Buffer.from('1234').toString('base64'),
      'image/png',
    );
    const other = { ...context, sessionId: 'session-b' };
    const b = await smallStore.snapshot(other, Buffer.from('5678').toString('base64'), 'image/png');
    await assert.rejects(smallStore.resolve(context, a.reference));
    assert.equal((await smallStore.resolve(other, b.reference)).snapshot, true);
  });
});
