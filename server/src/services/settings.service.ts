/** 合并已校验的设置并提供本机模型目录；持久化交给设置仓储。 */
import { readSettings, writeSettings } from '../repositories/settings.repository.js';
import type { SessionSettings } from '../types/domain.js';

/**
 * 读取会话的下一轮设置，供 CLI 与客户端摘要共用。
 * @param id 待处理实体的稳定标识。
 * @returns 保存的设置或空对象。
 */
export function sessionSettings(id: string): SessionSettings {
  return readSettings(id);
}

/**
 * 只合并已校验字段，保留未修改的设置。
 * @param id 待处理实体的稳定标识。
 * @param patch 要合并的局部设置或状态。
 * @returns 合并并保存后的设置。
 */
export function saveSessionSettings(id: string, patch: SessionSettings): SessionSettings {
  const settings = { ...readSettings(id), ...patch };
  writeSettings(id, settings);
  return settings;
}

/**
 * 从主机配置公开模型列表，仅接受可安全传给 CLI 的名称。
 * @returns 本机 Claude 的模型与模式目录。
 */
export function claudeCatalog() {
  const ids = (process.env.CLAUDE_MODELS || 'fable,opus,sonnet,haiku')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[a-zA-Z0-9._:/-]+$/.test(id));
  return {
    models: ids.map((id) => ({
      id,
      name: id,
      description: '由宿主机 Claude CLI 解析模型名称；可用性取决于主机账户',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })),
    modes: [
      { id: 'default', name: '执行' },
      { id: 'plan', name: '计划' },
    ],
    actions: [],
    settingsApply: 'next_turn',
    controlTransport: 'claude-cli',
  };
}
