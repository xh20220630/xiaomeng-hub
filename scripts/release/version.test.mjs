import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertProgress, checkVersions, compareVersions, parseVersion, syncVersions, validateManifest } from './version.mjs';

test('release ordering follows numeric SemVer and prerelease promotion', () => {
  const ordered = ['2.0.2', '2.0.3-alpha.1', '2.0.3-beta.0', '2.0.3-rc.2', '2.0.3-rc.10', '2.0.3', '2.0.10', '2.1.0', '3.0.0'];
  for (let i = 1; i < ordered.length; i++) assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1);
  assert.equal(compareVersions('2.0.3', '2.0.3'), 0);
  for (const invalid of ['v2.0.3', '02.0.3', '2.0', '2.0.3+18', '2.0.3-rc.01', '2.0.3-rc', '2.0.3\n', '2.0.3\nrun=bad']) {
    assert.throws(() => parseVersion(invalid));
  }
});

test('every release, including promotion, requires a higher Android build', () => {
  const previous = { version: '2.1.0-rc.1', buildNumber: 18 };
  assert.doesNotThrow(() => assertProgress(previous, { version: '2.1.0', buildNumber: 19 }));
  assert.doesNotThrow(() => assertProgress(previous, previous, true));
  for (const next of [previous, { version: '2.1.0', buildNumber: 18 }, { version: '2.0.9', buildNumber: 19 }, { ...previous, buildNumber: 19 }]) {
    assert.throws(() => assertProgress(previous, next));
  }
  for (const buildNumber of [0, -1, 1.1, 2100000001, '18']) {
    assert.throws(() => validateManifest({ version: '2.0.3', buildNumber }));
  }
});

test('sync updates only release versions and check detects drift in every consumer', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'xiaomeng-version-'));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'server'));
  await mkdir(path.join(directory, 'app'));
  await writeFile(path.join(directory, 'version.json'), JSON.stringify({ version: '2.1.0-rc.1', buildNumber: 18 }));
  await writeFile(path.join(directory, 'server/package.json'), JSON.stringify({ version: '0.1.0', scripts: { build: 'tsc' } }));
  await writeFile(path.join(directory, 'server/package-lock.json'), JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' }, 'node_modules/example': { version: '1.0.0' } } }));
  await writeFile(path.join(directory, 'app/pubspec.yaml'), 'name: test\r\nversion: 0.1.0+1\r\nenvironment:\r\n  sdk: ^3.12.0\r\n');
  await assert.rejects(checkVersions(directory), /disagree/);
  await syncVersions(directory);
  assert.equal((await checkVersions(directory)).buildNumber, 18);
  const read = async (name) => readFile(path.join(directory, name), 'utf8');
  assert.equal(JSON.parse(await read('server/package.json')).scripts.build, 'tsc');
  assert.equal(JSON.parse(await read('server/package-lock.json')).packages['node_modules/example'].version, '1.0.0');
  assert.equal(await read('app/pubspec.yaml'), 'name: test\r\nversion: 2.1.0-rc.1+18\r\nenvironment:\r\n  sdk: ^3.12.0\r\n');
  for (const filename of ['server/package.json', 'server/package-lock.json', 'app/pubspec.yaml']) {
    const original = await read(filename);
    await writeFile(path.join(directory, filename), original.replace('2.1.0-rc.1', '2.1.0'));
    await assert.rejects(checkVersions(directory), /disagree/);
    await writeFile(path.join(directory, filename), original);
  }
});
