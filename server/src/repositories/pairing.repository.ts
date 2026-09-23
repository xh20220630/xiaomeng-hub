/** 设备凭据仓储，只保存令牌散列并按管理员身份隔离绑定。 */
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceRow, DeviceView } from '../types/pairing.js';

/**
 * 为注入的数据库建立设备表和兼容迁移。
 * @param db 当前实例使用的 SQLite 连接。
 * @returns 设备凭据读写接口。
 */
export function createPairingRepository(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, authority_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  if (
    !db
      .prepare('PRAGMA table_info(paired_devices)')
      .all()
      .some((column) => column.name === 'installation_hash')
  ) {
    db.exec('ALTER TABLE paired_devices ADD COLUMN installation_hash TEXT');
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS paired_device_installation ON paired_devices(authority_hash, installation_hash) WHERE installation_hash IS NOT NULL',
  );

  return {
    /**
     * 同时校验设备令牌散列与管理员身份，支持主令牌轮换失效。
     * @param tokenHash 已散列的凭据，数据库不保存明文。
     * @param authority 当前管理员令牌的散列，用于隔离设备绑定。
     * @returns 匹配设备的最小身份信息。
     */
    findToken(tokenHash: string, authority: string) {
      return db
        .prepare(
          'SELECT id, installation_hash FROM paired_devices WHERE token_hash = ? AND authority_hash = ?',
        )
        .get(tokenHash, authority) as DeviceRow | undefined;
    },
    /**
     * 检查同一管理员下的安装身份，避免重复绑定。
     * @param authority 当前管理员令牌的散列，用于隔离设备绑定。
     * @param installation 设备安装身份的散列。
     * @returns 已绑定设备 ID，未找到时为 undefined。
     */
    findInstallation(authority: string, installation: string) {
      return db
        .prepare('SELECT id FROM paired_devices WHERE authority_hash = ? AND installation_hash = ?')
        .get(authority, installation) as
        | {
            /** 当前契约中的实体或活动标识。 */
            id: string;
          }
        | undefined;
    },
    /**
     * 读取当前管理员下的设备摘要，避免暴露凭据散列。
     * @param authority 当前管理员令牌的散列，用于隔离设备绑定。
     * @returns 可展示的已绑定设备列表。
     */
    list(authority: string) {
      return db
        .prepare(
          'SELECT id, name, platform, created_at AS createdAt FROM paired_devices WHERE authority_hash = ? ORDER BY created_at DESC',
        )
        .all(authority) as unknown as DeviceView[];
    },
    /**
     * 保存设备令牌散列和安装身份，明文凭据不落库。
     * @param id 待处理实体的稳定标识。
     * @param name 字段、能力或实体的展示名称。
     * @param platform 设备平台名称。
     * @param tokenHash 已散列的凭据，数据库不保存明文。
     * @param authority 当前管理员令牌的散列，用于隔离设备绑定。
     * @param createdAt 事件或命令发生的时间戳。
     * @param installation 设备安装身份的散列。
     * @returns 无返回值。
     */
    insert(
      id: string,
      name: string,
      platform: string,
      tokenHash: string,
      authority: string,
      createdAt: number,
      installation: string,
    ) {
      db.prepare(
        'INSERT INTO paired_devices (id, name, platform, token_hash, authority_hash, created_at, installation_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, name, platform, tokenHash, authority, createdAt, installation);
    },
    /**
     * 为持有旧令牌的设备补充安装身份，保留原连接。
     * @param installation 设备安装身份的散列。
     * @param id 待处理实体的稳定标识。
     * @returns 无返回值。
     */
    adopt(installation: string, id: string) {
      db.prepare('UPDATE paired_devices SET installation_hash = ? WHERE id = ?').run(
        installation,
        id,
      );
    },
    /**
     * 在管理员身份范围内删除设备。
     * @param id 待处理实体的稳定标识。
     * @param authority 当前管理员令牌的散列，用于隔离设备绑定。
     * @returns 无返回值。
     */
    remove(id: string, authority: string) {
      db.prepare('DELETE FROM paired_devices WHERE id = ? AND authority_hash = ?').run(
        id,
        authority,
      );
    },
  };
}
