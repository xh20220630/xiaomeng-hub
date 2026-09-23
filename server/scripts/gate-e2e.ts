/** 开发与运维入口：验证 hook 审批的端到端行为。 */
// E2E test of the remote-approval gate against the LIVE 4820 instance.
// 1) ignored cwd -> instant {}   2) other cwd -> HOLD -> approve via REST ->
// gate returns PermissionRequest allow JSON. Prints every step.
const BASE = 'http://127.0.0.1:4820';

/**
 * 发送演示 hook 或 gate 请求，用于人工验证现有接口。
 * @param path 当前操作的文件路径或相对请求路径。
 * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
 * @returns HTTP 结果或发送完成信号。
 */
async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.text() };
}

// --- 1) ignored cwd (cc_project) must pass through instantly
let t = Date.now();
const ign = await post('/hooks/gate', {
  hook_event_name: 'PermissionRequest',
  session_id: 'e2e-ignored',
  cwd: 'D:\\cc_project\\whatever',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build' },
});
console.log(`[1] ignored-cwd: ${ign.status} ${ign.body} in ${Date.now() - t}ms  (expect {} fast)`);

// --- 2) non-ignored cwd holds; approve from "the phone" (REST) after 1s
t = Date.now();
const heldPromise = post('/hooks/gate', {
  hook_event_name: 'PermissionRequest',
  session_id: 'e2e-gate',
  cwd: 'D:\\proj_x',
  tool_name: 'Bash',
  tool_input: { command: 'git push --force origin main' },
});

await new Promise((r) => setTimeout(r, 1000));
const pending = await (await fetch(BASE + '/api/approvals')).json();
console.log(
  `[2] pending after 1s: ${pending.length}`,
  pending[0] && {
    kind: pending[0].kind,
    risk: pending[0].risk,
    cmd: pending[0].command,
    hasExpiresAt: !!pending[0].expiresAt,
  },
);
if (!pending.length) {
  console.log('FAIL: gate did not create/hold an approval');
  process.exit(1);
}
const ap = pending[0];
const resp = await post(`/api/approvals/${ap.approvalId}`, {
  decision: 'approve',
  scope: 'always',
});
console.log(`[3] respond: ${resp.status} ${resp.body}`);
const replay = await post(`/api/approvals/${ap.approvalId}`, { decision: 'reject', scope: 'once' });
console.log(
  `[4] idempotent replay: ${replay.status} ${replay.body}  (expect already:true, status approved)`,
);

const held = await heldPromise;
console.log(`[5] gate released after ${Date.now() - t}ms: ${held.status} ${held.body}`);
const pendingAfter = await (await fetch(BASE + '/api/approvals')).json();
console.log(`[6] pending after resolve: ${pendingAfter.length} (expect 0)`);
