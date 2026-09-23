/** 把 Codex 主机状态、活动与审批映射为中心协议，操作结果以主机回执为准。 */
import type { CodexRpc } from './codex-rpc.js';
import type { AgentClient } from '../../sdk/agent-client.js';
import type { CodexDesktop } from './codex-desktop.js';
import type { AgentHandlers, CommandInput } from '../../types/sdk.js';
import type { CommandPayload, EventInput, RemoteProjectInput } from '../../types/domain.js';
import type {
  CodexThread,
  CodexItem,
  CodexModel,
  CodexNotification,
  ServerRequest,
  PendingApproval,
  ToolStream,
  HostIndex,
  ThreadSettings,
} from '../../types/codex.js';
import { asError } from '../../utils/errors.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readCodexHostIndex } from './codex-host-index.js';
import { historyEvent, toolResult } from './codex-history.js';
import { CodexDesktopBridge } from './codex-desktop-bridge.js';

/** Codex 同步范围及执行通道依赖。 */
export interface CodexAgentOptions {
  /** 已配置的 App Server 传输。 */
  rpc: CodexRpc;
  /** 向中心上报状态的 SDK。 */
  client: AgentClient;
  /** 初始项目目录。 */
  projects: string[];
  /** 中心与主机线程 ID 映射的持久化文件。 */
  stateFile: string;
  /** 可选的桌面执行通道。 */
  desktop?: CodexDesktop;
  /** 增量同步间隔。 */
  pollMs?: number;
  /** 主动读取的线程数量上限。 */
  maxThreads?: number;
  /** 是否导入整个主机。 */
  hostScope?: boolean;
  /** 是否按需读取正文。 */
  lazyHistory?: boolean;
  /** 可注入的只读主机索引读取器。 */
  hostIndex?: () => Promise<HostIndex>;
  /** 审批有效时长。 */
  approvalTtlMs?: number;
  /** 后台错误报告入口。 */
  onError?: (error: Error) => void;
}

/**
 * 限制提供方文本体积，防止单个事件淹没传输通道。
 * @param value 需要校验、散列或转换的输入值。
 * @param max 允许的文本长度上限。
 * @returns 转换并截断后的文本。
 */
const clipped = (value: unknown, max = 64000): string => String(value ?? '').slice(0, max);
/**
 * 为凭据或事件生成稳定摘要，避免公开原始秘密。
 * @param value 需要校验、散列或转换的输入值。
 * @returns SHA-256 十六进制摘要。
 */
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const controlCaps = [
  'message.send',
  'message.steer',
  'session.stop',
  'approval.respond',
  'session.configure',
  'session.compact',
];
const sourceKinds = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

/** 将 Codex 线程、轮次和审批转为中心协议，同时保留主机的实际控制权。 */
export class CodexAgent {
  /** 与 Codex App Server 通信的传输实例。 */
  rpc!: CodexRpc;
  /** 向中心发布数据的接入 SDK。 */
  client!: AgentClient;
  /** 用于复用凭据或会话映射的持久文件。 */
  stateFile!: string;
  /** 主机状态同步间隔，单位毫秒。 */
  pollMs!: number;
  /** 一次主动同步可读取的线程上限。 */
  maxThreads!: number;
  /** 是否允许导入主机上的全部项目。 */
  hostScope!: boolean;
  /** 是否在用户展开会话后才读取正文。 */
  lazyHistory!: boolean;
  /** 读取本机补充索引的函数。 */
  hostIndex!: () => Promise<HostIndex>;
  /** 审批在本机允许等待的最长时间。 */
  approvalTtlMs!: number;
  /** 后台异常报告入口。 */
  onError!: (error: Error) => void;
  /** 保存项目 ID 到实际工作目录的对应关系。 */
  projectAssignments: Map<
    string,
    RemoteProjectInput & {
      /** 主机执行任务时的工作目录。 */
      cwd: string;
    }
  >;
  /** 已发送摘要的签名，用于跳过未变化数据。 */
  published: Map<string, string>;
  /** 当前同步范围内的项目集合。 */
  projects: Map<
    string,
    RemoteProjectInput & {
      /** 主机执行任务时的工作目录。 */
      cwd: string;
    }
  >;
  /** 最近读取的主机线程状态。 */
  threads: Map<string, CodexThread>;
  /** 主机线程到中心预分配会话 ID 的映射。 */
  aliases: Record<string, string>;
  /** 已由当前 App Server 接管的线程。 */
  attached: Set<string>;
  /** 暂时无法取得控制权的原因。 */
  blocked: Map<string, string>;
  /** 失败控制尝试的冷却期限。 */
  blockedUntil: Map<string, number>;
  /** 等待用户或主机最终确认的请求。 */
  requests: Map<string, PendingApproval>;
  /** 最近工具与消息活动，用于补全后续通知。 */
  items: Map<string, CodexItem>;
  /** 每个线程当前受控的执行轮次。 */
  activeTurns: Map<string, string>;
  /** 每个线程的累计助手文本。 */
  streams: Map<string, string>;
  /** 等待节流发送的工具输出。 */
  toolStreams: Map<string, ToolStream>;
  /** 已提交的稳定事件 ID，防止重复同步。 */
  sentEvents: Set<string>;
  /** 串行状态更新队列的尾部 Promise。 */
  serial: Promise<unknown>;
  /** 串行写入映射文件的尾部 Promise。 */
  aliasWrite: Promise<void>;
  /** 当前正在提交操作的会话集合。 */
  sessionLocks: Map<string, boolean>;
  /** 进程实例标识，避免重启前后的临时事件键碰撞。 */
  instance: string;
  /** 实例是否正在或已经关闭。 */
  closed: boolean;
  /** 初始化已完成且通道仍可使用。 */
  ready: boolean;
  /** 可选桌面桥接或桌面传输实例。 */
  desktop: CodexDesktopBridge | null;
  /** 按操作名注册的处理器。 */
  handlers: AgentHandlers;
  /** 当前操作的超时或重试计时器。 */
  timer?: ReturnType<typeof setTimeout>;
  /** 最近从主机读取的模型目录。 */
  models?: CodexModel[];
  /** 模型目录缓存的更新时间。 */
  modelsAt: number = 0;

  /**
   * 建立实例独立的依赖与状态，避免不同接入端互相覆盖。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.rpc 与 Codex App Server 通信的传输实例。
   * @param options.client 连接中心服务的 Agent SDK。
   * @param options.projects 参与聚合的项目列表。
   * @param options.stateFile 用于复用凭据或会话映射的持久文件。
   * @param options.desktop 与现有 Codex 桌面拥有者通信的通道。
   * @param options.pollMs 主机状态同步间隔，单位毫秒。
   * @param options.maxThreads 一次主动同步可读取的线程上限。
   * @param options.hostScope 是否允许导入主机上的全部项目。
   * @param options.lazyHistory 是否在用户展开会话后才读取正文。
   * @param options.hostIndex 读取本机补充索引的函数。
   * @param options.approvalTtlMs 审批在本机允许等待的最长时间。
   * @param options.onError 后台异常报告入口。
   * @returns 已初始化但尚未连接的实例。
   */
  constructor({
    rpc,
    client,
    projects,
    stateFile,
    desktop,
    pollMs = 5000,
    maxThreads = Infinity,
    hostScope = false,
    lazyHistory = false,
    hostIndex = readCodexHostIndex,
    approvalTtlMs = 600000,
    onError = console.error,
  }: CodexAgentOptions) {
    Object.assign(this, {
      rpc,
      client,
      stateFile,
      pollMs,
      maxThreads,
      hostScope,
      lazyHistory,
      hostIndex,
      approvalTtlMs,
      onError,
    });
    this.projectAssignments = new Map();
    this.published = new Map();
    this.projects = new Map(
      projects.map(
        (
          cwd,
        ): [
          string,
          RemoteProjectInput & {
            /** 主机执行任务时的工作目录。 */
            cwd: string;
          },
        ] => {
          const root = path.resolve(cwd);
          return [root, { id: root, cwd: root, name: path.basename(root) || root }];
        },
      ),
    );
    this.threads = new Map();
    this.aliases = {};
    this.attached = new Set();
    this.blocked = new Map();
    this.blockedUntil = new Map();
    this.requests = new Map();
    this.items = new Map();
    this.activeTurns = new Map();
    this.streams = new Map();
    this.toolStreams = new Map();
    this.sentEvents = new Set();
    this.serial = Promise.resolve();
    this.aliasWrite = Promise.resolve();
    this.sessionLocks = new Map();
    this.instance = randomUUID();
    this.closed = false;
    this.ready = false;
    this.desktop = desktop ? new CodexDesktopBridge(this, desktop) : null;
    const available = client.isAvailable;
    client.isAvailable = () => this.ready && available();
    this.handlers = {
      /**
       * 将新建命令交给当前适配器，沿用中心分配的会话标识。
       * @param p 该能力对应的已解析命令参数。
       * @returns 主机创建会话的回执。
       */
      'session.start': (p) => this.exclusive(p.sessionId, () => this.startSession(p)),
      /**
       * 转交续聊指令，使同一会话通过既有执行通道继续。
       * @param p 该能力对应的已解析命令参数。
       * @returns 消息执行的异步回执。
       */
      'message.send': (p) => this.exclusive(p.sessionId, () => this.sendMessage(p)),
      /**
       * 向当前运行轮次追加指令，保持原轮次的控制权。
       * @param p 该能力对应的已解析命令参数。
       * @returns 主机受理追加指令的回执。
       */
      'message.steer': (p) => this.exclusive(p.sessionId, () => this.steer(p)),
      /**
       * 停止指定会话的当前执行，避免影响其他会话。
       * @param p 该能力对应的已解析命令参数。
       * @returns 停止操作的回执。
       */
      'session.stop': (p) => this.stop(p),
      /**
       * 将手机决定交给审批所属主机，并等待明确确认。
       * @param p 该能力对应的已解析命令参数。
       * @returns 主机确认结果。
       */
      'approval.respond': (p) => this.answer(p),
      /**
       * 读取主机历史，不以恢复或启动任务代替读取。
       * @param p 该能力对应的已解析命令参数。
       * @returns 事件页及后续游标。
       */
      'history.read': (p) => this.readHistory(p),
      /**
       * 按当前主机能力返回模型和操作目录，避免客户端硬编码选项。
       * @param p 该能力对应的已解析命令参数。
       * @returns 可用能力目录。
       */
      'agent.catalog': (p) => this.catalog(p),
      /**
       * 交给主机验证并保存下一轮设置，避免在客户端猜测配置是否生效。
       * @param p 该能力对应的已解析命令参数。
       * @returns 已确认的执行设置或配置回执。
       */
      'session.configure': (p) => this.exclusive(p.sessionId, () => this.configure(p)),
      /**
       * 受理上下文压缩命令，保留主机对执行状态的判断。
       * @param p 该能力对应的已解析命令参数。
       * @returns 主机压缩受理回执。
       */
      'session.compact': (p) => this.compact(p),
      /**
       * 只转交主机公开的能力操作，未支持的名称由适配器拒绝。
       * @param p 该能力对应的已解析命令参数。
       * @returns 操作专属结果。
       */
      'agent.action': (p) => this.action(p),
    };
    rpc.on('notification', (message: CodexNotification) =>
      this.enqueue(() => this.notification(message)),
    );
    rpc.on('request', (message: ServerRequest) => this.enqueue(() => this.serverRequest(message)));
    rpc.on('disconnect', () => {
      for (const request of this.requests.values()) {
        clearTimeout(request.timer);
        request.confirm?.reject(new Error('Codex 已断开，回复结果未知'));
      }
      this.requests.clear();
    });
  }

  /**
   * 串行执行同一数据源的更新，防止并发状态覆盖。
   * @param work 需要串行或独占执行的工作项。
   * @returns 本次工作项的结果。
   */
  enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch(this.onError);
    return result;
  }

  /**
   * 拒绝同一会话并发提交控制操作，避免轮次竞争。
   * @param key 用于队列、映射或去重的稳定键。
   * @param work 需要串行或独占执行的工作项。
   * @returns 独占执行的工作项结果。
   */
  async exclusive<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    if (this.sessionLocks.has(key)) throw new Error('此任务已有操作正在提交，请稍后重试');
    this.sessionLocks.set(key, true);
    try {
      return await work();
    } finally {
      this.sessionLocks.delete(key);
    }
  }

  /**
   * 建立执行通道并同步必要身份，后续操作才可开始。
   * @returns 操作完成的异步信号。
   */
  async connect() {
    try {
      this.aliases = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (cause) {
      const error = asError(cause);
      if (error.code !== 'ENOENT') throw error;
    }
    await this.rpc.connect();
    await this.client.connect();
    for (const project of this.projects.values()) await this.client.project(project);
    await this.sync();
    this.ready = true;
    this.schedule();
  }

  /**
   * 只在适配器与通道仍可用时安排下一次同步。
   * @returns 无返回值。
   */
  schedule() {
    if (this.closed || !this.rpc.ready) return;
    this.timer = setTimeout(async () => {
      await this.sync().catch(this.onError);
      this.schedule();
    }, this.pollMs);
  }

  /**
   * 串行并原子替换会话映射文件，避免并发新建丢失映射。
   * @returns 操作完成的异步信号。
   */
  async saveAliases() {
    const write = this.aliasWrite.then(async () => {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, JSON.stringify(this.aliases), { mode: 0o600 });
      await rename(temporary, this.stateFile);
    });
    this.aliasWrite = write.catch(() => {});
    await write;
  }

  /**
   * 优先使用主机保存的项目归属，再按配置决定是否接纳目录。
   * @param thread 已读取的 Codex 线程摘要。
   * @returns 所属项目；超出范围时为 undefined。
   */
  projectFor(thread: CodexThread) {
    const assigned = this.projectAssignments.get(thread.projectId || '');
    if (assigned) return assigned;
    const root = path.resolve(thread.cwd || '');
    /**
     * 按平台规则比较路径，保留非 Windows 文件系统大小写。
     * @param p 原始 hook 或模拟事件负载。
     * @returns 用于比较的目录字符串。
     */
    const normalize = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    let project = [...this.projects.values()].find((p) => normalize(p.cwd) === normalize(root));
    if (!project && this.hostScope && thread.cwd) {
      project = { id: root, cwd: root, name: path.basename(root) || root };
      this.projects.set(root, project);
    }
    return project;
  }

  /**
   * 复用中心预分配的会话 ID，历史导入则沿用主机线程 ID。
   * @param threadId Codex 主机线程标识。
   * @returns 对中心公开的会话标识。
   */
  sessionId(threadId: string): string {
    return this.aliases[threadId] || threadId;
  }
  /**
   * 查找配置范围内的主机线程，防止操作未接入的任务。
   * @param sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @returns 目标 Codex 线程。
   */
  threadFor(sessionId: string): CodexThread {
    const thread = [...this.threads.values()].find((t) => this.sessionId(t.id) === sessionId);
    if (!thread || !this.projectFor(thread)) throw new Error('任务不存在或不在 CODEX_PROJECTS 中');
    return thread;
  }

  /**
   * 综合主机状态和活动轮次判断任务状态，避免把未加载误认为运行中。
   * @param thread 已读取的 Codex 线程摘要。
   * @returns 统一任务状态。
   */
  state(thread: CodexThread): string {
    const last = thread.turns?.at(-1);
    const lastStatus = last?.status || thread.lastTurnStatus;
    if (
      this.activeTurns.has(thread.id) ||
      thread.status?.type === 'active' ||
      lastStatus === 'inProgress'
    )
      return 'running';
    if (thread.status?.type === 'systemError' || lastStatus === 'failed') return 'error';
    if (lastStatus === 'interrupted') return 'paused';
    return lastStatus === 'completed'
      ? 'done'
      : !lastStatus && thread.status?.type === 'notLoaded'
        ? 'ended'
        : 'waiting_input';
  }

  /**
   * 只在摘要变化时发布会话，避免周期同步重复推送。
   * @param thread 已读取的 Codex 线程摘要。
   * @returns 操作完成的异步信号。
   */
  async publish(thread: CodexThread) {
    const project = this.projectFor(thread);
    if (!project) return;
    const active = this.state(thread) === 'running';
    if ((this.blockedUntil.get(thread.id) || Infinity) < Date.now()) this.blocked.delete(thread.id);
    const desktop = this.desktop?.has(thread.id);
    const controlled =
      desktop || (this.attached.has(thread.id) && thread.canAcceptDirectInput !== false);
    const unavailable =
      thread.archived ||
      (!desktop &&
        (thread.canAcceptDirectInput === false ||
          this.blocked.has(thread.id) ||
          (active && !controlled)));
    const caps = unavailable
      ? []
      : controlled
        ? controlCaps
        : ['message.send', 'session.configure', 'session.compact'];
    const session = {
      id: this.sessionId(thread.id),
      summary: clipped(thread.name || thread.preview || 'Codex 新任务', 1000),
      status: this.state(thread),
      updatedAt: Math.min(Date.now(), Math.floor((thread.updatedAt || Date.now() / 1000) * 1000)),
      capabilities: caps,
      archived: Boolean(thread.archived),
      pinned: Boolean(thread.isPinned),
      cwd: thread.cwd,
      model: thread.model,
      source: thread.threadSource,
      reasoningEffort: thread.reasoningEffort,
      mode: thread.collaborationMode?.mode,
      controlTransport: desktop ? 'desktop-ipc' : controlled ? 'app-server' : 'resume',
      controlReason: thread.archived
        ? '已归档 · 可查看完整历史'
        : unavailable
          ? this.blocked.get(thread.id) || '主机执行通道尚未连接，请保持桌面端在线'
          : desktop
            ? '桌面已连接 · 操作直接交给当前会话'
            : controlled
              ? '已连接 · 可远程操作'
              : '发送指令后继续此任务；沿用主机权限设置',
    };
    const signature = JSON.stringify([project, session]);
    if (this.published.get(thread.id) === signature) return;
    await this.client.request('/sessions', { project, session, allowProjectMove: this.hostScope });
    this.published.set(thread.id, signature);
  }

  /**
   * 分页同步范围内线程，并补充已完成的历史项目。
   * @returns 操作完成的异步信号。
   */
  async sync() {
    if (this.lazyHistory) return this.syncIndex();
    let cursor: string | null | undefined;
    let count = 0;
    do {
      const page = await this.rpc.request('thread/list', {
        cursor,
        limit: Math.min(50, this.maxThreads - count),
        sortKey: 'updated_at',
        sourceKinds,
        cwd: [...this.projects.keys()],
      });
      for (const summary of page.data || []) {
        count++;
        if (!this.projectFor(summary)) continue;
        await this.enqueue(async () => {
          try {
            const { thread } = await this.rpc.request('thread/read', {
              threadId: summary.id,
              includeTurns: true,
            });
            this.threads.set(thread.id, thread);
            const active = thread.turns?.findLast((turn) => turn.status === 'inProgress');
            if (this.attached.has(thread.id)) {
              if (active) this.activeTurns.set(thread.id, active.id);
              else this.activeTurns.delete(thread.id);
            }
            if (
              this.rpc.url &&
              thread.status?.type === 'active' &&
              thread.canAcceptDirectInput === true &&
              !this.attached.has(thread.id)
            ) {
              await this.resume(thread);
            }
            await this.publish(thread);
            for (const turn of (thread.turns || []).slice(-20)) {
              for (const item of turn.items || []) {
                if (
                  turn.status === 'inProgress' &&
                  (item.type === 'agentMessage' || item.status === 'inProgress')
                )
                  continue;
                await this.item(
                  thread.id,
                  turn.id,
                  item,
                  true,
                  (turn.completedAt || turn.startedAt || thread.updatedAt || 0) * 1000,
                );
              }
            }
          } catch (cause) {
            const error = asError(cause);
            this.onError(error);
          }
        });
      }
      cursor = page.nextCursor;
    } while (cursor && count < this.maxThreads);
    for (const request of this.requests.values()) {
      if (!request.responding && request.expiresAt > Date.now()) await this.publishRequest(request);
    }
  }

  /**
   * 合并主机索引和全部协议分页，仅按需读取对话正文。
   * @returns 操作完成的异步信号。
   */
  async syncIndex() {
    const indexed = new Map<string, CodexThread>();
    if (this.hostScope && !this.rpc.url) {
      try {
        const host = await this.hostIndex();
        for (const saved of host.projects) {
          const project = { id: saved.cwd, cwd: saved.cwd, name: saved.name, saved: true };
          this.projects.set(project.id, project);
          this.projectAssignments.set(saved.id, project);
          const signature = JSON.stringify(project);
          if (this.published.get(`project:${saved.id}`) !== signature) {
            await this.client.project(project);
            this.published.set(`project:${saved.id}`, signature);
          }
        }
        for (const thread of host.threads) indexed.set(thread.id, thread);
      } catch (cause) {
        const error = asError(cause);
        this.onError(new Error(`宿主机索引读取失败，使用协议列表：${error.message}`));
      }
    }
    for (const archived of [false, true]) {
      let cursor: string | null | undefined;
      const cursors = new Set();
      do {
        const page = await this.rpc.request('thread/list', {
          cursor,
          limit: 100,
          archived,
          sortKey: 'updated_at',
          sourceKinds,
          modelProviders: [],
          useStateDbOnly: true,
          ...(!this.hostScope ? { cwd: [...this.projects.keys()] } : {}),
        });
        for (const summary of page.data || [])
          indexed.set(summary.id, { ...indexed.get(summary.id), ...summary, archived });
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex 返回重复分页游标');
        cursors.add(cursor);
      } while (cursor);
    }
    for (const summary of indexed.values()) {
      if (!this.projectFor(summary)) continue;
      const old = this.threads.get(summary.id);
      if (this.desktop?.has(summary.id)) {
        await this.desktop.project(summary.id);
        continue;
      }
      const thread = { ...old, ...summary, turns: old?.turns || [] };
      this.threads.set(thread.id, thread);
      if (
        this.rpc.url &&
        !thread.archived &&
        thread.status?.type === 'active' &&
        thread.canAcceptDirectInput === true &&
        !this.attached.has(thread.id)
      ) {
        await this.resume(thread).catch(this.onError);
      }
      await this.publish(thread);
    }
    if (this.desktop) {
      const candidates = [...this.threads.values()].filter(
        (t) => !t.archived && !this.desktop!.has(t.id) && this.state(t) === 'running',
      );
      for (let i = 0; i < candidates.length; i += 6)
        await Promise.allSettled(candidates.slice(i, i + 6).map((t) => this.desktop!.follow(t.id)));
    }
  }

  /**
   * 依据游标读取一页历史，避免重复读取完整正文。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param options.cursor 数据来源生成的下一页游标。
   * @param options.limit 单次返回的数据条数上限。
   * @returns 事件分页结果。
   */
  async readHistory({ sessionId, cursor, limit = 40 }: CommandInput<'sessionId'>) {
    const thread = this.threadFor(sessionId);
    if (this.desktop && !thread.archived && !cursor) await this.desktop.follow(thread.id);
    const page = await this.rpc.request('thread/items/list', {
      threadId: thread.id,
      cursor: cursor || null,
      limit: Math.min(100, Math.max(1, limit)),
      sortDirection: 'desc',
    });
    const events = (page.data || [])
      .map(({ turnId, item }) => historyEvent(thread.id, turnId, item, null))
      .filter(Boolean);
    return { events, nextCursor: page.nextCursor || null };
  }

  /**
   * 读取主机实际模型能力，并短期缓存以减少重复查询。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @returns 模型、模式和公开动作目录。
   */
  async catalog({ sessionId }: CommandPayload = {}) {
    const thread = sessionId ? this.threadFor(sessionId) : null;
    if (thread && this.desktop && !thread.archived) await this.desktop.follow(thread.id);
    if (!this.models || Date.now() - this.modelsAt > 60000) {
      const models = [];
      let cursor: string | null | undefined;
      do {
        const page = await this.rpc.request('model/list', {
          cursor,
          limit: 100,
          includeHidden: false,
        });
        models.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);
      this.models = models;
      this.modelsAt = Date.now();
    }
    return {
      models: this.models.map((m) => ({
        id: m.model,
        name: m.displayName || m.model,
        description: m.description,
        reasoningEfforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort),
        defaultReasoningEffort: m.defaultReasoningEffort,
      })),
      modes: [
        { id: 'default', name: '执行' },
        { id: 'plan', name: '计划' },
      ],
      actions: [
        { id: 'skills.list', name: '主机技能', description: '查看此项目可用的技能' },
        { id: 'mcp.list', name: '工具与连接', description: '查看主机 MCP 工具服务' },
        { id: 'plugins.list', name: '主机插件', description: '查看已安装的插件' },
      ],
      settingsApply: 'next_turn',
      controlTransport: thread && this.desktop?.has(thread.id) ? 'desktop-ipc' : 'app-server',
    };
  }

  /**
   * 校验模型与推理强度的组合，再提交到当前主机控制通道。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param options.settings 准备在下一轮生效的会话设置。
   * @returns 主机确认的下一轮设置。
   */
  async configure({ sessionId, settings }: CommandInput<'sessionId' | 'settings'>) {
    let thread = this.threadFor(sessionId);
    const catalog = await this.catalog({ sessionId });
    const desktopState = this.desktop?.has(thread.id)
      ? await this.desktop.desktop.state(thread.id)
      : null;
    const modelId =
      settings.model ||
      desktopState?.latestThreadSettings?.model ||
      desktopState?.latestModel ||
      thread.model ||
      catalog.models[0]?.id;
    const model = catalog.models.find((m) => m.id === modelId);
    if (settings.model && !model) throw new Error('主机未提供这个模型，请刷新模型列表');
    if (settings.reasoningEffort && !model?.reasoningEfforts.includes(settings.reasoningEffort))
      throw new Error('该模型不支持所选推理强度');
    if (settings.mode && !catalog.modes.some((m) => m.id === settings.mode))
      throw new Error('不支持的工作模式');
    const patch: ThreadSettings = {
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.reasoningEffort ? { effort: settings.reasoningEffort } : {}),
    };
    const currentEffort = desktopState?.latestThreadSettings?.effort || thread.reasoningEffort;
    if (
      settings.model &&
      !settings.reasoningEffort &&
      currentEffort &&
      !model!.reasoningEfforts.includes(currentEffort)
    ) {
      patch.effort = model!.defaultReasoningEffort || null;
    }
    if (settings.mode)
      patch.collaborationMode = {
        mode: settings.mode,
        settings: {
          model: modelId,
          reasoning_effort:
            patch.effort ??
            (model?.reasoningEfforts.includes(currentEffort || '')
              ? currentEffort
              : model?.defaultReasoningEffort) ??
            null,
          developer_instructions: null,
        },
      };
    let result;
    if (this.desktop?.has(thread.id)) result = await this.desktop.configure(thread.id, patch);
    else {
      if (!this.attached.has(thread.id)) thread = await this.resume(thread);
      result = await this.rpc.request('thread/settings/update', { threadId: thread.id, ...patch });
      if (settings.model) thread.model = settings.model;
      if (Object.hasOwn(patch, 'effort')) thread.reasoningEffort = patch.effort;
      if (patch.collaborationMode) thread.collaborationMode = patch.collaborationMode;
      await this.publish(thread);
    }
    return { confirmed: true, appliesTo: 'next_turn', settings, result };
  }

  /**
   * 仅在没有执行中轮次时申请压缩上下文。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @returns 主机受理结果。
   */
  async compact({ sessionId }: CommandInput<'sessionId'>) {
    let thread = this.threadFor(sessionId);
    if (this.state(thread) === 'running') throw new Error('请等当前执行结束后再压缩上下文');
    if (this.desktop && (await this.desktop.follow(thread.id)))
      return this.desktop.compact(thread.id);
    if (!this.attached.has(thread.id)) thread = await this.resume(thread);
    return this.rpc.request('thread/compact/start', { threadId: thread.id });
  }

  /**
   * 把公开动作映射为技能、MCP 或插件的只读查询。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param options.name 字段、能力或实体的展示名称。
   * @returns 主机返回的条目和可选警告。
   */
  async action({ sessionId, name }: CommandInput<'name'>) {
    const thread = sessionId ? this.threadFor(sessionId) : null;
    if (name === 'skills.list') {
      const result = await this.rpc.request('skills/list', {
        cwds: thread ? [thread.cwd] : [...this.projects.keys()],
      });
      return {
        entries: result.data.flatMap((group) =>
          group.skills.map((skill) => ({
            name: skill.interface?.displayName || skill.name,
            description: skill.shortDescription || skill.description,
            detail: skill.path,
            status: skill.enabled === false ? 'disabled' : 'available',
          })),
        ),
        warnings: result.data.flatMap((group) =>
          (group.errors || []).map((error) => error.message),
        ),
      };
    }
    if (name === 'mcp.list') {
      const entries = [];
      let cursor: string | null | undefined;
      do {
        const result = await this.rpc.request('mcpServerStatus/list', { cursor, limit: 100 });
        entries.push(
          ...result.data.map((server) => ({
            name: server.name,
            description: server.serverInfo?.title || server.serverInfo?.name || '主机工具服务',
            detail: `${Object.keys(server.tools || {}).length} 个工具 · ${(server.resources || []).length} 个资源`,
            status:
              typeof server.runtimeStatus === 'string'
                ? server.runtimeStatus
                : server.runtimeStatus?.type || server.authStatus,
          })),
        );
        cursor = result.nextCursor;
      } while (cursor);
      return { entries };
    }
    if (name === 'plugins.list') {
      const result = await this.rpc.request('plugin/installed', {
        cwds: thread ? [thread.cwd] : [],
      });
      return {
        entries: result.marketplaces.flatMap((marketplace) =>
          marketplace.plugins
            .filter((plugin) => plugin.installed)
            .map((plugin) => ({
              name: plugin.interface?.displayName || plugin.name,
              description: plugin.interface?.shortDescription,
              detail: plugin.localVersion || plugin.version || marketplace.name,
              status: plugin.enabled ? 'enabled' : 'disabled',
            })),
        ),
        warnings: (result.marketplaceLoadErrors || []).map((error) => error.message),
      };
    }
    throw new Error('主机未提供此操作');
  }

  /**
   * 恢复 App Server 控制权；失败时暂时标记只读并保留原因。
   * @param thread 已读取的 Codex 线程摘要。
   * @returns 主机确认的线程状态。
   */
  async resume(thread: CodexThread): Promise<CodexThread> {
    try {
      const result = await this.rpc.request('thread/resume', { threadId: thread.id });
      if (result.thread.canAcceptDirectInput === false)
        throw new Error('此 Codex 任务不接受直接输入');
      this.attached.add(thread.id);
      this.blocked.delete(thread.id);
      this.threads.set(thread.id, result.thread);
      const active = result.thread.turns?.findLast((t) => t.status === 'inProgress');
      if (active) this.activeTurns.set(thread.id, active.id);
      await this.publish(result.thread);
      return result.thread;
    } catch (cause) {
      const error = asError(cause);
      this.blocked.set(thread.id, clipped(error.message, 1000));
      this.blockedUntil.set(thread.id, Date.now() + 30000);
      await this.publish(thread);
      throw error;
    }
  }

  /**
   * 在指定工作目录创建会话，并尽早上报主机确认的真实 ID。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.projectId 目标项目标识。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param options.text 用户指令、输出或待处理文本。
   * @returns 新会话的执行结果。
   */
  async startSession({
    projectId,
    sessionId,
    text,
  }: CommandInput<'projectId' | 'sessionId' | 'text'>) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('项目不在 CODEX_PROJECTS 中');
    const { thread } = await this.rpc.request('thread/start', {
      cwd: project.cwd,
      serviceName: 'xiaomeng_lan',
    });
    this.aliases[thread.id] = sessionId;
    await this.saveAliases();
    this.threads.set(thread.id, thread);
    this.attached.add(thread.id);
    await this.publish(thread);
    return this.sendMessage({ sessionId, text });
  }

  /**
   * 向会话所属执行通道发送指令，避免在错误主机启动任务。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param options.text 用户指令、输出或待处理文本。
   * @returns 受理命令或主机轮次标识。
   */
  async sendMessage({ sessionId, text }: CommandInput<'sessionId' | 'text'>) {
    let thread = this.threadFor(sessionId);
    if (this.desktop && (await this.desktop.follow(thread.id)))
      return this.desktop.send(thread.id, text, false);
    if (!this.attached.has(thread.id)) thread = await this.resume(thread);
    if (thread.canAcceptDirectInput === false) throw new Error('此 Codex 任务不接受直接输入');
    if (this.activeTurns.has(thread.id) || this.state(thread) === 'running')
      throw new Error('任务正在运行，请使用追加指令');
    const { turn } = await this.rpc.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text }],
    });
    const observed = this.threads.get(thread.id)?.turns?.find((t) => t.id === turn.id);
    if (turn.status === 'inProgress' && (!observed || observed.status === 'inProgress'))
      this.activeTurns.set(thread.id, turn.id);
    return { threadId: thread.id, turnId: turn.id };
  }

  /**
   * 只向确认仍在执行的同一轮次追加指令。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @param options.text 用户指令、输出或待处理文本。
   * @returns 主机追加指令回执。
   */
  async steer({ sessionId, text }: CommandInput<'sessionId' | 'text'>) {
    const thread = this.threadFor(sessionId);
    if (this.desktop && (await this.desktop.follow(thread.id)))
      return this.desktop.send(thread.id, text, true);
    const turnId = this.activeTurns.get(thread.id);
    if (!this.attached.has(thread.id) || !turnId)
      throw new Error('任务已结束或不可控，追加指令未发送');
    return this.rpc.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turnId,
      input: [{ type: 'text', text }],
    });
  }

  /**
   * 针对当前执行通道停止指定轮次，不猜测其他客户端的状态。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.sessionId 目标会话标识，使用当前协议一侧的命名空间。
   * @returns 主机停止回执或关闭完成信号。
   */
  async stop({ sessionId }: CommandInput<'sessionId'>) {
    const thread = this.threadFor(sessionId);
    if (this.desktop && (await this.desktop.follow(thread.id))) return this.desktop.stop(thread.id);
    const turnId = this.activeTurns.get(thread.id);
    if (!this.attached.has(thread.id) || !turnId) throw new Error('此任务当前没有可停止的执行');
    await this.rpc.request('turn/interrupt', { threadId: thread.id, turnId });
    return { threadId: thread.id, turnId };
  }

  /**
   * 将事件交给领域服务处理，通知路径不等待模型执行。
   * @param threadId Codex 主机线程标识。
   * @param type 领域事件或操作的类别。
   * @param key 用于队列、映射或去重的稳定键。
   * @param fields 附加事件字段，包含内容和关联标识。
   * @returns 操作完成的异步信号。
   */
  async event(threadId: string, type: string, key: string, fields: EventInput) {
    const eventId = digest(`${threadId}\0${key}`);
    if (this.sentEvents.has(eventId)) return;
    await this.client.event(this.sessionId(threadId), type, { ...fields, eventId });
    this.sentEvents.add(eventId);
    if (this.sentEvents.size > 20000)
      this.sentEvents.delete(this.sentEvents.values().next().value!);
  }

  /**
   * 将主机活动转换为持久事件，完成后清理对应流式缓存。
   * @param threadId Codex 主机线程标识。
   * @param turnId 主机执行轮次标识。
   * @param item 当前轮次内的消息或工具活动。
   * @param completed 该活动是否已结束，可结束的活动才写入最终输出。
   * @param createdAt 事件或命令发生的时间戳。
   * @param live 是否来自实时通知，用于清理对应流式片段。
   * @returns 操作完成的异步信号。
   */
  async item(
    threadId: string,
    turnId: string,
    item: CodexItem,
    completed: boolean,
    createdAt?: number,
    live = false,
  ) {
    const key = `${turnId}:${item.id}:${completed ? 'completed' : 'started'}`;
    this.items.set(`${threadId}:${item.id}`, item);
    if (this.items.size > 2000) this.items.delete(this.items.keys().next().value!);
    const fields = { createdAt, turnId, itemId: item.id, phase: item.phase };
    if (item.type === 'userMessage' && completed) {
      await this.event(threadId, 'message.user', key, {
        ...fields,
        text: clipped(
          item.content?.map((c) => c.text || (c.type === 'text' ? '' : `[${c.type}]`)).join('\n'),
        ),
      });
    } else if (item.type === 'agentMessage' && completed) {
      const questions =
        item.questions
          ?.map((q) => `\n\n${q.title}\n${q.options?.map((o) => `• ${o}`).join('\n') || ''}`)
          .join('') || '';
      await this.event(threadId, 'message.assistant', key, {
        ...fields,
        text: clipped(item.text + questions, 256000),
      });
      if (live) {
        this.streams.delete(threadId);
        if (this.activeTurns.has(threadId))
          await this.client.event(this.sessionId(threadId), 'assistant.delta', { text: '' });
      }
    } else if (item.type === 'reasoning' && completed && item.summary?.length) {
      await this.event(threadId, 'thinking', key, {
        ...fields,
        text: clipped(item.summary.join('\n')),
      });
    } else if (
      [
        'commandExecution',
        'fileChange',
        'mcpToolCall',
        'dynamicToolCall',
        'plan',
        'webSearch',
        'exitedReviewMode',
      ].includes(item.type)
    ) {
      const toolName =
        (
          {
            commandExecution: 'Terminal',
            fileChange: 'FileChange',
            plan: 'Plan',
            webSearch: 'WebSearch',
            exitedReviewMode: 'Review',
          } as Record<string, string>
        )[item.type] || `${item.server || ''}/${item.tool}`;
      const text =
        item.type === 'commandExecution'
          ? `${item.command}\n${completed ? item.aggregatedOutput || '' : ''}`
          : item.type === 'fileChange'
            ? (item.changes || []).map((c) => `${c.path}\n${c.diff}`).join('\n\n')
            : item.text || item.review || toolResult(item.result || item.arguments || item.action);
      await this.event(threadId, completed ? 'tool.finished' : 'tool.started', key, {
        ...fields,
        toolName,
        toolCallId: `${turnId}:${item.id}`,
        toolInput:
          item.type === 'commandExecution'
            ? clipped(item.command)
            : item.arguments == null
              ? null
              : clipped(toolResult(item.arguments)),
        text: clipped(text),
        ok: completed
          ? !['failed', 'declined'].includes(item.status || '') && item.success !== false
          : null,
      });
      if (completed) {
        clearTimeout(this.toolStreams.get(`${threadId}:${item.id}`)?.timer ?? undefined);
        this.toolStreams.delete(`${threadId}:${item.id}`);
      }
    }
  }

  /**
   * 按通知方法更新线程、文本和工具流，保持轮次关联。
   * @param options 本次操作的具名参数，缺省值由实现统一处理。
   * @param options.method 主机或 HTTP 协议的方法名称。
   * @param options.params 与协议方法对应的参数。
   * @returns 操作完成的异步信号。
   */
  async notification({ method, params: p }: CodexNotification) {
    if (method === 'serverRequest/resolved') {
      const request = this.requests.get(JSON.stringify(p.requestId));
      if (request) {
        clearTimeout(request.timer);
        this.requests.delete(JSON.stringify(p.requestId));
        request.confirm?.resolve({ confirmed: true });
        await this.client.resolveApproval(request.id, request.outcome || 'expired');
      }
      return;
    }
    const thread = this.threads.get(p.threadId);
    if (!thread || !this.projectFor(thread)) return;
    if (method === 'thread/settings/updated') {
      thread.model = p.threadSettings.model;
      thread.reasoningEffort = p.threadSettings.effort;
      thread.collaborationMode = p.threadSettings.collaborationMode;
      await this.publish(thread);
      return;
    }
    if (method === 'turn/started') {
      this.activeTurns.set(thread.id, p.turn.id);
      thread.updatedAt = Date.now() / 1000;
      await this.client.event(this.sessionId(thread.id), 'assistant.start', { turnId: p.turn.id });
      await this.publish(thread);
    } else if (method === 'turn/completed') {
      this.activeTurns.delete(thread.id);
      this.streams.delete(thread.id);
      thread.status = { type: 'idle' };
      thread.turns = [...(thread.turns || []).filter((t) => t.id !== p.turn.id), p.turn];
      thread.updatedAt = Date.now() / 1000;
      for (const item of p.turn.items || [])
        await this.item(thread.id, p.turn.id, item, true, Date.now());
      await this.client.event(this.sessionId(thread.id), 'assistant.done', {
        ok: p.turn.status !== 'failed',
        aborted: p.turn.status === 'interrupted',
        error: clipped(p.turn.error?.message, 2000),
      });
      await this.publish(thread);
      for (const request of [...this.requests.values()])
        if (request.params.threadId === thread.id && request.params.turnId === p.turn.id)
          await this.expireRequest(request);
    } else if (method === 'item/agentMessage/delta') {
      const text = clipped((this.streams.get(thread.id) || '') + p.delta, 256000);
      this.streams.set(thread.id, text);
      await this.client.event(this.sessionId(thread.id), 'assistant.delta', {
        text,
        turnId: p.turnId,
        itemId: p.itemId,
        phase: this.items.get(`${thread.id}:${p.itemId}`)?.phase,
      });
    } else if (method === 'item/started' || method === 'item/completed') {
      await this.item(thread.id, p.turnId, p.item, method === 'item/completed', Date.now(), true);
    } else if (method === 'item/commandExecution/outputDelta') {
      const key = `${thread.id}:${p.itemId}`;
      const output: ToolStream = this.toolStreams.get(key) || { text: '', lastAt: 0, count: 0 };
      output.text = (output.text + p.delta).slice(-64000);
      this.toolStreams.set(key, output);
      if (Date.now() - output.lastAt >= 500) {
        await this.flushToolOutput(thread.id, p.turnId, p.itemId, output);
      } else if (!output.timer) {
        output.timer = setTimeout(
          () => {
            output.timer = null;
            this.enqueue(() => this.flushToolOutput(thread.id, p.turnId, p.itemId, output)).catch(
              () => {},
            );
          },
          500 - (Date.now() - output.lastAt),
        );
      }
    } else if (method === 'turn/diff/updated') {
      await this.event(thread.id, 'tool.finished', `diff:${p.turnId}:${digest(p.diff)}`, {
        toolName: 'Diff',
        text: clipped(p.diff),
      });
    } else if (method === 'turn/plan/updated') {
      await this.event(
        thread.id,
        'tool.finished',
        `plan:${p.turnId}:${digest(JSON.stringify(p.plan))}`,
        {
          toolName: 'Plan',
          text: clipped(p.plan.map((step) => `${step.status}: ${step.step}`).join('\n')),
        },
      );
    } else if (method === 'thread/status/changed') {
      thread.status = p.status;
      if (p.status.type === 'notLoaded') {
        this.attached.delete(thread.id);
        this.activeTurns.delete(thread.id);
      }
      await this.publish(thread);
    } else if (method === 'thread/closed') {
      this.attached.delete(thread.id);
      this.activeTurns.delete(thread.id);
      thread.status = { type: 'notLoaded' };
      await this.publish(thread);
    }
  }

  /**
   * 只发送仍有效的输出缓冲区，避免已结束工具的迟到推送。
   * @param threadId Codex 主机线程标识。
   * @param turnId 主机执行轮次标识。
   * @param itemId 轮次内的工具或消息标识。
   * @param output 等待节流发送的累计工具输出。
   * @returns 操作完成的异步信号。
   */
  async flushToolOutput(threadId: string, turnId: string, itemId: string, output: ToolStream) {
    if (this.closed || this.toolStreams.get(`${threadId}:${itemId}`) !== output) return;
    output.lastAt = Date.now();
    await this.event(
      threadId,
      'tool.output',
      `output:${this.instance}:${turnId}:${itemId}:${output.count++}`,
      {
        toolName: 'Terminal',
        toolCallId: `${turnId}:${itemId}`,
        text: output.text,
        turnId,
        itemId,
      },
    );
  }

  /**
   * 限制可代理的主机请求，其余请求明确拒绝或交回主机处理。
   * @param message 协议消息或可展示的错误说明。
   * @returns 操作完成的异步信号。
   */
  async serverRequest(message: ServerRequest) {
    const { id, method, params: p } = message;
    const thread = this.threads.get(p.threadId);
    if (!thread || !this.projectFor(thread)) {
      this.rpc.reject(id, 'Thread is outside configured projects');
      return;
    }
    if (
      ![
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
      ].includes(method)
    ) {
      if (method === 'mcpServer/elicitation/request')
        this.rpc.respond(id, { action: 'decline', content: null });
      else this.rpc.reject(id);
      await this.event(thread.id, 'task.status', `unsupported:${this.instance}:${id}`, {
        text: `主机请求 ${method} 暂不支持，请在主机处理`,
      });
      return;
    }
    const request: PendingApproval = {
      ...message,
      id: `codex:${this.instance}:${id}`,
      rpcId: id,
      expiresAt: Date.now() + this.approvalTtlMs,
    };
    this.requests.set(JSON.stringify(id), request);
    request.timer = setTimeout(() => {
      this.enqueue(() => this.expireRequest(request)).catch(() => {});
    }, this.approvalTtlMs);
    await this.publishRequest(request);
  }

  /**
   * 将主机审批和输入问题转换为中心可显示的请求。
   * @param request 带期限和回执等待器的主机请求。
   * @returns 操作完成的异步信号。
   */
  async publishRequest(request: PendingApproval) {
    const p = request.params;
    const item = this.items.get(`${p.threadId}:${p.itemId}`);
    const input = request.method === 'item/tool/requestUserInput';
    const file = request.method === 'item/fileChange/requestApproval';
    const permissions = request.method === 'item/permissions/requestApproval';
    const details = permissions
      ? JSON.stringify(p.permissions, null, 2)
      : p.networkApprovalContext
        ? JSON.stringify(p.networkApprovalContext, null, 2)
        : [
            p.command || item?.command,
            p.reason,
            p.additionalPermissions ? JSON.stringify(p.additionalPermissions, null, 2) : '',
          ]
            .filter(Boolean)
            .join('\n\n');
    await this.client.approval({
      id: request.id,
      sessionId: this.sessionId(p.threadId),
      kind: input ? 'input' : file ? 'file_edit' : 'command',
      title: input
        ? 'Codex 需要你的回复'
        : clipped(
            p.reason ||
              (permissions
                ? 'Codex 请求额外权限'
                : file
                  ? 'Codex 请求修改文件'
                  : 'Codex 请求执行操作'),
            1000,
          ),
      command: clipped(details),
      filePath: clipped(item?.changes?.map((c) => c.path).join(', '), 4096),
      diff: clipped(item?.changes?.map((c) => `${c.path}\n${c.diff}`).join('\n\n')),
      questions: input ? p.questions : undefined,
      ttlMs: Math.max(1000, request.expiresAt - Date.now()),
    });
  }

  /**
   * 把手机选择映射为主机允许的决策值，并校验所有必答问题。
   * @param request 带期限和回执等待器的主机请求。
   * @param payload 当前操作、事件或 hook 的负载。
   * @returns 主机协议所需的回复正文。
   */
  response(request: PendingApproval, payload: CommandPayload) {
    const approve = payload.decision === 'approve';
    if (request.method === 'item/tool/requestUserInput') {
      if (!approve) return { answers: {} };
      return {
        answers: Object.fromEntries(
          (request.params.questions || []).map((q) => {
            const value = payload.answers?.[q.id];
            if (typeof value !== 'string' || !value.trim()) throw new Error('请回答所有问题');
            return [q.id, { answers: [value] }];
          }),
        ),
      };
    }
    if (request.method === 'item/permissions/requestApproval')
      return { permissions: approve ? request.params.permissions : {}, scope: 'turn' };
    const available = request.params.availableDecisions;
    const decision = approve
      ? 'accept'
      : available?.includes('decline') || !available
        ? 'decline'
        : 'cancel';
    if (available && !available.includes(decision))
      throw new Error('Codex 未提供本次授权选项，请在主机处理');
    return { decision };
  }

  /**
   * 提交决策后等待主机确认，传输写入成功不等于审批成功。
   * @param payload 当前操作、事件或 hook 的负载。
   * @returns 明确主机确认，或以超时、断线错误拒绝。
   */
  async answer(payload: CommandInput<'approvalId' | 'decision'>) {
    if (this.desktop?.requests.has(payload.approvalId)) return this.desktop.answer(payload);
    const request = [...this.requests.values()].find((r) => r.id === payload.approvalId);
    if (!request || request.expiresAt <= Date.now() || request.responding)
      throw new Error('问题或审批已结束');
    const response = this.response(request, payload);
    request.responding = true;
    request.outcome = payload.decision === 'approve' ? 'approved' : 'denied';
    // A pipe write is not a receipt: wait for the host to resolve this exact request.
    return new Promise<{
      /** 是否已得到主机的最终确认。 */
      confirmed: boolean;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex 审批确认超时，结果未知')), 20000);
      request.confirm = {
        /**
         * 完成请求并取消超时任务，避免已确认操作再次被报告为超时。
         * @param result 主机返回的操作结果。
         * @returns 无返回值。
         */
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        /**
         * 传播执行失败并取消超时任务，保持最终结果唯一。
         * @param error 主机或传输层报告的失败。
         * @returns 无返回值。
         */
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      try {
        this.rpc.respond(request.rpcId, response);
      } catch (cause) {
        const error = asError(cause);
        request.confirm!.reject(error);
      }
    });
  }

  /**
   * 清理已过期的主机请求，并同步中心状态。
   * @param request 带期限和回执等待器的主机请求。
   * @returns 操作完成的异步信号。
   */
  async expireRequest(request: PendingApproval) {
    if (!this.requests.delete(JSON.stringify(request.rpcId))) return;
    clearTimeout(request.timer);
    request.confirm?.reject(new Error('Codex 请求已结束'));
    if (!request.responding && this.rpc.ready)
      this.rpc.respond(request.rpcId, this.response(request, { decision: 'reject' }));
    await this.client.resolveApproval(request.id, 'expired');
  }

  /**
   * 释放实例持有的连接和计时器，使停止后不再接收或发送任务。
   * @returns 操作完成的异步信号。
   */
  async close() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.timer);
    this.desktop?.close();
    for (const output of this.toolStreams.values()) clearTimeout(output.timer ?? undefined);
    for (const request of [...this.requests.values()])
      await this.expireRequest(request).catch(this.onError);
    await this.rpc.close();
    await this.serial;
    await this.client.close();
  }
}
