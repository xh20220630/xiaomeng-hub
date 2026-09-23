// Seeds a realistic multi-project demo for F1/F2 (monitoring events only).
// The pending-approval project is created separately by holding a /hooks/gate
// request (see verify steps). Run: node scripts/seed-demo.mjs
const BASE = process.env.BASE || 'http://localhost:4820';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p) {
  await fetch(BASE + '/hooks/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  await sleep(60);
}

async function seq(sid, cwd, events) {
  for (const e of events) await post({ session_id: sid, cwd, ...e });
}

// running projects
await seq('s-web', 'D:\\demo\\web-dashboard', [
  { hook_event_name: 'SessionStart' },
  { hook_event_name: 'UserPromptSubmit', prompt: '给登录按钮加一个加载态' },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run dev' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'ready in 320 ms', exit_code: 0 } },
  { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/App.tsx' } },
]);

await seq('s-ml', 'D:\\demo\\ml-trainer', [
  { hook_event_name: 'SessionStart' },
  { hook_event_name: 'UserPromptSubmit', prompt: '跑一遍单元测试' },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pytest -q tests/' } },
]);

// done projects
for (const [sid, cwd, result] of [
  ['s-data', 'D:\\demo\\data-pipeline', '7 任务'],
  ['s-docs', 'D:\\demo\\docs-site', '已部署'],
  ['s-cli', 'D:\\demo\\cli-tool', '已合并'],
]) {
  await seq(sid, cwd, [
    { hook_event_name: 'SessionStart' },
    { hook_event_name: 'UserPromptSubmit', prompt: '完成今天的任务' },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: result, exit_code: 0 } },
    { hook_event_name: 'Stop' },
  ]);
}

// api-server: lead-up to an approval (the gate request adds the needs_approval)
await seq('s-api', 'D:\\demo\\api-server', [
  { hook_event_name: 'SessionStart' },
  { hook_event_name: 'UserPromptSubmit', prompt: '继续，把它部署到 staging' },
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: '24 passed', exit_code: 0 } },
  { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'deploy.yml' } },
  { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_response: { success: true, additions: 6, deletions: 1 } },
]);

console.log('seeded demo projects:', BASE);
