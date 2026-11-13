import type { ToolUiConfig } from "../config.ts";
import type { CallHeadingData } from "../rendering/headings.ts";
import { formatCodemodeNodeName } from "../format.ts";
import { isToolIncluded } from "../matcher.ts";
import { buildSubagentNodes, MISSING_RESULT, nestedRootArguments, readSubagentNodeDetail, safeNestedRootResult, subagentSummary, type NestedNode, type NestedNodeDetail } from "./nested.ts";
import { deriveDisplayStatus, nodeStatusLabel } from "../status.ts";
import type { ToolUiState } from "../runtime/state.ts";
import type { GroupPosition, NestedCallSummary, NestedSummary, ToolRenderContext } from "../types.ts";

// 视图投影可以读取状态，但协议解析、标题格式化和交互组件都不反向读取状态聚合根。
export function buildCodemodeNodes(summary: NestedSummary | null): NestedNode[] {
  // 名称在可见节点排版时才清理；投影仅持有当前帧摘要，不跨帧缓存。
  return summary?.calls.map(call => ({ id: call.id, get name() { return formatCodemodeNodeName(call.name); },
    label: nodeStatusLabel(call.status), argumentSummary: call.argumentSummary })) ?? [];
}
export function readCodemodeNodeDetail(state: ToolUiState, rootId: string, nodeId: string, calls: ReadonlyMap<string, NestedCallSummary> | null): NestedNodeDetail {
  const snapshot = state.nestedDetail(rootId, nodeId);
  const duration = state.records.get(nodeId)?.durationMs;
  // Map 来自调用方当前帧的根摘要；null 表示本帧已知无摘要，不能再次协调。
  const summary = calls?.get(nodeId)?.argumentSummary;
  return { lines: [...(snapshot?.args?.lines.length ? snapshot.args.lines : summary ? [`参数摘要: ${summary}`] : []),
    ...(snapshot?.metadata?.lines ?? []), ...(snapshot?.result?.lines ?? [MISSING_RESULT]), ...(typeof duration === "number" && Number.isFinite(duration) ? [`耗时: ${duration}ms`] : [])],
    incomplete: !!(snapshot?.args?.incomplete || snapshot?.result?.incomplete || snapshot?.metadata?.incomplete),
    sourceTruncated: snapshot?.result?.sourceTruncated,
    retentionTruncated: !!(snapshot?.args?.retentionTruncated || snapshot?.result?.retentionTruncated || snapshot?.metadata?.retentionTruncated) };
}
export interface NestedFrame {
  config: ToolUiConfig;
  group?: GroupPosition;
  expanded: boolean;
  tree: boolean;
  heading: CallHeadingData;
  nodes: NestedNode[];
  incomplete: boolean;
  emptyIncomplete: boolean;
  isExpanded(id: string): boolean;
  detail(id: string): NestedNodeDetail;
  rootArguments(): string[];
}

/** 每个 slot 绑定原参数、上下文与 generation；不跨帧缓存派生摘要或子节点正文。 */
export class NestedToolView {
  private readonly generation: number;
  constructor(private readonly state: ToolUiState, private readonly toolName: string,
    private readonly args: unknown, private readonly context: ToolRenderContext) {
    state.bind({ toolCallId: context.toolCallId, toolName, args: context.args }, context.invalidate);
    state.syncNestedHost(context.toolCallId, context.expanded);
    this.generation = state.generation;
  }
  get valid(): boolean { return this.generation === this.state.generation; }
  frame(withGroup: boolean): NestedFrame | undefined {
    if (!this.valid) return undefined;
    const { state, toolName, args, context: ctx } = this;
    // 外部展开先同步；只有宿主值真实变化才全开，重复重绘不能覆盖独立点击。
    state.syncNestedHost(ctx.toolCallId, ctx.expanded);
    const expanded = state.isNestedRootExpanded(ctx.toolCallId);
    const config = state.config, record = state.records.get(ctx.toolCallId);
    const summary = toolName === "subagent" && record ? subagentSummary(record) : undefined;
    const active = isActive(config, toolName);
    const tree = active && (toolName === "subagent" ? !!summary && config.subagentLayout[summary.mode] === "tree" : config.codemodeLayout === "tree");
    // 一次 render 只获取一次摘要；索引仅在当前调用栈存活，下一帧重新读取可变 records。
    const codemode = toolName === "codemode" && config.codemodeSummary ? state.nestedSummary(ctx.toolCallId) ?? null : null;
    const calls = tree && codemode ? new Map(codemode.calls.map(call => [call.id, call])) : null;
    const nodes = !tree ? [] : toolName === "subagent" ? record ? buildSubagentNodes(record, summary ?? null) : [] : buildCodemodeNodes(codemode);
    return {
      config, group: withGroup ? state.group(ctx.toolCallId) : undefined, expanded, tree, nodes,
      heading: { toolName, args, context: ctx, status: deriveDisplayStatus(ctx, record), subagent: summary ?? null, codemode },
      incomplete: toolName === "subagent" ? !!summary?.incomplete : !codemode?.complete,
      emptyIncomplete: tree && !nodes.length && state.nestedIncomplete(ctx.toolCallId),
      isExpanded: id => state.isNestedExpanded(ctx.toolCallId, id),
      // 目标实际展开后才读取详情；未展开的 subagent 正文 getter 不得被预读。
      detail: id => toolName === "subagent" ? readSubagentNodeDetail(record!, id) : readCodemodeNodeDetail(state, ctx.toolCallId, id, calls),
      rootArguments: () => nestedRootArguments(toolName, args),
    };
  }
  resultFrame(result: unknown, withGroup: boolean) {
    if (!this.valid) return undefined;
    const { state, context: ctx } = this;
    state.syncNestedHost(ctx.toolCallId, ctx.expanded);
    const expanded = state.isNestedRootExpanded(ctx.toolCallId);
    return { config: state.config, group: withGroup ? state.group(ctx.toolCallId) : undefined,
      expanded, context: { ...ctx, expanded }, result: safeNestedRootResult(result) };
  }
  toggle(id?: string): void {
    // 旧组件的回调不能操作同 ID 的新会话记录。
    if (!this.valid) return;
    if (id) this.state.toggleNested(this.context.toolCallId, id);
    else this.state.toggleAllNested(this.context.toolCallId);
  }
}

function isActive(config: ToolUiConfig, toolName: string): boolean {
  return isToolIncluded(config, toolName) && (toolName === "subagent" ? config.subagentSummary : config.codemodeSummary);
}
