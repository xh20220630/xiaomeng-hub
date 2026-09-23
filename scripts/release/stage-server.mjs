import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkVersions, root } from './version.mjs';

const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination) throw new Error('Usage: stage-server.mjs <new-output-directory>');
const manifest = await checkVersions();
const server = path.join(root, 'server');
const runtimeScripts = {
  start: 'src/index.js', host: 'scripts/start-host.js', sample: 'scripts/send-sample.js',
  'agent:demo': 'scripts/demo-agent.js', 'agent:codex': 'scripts/codex-agent.js', 'agent:connect': 'scripts/connect-hub.js',
};
for (const filename of Object.values(runtimeScripts)) {
  if (!(await stat(path.join(server, 'dist', filename))).isFile()) throw new Error(`Missing compiled entry: ${filename}`);
}
await mkdir(path.dirname(destination), { recursive: true });
await mkdir(destination);
for (const name of ['dist/src', 'dist/scripts', 'public', 'package-lock.json']) {
  await cp(path.join(server, name), path.join(destination, name), { recursive: true });
}
const pkg = JSON.parse(await readFile(path.join(server, 'package.json'), 'utf8'));
// Production packages run the compiled entry points without installing the TypeScript toolchain.
pkg.scripts = Object.fromEntries(Object.entries(runtimeScripts).map(([name, filename]) => [name, `node --disable-warning=ExperimentalWarning dist/${filename}`]));
await writeFile(path.join(destination, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await writeFile(path.join(destination, 'version.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(path.join(root, 'docs/SERVER_DISTRIBUTION.md'), path.join(destination, 'README.md'));
await mkdir(path.join(destination, 'docs'));
for (const name of ['PAIRING.md', 'CODEX_SETUP.md', 'AGENT_PROTOCOL.md']) {
  await cp(path.join(root, 'docs', name), path.join(destination, 'docs', name));
}
console.log(destination);
