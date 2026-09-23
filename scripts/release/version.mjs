import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../..', import.meta.url));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

export function parseVersion(version) {
  const match = typeof version === 'string' && version.match(versionPattern);
  if (!match || match[0] !== version) throw new Error('Version must be X.Y.Z or X.Y.Z-(alpha|beta|rc).N');
  const numbers = [match[1], match[2], match[3], match[5] || '0'].map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number))) throw new Error('Version is too large');
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], channel: match[4] || '', sequence: numbers[3] };
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (const part of ['major', 'minor', 'patch']) {
    if (a[part] !== b[part]) return Math.sign(a[part] - b[part]);
  }
  const channels = ['alpha', 'beta', 'rc', ''];
  return Math.sign(channels.indexOf(a.channel) - channels.indexOf(b.channel)) || Math.sign(a.sequence - b.sequence);
}

export function validateManifest(manifest) {
  parseVersion(manifest.version);
  if (!Number.isInteger(manifest.buildNumber) || manifest.buildNumber < 1 || manifest.buildNumber > 2100000000) {
    throw new Error('buildNumber must be an integer between 1 and 2100000000');
  }
  return manifest;
}

export function assertProgress(previous, next, allowUnchanged = false) {
  validateManifest(previous);
  validateManifest(next);
  if (allowUnchanged && previous.version === next.version && previous.buildNumber === next.buildNumber) return;
  if (compareVersions(next.version, previous.version) <= 0 || next.buildNumber <= previous.buildNumber) {
    throw new Error('A new release must increase both version and buildNumber');
  }
}

export async function readManifest(directory = root) {
  return validateManifest(JSON.parse(await readFile(path.join(directory, 'version.json'), 'utf8')));
}

export async function checkVersions(directory = root) {
  const manifest = await readManifest(directory);
  const readJson = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  const pkg = await readJson('server/package.json');
  const lock = await readJson('server/package-lock.json');
  const pubspec = await readFile(path.join(directory, 'app/pubspec.yaml'), 'utf8');
  const flutterVersion = pubspec.match(/^version:\s*(\S+)\s*$/m)?.[1];
  if ([pkg.version, lock.version, lock.packages?.['']?.version].some((version) => version !== manifest.version)
      || flutterVersion !== `${manifest.version}+${manifest.buildNumber}`) {
    throw new Error('Version files disagree. Run node scripts/release/version.mjs sync');
  }
  return manifest;
}

export async function syncVersions(directory = root) {
  const manifest = await readManifest(directory);
  const files = ['server/package.json', 'server/package-lock.json'];
  for (const name of files) {
    const filename = path.join(directory, name);
    const original = await readFile(filename, 'utf8');
    const data = JSON.parse(original);
    data.version = manifest.version;
    if (name.endsWith('package-lock.json')) data.packages[''].version = manifest.version;
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    await writeFile(filename, `${JSON.stringify(data, null, 2)}\n`.replaceAll('\n', newline));
  }
  const filename = path.join(directory, 'app/pubspec.yaml');
  const pubspec = await readFile(filename, 'utf8');
  if (!/^version:.*$/m.test(pubspec)) throw new Error('pubspec.yaml has no version field');
  await writeFile(filename, pubspec.replace(/^version:[^\r\n]*/m, `version: ${manifest.version}+${manifest.buildNumber}`));
  return checkVersions(directory);
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function manifestAt(ref) {
  git('rev-parse', '--verify', `${ref}^{commit}`);
  if (!git('ls-tree', '--name-only', ref, '--', 'version.json')) return null;
  return validateManifest(JSON.parse(git('show', `${ref}:version.json`)));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'sync' && args.length === 0) {
    await syncVersions();
  } else if (command === 'set' && args.length === 1) {
    const previous = await checkVersions();
    const parsed = parseVersion(previous.version);
    const requested = args[0];
    const bumps = { patch: `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`,
      minor: `${parsed.major}.${parsed.minor + 1}.0`, major: `${parsed.major + 1}.0.0` };
    if (parsed.channel && Object.hasOwn(bumps, requested)) throw new Error('Use an explicit version to promote a prerelease');
    const next = { version: bumps[requested] || requested, buildNumber: previous.buildNumber + 1 };
    assertProgress(previous, next);
    await writeFile(path.join(root, 'version.json'), `${JSON.stringify(next, null, 2)}\n`);
    await syncVersions();
  } else if (command === 'check') {
    const manifest = await checkVersions();
    for (let i = 0; i < args.length; i++) {
      const option = args[i];
      if (option === '--base' && args[i + 1]) {
        const previous = manifestAt(args[++i]);
        if (previous) assertProgress(previous, manifest, true);
      } else if (option === '--tag' && args[i + 1]) {
        if (args[++i] !== `v${manifest.version}`) throw new Error('Tag must match version.json exactly');
        const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
        if (!changelog.split(/\r?\n/).some((line) => line.startsWith(`## [${manifest.version}] - `))) {
          throw new Error('Add a dated CHANGELOG.md entry before releasing');
        }
      } else if (option === '--released') {
        for (const tag of git('tag', '--list', 'v*').split('\n').filter(Boolean)) {
          if (tag === `v${manifest.version}` || !versionPattern.test(tag.slice(1))) continue;
          if (compareVersions(manifest.version, tag.slice(1)) <= 0) throw new Error(`Version must exceed existing tag ${tag}`);
          const previous = manifestAt(tag);
          if (previous) assertProgress(previous, manifest);
        }
      } else throw new Error(`Unknown or incomplete option: ${option}`);
    }
  } else throw new Error('Usage: version.mjs sync | set <patch|minor|major|version> | check [--base ref] [--tag tag] [--released]');
  const manifest = await checkVersions();
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${manifest.version}\nbuild_number=${manifest.buildNumber}\nprerelease=${Boolean(parseVersion(manifest.version).channel)}\n`);
  }
  console.log(`Version ${manifest.version}, Android build ${manifest.buildNumber}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
