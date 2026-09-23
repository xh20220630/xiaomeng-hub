/** 处理二维码生命周期、安装身份去重与凭据兑换，HTTP 安全边界由中间件负责。 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import QRCode from 'qrcode';
import { createPairingRepository } from '../repositories/pairing.repository.js';
import type {
  PairingOptions,
  PairingSession,
  PairingAddress,
  PairingResponse,
} from '../types/pairing.js';

/**
 * 为凭据或事件生成稳定摘要，避免公开原始秘密。
 * @param value 需要校验、散列或转换的输入值。
 * @returns SHA-256 十六进制摘要。
 */
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
/**
 * 使用密码学随机数生成短期兑换码。
 * @returns URL 安全的随机字符串。
 */
const secret = (): string => randomBytes(32).toString('base64url');

/**
 * 为一个中心实例建立独立的二维码会话、凭据与过期策略。
 * @param options 本次操作的具名参数，缺省值由实现统一处理。
 * @param options.db 当前实例使用的 SQLite 连接。
 * @param options.authToken 管理员访问令牌，用于隔离设备绑定和验证客户端。
 * @param options.onRevoke 设备撤销后断开失效连接的回调。
 * @param options.now 本次过期结算使用的统一毫秒时间。
 * @param options.ttlMs 二维码从生成到失效的时长，单位毫秒。
 * @param options.interfaces 枚举本机网卡的函数，可在测试中注入。
 * @param options.listenHost 实际监听的地址，用于筛选手机可连接的网卡。
 * @param options.getAgents 读取可展示 Agent 目录的函数。
 * @returns 配对业务接口。
 */
export function createPairingService({
  db,
  authToken,
  onRevoke = () => {},
  now = Date.now,
  ttlMs = 120000,
  interfaces = os.networkInterfaces,
  listenHost = process.env.HOST || '0.0.0.0',
  getAgents = () => [],
}: PairingOptions) {
  const repository = createPairingRepository(db);
  const authority = digest(authToken);
  const sessions = new Map<string, PairingSession>();

  /**
   * 按当前管理员身份验证设备令牌，使撤销与主令牌轮换立即生效。
   * @param token 待验证或用于认证的凭据。
   * @returns 设备是否仍拥有访问权限。
   */
  function authorizeDevice(token: string): boolean {
    return (
      !!authToken &&
      typeof token === 'string' &&
      token.length < 256 &&
      !!repository.findToken(digest(token), authority)
    );
  }

  /**
   * 移除过期二维码及其临时兑换结果，限制敏感数据驻留时间。
   * @returns 无返回值。
   */
  function prune(): void {
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
  }

  /**
   * 筛选当前监听地址可用的本机 IPv4 网卡。
   * @param localAddress 处理请求的 socket 本机地址。
   * @param localPort 处理请求的实际监听端口。
   * @returns 可供手机连接的候选地址。
   */
  function addresses(
    localAddress: string | undefined,
    localPort: number | undefined,
  ): PairingAddress[] {
    const bound = localAddress?.replace('::ffff:', '');
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(listenHost)) return [];
    /**
     * 优先推荐常用私网物理网卡，降低选择虚拟网卡的概率。
     * @param entry 参与展示或排序的单个记录。
     * @returns 越小越优先的排序权重。
     */
    const priority = (entry: PairingAddress): number => {
      const ip = new URL(entry.url).hostname;
      const virtual =
        /virtual|vethernet|vmware|wsl|mihomo|clash|tun|vpn|docker|tailscale|zerotier/i.test(
          entry.name,
        );
      const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      return (virtual ? 10 : 0) + (privateIp ? 0 : 2);
    };
    return Object.entries(interfaces())
      .flatMap(([name, entries]) =>
        (entries || [])
          .filter(
            (entry) =>
              entry.family === 'IPv4' &&
              !entry.internal &&
              (['0.0.0.0', '::'].includes(listenHost) || entry.address === bound),
          )
          .map((entry) => ({ name, url: `http://${entry.address}:${localPort}` })),
      )
      .sort((a, b) => priority(a) - priority(b));
  }

  /**
   * 校验临时码与安装身份，防止重复注册及不同设备重放。
   * @param body 当前接口提交的结构化负载，业务边界仍执行运行时校验。
   * @returns 设备凭据或兼容客户端的错误状态。
   */
  function exchange(body: Record<string, unknown>): PairingResponse {
    if (!authToken) return { status: 503, body: { error: '宿主机尚未设置 AUTH_TOKEN' } };
    prune();
    const { code, clientNonce, installationId, existingToken, deviceName, platform } = body;
    if (typeof installationId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(installationId)) {
      return {
        status: 426,
        body: {
          errorCode: 'CLIENT_UPDATE_REQUIRED',
          error: '请升级小梦 APP 后绑定；旧版不支持设备去重',
        },
      };
    }
    if (
      typeof code !== 'string' ||
      typeof clientNonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(clientNonce) ||
      typeof deviceName !== 'string' ||
      !deviceName.trim() ||
      deviceName.length > 60 ||
      typeof platform !== 'string' ||
      !['android', 'ios', 'other'].includes(platform)
    ) {
      return { status: 400, body: { error: '绑定信息不完整，请重新扫码' } };
    }
    const session = [...sessions.values()].find((item) => item.codeHash === digest(code));
    if (!session) return { status: 410, body: { error: '二维码已过期或已刷新，请重新扫码' } };
    const installationHash = digest(installationId);
    if (session.result) {
      // HTTP 响应丢失时，仅允许同一安装身份与随机数取回已有结果。
      if (
        session.clientNonce === clientNonce &&
        session.installationHash === installationHash &&
        authorizeDevice(session.result.token)
      )
        return { status: 200, body: session.result };
      return { status: 409, body: { error: '二维码已被使用，请在电脑上生成新的二维码' } };
    }
    if (repository.findInstallation(authority, installationHash)) {
      return {
        status: 409,
        body: {
          errorCode: 'DEVICE_ALREADY_PAIRED',
          error: '这台设备已绑定此宿主机，无需重复绑定。需要重新绑定时，请先在电脑上解除绑定。',
        },
      };
    }
    const legacy =
      typeof existingToken === 'string' && existingToken.length < 256
        ? repository.findToken(digest(existingToken), authority)
        : undefined;
    // 旧版绑定只能由持有原设备令牌的手机补充安装身份。
    if (legacy && legacy.installation_hash === null) {
      repository.adopt(installationHash, legacy.id);
      return {
        status: 409,
        body: {
          errorCode: 'DEVICE_ALREADY_PAIRED',
          error: '这台设备已绑定此宿主机，已保留原有连接，无需再次绑定。',
        },
      };
    }
    const token = `xm_device_${secret()}`,
      id = randomUUID();
    repository.insert(
      id,
      deviceName.trim(),
      platform,
      digest(token),
      authority,
      now(),
      installationHash,
    );
    session.installationHash = installationHash;
    session.clientNonce = clientNonce;
    session.deviceName = deviceName.trim();
    session.result = { deviceId: id, token, serverUrl: session.serverUrl, hostName: os.hostname() };
    return { status: 201, body: session.result };
  }

  /**
   * 组合主机、设备和 Agent 摘要，不公开任何设备令牌。
   * @param availableAddresses 当前监听配置允许公开的本机地址。
   * @returns 配对管理页需要的公开状态。
   */
  function info(availableAddresses: PairingAddress[]) {
    return {
      hostName: os.hostname(),
      platform: os.platform(),
      addresses: availableAddresses,
      authEnabled: !!authToken,
      devices: repository.list(authority),
      agents: getAgents().map(({ agentId, name, provider, online }) => ({
        agentId,
        name,
        provider,
        online,
      })),
    };
  }

  /**
   * 只为本机可用地址生成短时二维码，并作废尚未兑换的旧码。
   * @param serverUrl 手机访问中心服务的局域网地址。
   * @param availableAddresses 当前监听配置允许公开的本机地址。
   * @returns 二维码资料或生成失败的状态和原因。
   */
  async function createSession(
    serverUrl: unknown,
    availableAddresses: PairingAddress[],
  ): Promise<PairingResponse> {
    if (!authToken)
      return { status: 503, body: { error: '请先为后端设置 AUTH_TOKEN，再重启服务' } };
    if (
      typeof serverUrl !== 'string' ||
      !availableAddresses.some((entry) => entry.url === serverUrl)
    )
      return { status: 400, body: { error: '请选择本机可用的局域网地址' } };
    prune();
    if (sessions.size >= 100) return { status: 429, body: { error: '生成过于频繁，请稍后重试' } };
    const id = randomUUID(),
      code = secret(),
      expiresAt = now() + ttlMs;
    const payload = `xiaomeng://pair?${new URLSearchParams({ v: '1', server: serverUrl, name: os.hostname(), code, expires: String(expiresAt) })}`;
    const svg = await QRCode.toString(payload, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 280,
    });
    for (const [key, session] of sessions) if (!session.result) sessions.delete(key);
    sessions.set(id, { codeHash: digest(code), expiresAt, serverUrl });
    return {
      status: 201,
      body: {
        id,
        payload,
        expiresAt,
        qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      },
    };
  }

  /**
   * 先移除过期二维码，再返回当前绑定进度。
   * @param id 待处理实体的稳定标识。
   * @returns waiting、paired 或 expired 状态。
   */
  function sessionStatus(id: string) {
    prune();
    const session = sessions.get(id);
    if (!session) return { status: 'expired' };
    return {
      status: session.result ? 'paired' : 'waiting',
      expiresAt: session.expiresAt,
      deviceName: session.deviceName,
    };
  }

  /**
   * 删除设备凭据并通知传输层断开已有连接。
   * @param id 待处理实体的稳定标识。
   * @returns 无返回值。
   */
  function revoke(id: string): void {
    repository.remove(id, authority);
    onRevoke();
  }

  return { authorizeDevice, addresses, exchange, info, createSession, sessionStatus, revoke };
}

/** 控制器依赖的配对服务接口。 */
export type PairingService = ReturnType<typeof createPairingService>;
