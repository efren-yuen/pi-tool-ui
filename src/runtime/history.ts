import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ToolUiState } from "./state.ts";
import { nestedGet } from "../nested/nested.ts";

/** 仅接收 getBranch() 的活动路径；不读会话文件，也不遍历全局 entries。 */
export function rebuildHistory(state: ToolUiState, branch: readonly SessionEntry[]): void {
  state.clear();
  for (const entry of branch) {
    if (entry.type === "message") observeMessage(state, entry.message, true);
    else if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "compaction") state.boundary();
  }
}
export function observeMessage(state: ToolUiState, message: AgentMessage, historical = false): void {
  if (message.role === "assistant") {
    // 先审查身份和父关系，再允许源顺序变更及读取参数；冲突块不影响已有顺序。
    const accepted = new Map<unknown, { toolCallId: string; toolName: string; parentToolCallId?: string }>();
    const identities = new Map<string, { toolName: string; parentToolCallId?: string }>();
    for (const block of message.content) {
      if (nestedGet(block, "type") !== "toolCall") continue;
      try {
        const { id, name } = block as { id?: unknown; name?: unknown };
        const parent = (block as { parentToolCallId?: unknown }).parentToolCallId;
        if (typeof id !== "string" || !id || typeof name !== "string" || !name || parent !== undefined && (typeof parent !== "string" || !parent)) continue;
        const identity = { toolCallId: id, toolName: name, parentToolCallId: parent as string | undefined };
        const previous = identities.get(id);
        if (!state.acceptsIdentity(identity) || previous && (previous.toolName !== name || previous.parentToolCallId !== parent)) continue;
        identities.set(id, identity); accepted.set(block, identity);
      } catch { /* 损坏的身份 getter 不参与排序，也不读取参数。 */ }
    }
    state.prepareAssistant([...accepted.values()].map(call => call.toolCallId));
    for (const block of message.content) {
      const identity = accepted.get(block);
      if (identity) state.sourceCall({ ...identity, get args() { return nestedGet(block, "arguments"); } });
      else {
        const type = nestedGet(block, "type");
        const text = nestedGet(block, type === "thinking" ? "thinking" : type === "text" ? "text" : "type");
        if ((type === "text" || type === "thinking") && typeof text === "string" && text.trim()) state.boundary();
      }
    }
  } else if (message.role === "toolResult") {
    const existing = state.records.get(message.toolCallId);
    if (existing && existing.toolName !== message.toolName) return;
    if (historical || !state.records.get(message.toolCallId)?.result) {
      state.end({ toolCallId: message.toolCallId, toolName: message.toolName, result: message, isError: message.isError, durationMs: message.durationMs });
    } else state.observeNested(message.toolCallId, message.nestedCalls, message.details, message.toolName);
  } else if (message.role !== "system") state.boundary();
}
