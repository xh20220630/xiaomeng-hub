// Posts a realistic sequence of Claude Code hook events to the running server,
// so you can verify the pipeline (and demo the app) without a live Claude task.
//   node scripts/send-sample.mjs            -> http://localhost:4820
//   BASE=http://192.168.1.20:4820 node scripts/send-sample.mjs
const BASE = process.env.BASE || 'http://localhost:4820';
const sid = 'demo-' + Math.random().toString(36).slice(2, 10);
const cwd = 'D:\\cc_project';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  const payload = { session_id: sid, cwd, ...body };
  const r = await fetch(BASE + '/hooks/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log(String(body.hook_event_name).padEnd(16), '->', r.status);
}

const seq = [
  { hook_event_name: 'SessionStart' },
  { hook_event_name: 'UserPromptSubmit', prompt: '帮我重构登录模块' },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'All tests passed', exit_code: 0 } },
  { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth/login.js' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_response: { filePath: 'src/auth/login.js', success: true } },
  { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude 需要运行 git push，请审批' },
  { hook_event_name: 'Stop' },
];

console.log(`Sending ${seq.length} events as session ${sid} -> ${BASE}\n`);
for (const e of seq) {
  await post(e);
  await sleep(800);
}
console.log('\nDone. Check the app / GET /api/sessions.');
