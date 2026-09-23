/** 会话设置使用独立表保存，避免更新设置时重写事件历史。 */
import db, { prepare } from '../infrastructure/database.js';
import type { SessionSettings } from '../types/domain.js';

db.exec(
  'CREATE TABLE IF NOT EXISTS agent_session_settings (session_id TEXT PRIMARY KEY, settings TEXT NOT NULL)',
);

/**
 * 读取下一轮设置，尚未设置时保留主机默认行为。
 * @param id 本机会话 ID。
 * @returns 已保存的设置，缺省为空对象。
 */
export function readSettings(id: string): SessionSettings {
  const row = prepare<{
    /** 下一轮或当前主机线程的设置。 */
    settings: string;
  }>('SELECT settings FROM agent_session_settings WHERE session_id=?').get(id);
  return row ? (JSON.parse(row.settings) as SessionSettings) : {};
}

/**
 * 按会话 ID 替换已经校验的完整设置。
 * @param id 本机会话 ID。
 * @param settings 合并后的下一轮设置。
 * @returns 写入完成后返回。
 */
export function writeSettings(id: string, settings: SessionSettings): void {
  prepare(
    'INSERT INTO agent_session_settings VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET settings=excluded.settings',
  ).run(id, JSON.stringify(settings));
}
