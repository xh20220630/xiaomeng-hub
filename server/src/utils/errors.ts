/** 将未知异常规范为可展示的错误，避免 HTTP 和进程适配层直接假定抛出值的形状。 */

/** Node 系统错误及 HTTP 业务错误共用的可选元信息。 */
export interface ErrorDetails extends Error {
  /** Node 系统错误码，例如 ENOENT。 */
  code?: string;
  /** HTTP 业务错误状态；缺省视作内部错误。 */
  status?: number;
}

/**
 * 保留已有 Error 的身份，仅为非 Error 抛出值生成可读信息。
 * @param cause 捕获到的未知异常。
 * @returns 可安全读取 message、code 和 status 的错误。
 */
export function asError(cause: unknown): ErrorDetails {
  return cause instanceof Error ? cause : new Error(String(cause));
}
