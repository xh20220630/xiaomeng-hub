/** 集中管理 SQLite 连接和基础表结构，业务查询由仓储层封装。 */
// SQLite persistence using Node's built-in node:sqlite (no native build needed).
// Tables: sessions (latest state per session), events (append-only timeline),
// approvals (remote-approval requests + their resolution).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { join } from 'node:path';
import { SERVER_ROOT } from '../config/paths.js';

const DB_PATH = process.env.DB_PATH || join(SERVER_ROOT, 'data.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    cwd         TEXT,
    status      TEXT,
    last_event  TEXT,
    last_tool   TEXT,
    summary     TEXT,
    started_at  INTEGER,
    updated_at  INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT,
    hook_event_name TEXT,
    tool_name       TEXT,
    status          TEXT,
    summary         TEXT,
    detail          TEXT,
    ok              INTEGER,
    raw_json        TEXT,
    created_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
  CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    session_id  TEXT,
    project_id  TEXT,
    kind        TEXT,
    title       TEXT,
    command     TEXT,
    file_path   TEXT,
    diff        TEXT,
    risk        TEXT,
    options     TEXT,
    status      TEXT,
    created_at  INTEGER,
    expires_at  INTEGER,
    resolved_at INTEGER,
    decided_by  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
`);

export default db;

/**
 * 为已知表结构提供类型化查询；JSON 列仍由仓储或领域映射器解码。
 * @param sql 仓储层定义的固定 SQL，动态值必须通过绑定参数传入。
 * @param database 可注入的连接，便于隔离配对测试数据库。
 * @returns 保留 SQLite 写入结果、提供行类型的预编译查询。
 */
export function prepare<Row = Record<string, unknown>>(sql: string, database = db) {
  const statement = database.prepare(sql);
  return {
    /**
     * 读取首行，允许调用方明确处理记录不存在的情况。
     * @param values 按 SQL 占位符顺序绑定的值。
     * @returns 查询首行；未匹配时为 undefined。
     */
    get: (...values: SQLInputValue[]) => statement.get(...values) as Row | undefined,
    /**
     * 读取全部匹配行，行结构由拥有该查询的仓储声明。
     * @param values 按 SQL 占位符顺序绑定的值。
     * @returns 匹配的行列表，未匹配时为空数组。
     */
    all: (...values: SQLInputValue[]) => statement.all(...values) as Row[],
    /**
     * 执行参数化写入，避免将业务输入拼入 SQL。
     * @param values 按 SQL 占位符顺序绑定的值。
     * @returns SQLite 变更行数和最后插入行标识。
     */
    run: (...values: SQLInputValue[]) => statement.run(...values),
  };
}
