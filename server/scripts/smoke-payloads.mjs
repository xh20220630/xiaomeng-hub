// Generates JSON payload files for the smoke test (avoids shell escaping woes).
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.';
const w = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));

w('pA.json', {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /important' },
  session_id: 'smoke-ignored',
  cwd: 'D:\\cc_project',
});
w('pB.json', {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git push --force origin main' },
  session_id: 'smoke-sess-1',
  cwd: 'C:\\some\\other\\proj',
});
w('pC.json', {
  hook_event_name: 'PermissionRequest',
  tool_name: 'WebFetch',
  tool_input: { url: 'https://example.com' },
  session_id: 'smoke-sess-2',
  cwd: 'C:\\some\\other\\proj',
});
w('pD.json', {
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: {
    file_path: 'C:\\x\\a.txt',
    old_string: 'hello world\nline2\nline3',
    new_string: 'hello brave world\nline2\nline3 changed',
  },
  session_id: 'smoke-sess-3',
  cwd: 'C:\\some\\other\\proj',
});
w('pE.json', {
  hook_event_name: 'Stop',
  session_id: 'smoke-sess-1',
  cwd: 'C:\\some\\other\\proj',
});
console.log('payloads written to', dir);
