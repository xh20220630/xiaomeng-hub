import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { root } from './version.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-package-test-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const write = async (name, contents) => {
    const filename = path.join(directory, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, contents);
  };
  await cp(path.join(root, 'scripts/release'), path.join(directory, 'scripts/release'), { recursive: true });
  await write('version.json', JSON.stringify({ version: '2.0.3', buildNumber: 18 }));
  await write('app/pubspec.yaml', 'version: 2.0.3+18\n');
  await write('server/package.json', JSON.stringify({ name: 'test-server', version: '2.0.3', type: 'module',
    main: 'dist/src/index.js', scripts: { prestart: 'tsc', start: 'tsx src/index.ts' } }));
  await write('server/package-lock.json', JSON.stringify({ version: '2.0.3', packages: { '': { version: '2.0.3' } } }));
  const run = (name, args = [], env = {}) => execFileSync(process.execPath, [path.join(directory, 'scripts/release', name), ...args], {
    cwd: directory, env: { ...process.env, GITHUB_OUTPUT: '', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { directory, write, run };
}

test('server packaging excludes private state and runs without build lifecycle hooks', async (t) => {
  const { directory, write, run } = await fixture(t);
  for (const entry of ['src/index.js', 'scripts/start-host.js', 'scripts/send-sample.js', 'scripts/demo-agent.js', 'scripts/codex-agent.js', 'scripts/connect-hub.js']) {
    await write(`server/dist/${entry}`, 'export {};\n');
  }
  await write('server/public/pair/index.html', '<html>Pair</html>');
  for (const name of ['SERVER_DISTRIBUTION.md', 'PAIRING.md', 'CODEX_SETUP.md', 'AGENT_PROTOCOL.md']) await write(`docs/${name}`, '# Documentation');
  for (const name of ['data.db', '.env', 'server.log', 'node_modules/private.txt', 'dist/test/fixture.js']) await write(`server/${name}`, 'private');
  const staged = path.join(directory, 'output');
  run('stage-server.mjs', [staged]);
  const files = (await readdir(staged, { recursive: true })).map((name) => name.replaceAll('\\', '/'));
  assert.ok(files.includes('dist/src/index.js'));
  assert.ok(files.includes('public/pair/index.html'));
  for (const name of ['data.db', '.env', 'server.log', 'node_modules', 'dist/test']) assert.ok(!files.includes(name), name);
  const pkg = JSON.parse(await readFile(path.join(staged, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prestart, undefined);
  assert.equal(pkg.scripts.prehost, undefined);
  assert.match(pkg.scripts['agent:codex'], /node .*dist\/scripts\/codex-agent\.js$/);
  assert.throws(() => run('stage-server.mjs', [staged]), /EEXIST/);
});

test('artifact manifest binds exact assets to their commit and detects missing or extra files', async (t) => {
  const { directory, write, run } = await fixture(t);
  const names = ['xiaomeng-v2.0.3-android.apk', 'xiaomeng-server-v2.0.3.zip', 'xiaomeng-server-v2.0.3.tar.gz'];
  const output = path.join(directory, 'artifacts');
  for (const name of names) await write(`artifacts/${name}`, `contents:${name}`);
  assert.throws(() => run('artifact-manifest.mjs', [output], { RELEASE_SHA: 'invalid' }), /full release commit/);
  const env = { RELEASE_SHA: 'a'.repeat(40) };
  await write('artifacts/unexpected.txt', 'unexpected');
  assert.throws(() => run('artifact-manifest.mjs', [output], env), /unexpected release assets/);
  await rm(path.join(output, 'unexpected.txt'));
  run('artifact-manifest.mjs', [output], env);
  const manifest = JSON.parse(await readFile(path.join(output, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.commit, env.RELEASE_SHA);
  assert.equal(manifest.buildNumber, 18);
  assert.equal(manifest.artifacts.length, 3);
  for (const artifact of manifest.artifacts) {
    assert.equal(artifact.sha256, createHash('sha256').update(`contents:${artifact.name}`).digest('hex'));
  }
  const checksums = await readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(checksums.trim().split('\n').length, 4);
  assert.match(checksums, /release-manifest\.json/);
});
