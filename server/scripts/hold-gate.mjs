// Holds a /hooks/gate request (simulates Claude Code asking to run a dangerous
// command and waiting for phone approval). Prints the decision when resolved.
//   node scripts/hold-gate.mjs
const BASE = process.env.BASE || 'http://localhost:4820';
const sid = process.env.SID || 's-api';
const cwd = process.env.CWD_ARG || 'D:\\demo\\api-server';
const cmd = process.env.CMD_ARG || 'git push --force origin main';

const body = JSON.stringify({
  session_id: sid,
  cwd,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: cmd },
});

console.log(`[hold-gate] POST ${BASE}/hooks/gate  (${cmd})`);
fetch(BASE + '/hooks/gate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
})
  .then((r) => r.json())
  .then((j) => console.log('GATE_DECISION=' + JSON.stringify(j)))
  .catch((e) => console.log('ERR ' + e.message));
