import type { ToolRecord, ToolRenderContext, ToolStatus } from "./types.ts";

const EVENT_STATUS_RANK: Record<ToolStatus, number> = { pending: 0, running: 1, success: 2, cancelled: 3, error: 4 };
export const isTerminalStatus = (status: ToolStatus): boolean => status !== "pending" && status !== "running";

/** 只收敛事件：终态不被迟到 partial 覆盖，冲突终态保留失败。 */
export function mergeEventStatus(current: ToolStatus, incoming: ToolStatus): ToolStatus {
  return EVENT_STATUS_RANK[incoming] > EVENT_STATUS_RANK[current] ? incoming : current;
}
export function executionStatus(isError: boolean, durationMs?: number): ToolStatus {
  return isError ? durationMs === undefined ? "cancelled" : "error" : "success";
}
/** 标题以当前宿主上下文为准；记录仅辅助判断 partial 是否已开始执行。 */
export function deriveDisplayStatus(context: Pick<ToolRenderContext, "isPartial" | "isError" | "durationMs" | "executionStarted">, record?: Pick<ToolRecord, "status">): ToolStatus {
  if (context.isPartial) return context.executionStarted || record?.status === "running" ? "running" : "pending";
  return executionStatus(context.isError, context.durationMs);
}
/** 两种历史协议使用不同白名单；未知值不能被解释为成功。 */
export function nestedEventStatus(value: unknown, native: boolean): ToolStatus | undefined {
  switch (value) {
    case "ok": return "success";
    case "error": return "error";
    case "cancelled": return native ? "cancelled" : undefined;
    case "running": return native ? "running" : undefined;
    case "unfinished": return native ? undefined : "running";
    default: return undefined;
  }
}
/** 子节点成功不重复显示图标，其余执行状态保留原语义。 */
export const nodeStatusLabel = (status: ToolStatus): Exclude<ToolStatus, "success"> | "" => status === "success" ? "" : status;
