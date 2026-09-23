/** 开发与运维入口：发送一组可重复的 hook 示例。 */
import type { HookPayload } from '../src/types/claude.js';
// Posts a realistic sequence of Claude Code hook events to the running server,
// so you can verify the pipeline (and demo the app) without a live Claude task.
//   npx tsx scripts/send-sample.ts            -> http://localhost:4820
//   BASE=http://192.168.1.20:4820 npx tsx scripts/send-sample.ts
const BASE = process.env.BASE || 'http://localhost:4820';
const sid = 'demo-' + Math.random().toString(36).slice(2, 10);
const cwd = 'D:\\cc_project';

/**
 * 为演示和重试提供有界等待，不阻塞进程事件循环。
 * @param ms 需要等待的毫秒数。
 * @returns 指定间隔后完成的 Promise。
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 发送演示 hook 或 gate 请求，用于人工验证现有接口。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns 操作完成的异步信号。
 */
async function post(body: HookPayload) {
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
  {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { stdout: 'All tests passed', exit_code: 0 },
  },
  {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'src/auth/login.js' },
  },
  {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_response: { filePath: 'src/auth/login.js', success: true },
  },
  {
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Claude 需要运行 git push，请审批',
  },
  { hook_event_name: 'Stop' },
];

console.log(`Sending ${seq.length} events as session ${sid} -> ${BASE}\n`);
for (const e of seq) {
  await post(e);
  await sleep(800);
}
console.log('\nDone. Check the app / GET /api/sessions.');
