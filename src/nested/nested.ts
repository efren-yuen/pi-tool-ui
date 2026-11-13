import { truncateToWidth } from "@earendil-works/pi-tui";
import { cleanText, formatCallSummary } from "../format.ts";
import { isTerminalStatus } from "../status.ts";
import type { ToolRecord } from "../types.ts";

// 这里只解释 subagent、历史 nestedCalls 与原生 trace 的安全数据形状；不读取会话状态。
// 协议缺失或损坏不等于成功，正文也不能用来猜测节点身份或补全历史。

export type AgentMode = "single" | "parallel" | "chain";
export type AgentLabel = "" | "planned" | "pending" | "running" | "error" | "cancelled" | "incomplete";
interface AgentName { text: string; key?: string }
interface AgentNode { agent: AgentName; label: AgentLabel; reliable: boolean; slot: number }
export interface AgentSummary { mode: AgentMode; nodes: AgentNode[]; incomplete: boolean }
export interface NestedNode { id: string; name: string; label: AgentLabel; slot?: number; argumentSummary?: string; available?: boolean }
export interface NestedNodeDetail { lines: string[]; incomplete: boolean; sourceTruncated?: boolean; retentionTruncated?: boolean }
export interface NestedSnapshot { args?: NestedNodeDetail; result?: NestedNodeDetail; metadata?: NestedNodeDetail; final?: boolean }
export const NESTED_ITEM_BYTES = 16 * 1024;
export const NESTED_ROOT_BYTES = 256 * 1024;
export const MISSING_RESULT = "结果未保存";
export const RETENTION_NOTICE = "详情未保存/超出 UI 保留上限（UI预算已截断）";
export const SOURCE_TRUNCATION_NOTICE = "原始工具输出已截断";
export function nestedDetailNotices(detail: NestedNodeDetail): string[] {
  return [...(detail.sourceTruncated ? [SOURCE_TRUNCATION_NOTICE] : []),
    ...(detail.retentionTruncated ? [RETENTION_NOTICE] : []),
    ...(detail.incomplete && !detail.sourceTruncated && !detail.retentionTruncated ? ["详情不完整或部分字段不可读取"] : [])];
}

/** 读取白名单字段；坏 getter 不传播异常，也不回显异常对象。 */
export function nestedGet(value: unknown, key: string): unknown {
  try { return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
function rawArrayLength(value: unknown): number {
  try {
    const n = nestedGet(value, "length");
    return Array.isArray(value) && typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

/** 摘要阶段绝不读取任务、消息或错误正文；槽位身份不依赖名称。 */
export function subagentSummary(record: ToolRecord, target?: { id: string; item?: unknown }): AgentSummary | undefined {
  let incomplete = false, readFailures = 0;
  const get = (value: unknown, key: string): unknown => {
    try { return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
    catch { incomplete = true; readFailures++; return undefined; }
  };
  const length = (value: unknown): number | undefined => {
    try {
      if (!Array.isArray(value)) { if (value !== undefined) incomplete = true; return undefined; }
      const n = get(value, "length");
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) { incomplete = true; return undefined; }
      if (n > 64) incomplete = true;
      return Math.min(n, 64);
    } catch { incomplete = true; return undefined; }
  };
  const name = (value: unknown): AgentName | undefined => {
    if (typeof value !== "string") return undefined;
    if (value.length > 512) incomplete = true;
    const safe = cleanText(value.slice(0, 512)).replace(/[\s\u2028\u2029]+/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").trim();
    return safe ? { text: truncateToWidth(safe, 64), key: value.length <= 512 ? value : undefined } : undefined;
  };
  const args = record.args;
  const chain = get(args, "chain"), tasks = get(args, "tasks"), single = get(args, "agent");
  const modes = [chain !== undefined && "chain", tasks !== undefined && "parallel", single !== undefined && "single"].filter(Boolean) as AgentMode[];
  if (modes.length > 1 || readFailures) return undefined;
  const plannedMode = modes[0];
  const plan: (AgentName | undefined)[] = [];
  if (plannedMode === "single") {
    const agent = name(single);
    if (!agent) return undefined;
    plan.push(agent);
  } else if (plannedMode) {
    const list = plannedMode === "chain" ? chain : tasks;
    const n = length(list);
    if (!n) return undefined;
    for (let i = 0; i < n; i++) {
      const agent = name(get(get(list, String(i)), "agent"));
      if (!agent || readFailures) return undefined;
      plan.push(agent);
    }
  }
  const active = !isTerminalStatus(record.status);
  const partial = active ? get(record.partialResult, "details") : undefined;
  const details = partial ?? get(record.result, "details");
  const rawMode = get(details, "mode");
  const validMode = rawMode === "single" || rawMode === "parallel" || rawMode === "chain";
  if (details !== undefined && !validMode) incomplete = true;
  if (validMode && plannedMode !== undefined && rawMode !== plannedMode) return undefined;
  const mode = validMode ? rawMode : plannedMode;
  if (!mode) return undefined;
  const results = validMode ? get(details, "results") : undefined;
  const n = length(results);
  if (validMode && n === undefined) incomplete = true;
  if (mode === "single" && n !== undefined && n !== 1) incomplete = true;
  if (mode === "parallel" && plan.length && n !== undefined && n > plan.length) incomplete = true;
  const nodes: AgentNode[] = [];
  const same = (a?: AgentName, b?: AgentName) => a?.key !== undefined && a.key === b?.key;
  const add = (agent: AgentName, label: AgentLabel, slot: number) => nodes.push({ agent, label, slot, reliable: label !== "planned" });
  const resultAt = (i: number): { agent?: AgentName; label: AgentLabel; valid: boolean } => {
    const failures = readFailures;
    const item = get(results, String(i));
    const agent = name(get(item, "agent"));
    const source = get(item, "agentSource"), exit = get(item, "exitCode"), step = get(item, "step"), stop = get(item, "stopReason");
    const valid = readFailures === failures && !!agent && (source === undefined || typeof source === "string") &&
      (step === undefined || Number.isSafeInteger(step) && step === i + 1) &&
      (stop === undefined || typeof stop === "string") && (exit === undefined || typeof exit === "number" && Number.isSafeInteger(exit));
    if (!valid) incomplete = true;
    if (valid && target?.id === `${record.toolCallId}:result:${i}`) target.item = item;
    let label: AgentLabel = "incomplete";
    if (valid) {
      if (stop === "aborted") label = "cancelled";
      else if (stop === "error" || typeof exit === "number" && exit !== 0 && exit !== -1) label = "error";
      else if (exit === -1) label = "pending";
      else if (exit !== 0 || agent?.key === undefined) incomplete = true;
      else if (active) label = "running";
      else if (record.status === "success") label = "";
      else if (mode === "chain" && i < (n ?? 0) - 1) label = "";
    }
    return { agent, label, valid };
  };
  if (mode === "single") {
    const item = n ? resultAt(0) : undefined;
    const agent = item?.agent ?? plan[0];
    if (agent) add(agent, item?.valid ? n === 1 ? item.label : "incomplete" : "planned", 0);
  } else if (mode === "parallel") {
    for (let i = 0; i < (plan.length || n || 0); i++) {
      const item = i < (n ?? 0) ? resultAt(i) : undefined, planned = plan[i];
      if (plan.length) {
        if (item && (!item.valid || !same(item.agent, planned))) incomplete = true;
        if (planned) add(planned, item?.valid && same(item.agent, planned) ? item.label : "planned", i);
      } else if (item?.valid && item.agent) add(item.agent, item.label, i);
    }
  } else {
    if (!active && record.status === "success" && plan.length > (n ?? 0)) incomplete = true;
    for (let i = 0; i < (n ?? 0); i++) {
      const item = resultAt(i);
      if (!item.valid || !item.agent || plan.length && !same(item.agent, plan[i])) { incomplete = true; break; }
      add(item.agent, active && i < (n ?? 0) - 1 && item.label === "running" ? "" : item.label, i);
      if (["error", "cancelled", "pending", "incomplete"].includes(item.label)) {
        if (i < (n ?? 0) - 1) incomplete = true;
        break;
      }
    }
  }
  return { mode, nodes, incomplete };
}
export function buildSubagentNodes(record: ToolRecord, summary: AgentSummary | null = subagentSummary(record) ?? null): NestedNode[] {
  return summary?.nodes.map(node => ({ id: `${record.toolCallId}:result:${node.slot}`, name: node.agent.text,
    label: node.label, slot: node.slot, available: node.reliable })) ?? [];
}

/** UTF-8 预算包含换行；只保留已接受的前缀，不保存源对象。 */
export function boundDetail(detail: NestedNodeDetail, budget: number): NestedNodeDetail {
  const lines: string[] = [];
  let remaining = Math.max(0, budget), incomplete = detail.incomplete, retentionTruncated = detail.retentionTruncated;
  for (const line of detail.lines) {
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes <= remaining) { lines.push(line); remaining -= bytes; continue; }
    let prefix = "";
    for (const char of line) {
      const size = Buffer.byteLength(char, "utf8");
      if (size + 1 > remaining) break;
      prefix += char; remaining -= size;
    }
    if (prefix) lines.push(prefix);
    incomplete = retentionTruncated = true; break;
  }
  return { ...detail, lines, incomplete, ...(retentionTruncated ? { retentionTruncated } : {}) };
}
export const detailBytes = (detail?: NestedNodeDetail): number => detail?.lines.reduce((n, line) => n + Buffer.byteLength(line, "utf8") + 1, 0) ?? 0;
function collector() {
  const detail: NestedNodeDetail = { lines: [], incomplete: false };
  let used = 0, stopped = false;
  return {
    detail,
    text(value: unknown, label = "") {
      if (stopped || typeof value !== "string") return;
      // 清理前先限制输入，避免巨大正文复制；多字节文本随后再按字节裁剪。
      const safe = cleanText(value.slice(0, NESTED_ITEM_BYTES));
      const part = boundDetail({ lines: [`${label}${safe}`], incomplete: value.length > NESTED_ITEM_BYTES,
        ...(value.length > NESTED_ITEM_BYTES ? { retentionTruncated: true } : {}) }, NESTED_ITEM_BYTES - used);
      detail.lines.push(...part.lines); detail.incomplete ||= part.incomplete; detail.retentionTruncated ||= part.retentionTruncated; used += detailBytes(part);
      stopped ||= part.incomplete;
    },
    full() { return stopped || used >= NESTED_ITEM_BYTES; },
  };
}
function appendContent(content: unknown, out: ReturnType<typeof collector>): void {
  const length = rawArrayLength(content), n = Math.min(length, 256);
  if (length > n) out.detail.incomplete = out.detail.retentionTruncated = true;
  let i = 0;
  for (; i < n && !out.full(); i++) {
    const block = nestedGet(content, String(i)), type = nestedGet(block, "type");
    if (type === "text") out.text(nestedGet(block, "text"));
    else if (type === "image") {
      const mime = nestedGet(block, "mimeType"), alt = nestedGet(block, "alt");
      out.text(`▧ ${typeof mime === "string" ? cleanText(mime.slice(0, 128)) : "未知媒体类型"}${typeof alt === "string" ? ` · ${cleanText(alt.slice(0, 512))}` : ""} [图片数据未保留]`);
    } else out.text("[未知或不可读取的内容块]");
  }
  if (i < n) out.detail.incomplete = out.detail.retentionTruncated = true;
  if (!n && content !== undefined) out.text("[内容不可读取或为空]");
}
export function snapshotCodemodeArgs(toolName: string, args: unknown): NestedNodeDetail & { summary: string } {
  // 详情只增加已支持的路径/命令/搜索字段；不读 edit/write 正文或未知参数。
  const keys = ["read", "write", "edit", "ls"].includes(toolName) ? ["path", "file_path"]
    : ["grep", "find"].includes(toolName) ? ["pattern", "path", "file_path"]
    : ["bash", "powershell"].includes(toolName) ? ["command"] : ["title", "description", "label", "name"];
  const known = ["read", "write", "edit", "ls", "grep", "find", "bash", "powershell"].includes(toolName);
  const safe: Record<string, string> = {}, out = collector();
  for (const key of keys) {
    if (out.full()) break;
    let value: unknown;
    try { value = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined; }
    catch { out.detail.incomplete = true; continue; }
    if (typeof value !== "string") continue;
    safe[key] = cleanText(value.slice(0, NESTED_ITEM_BYTES));
    if (known) out.text(value, `${key}: `);
    if (value.length > NESTED_ITEM_BYTES) out.detail.incomplete = out.detail.retentionTruncated = true;
    if (key === "path" && safe[key]) keys.splice(keys.indexOf("file_path"), 1);
  }
  const summary = formatCallSummary(toolName, safe);
  if (!known && summary) out.text(summary, "参数摘要: ");
  return { ...out.detail, summary };
}
/** 原生 trace 只是参数/错误预览，不冒充完整结果。 */
export function snapshotCodemodeMetadata(item: unknown, previous?: NestedNodeDetail): NestedNodeDetail {
  const out = collector();
  const get = (key: string): unknown => {
    try { return item !== null && typeof item === "object" ? (item as Record<string, unknown>)[key] : undefined; }
    catch { out.detail.incomplete = true; return undefined; }
  };
  const args = get("args"), error = get("error"), cost = get("cost");
  // 只合并三个公开预览字段；缺失/损坏值不能擦除先前已保留的有效字段。
  const keep = (prefix: string) => previous?.lines.find(line => line.startsWith(prefix));
  if (typeof args === "string" && args) out.text(args.slice(0, 200), "参数预览: ");
  else out.text(keep("参数预览: "));
  if (typeof error === "string" && error) out.text(error.slice(0, 500), "错误预览: ");
  else out.text(keep("错误预览: "));
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) out.text(`cost: ${cost}`);
  else out.text(keep("cost: "));
  out.detail.incomplete ||= previous?.incomplete ?? false;
  out.detail.retentionTruncated ||= previous?.retentionTruncated;
  if (typeof args === "string" && args.length > 200 || typeof error === "string" && error.length > 500) {
    out.detail.incomplete = out.detail.retentionTruncated = true;
  }
  return out.detail;
}
export function snapshotCodemodeResult(result: unknown): NestedNodeDetail {
  const out = collector();
  const content = nestedGet(result, "content"), details = nestedGet(result, "details");
  const path = nestedGet(details, "fullOutputPath");
  if (typeof path === "string") {
    out.text(path.slice(0, 4096), "完整输出路径: ");
    if (path.length > 4096) out.detail.incomplete = out.detail.retentionTruncated = true;
  }
  if (nestedGet(nestedGet(details, "truncation"), "truncated") === true) {
    out.detail.incomplete = out.detail.sourceTruncated = true;
  }
  appendContent(content, out);
  out.text(nestedGet(result, "errorMessage"), "错误: ");
  if (!out.full()) {
    out.text(nestedGet(details, "errorMessage"), "错误: ");
    out.text(nestedGet(details, "stderr"), "stderr: ");
  }
  if (!out.detail.lines.length) out.text(content === undefined ? MISSING_RESULT : "无文字结果");
  return out.detail;
}
export function readSubagentNodeDetail(record: ToolRecord, nodeId: string): NestedNodeDetail {
  // 验证与正文读取共用同一个目标 item；动态 Proxy 不能在二次取槽时换入别的结果。
  const target: { id: string; item?: unknown } = { id: nodeId };
  const node = buildSubagentNodes(record, subagentSummary(record, target) ?? null).find(node => node.id === nodeId);
  if (!node?.available) return { lines: [MISSING_RESULT], incomplete: false };
  const item = target.item;
  if (!item) return { lines: [MISSING_RESULT], incomplete: false };
  const out = collector();
  out.text(nestedGet(item, "task"), "任务: ");
  const messages = nestedGet(item, "messages"), length = rawArrayLength(messages), n = Math.min(length, 128);
  let i = 0;
  for (; i < n && !out.full(); i++) {
    const message = nestedGet(messages, String(i));
    const content = nestedGet(message, "content");
    if (typeof content === "string") out.text(content);
    else appendContent(content, out);
  }
  if (i < n || length > n) out.detail.incomplete = out.detail.retentionTruncated = true;
  if (!out.full()) appendContent(nestedGet(item, "content"), out);
  if (!out.full()) out.text(nestedGet(item, "stderr"), "stderr: ");
  if (!out.full()) out.text(nestedGet(item, "errorMessage"), "错误: ");
  if (!out.detail.lines.length) out.text(MISSING_RESULT);
  if (!out.full()) {
    const exit = nestedGet(item, "exitCode");
    if (typeof exit === "number" && Number.isSafeInteger(exit)) out.text(`exitCode: ${exit}`);
    const usage = nestedGet(item, "usage");
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "turns"]) {
      const value = nestedGet(usage, key);
      if (typeof value === "number" && Number.isFinite(value)) out.text(`usage.${key}: ${value}`);
    }
    const cost = nestedGet(nestedGet(usage, "cost"), "total");
    if (typeof cost === "number" && Number.isFinite(cost)) out.text(`usage.cost.total: ${cost}`);
  }
  return out.detail;
}

/** 父参数也只读明确字段；绝不枚举未知对象或触发 toJSON。 */
export function nestedRootArguments(toolName: string, args: unknown): string[] {
  const lines: string[] = [];
  for (const key of toolName === "codemode" ? ["title", "description", "code", "script"] : ["title", "description", "agent", "task"]) {
    const value = nestedGet(args, key);
    if (typeof value === "string") lines.push(`${key}: ${cleanText(value)}`);
  }
  for (const key of ["agentScope", "confirmProjectAgents", "maxConcurrency"]) {
    const value = nestedGet(args, key);
    if (typeof value === "string") lines.push(`${key}: ${cleanText(value)}`);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) lines.push(`${key}: ${value}`);
  }
  // 并行/链的 task 属于各 child，不在父级展开时读取。
  return lines;
}

/** 父结果使用相同白名单媒体路径，保留正文而不枚举 details。 */
type SafeRootBlock = { type: "text"; text: string } | { type: "image"; mimeType: string; alt?: string; data: string };
export function safeNestedRootResult(result: unknown): { content: SafeRootBlock[]; details: undefined } {
  // 父结果不使用 child 的保留预算；逐块清理，坏字段安全降级。
  const content = nestedGet(result, "content");
  const blocks: SafeRootBlock[] = [];
  const length = rawArrayLength(content), n = Math.min(length, 4096);
  for (let i = 0; i < n; i++) {
    const block = nestedGet(content, String(i)), type = nestedGet(block, "type");
    if (type === "text") {
      const text = nestedGet(block, "text");
      blocks.push({ type: "text", text: typeof text === "string" ? cleanText(text) : "[内容不可读取]" });
    } else if (type === "image") {
      const mime = nestedGet(block, "mimeType"), alt = nestedGet(block, "alt");
      blocks.push({ type: "image", data: "", mimeType: typeof mime === "string" ? cleanText(mime.slice(0, 128)) : "未知媒体类型", alt: typeof alt === "string" ? cleanText(alt.slice(0, 512)) : undefined });
    } else blocks.push({ type: "text", text: "[未知或不可读取的内容块]" });
  }
  if (length > n) blocks.push({ type: "text", text: RETENTION_NOTICE });
  const path = nestedGet(nestedGet(result, "details"), "fullOutputPath");
  if (typeof path === "string") blocks.push({ type: "text", text: `完整输出路径: ${cleanText(path.slice(0, 4096))}` });
  return { content: blocks, details: undefined };
}
