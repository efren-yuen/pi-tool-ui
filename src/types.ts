import type { ToolRenderers } from "@earendil-works/pi-coding-agent";

// 宿主公开 renderer 签名包含上下文，但 1.5.0 未从根入口单独导出该类型。
export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

export type ToolStatus = "pending" | "running" | "success" | "error" | "cancelled";
// 历史参数仅用于白名单短摘要；仍须运行时校验，不读取错误正文。
export interface NestedCallData {
  id: string;
  name: string;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  arguments?: unknown;
  argumentsBytes?: number;
}
export interface NestedCallsData { calls: readonly NestedCallData[]; complete?: boolean }
export interface NestedCallSummary { id: string; name: string; status: ToolStatus; argumentSummary?: string }
export interface NestedSummary { calls: readonly NestedCallSummary[]; complete: boolean }
export interface ToolResultData {
  content: readonly unknown[];
  details?: unknown;
  nestedCalls?: NestedCallsData;
}
export interface ToolRecord {
  toolCallId: string;
  toolName: string;
  parentToolCallId?: string;
  args: unknown;
  argumentSummary?: string;
  partialResult?: ToolResultData;
  result?: ToolResultData;
  isError: boolean;
  durationMs?: number;
  executionStarted: boolean;
  status: ToolStatus;
  invalidate?: () => void;
}
export interface ConfigDiagnostic { path: string; message: string }
export interface GroupPosition { id: string; label: string; first: boolean; last: boolean }
export interface ImagePlaceholder { type: "image"; mimeType: string; alt?: string }
