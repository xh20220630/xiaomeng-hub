import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkVersions } from './version.mjs';

const directory = process.argv[2] && path.resolve(process.argv[2]);
if (!directory) throw new Error('Usage: artifact-manifest.mjs <artifact-directory>');
const manifest = await checkVersions();
const revision = process.env.RELEASE_SHA;
if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('RELEASE_SHA must identify the full release commit');
const prefix = `xiaomeng-server-v${manifest.version}`;
const expected = [`xiaomeng-v${manifest.version}-android.apk`, `${prefix}.tar.gz`, `${prefix}.zip`].sort();
const names = (await readdir(directory)).sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Missing or unexpected release assets');
const metadata = { ...manifest, commit: revision, runId: process.env.GITHUB_RUN_ID || null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || null, artifacts: [] };
const checksums = [];
for (const name of names) {
  const content = await readFile(path.join(directory, name));
  if (!content.length) throw new Error(`Empty release artifact: ${name}`);
  const sha256 = createHash('sha256').update(content).digest('hex');
  metadata.artifacts.push({ name, bytes: content.length, sha256 });
  checksums.push(`${sha256}  ${name}`);
}
const json = `${JSON.stringify(metadata, null, 2)}\n`;
await writeFile(path.join(directory, 'release-manifest.json'), json);
checksums.push(`${createHash('sha256').update(json).digest('hex')}  release-manifest.json`);
await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
