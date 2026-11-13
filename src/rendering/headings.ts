import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorize } from "./components.ts";
import type { Role, ToolUiConfig } from "../config.ts";
import { cleanText, formatCallSummary, formatCodemodeNodeName, formatDuration, formatStatusLine } from "../format.ts";
import type { AgentLabel, AgentSummary } from "../nested/nested.ts";
import { nodeStatusLabel } from "../status.ts";
import { treeRows } from "./tree-layout.ts";
import type { NestedSummary, ToolRenderContext, ToolStatus } from "../types.ts";

/** 标题只消费调用方已取得的数据，不回查状态或触发 reconcile，也不缓存主题颜色。 */
export interface CallHeadingData {
  toolName: string;
  args: unknown;
  context: Pick<ToolRenderContext, "isError" | "isPartial" | "durationMs" | "expanded">;
  status: ToolStatus;
  subagent?: AgentSummary | null;
  codemode?: NestedSummary | null;
}
export const statusRole = (context: Pick<ToolRenderContext, "isError" | "durationMs" | "isPartial">): Role =>
  context.isError ? context.durationMs === undefined ? "cancelled" : "error" : context.isPartial ? "meta" : "success";

function callHeading(data: CallHeadingData, theme: Theme, config: ToolUiConfig, agent = "", mode = ""): string {
  const { toolName, args, context } = data;
  const token = formatStatusLine(data.status, undefined, config.statusStyle, false);
  const summary = formatCallSummary(toolName, args);
  return [
    token ? colorize(theme, config, statusRole(context), token) : "",
    colorize(theme, config, "call", cleanText(toolName).replace(/\s+/g, " ")),
    mode ? colorize(theme, config, "meta", mode) : "",
    agent,
    summary ? colorize(theme, config, "args", summary) : "",
    config.showDuration && context.durationMs !== undefined ? colorize(theme, config, "meta", formatDuration(context.durationMs)) : "",
  ].filter(Boolean).join(" ");
}
/** 节点状态只属于节点；成功不重复显示完成文字。 */
export function nodeHeading(name: string, label: AgentLabel, theme: Theme, config: ToolUiConfig, argumentSummary?: string): string {
  const role: Role = label === "error" ? "error" : label === "cancelled" ? "cancelled" : label === "running" || label === "pending" ? "args" : "meta";
  const icon = { "": "", running: "…", pending: "…", error: "✗", cancelled: "⊘", planned: "◇", incomplete: "?" }[label];
  return colorize(theme, config, role, `${name}${icon ? ` ${icon}` : ""}`) +
    (argumentSummary ? ` ${colorize(theme, config, "args", argumentSummary)}` : "");
}
function nodeLines<T>(nodes: readonly T[], heading: (node: T) => string, tree: boolean, separator: string, incomplete: boolean, theme: Theme, config: ToolUiConfig, expanded: boolean): string[] {
  const meta = (text: string) => colorize(theme, config, "meta", text);
  const suffix = incomplete ? meta(" · ?") : "";
  if (!tree) return [meta("  └ ") + nodes.map(heading).join(meta(separator)) + suffix];
  return treeRows(nodes, expanded, config.summaryMaxRows, incomplete).map(row =>
    meta(row.prefix) + (row.kind === "node" ? heading(row.node) : meta(`… +${row.count}`)) + (row.suffix ? meta(row.suffix) : ""));
}
/** tree 只需要根标题；single-inline 仍把首节点合入根标题。 */
export function rootCallHeading(data: CallHeadingData, theme: Theme, config: ToolUiConfig): string {
  const summary = data.toolName === "subagent" && config.subagentSummary ? data.subagent : null;
  if (!summary) return callHeading(data, theme, config);
  const first = summary.nodes[0];
  const agent = first && summary.mode === "single" && config.subagentLayout.single === "inline"
    ? nodeHeading(first.agent.text, first.label, theme, config) + (summary.incomplete ? colorize(theme, config, "meta", " · ?") : "") : "";
  return callHeading(data, theme, config, agent, summary.mode);
}
/** generic/native/inline 共用标题规则；子树只属于 call，不参与 result 的正文布局。 */
export function callHeadings(data: CallHeadingData, theme: Theme, config: ToolUiConfig): string[] {
  const { toolName, context } = data;
  if (toolName === "subagent" && config.subagentSummary && data.subagent) {
    const summary = data.subagent;
    const layout = config.subagentLayout[summary.mode];
    const root = rootCallHeading(data, theme, config);
    if (!summary.nodes.length || summary.mode === "single" && layout === "inline") return [root];
    return [root, ...nodeLines(summary.nodes, node => nodeHeading(node.agent.text, node.label, theme, config),
      layout === "tree", summary.mode === "chain" ? " → " : " · ", summary.incomplete, theme, config, context.expanded)];
  }
  const lines = [rootCallHeading(data, theme, config)];
  if (toolName !== "codemode" || !config.codemodeSummary || !data.codemode) return lines;
  const summary = data.codemode;
  return [...lines, ...nodeLines(summary.calls,
    call => nodeHeading(formatCodemodeNodeName(call.name), nodeStatusLabel(call.status), theme, config, config.codemodeShowArguments ? call.argumentSummary : undefined),
    config.codemodeLayout === "tree", " · ", !summary.complete, theme, config, context.expanded)];
}
