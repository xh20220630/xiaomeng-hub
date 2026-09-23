/** 单元测试使用真实适配器外壳替换协议方法，避免为未测试的方法伪造不完整类实例。 */
import { CodexAgent, type CodexAgentOptions } from '../../src/adapters/codex/codex-agent.js';
import { CodexRpc } from '../../src/adapters/codex/codex-rpc.js';
import { AgentClient } from '../../src/sdk/agent-client.js';

/** 测试只覆写当前场景涉及的传输方法。 */
type FixtureOptions = Omit<CodexAgentOptions, 'rpc' | 'client' | 'stateFile'> & {
  /** App Server 方法替身，不建立真实进程连接。 */
  rpc: object;
  /** 中心 HTTP 方法替身，不发送网络请求。 */
  client: object;
  /** 仅涉及身份保存的场景才需要设置。 */
  stateFile?: string;
};

/**
 * 提供完整运行时依赖，并仅覆写测试给出的行为。
 * @param options 同步范围及当前场景的方法替身。
 * @returns 尚未连接的 Codex 适配器。
 */
export function createTestAgent(options: FixtureOptions): CodexAgent {
  const rpc = Object.assign(new CodexRpc(), options.rpc);
  const client = Object.assign(
    new AgentClient({ hubUrl: 'http://127.0.0.1:1', agentKey: 'fixture', name: 'Fixture' }),
    options.client,
  );
  return new CodexAgent({
    ...options,
    rpc,
    client,
    stateFile: options.stateFile || 'unused-fixture-state.json',
  });
}
