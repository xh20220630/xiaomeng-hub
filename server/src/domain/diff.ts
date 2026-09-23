/** 从工具输入生成受限的文本差异，避免移动端处理过大的变更正文。 */
import type { ToolInput } from '../types/claude.js';
// Minimal unified-diff generator (line-level LCS) — used to fill approval.diff
// for file-edit approvals (audit A3). No deps; good enough for phone review.
//
//   Edit       -> diff(old_string, new_string)
//   MultiEdit  -> concatenated per-edit diffs
//   Write      -> every line of `content` as additions
//   NotebookEdit -> new_source as additions

const MAX_LINES = 400; // cap the LCS table (O(n*m)); beyond this, degrade

/**
 * 统一空值及换行输入，供行级差异计算复用。
 * @param s 当前函数处理的文本或会话记录。
 * @returns 按换行分隔的文本行。
 */
function splitLines(s: unknown) {
  return String(s ?? '').split('\n');
}

/// Plain line-level LCS diff: returns "-old / +new /  ctx" lines.
/**
 * 使用有规模上限的 LCS 生成审阅差异，大文件退化为整块替换。
 * @param oldStr 编辑前的完整文本。
 * @param newStr 编辑后的完整文本。
 * @returns 带增加、删除和上下文前缀的差异文本。
 */
export function unifiedDiff(oldStr: unknown, newStr: unknown) {
  const a = splitLines(oldStr);
  const b = splitLines(newStr);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // degrade: whole-block replace (still reviewable, avoids O(n*m) blowup)
    return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)].join('\n');
  }
  // LCS DP table
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out.join('\n');
}

/**
 * 把完整新内容表示为新增行，用于 Write 和 Notebook 编辑。
 * @param text 用户指令、输出或待处理文本。
 * @returns 只包含新增行的差异文本。
 */
function additionsOnly(text: unknown) {
  return splitLines(text)
    .map((l) => `+${l}`)
    .join('\n');
}

const DIFF_CAP = 20000; // keep approval payloads phone-friendly

/**
 * 限制差异体积，避免审批消息拖慢手机端。
 * @param s 当前函数处理的文本或会话记录。
 * @returns 必要时带截断说明的文本。
 */
function cap(s: string) {
  return s.length > DIFF_CAP ? s.slice(0, DIFF_CAP) + '\n… (diff 截断)' : s;
}

/// Build the approval diff for an edit-tool hook payload. Returns null when the
/// tool/input shape is not an edit we know how to render.
/**
 * 按工具输入形式生成真实差异，而非期待 hook 自带 diff。
 * @param toolName 主机工具名称。
 * @param input 工具提供的结构化输入。
 * @returns 可识别编辑的差异；不支持的输入返回 null。
 */
export function diffForToolInput(toolName: string, input?: ToolInput) {
  if (!input || typeof input !== 'object') return null;
  try {
    switch (toolName) {
      case 'Write':
        return typeof input.content === 'string' ? cap(additionsOnly(input.content)) : null;
      case 'Edit':
        if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
          return cap(unifiedDiff(input.old_string || '', input.new_string || ''));
        }
        return null;
      case 'MultiEdit': {
        if (!Array.isArray(input.edits)) return null;
        const parts = input.edits.map((e, idx) => {
          const d = unifiedDiff(e?.old_string || '', e?.new_string || '');
          return input.edits!.length > 1 ? `@@ 编辑 ${idx + 1}/${input.edits!.length} @@\n${d}` : d;
        });
        return cap(parts.join('\n'));
      }
      case 'NotebookEdit':
        return typeof input.new_source === 'string' ? cap(additionsOnly(input.new_source)) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
