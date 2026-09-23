import db from './db.js';

db.exec('CREATE TABLE IF NOT EXISTS agent_session_settings (session_id TEXT PRIMARY KEY, settings TEXT NOT NULL)');

export function sessionSettings(id) {
  const row = db.prepare('SELECT settings FROM agent_session_settings WHERE session_id=?').get(id);
  return row ? JSON.parse(row.settings) : {};
}

export function saveSessionSettings(id, patch) {
  const settings = { ...sessionSettings(id), ...patch };
  db.prepare('INSERT INTO agent_session_settings VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET settings=excluded.settings').run(id, JSON.stringify(settings));
  return settings;
}

export function claudeCatalog() {
  const ids = (process.env.CLAUDE_MODELS || 'fable,opus,sonnet,haiku').split(',').map((id) => id.trim()).filter((id) => /^[a-zA-Z0-9._:/-]+$/.test(id));
  return { models: ids.map((id) => ({ id, name: id, description: '由宿主机 Claude CLI 解析模型名称；可用性取决于主机账户',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] })),
    modes: [{ id: 'default', name: '执行' }, { id: 'plan', name: '计划' }], actions: [], settingsApply: 'next_turn', controlTransport: 'claude-cli' };
}
