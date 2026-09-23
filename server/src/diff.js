// Minimal unified-diff generator (line-level LCS) — used to fill approval.diff
// for file-edit approvals (audit A3). No deps; good enough for phone review.
//
//   Edit       -> diff(old_string, new_string)
//   MultiEdit  -> concatenated per-edit diffs
//   Write      -> every line of `content` as additions
//   NotebookEdit -> new_source as additions

const MAX_LINES = 400; // cap the LCS table (O(n*m)); beyond this, degrade

function splitLines(s) {
  return String(s ?? '').split('\n');
}

/// Plain line-level LCS diff: returns "-old / +new /  ctx" lines.
export function unifiedDiff(oldStr, newStr) {
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

function additionsOnly(text) {
  return splitLines(text)
    .map((l) => `+${l}`)
    .join('\n');
}

const DIFF_CAP = 20000; // keep approval payloads phone-friendly

function cap(s) {
  return s.length > DIFF_CAP ? s.slice(0, DIFF_CAP) + '\n… (diff 截断)' : s;
}

/// Build the approval diff for an edit-tool hook payload. Returns null when the
/// tool/input shape is not an edit we know how to render.
export function diffForToolInput(toolName, input) {
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
          return input.edits.length > 1 ? `@@ 编辑 ${idx + 1}/${input.edits.length} @@\n${d}` : d;
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
