// Maps a raw Claude Code hook payload to dashboard semantics.
//
// Research-backed rules:
//  - Correlate by session_id only (no uniform base payload across hooks).
//  - Stop = task finished; SubagentStop = a subagent finished (NOT an approval wait).
//  - "Needs approval" comes ONLY from Notification.notification_type === 'permission_prompt'.
//  - tool_response shape is tool-specific: Bash -> {stdout, exit_code};
//    Write/Edit/MultiEdit -> {success, ...}. So branch on tool_name.

function truncate(str, n) {
  if (typeof str !== 'string') return '';
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

// Returns true (ok), false (failed), or null (unknown). tool_response is
// tool-specific, so check the known success indicators in priority order:
// exit_code (Bash/PowerShell), then success (Write/Edit/MultiEdit).
function toolSucceeded(resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (typeof resp.exit_code === 'number') return resp.exit_code === 0;
  if ('success' in resp) return !!resp.success;
  return null;
}

// Short human hint about what a tool is doing, across tool types.
function describeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return `: ${truncate(input.command, 60)}`;        // Bash / PowerShell
  if (input.file_path) return `: ${input.file_path}`;                  // Read / Write / Edit
  if (input.path) return `: ${input.path}`;                            // Glob / dir tools
  if (input.pattern) return `: ${truncate(input.pattern, 40)}`;        // Grep / Glob
  if (input.url) return `: ${truncate(input.url, 50)}`;                // WebFetch
  if (input.description) return `: ${truncate(input.description, 50)}`; // Task / Agent
  return '';
}

// The raw command / file / pattern a tool is acting on (no prefix), used as the
// chat tool-block title and as the approval command text.
export function rawToolInput(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.command) return truncate(input.command, 200);
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.pattern) return truncate(input.pattern, 80);
  if (input.url) return truncate(input.url, 120);
  // ExitPlanMode: full plan markdown — the app renders it as a 计划 block.
  if (typeof input.plan === 'string' && input.plan.trim()) return input.plan;
  // TodoWrite: pass the structured list through as JSON for the app's TODO card.
  if (Array.isArray(input.todos)) {
    try {
      return JSON.stringify({ todos: input.todos });
    } catch {
      /* not serializable — fall through */
    }
  }
  if (input.description) return truncate(input.description, 80);
  return null;
}

// A short result line for a completed tool (chat tool-block output).
function outputSummary(tool, resp) {
  if (!resp || typeof resp !== 'object') return null;
  if (typeof resp.exit_code === 'number') {
    const head = typeof resp.stdout === 'string' ? resp.stdout.trim().split('\n')[0] : '';
    return resp.exit_code === 0
      ? (head ? `✓ ${truncate(head, 60)}` : '✓ 完成')
      : `✗ exit ${resp.exit_code}`;
  }
  if ('success' in resp) {
    if (typeof resp.additions === 'number' || typeof resp.deletions === 'number') {
      return `+${resp.additions ?? 0}  −${resp.deletions ?? 0}`;
    }
    return resp.success ? '✓ 已应用' : '✗ 失败';
  }
  return null;
}

// status vocabulary used across server + app:
//   running | needs_approval | waiting_input | notification | done | ended
export function deriveState(p) {
  const event = p.hook_event_name || 'Unknown';
  const tool = p.tool_name || null;
  let status = 'running';
  let summary = event;
  let detail = null;
  let ok = null;

  switch (event) {
    case 'SessionStart':
      status = 'running';
      summary = `会话开始${p.cwd ? ` (${p.cwd})` : ''}`;
      break;
    case 'UserPromptSubmit':
      status = 'running';
      summary = '收到新指令，开始任务';
      detail = typeof p.prompt === 'string' ? truncate(p.prompt, 400) : null;
      break;
    case 'PreToolUse':
      status = 'running';
      detail = rawToolInput(p.tool_input);
      summary = `正在执行：${tool ?? '工具'}${detail ? `: ${truncate(detail, 60)}` : ''}`;
      break;
    case 'PostToolUse': {
      ok = toolSucceeded(p.tool_response);
      status = 'running';
      detail = outputSummary(tool, p.tool_response);
      summary = `${tool ?? '工具'} ${ok === false ? '失败 ✗' : '完成 ✓'}`;
      break;
    }
    case 'PostToolUseFailure':
      status = 'running';
      ok = false;
      detail = outputSummary(tool, p.tool_response) || '✗ 失败';
      summary = `${tool ?? '工具'} 失败 ✗`;
      break;
    case 'PermissionRequest':
      // Precise "needs approval" signal — fires when Claude asks to use a tool.
      status = 'needs_approval';
      detail = rawToolInput(p.tool_input);
      summary = `需要审批：${tool ?? '工具'}${detail ? `: ${truncate(detail, 60)}` : ''}`;
      break;
    case 'PermissionDenied':
      status = 'running';
      summary = `权限被拒绝：${tool ?? '工具'}`;
      break;
    case 'TaskCreated':
      status = 'running';
      summary = `新建任务${p.description ? `：${truncate(p.description, 50)}` : ''}`;
      break;
    case 'TaskCompleted':
      status = 'running';
      summary = `任务完成 ✓${p.description ? `：${truncate(p.description, 50)}` : ''}`;
      break;
    case 'Notification': {
      const nt = p.notification_type;
      if (nt === 'permission_prompt') {
        status = 'needs_approval';
        summary = p.message || '需要审批：Claude 正在等待授权';
      } else if (nt === 'idle_prompt') {
        status = 'waiting_input';
        summary = p.message || '等待你的输入';
      } else {
        status = 'notification';
        summary = p.message || '通知';
      }
      break;
    }
    case 'Stop':
      status = 'done';
      summary = '任务完成 ✓';
      break;
    case 'SubagentStop':
      status = 'running';
      summary = '子任务完成';
      break;
    case 'SessionEnd':
      status = 'ended';
      summary = '会话结束';
      break;
    default:
      status = 'running';
      summary = event;
  }

  return { status, tool, summary, detail, ok };
}

// Danger heuristic for the approval gate: destructive / irreversible commands.
const DANGER_RE =
  /(rm\s+-rf|rm\s+-r\b|git\s+push\s+.*(--force|-f)\b|git\s+reset\s+--hard|sudo\b|mkfs|dd\s+if=|chmod\s+-R\s+777|drop\s+table|truncate\s+table|:\(\)\s*\{|>\s*\/dev\/sd)/i;

export function isDangerousCommand(command) {
  return typeof command === 'string' && DANGER_RE.test(command);
}
