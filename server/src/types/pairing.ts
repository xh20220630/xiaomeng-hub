/** 配对流程契约；临时二维码、设备身份和管理员凭据具有不同生命周期。 */
import type { DatabaseSync } from 'node:sqlite';
import type os from 'node:os';
import type { AgentView } from './domain.js';

/** 用于隔离测试和配置主机配对行为的依赖。 */
export interface PairingOptions {
  /** 保存设备身份的连接。 */
  db: DatabaseSync;
  /** 管理员令牌，仅其散列用于绑定归属。 */
  authToken: string;
  /** 撤销设备后立即清理已连接的 WebSocket。 */
  onRevoke?: () => void;
  /** 可替换的毫秒时钟。 */
  now?: () => number;
  /** 二维码有效期。 */
  ttlMs?: number;
  /** 读取本机网卡信息。 */
  interfaces?: () => Record<
    string,
    Pick<os.NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] | undefined
  >;
  /** 实际监听地址，限制可发布的网卡。 */
  listenHost?: string;
  /** 获取客户端可见的 Agent 在线状态。 */
  getAgents?: () => Pick<AgentView, 'agentId' | 'name' | 'provider' | 'online'>[];
}

/** 已配对设备的客户端摘要。 */
export interface DeviceView {
  /** 撤销绑定使用的设备 ID。 */
  id: string;
  /** 用户指定的设备名称。 */
  name: string;
  /** android、ios 或 other。 */
  platform: string;
  /** 注册时间，单位毫秒。 */
  createdAt: number;
}

/** 按凭据查询设备时需要的最小数据。 */
export interface DeviceRow {
  /** 设备 ID。 */
  id: string;
  /** 安装身份散列，旧版记录可能为 null。 */
  installation_hash: string | null;
}

/** 手机保存的绑定结果。 */
export interface PairingResult {
  /** 中心分配的设备 ID。 */
  deviceId: string;
  /** 设备专属令牌，不能注册 Agent。 */
  token: string;
  /** 手机应访问的局域网地址。 */
  serverUrl: string;
  /** 显示给用户的宿主机名称。 */
  hostName: string;
}

/** 二维码交换的内存状态，过期后不保留明文设备令牌。 */
export interface PairingSession {
  /** 临时码散列。 */
  codeHash: string;
  /** 临时码失效时间。 */
  expiresAt: number;
  /** 生成二维码时选择的网卡地址。 */
  serverUrl: string;
  /** 成功兑换的安装身份。 */
  installationHash?: string;
  /** 重试请求的幂等随机数。 */
  clientNonce?: string;
  /** 兑换成功的设备名称。 */
  deviceName?: string;
  /** 在有效期内允许同一手机重试读取的结果。 */
  result?: PairingResult;
}

/** 网络适配器摘要。 */
export interface PairingAddress {
  /** 网卡名称。 */
  name: string;
  /** 包含监听端口的 HTTP 地址。 */
  url: string;
}

/** 服务层给控制器的结果，不依赖 Express Response。 */
export interface PairingResponse {
  /** 与原接口保持兼容的 HTTP 状态。 */
  status: number;
  /** 成功数据或可展示的错误信息。 */
  body: unknown;
}
