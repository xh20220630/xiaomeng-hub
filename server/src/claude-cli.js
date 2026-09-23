// Claude Code CLI bridge: really runs `claude` headlessly to continue (resume)
// or start sessions, streaming stream-json output back over the WS.
//
// Audit A8/A9/A10 rules encoded here:
//  - NO shell:true. The user prompt goes through STDIN, never the command line
//    (no quoting/injection issues, no length limits).
//  - Windows executable resolution: try 'claude.cmd', then 'claude'; both fail
//    on npm-shim installs under Node >= 21.7 (spawning .cmd without a shell is
//    blocked with EINVAL — CVE-2024-27980 mitigation), so the last candidate is
//    `cmd.exe /d /s /c claude <args>`. That is NOT shell:true for the payload:
//    argv contains flags, UUIDs and allowlisted model settings; free-form
//    prompts stay on stdin and are never parsed by cmd.exe.
//  - Per-session serial queue: one child per session at a time (no parallel
//    spawns fighting over the same transcript).
//  - children map (sessionId -> child) supports session.control 'stop' (A9).
//  - Token-level streaming via --include-partial-messages (content_block_delta).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { sessionInfo } from './claude-data.js';
import { broadcast } from './ws.js';
import { sessionSettings } from './agent-settings.js';

const children = new Map(); // sessionId -> ChildProcess
const queues = new Map(); // sessionId -> tail Promise (serial queue)

const BASE_ARGS = ['--output-format', 'stream-json', '--include-partial-messages', '--verbose'];

function spawnOnce(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { ...opts, shell: false });
    } catch (e) {
      return reject(e); // EINVAL for .cmd on modern Node throws synchronously
    }
    const onErr = (e) => reject(e);
    child.once('error', onErr);
    child.once('spawn', () => {
      child.removeListener('error', onErr);
      resolve(child);
    });
  });
}

async function spawnClaude(args, cwd) {
  const candidates =
    process.platform === 'win32'
      ? [
          ['claude.cmd', args],
          ['claude', args],
          ['cmd.exe', ['/d', '/s', '/c', 'claude', ...args]],
        ]
      : [['claude', args]];
  let lastErr = null;
  for (const [cmd, a] of candidates) {
    try {
      return await spawnOnce(cmd, a, { cwd, windowsHide: true });
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EINVAL' || e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'UNKNOWN')) {
        continue; // try next candidate
      }
      throw e;
    }
  }
  throw lastErr || new Error('claude CLI not found');
}

// Extract streaming text; once real token deltas are seen, ignore the full
// `assistant` message events (they duplicate what the deltas already carried).
function makeExtractor() {
  let sawDelta = false;
  return (ev) => {
    if (!ev || typeof ev !== 'object') return '';
    if (ev.type === 'stream_event') {
      const e = ev.event || {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        sawDelta = true;
        return e.delta.text || '';
      }
      return '';
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      sawDelta = true;
      return ev.delta.text || '';
    }
    if (ev.type === 'assistant' && !sawDelta && ev.message?.content) {
      const c = ev.message.content;
      if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      if (typeof c === 'string') return c;
    }
    return '';
  };
}

function enqueue(key, task) {
  const tail = queues.get(key) || Promise.resolve();
  const run = tail.then(task, task); // run regardless of previous outcome
  queues.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/// Core runner. Resolves { ok, code?, aborted?, text, sessionId, error? }.
async function runClaude({ args, cwd, text, requestKey, onInit, onDelta }) {
  let child;
  try {
    child = await spawnClaude(args, cwd || process.cwd());
  } catch (e) {
    return { ok: false, text: '', sessionId: requestKey || null, error: `无法启动 claude CLI: ${e.message}` };
  }
  const keys = new Set();
  const track = (id) => {
    if (id) {
      keys.add(id);
      children.set(id, child);
    }
  };
  track(requestKey);
  try {
    child.stdin.write(String(text));
    child.stdin.end();
  } catch {
    /* child may have died instantly; close handler reports it */
  }

  const extract = makeExtractor();
  const rl = readline.createInterface({ input: child.stdout });
  let acc = '';
  let stderr = '';
  let initId = null;
  child.stderr.on('data', (d) => {
    if (stderr.length < 4096) stderr += d;
  });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // ignore non-JSON lines
    }
    if (!initId && ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
      initId = ev.session_id;
      track(initId); // --resume forks a NEW session id; track both for 'stop'
      try {
        onInit?.(initId);
      } catch {
        /* listener error */
      }
    }
    const chunk = extract(ev);
    if (chunk) {
      acc += chunk;
      try {
        onDelta?.(acc);
      } catch {
        /* listener error */
      }
    }
  });

  return await new Promise((resolve) => {
    child.on('error', (e) =>
      resolve({ ok: false, text: acc, sessionId: initId || requestKey || null, error: e.message }),
    );
    child.on('close', (code) => {
      for (const k of keys) if (children.get(k) === child) children.delete(k);
      const aborted = !!child.__aborted;
      const ok = code === 0 && !aborted;
      resolve({
        ok,
        code,
        aborted,
        text: acc,
        sessionId: initId || requestKey || null,
        error: ok ? null : aborted ? '已停止' : stderr.trim().slice(0, 400) || `claude 退出码 ${code}`,
      });
    });
  });
}

/// Resume an existing session with a new prompt (serialized per session).
export function sendMessageStream(sessionId, cwd, text, { onDelta, onDone } = {}) {
  return enqueue(sessionId, async () => {
    const settings = sessionSettings(sessionId);
    const extra = [];
    if (settings.model) extra.push('--model', settings.model);
    if (settings.reasoningEffort) extra.push('--effort', settings.reasoningEffort);
    if (settings.mode === 'plan') extra.push('--permission-mode', 'plan');
    const r = await runClaude({
      args: ['--resume', sessionId, '-p', ...BASE_ARGS, ...extra],
      cwd,
      text,
      requestKey: sessionId,
      onDelta,
    });
    try {
      onDone?.(r.text || '');
    } catch {
      /* ignore */
    }
    return r;
  });
}

/// Start a brand-new session in `cwd` (audit A10). onInit fires with the real
/// session_id as soon as the CLI's system/init event arrives.
export function startSession(cwd, text, { onInit, onDelta } = {}) {
  return runClaude({ args: ['-p', ...BASE_ARGS], cwd, text, onInit, onDelta });
}

/// Full message.send flow shared by WS and REST: resolves cwd, broadcasts
/// assistant.start/.delta/.done (done carries ok + error per the contract).
export async function sendToSession(sessionId, text) {
  if (!text || !String(text).trim()) {
    broadcast({ type: 'assistant.done', sessionId, ok: false, error: '空消息' });
    return { ok: false, error: 'empty_text' };
  }
  let info = null;
  try {
    info = await sessionInfo(sessionId);
  } catch {
    /* cwd stays unknown; claude may still resolve the session itself */
  }
  console.log(`[send] resume ${String(sessionId).slice(0, 8)} (cwd=${info?.cwd || '?'}) len=${String(text).length}`);
  broadcast({ type: 'assistant.start', sessionId });
  const r = await sendMessageStream(sessionId, info?.cwd, text, {
    onDelta: (acc) => broadcast({ type: 'assistant.delta', sessionId, text: acc }),
  });
  if (!r.aborted) {
    // aborted -> stopSession already broadcast its own done frame
    broadcast({ type: 'assistant.done', sessionId, ok: !!r.ok, error: r.ok ? null : r.error || '发送失败' });
  }
  if (!r.ok && !r.aborted) console.error('[send] failed:', r.error);
  return r;
}

/// session.control action:'stop' (audit A9). Kills the whole child tree on
/// Windows via taskkill. Returns false when no child is running for the id.
export function stopSession(sessionId) {
  const child = children.get(sessionId);
  if (!child) return false;
  child.__aborted = true;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) {
    console.error('[stop] kill failed:', e.message);
  }
  console.log(`[stop] session ${String(sessionId).slice(0, 8)} pid=${child.pid}`);
  broadcast({ type: 'assistant.done', sessionId, ok: false, error: '已停止', aborted: true });
  return true;
}
