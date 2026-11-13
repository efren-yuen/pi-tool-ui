import { DEFAULT_CONFIG, type ToolUiConfig } from "../config.ts";
import { resolveToolGroup } from "../matcher.ts";
import { executionStatus, isTerminalStatus, mergeEventStatus, nestedEventStatus } from "../status.ts";
import { buildSubagentNodes, nestedGet, snapshotCodemodeArgs, snapshotCodemodeMetadata, snapshotCodemodeResult, type NestedNodeDetail, type NestedSnapshot } from "../nested/nested.ts";
import { NestedDetails } from "../nested/nested-details.ts";
import type { GroupPosition, NestedCallSummary, NestedSummary, ToolRecord, ToolResultData, ToolStatus } from "../types.ts";

const NESTED_LIMIT = 256;
// 固定审查前缀允许重复条目，但绝不扫描任意长后缀；保留容量仍为每根 256。
const METADATA_SCAN_LIMIT = 512;
interface NestedView { expanded: Set<string>; rootExpanded: boolean; followAll: boolean; hostExpanded?: boolean }
interface NestedIndex {
  calls: Map<string, NestedCallSummary>;
  truncated: boolean;
  metadataComplete?: boolean;
  nativeComplete?: boolean;
}

interface CallIdentity { toolCallId: string; toolName: string; args?: unknown; parentToolCallId?: string }
export class ToolUiState {
  config: ToolUiConfig = DEFAULT_CONFIG;
  readonly records = new Map<string, ToolRecord>();
  // null 是真实消息边界，不把跨用户消息的同名组连接起来。
  readonly order: (string | null)[] = [];
  private readonly orderPositions = new Map<string, number>();
  private orderIndexDirty = false;
  private epoch = 0;
  // 仅 UI bind/ensure 的身份尚可补父；执行或消息源确认后的根不可降为 child。
  private confirmedIdentities = new WeakSet<ToolRecord>();
  private readonly nested = new Map<string, NestedIndex>();
  private readonly nestedDetails = new NestedDetails();
  private readonly nestedExpanded = new Map<string, NestedView>();
  // 丢失未知父链后无法证明它属于哪个根；直到 clear 都保守地报告不完整。
  private unresolvedTruncated = false;

  acceptsIdentity(call: CallIdentity): boolean {
    const record = this.records.get(call.toolCallId);
    if (record && record.toolName !== call.toolName) return false;
    if (record && call.parentToolCallId && record.parentToolCallId !== call.parentToolCallId &&
      (record.parentToolCallId || this.confirmedIdentities.has(record))) return false;
    return true;
  }
  /** 只建立身份；调用方负责协调归属和容量，确认后才能读取子调用载荷。 */
  private insertIdentity(call: CallIdentity): ToolRecord | undefined {
    // 身份冲突先于参数/结果/getter、状态、缓存和刷新；消息源预审也共用此门禁。
    if (!this.acceptsIdentity(call)) return undefined;
    let record = this.records.get(call.toolCallId);
    if (!record) {
      record = { toolCallId: call.toolCallId, toolName: call.toolName, parentToolCallId: call.parentToolCallId,
        args: call.parentToolCallId ? undefined : call.args, status: "pending", executionStarted: false, isError: false };
      this.records.set(call.toolCallId, record);
      if (!call.parentToolCallId) {
        this.orderPositions.set(call.toolCallId, this.order.length);
        this.order.push(call.toolCallId);
      }
    } else {
      if (call.parentToolCallId && !record.parentToolCallId) {
        record.parentToolCallId = call.parentToolCallId;
        record.args = record.result = record.partialResult = undefined;
        const i = this.position(call.toolCallId);
        if (i >= 0) { this.order.splice(i, 1); this.orderIndexDirty = true; }
      }
      if (!record.parentToolCallId && call.args !== undefined) record.args = call.args;
    }
    return record;
  }
  ensure(call: CallIdentity): ToolRecord | undefined {
    const previous = this.records.get(call.toolCallId), previousParent = previous?.parentToolCallId;
    const record = this.insertIdentity(call);
    if (!record) return undefined;
    if (!previous || previousParent !== record.parentToolCallId) {
      const changed = this.reconcile();
      const retained = this.records.has(record.toolCallId);
      const root = retained ? this.root(record) : undefined;
      for (const parent of changed) if (parent !== root) parent.invalidate?.();
      if (!retained) return undefined;
    }
    // 父关系和容量确认后才读参数；不保留原始对象，也不让改名事件污染摘要。
    if (record.parentToolCallId && !record.argumentSummary && record.toolName === call.toolName) {
      try {
        const detail = snapshotCodemodeArgs(record.toolName, call.args);
        if (detail.summary) record.argumentSummary = detail.summary;
        const accepted = this.acceptedNested(call);
        if (accepted && (detail.lines.length || detail.incomplete)) this.retainDetail(accepted.root, record, "args", detail);
      } catch { /* 参数 getter 损坏不影响状态，也不回显异常。 */ }
    }
    return record;
  }
  prepareAssistant(ids: readonly string[]): void {
    const calls = new Set(ids);
    // 流式 UI 可能先绑定组件；最终 assistant 源顺序仍具有优先权。
    for (let i = this.order.length - 1; i >= 0; i--) if (calls.has(this.order[i] ?? "")) {
      this.order.splice(i, 1); this.orderIndexDirty = true;
    }
  }
  sourceCall(call: CallIdentity): void {
    const record = this.ensure(call);
    if (!record) return;
    this.confirmedIdentities.add(record);
    if (!record.parentToolCallId && this.position(call.toolCallId) < 0) {
      this.orderPositions.set(call.toolCallId, this.order.length);
      this.order.push(call.toolCallId);
    }
  }
  boundary(): void {
    if (this.order.length && this.order.at(-1) !== null) this.order.push(null);
  }
  start(call: CallIdentity): void {
    const record = this.ensure(call);
    if (!record) return;
    this.confirmedIdentities.add(record);
    record.status = mergeEventStatus(record.status, "running");
    record.executionStarted = true;
    this.captureNestedStart(call);
    this.refresh(record);
    if (!record.parentToolCallId) this.invalidateAll();
  }
  update(call: CallIdentity & { partialResult: ToolResultData }): void {
    const record = this.ensure(call);
    if (!record) return;
    this.confirmedIdentities.add(record);
    if (!isTerminalStatus(record.status)) {
      if (!record.parentToolCallId) record.partialResult = this.rootResult(record, call.partialResult);
      record.status = "running";
      this.captureNestedUpdate(call);
    }
    this.refresh(record);
  }
  end(call: CallIdentity & { result: ToolResultData; isError: boolean; durationMs?: number }): void {
    const record = this.ensure(call);
    if (!record) return;
    this.confirmedIdentities.add(record);
    const result = !record.parentToolCallId ? this.rootResult(record, call.result) : undefined;
    const incoming = executionStatus(call.isError, call.durationMs);
    const status = mergeEventStatus(record.status, incoming);
    // 只有胜出的终态可替换正文；失败后的成功不能覆盖诊断，同优先级 final 仍可补齐结果。
    if (status === incoming) {
      if (!record.parentToolCallId) record.result = result;
      record.partialResult = undefined;
      record.isError = call.isError;
      record.durationMs = call.durationMs;
    }
    record.status = status;
    if (status === incoming) this.captureNestedEnd(call);
    this.refresh(record);
  }
  observeResult(call: CallIdentity & { content: readonly unknown[]; details?: unknown; isError: boolean; nestedCalls?: unknown }): void {
    const accepted = !!this.acceptedNested(call);
    const record = this.ensure(call);
    if (!record) return;
    this.confirmedIdentities.add(record);
    const result = !record.parentToolCallId ? this.rootResult(record, call) : undefined;
    if (!record.parentToolCallId && !isTerminalStatus(record.status)) {
      record.result = result;
      record.isError = call.isError;
    }
    if (accepted) this.captureNestedResult(call, call);
    this.refresh(record);
    // 只观察；tool_execution_end 提供最终状态、耗时，不在 middleware 返回补丁。
  }
  /** 先有界提取 trace，再保存父自身 details；codemode 根绝不持有源 calls 引用。 */
  private rootResult(record: ToolRecord, result: { content: readonly unknown[]; details?: unknown; nestedCalls?: unknown }): ToolResultData {
    const details = nestedGet(result, "details");
    this.restoreNested(record, nestedGet(result, "nestedCalls"));
    this.restoreNested(record, details, true);
    if (record.toolName !== "codemode") return { content: result.content, details };
    const path = nestedGet(details, "fullOutputPath");
    const ownDetails = typeof path === "string" ? { fullOutputPath: path.slice(0, 4096) } : undefined;
    return { content: result.content, details: ownDetails };
  }
  /** message_end 可能晚于 execution_end，仍须接收最终 metadata。 */
  observeNested(toolCallId: string, value: unknown, details?: unknown, toolName?: string): void {
    const record = this.records.get(toolCallId);
    if (!record || toolName !== undefined && toolName !== record.toolName || value === undefined && details === undefined) return;
    this.restoreNested(record, value);
    this.restoreNested(record, details, true);
    this.refresh(record);
  }
  private root(record: ToolRecord, cache?: Map<string, ToolRecord | undefined>): ToolRecord | undefined {
    const seen = new Set<string>();
    let current: ToolRecord | undefined = record;
    while (current) {
      if (cache?.has(current.toolCallId)) { current = cache.get(current.toolCallId); break; }
      if (seen.has(current.toolCallId)) { current = undefined; break; }
      seen.add(current.toolCallId);
      if (!current.parentToolCallId) break;
      current = this.records.get(current.parentToolCallId);
    }
    for (const id of seen) cache?.set(id, current);
    return current;
  }
  private index(id: string): NestedIndex {
    let index = this.nested.get(id);
    if (!index) { index = { calls: new Map(), truncated: false }; this.nested.set(id, index); }
    return index;
  }
  /** 待定父链最多保留 256 条；先解析完整父链，再限制孤儿（含循环和溢出节点的后代）。 */
  private reconcile(): Set<ToolRecord> {
    const changed = new Set<ToolRecord>();
    // 仅单次扫描缓存父链，深链不重复遍历；删除记录后不跨扫描复用。
    const roots = new Map<string, ToolRecord | undefined>();
    for (const record of this.records.values()) {
      if (!record.parentToolCallId) continue;
      const root = this.root(record, roots);
      if (root?.toolName !== "codemode") continue;
      const index = this.index(root.toolCallId);
      const previous = index.calls.get(record.toolCallId);
      if (!previous && index.calls.size >= NESTED_LIMIT) {
        index.truncated = true;
        record.invalidate = undefined;
        this.records.delete(record.toolCallId);
        changed.add(root);
        continue;
      }
      if (!previous || previous.status !== record.status || previous.argumentSummary !== record.argumentSummary) {
        index.calls.set(record.toolCallId, { id: record.toolCallId, name: record.toolName, status: record.status,
          ...(record.argumentSummary ? { argumentSummary: record.argumentSummary } : {}) });
        changed.add(root);
      }
    }
    let unresolved = 0;
    roots.clear();
    for (const record of this.records.values()) {
      if (!record.parentToolCallId || this.root(record, roots)) continue;
      if (++unresolved <= NESTED_LIMIT) continue;
      record.invalidate = undefined;
      this.records.delete(record.toolCallId);
      if (!this.unresolvedTruncated) {
        this.unresolvedTruncated = true;
        for (const root of this.records.values()) if (!root.parentToolCallId && root.toolName === "codemode") changed.add(root);
      }
    }
    // 归属与容量仍由同一状态事务判断；存储层只执行释放，不能自行收养孤儿或猜根。
    this.nestedDetails.prune((rootId, id) => {
      const child = this.records.get(id);
      return !!child && this.root(child, roots)?.toolCallId === rootId;
    });
    return changed;
  }
  private refresh(record: ToolRecord): void {
    const changed = this.reconcile();
    const root = this.root(record);
    if (root && (!record.parentToolCallId || root.toolName === "codemode")) changed.add(root);
    for (const parent of changed) parent.invalidate?.();
  }
  nestedSummary(toolCallId: string): NestedSummary | undefined {
    this.reconcile();
    const record = this.records.get(toolCallId);
    const index = this.nested.get(toolCallId);
    if (record?.toolName !== "codemode" || !index?.calls.size) return undefined;
    const calls = [...index.calls.values()];
    return { calls, complete: !this.unresolvedTruncated && !index.truncated && index.metadataComplete !== false && index.nativeComplete !== false && isTerminalStatus(record.status) && calls.every(call => isTerminalStatus(call.status)) };
  }
  private restoreNested(record: ToolRecord, value: unknown, native = false): void {
    if (record.toolName !== "codemode" || record.parentToolCallId || value === undefined) return;
    const index = this.index(record.toolCallId), flag = native ? "nativeComplete" : "metadataComplete";
    let complete = true, readFailures = 0;
    const get = (object: unknown, key: string): unknown => {
      try { return object !== null && typeof object === "object" ? (object as Record<string, unknown>)[key] : undefined; }
      catch { complete = false; readFailures++; return undefined; }
    };
    const object = (v: unknown): boolean => {
      try { return !!v && typeof v === "object" && !Array.isArray(v); }
      catch { complete = false; return false; }
    };
    if (!object(value)) { index[flag] = false; return; }
    if (!native) complete = get(value, "complete") === true;
    const calls = get(value, "calls");
    // 非 codemode details 没有 calls，不能把它当作损坏 trace。
    if (native && calls === undefined) { if (!complete) index[flag] = false; return; }
    let length: unknown;
    try { if (Array.isArray(calls)) length = get(calls, "length"); }
    catch { complete = false; }
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) { index[flag] = false; return; }
    if (length > METADATA_SCAN_LIMIT) { complete = false; index.truncated = true; }
    const valid = new Map<string, { id: string; name: string; parent?: string; status: ToolStatus; items: unknown[] }>();
    const nonempty = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && v.trim().length > 0;
    // 只读取固定数字前缀一次；后续处理只遍历自己创建的有限集合，不碰源 iterator。
    for (let i = 0; i < Math.min(length, METADATA_SCAN_LIMIT); i++) {
      const item = get(calls, String(i));
      if (!object(item)) { complete = false; continue; }
      const id = get(item, "id"), name = get(item, "name");
      if (!nonempty(id, 4096) || !nonempty(name, 512) || id === record.toolCallId || id === `${record.toolCallId}/?`) { complete = false; continue; }
      const previous = valid.get(id), existing = this.records.get(id);
      // 改名与跨根冲突必须先于 status、参数、错误、耗时等 getter。
      if (previous && previous.name !== name || existing && existing.toolName !== name) { complete = false; continue; }
      const root = existing && this.root(existing);
      if (root && root.toolCallId !== record.toolCallId) { complete = false; continue; }
      let namespace: string | undefined;
      for (let slash = id.indexOf("/"); slash >= 0; slash = id.indexOf("/", slash + 1)) {
        const candidate = this.records.get(id.slice(0, slash));
        if (candidate && !candidate.parentToolCallId) namespace = candidate.toolCallId;
      }
      if (namespace !== undefined && namespace !== record.toolCallId) { complete = false; continue; }
      if (native) {
        const model = name === "models.classify" || name === "models.generateImages";
        const prefix = `${record.toolCallId}/${model ? `${name}/` : ""}`;
        if (!id.startsWith(prefix) || !/^[1-9]\d*$/.test(id.slice(prefix.length)) || name.startsWith("models.") && !model) { complete = false; continue; }
      }
      const failures = readFailures, parent = get(item, "parentToolCallId");
      if (failures !== readFailures || parent !== undefined && !nonempty(parent, 4096) || typeof parent === "string" &&
        (!this.acceptsIdentity({ toolCallId: id, toolName: name, parentToolCallId: parent }) || previous?.parent !== undefined && previous.parent !== parent)) {
        complete = false; continue;
      }
      if (previous) { previous.parent ??= parent as string | undefined; previous.items.push(item); }
      else valid.set(id, { id, name, parent: parent as string | undefined, status: "pending", items: [item] });
    }
    // 先证明父链，再读 status/载荷。稀疏 metadata 省略祖先不等于重新指定父级。
    const parents = new Map<string, string>();
    for (const entry of valid.values()) {
      let parent = record.toolCallId;
      if (!native) for (const id of valid.keys()) if (id !== entry.id && entry.id.startsWith(`${id}/`) && id.length > parent.length) parent = id;
      const existing = this.records.get(entry.id);
      if (entry.parent !== undefined) parent = entry.parent;
      else if (existing?.parentToolCallId && this.root(existing) === record) {
        // 批次仅列出更远祖先时，也不能把已确认的直接 parent 压平。
        let ancestor = existing.parentToolCallId;
        while (ancestor !== parent && ancestor !== record.toolCallId) ancestor = this.records.get(ancestor)!.parentToolCallId!;
        if (ancestor === parent) parent = existing.parentToolCallId;
      }
      if (this.acceptsIdentity({ toolCallId: entry.id, toolName: entry.name, parentToolCallId: parent })) parents.set(entry.id, parent);
      else complete = false;
    }
    const belongs = (id: string): boolean => {
      const seen = new Set<string>();
      while (id !== record.toolCallId) {
        if (seen.has(id) || valid.has(id) && !parents.has(id)) return false;
        seen.add(id);
        const parent = parents.get(id) ?? this.records.get(id)?.parentToolCallId;
        if (!parent) return false;
        id = parent;
      }
      return true;
    };
    let retained = 0;
    for (const [id, entry] of valid) {
      if (!parents.has(id) || !belongs(id)) { complete = false; valid.delete(id); continue; }
      if (retained >= NESTED_LIMIT) { index.truncated = true; complete = false; valid.delete(id); continue; }
      const items: unknown[] = [];
      for (const item of entry.items) {
        const status = nestedEventStatus(get(item, "status"), native);
        if (!status) { complete = false; continue; }
        entry.status = mergeEventStatus(entry.status, status); items.push(item);
      }
      entry.items = items;
      if (!items.length) { valid.delete(id); continue; }
      retained++;
    }
    // 无淘汰、无待定父链时，身份可一次建立；否则保留逐条协调的收养/淘汰优先顺序。
    // 这里只看状态身份，不读取源条目的载荷，也不缓存到下一批次。
    let batch = valid.size > 0;
    // 空批次无需扫描资格；下方原有的最终协调和刷新仍照常执行。
    if (batch) {
      const roots = new Map<string, ToolRecord | undefined>();
      const known = new Set<string>([record.toolCallId]), reserved = new Set(index.calls.keys());
      for (const child of this.records.values()) {
        if (!child.parentToolCallId) continue;
        const root = this.root(child, roots);
        if (!root) batch = false;
        if (root === record) { known.add(child.toolCallId); reserved.add(child.toolCallId); }
      }
      for (const entry of valid.values()) {
        const existing = this.records.get(entry.id);
        if (!known.has(parents.get(entry.id)!) || existing && !existing.parentToolCallId) batch = false;
        known.add(entry.id); reserved.add(entry.id);
      }
      if (reserved.size > NESTED_LIMIT) batch = false;
    }
    const accepted = new Map<string, ToolRecord>();
    for (const entry of valid.values()) {
      const identity = { toolCallId: entry.id, toolName: entry.name, parentToolCallId: parents.get(entry.id) };
      const child = batch ? this.insertIdentity(identity) : this.ensure(identity);
      if (!child) { complete = false; continue; }
      accepted.set(entry.id, child);
    }
    const changed = this.reconcile();
    for (const root of changed) if (root !== record) root.invalidate?.();
    // 所有祖先建立且实际归属再次确认后，才能读载荷或合并状态。
    for (const entry of valid.values()) {
      const child = accepted.get(entry.id);
      if (!child || this.acceptedNested({ toolCallId: entry.id, toolName: entry.name })?.root !== record) { complete = false; continue; }
      const stale = isTerminalStatus(child.status) && !isTerminalStatus(entry.status);
      child.status = mergeEventStatus(child.status, entry.status);
      if (native && stale) continue;
      for (const item of entry.items) {
        if (child.durationMs === undefined) {
          const duration = get(item, "durationMs");
          if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) child.durationMs = duration;
        }
        if (native) {
          const detail = snapshotCodemodeMetadata(item, this.nestedDetail(record.toolCallId, child.toolCallId)?.metadata);
          if (detail.incomplete) complete = false;
          this.retainDetail(record, child, "metadata", detail);
        } else if (!child.argumentSummary) {
          const detail = snapshotCodemodeArgs(child.toolName, get(item, "arguments"));
          if (detail.summary) child.argumentSummary = detail.summary;
          if (detail.incomplete) complete = false;
          if (detail.lines.length || detail.incomplete) this.retainDetail(record, child, "args", detail);
        }
      }
    }
    index[flag] = complete;
  }
  /** 只有已证明归属且容量内、名字一致的 codemode child 才能读取详情。 */
  private acceptedNested(call: CallIdentity): { root: ToolRecord; child: ToolRecord } | undefined {
    const child = this.records.get(call.toolCallId);
    if (!child?.parentToolCallId || child.toolName !== call.toolName || call.parentToolCallId && child.parentToolCallId !== call.parentToolCallId) return undefined;
    const root = this.root(child);
    if (root?.toolName !== "codemode" || !this.nested.get(root.toolCallId)?.calls.has(child.toolCallId)) return undefined;
    return { root, child };
  }
  private captureNested(call: CallIdentity, kind: "args" | "result", value: unknown, final = false): void {
    const accepted = this.acceptedNested(call);
    if (!accepted) return;
    const { root, child } = accepted;
    const previous = this.nestedDetails.get(root.toolCallId, child.toolCallId);
    // 已接受的参数详情不被占位摘要擦除，final 正文也不能退回迟到的 partial。
    if (kind === "args" && previous?.args?.lines.length || kind === "result" && previous?.final && !final) return;
    // 先确认身份，再读取白名单；丢弃旧 partial 后计算可用空间。
    const detail = kind === "args" ? { lines: child.argumentSummary ? [`参数摘要: ${child.argumentSummary}`] : [], incomplete: false } : snapshotCodemodeResult(value);
    if (kind !== "args" || detail.lines.length) this.retainDetail(root, child, kind, detail, final);
  }
  private retainDetail(root: ToolRecord, child: ToolRecord, kind: "args" | "result" | "metadata", detail: NestedNodeDetail, final = false): void {
    this.nestedDetails.retain(root.toolCallId, child.toolCallId, kind, detail, final);
  }
  captureNestedStart(call: CallIdentity): void { this.captureNested(call, "args", undefined); }
  captureNestedUpdate(call: CallIdentity, result?: unknown): void {
    if (!this.acceptedNested(call)) return;
    this.captureNested(call, "result", result ?? nestedGet(call, "partialResult"));
  }
  captureNestedEnd(call: CallIdentity, result?: unknown): void {
    if (!this.acceptedNested(call)) return;
    this.captureNestedStart(call); this.captureNested(call, "result", result ?? nestedGet(call, "result"), true);
  }
  captureNestedResult(call: CallIdentity, result: unknown): void {
    this.captureNestedStart(call); this.captureNested(call, "result", result, true);
  }
  nestedDetail(rootId: string, childId: string): NestedSnapshot | undefined { return this.nestedDetails.get(rootId, childId); }
  private nestedIds(rootId: string): string[] {
    const record = this.records.get(rootId);
    return record?.toolName === "subagent" ? buildSubagentNodes(record).map(node => node.id) : this.nestedSummary(rootId)?.calls.map(call => call.id) ?? [];
  }
  private view(rootId: string): NestedView {
    let view = this.nestedExpanded.get(rootId);
    if (!view) { view = { expanded: new Set(), rootExpanded: false, followAll: false }; this.nestedExpanded.set(rootId, view); }
    return view;
  }
  private setAllNested(rootId: string, expanded: boolean, ids = expanded ? this.nestedIds(rootId) : []): void {
    const view = this.view(rootId);
    view.rootExpanded = view.followAll = expanded;
    view.expanded = new Set(expanded ? ids : []);
  }
  /** 两个 slot 共用；只响应宿主值的真实变化，不在普通重绘时覆盖独立点击。 */
  syncNestedHost(rootId: string, expanded: boolean): void {
    const view = this.view(rootId);
    if (view.hostExpanded !== expanded && (view.hostExpanded !== undefined || expanded)) this.setAllNested(rootId, expanded);
    view.hostExpanded = expanded;
  }
  isNestedRootExpanded(rootId: string): boolean { return this.nestedExpanded.get(rootId)?.rootExpanded ?? false; }
  nestedIncomplete(rootId: string): boolean {
    const index = this.nested.get(rootId);
    return !!index && (index.truncated || index.metadataComplete === false || index.nativeComplete === false);
  }
  isNestedExpanded(rootId: string, childId: string): boolean {
    const view = this.nestedExpanded.get(rootId);
    return !!view && (view.followAll || view.expanded.has(childId));
  }
  toggleNested(rootId: string, childId: string): void {
    const ids = this.nestedIds(rootId);
    if (!ids.includes(childId)) return;
    const view = this.view(rootId);
    // 独立点击后停止自动跟随新增节点；已打开的兄弟保持不变。
    if (view.followAll) { view.expanded = new Set(ids); view.followAll = false; }
    if (view.expanded.has(childId)) view.expanded.delete(childId); else view.expanded.add(childId);
    this.records.get(rootId)?.invalidate?.();
  }
  // 子节点全开不代表根自身参数区已开；rootExpanded 与 expanded 集合是两个独立维度。
  nestedExpansionState(rootId: string): "none" | "some" | "all" {
    const ids = this.nestedIds(rootId);
    const count = ids.filter(id => this.isNestedExpanded(rootId, id)).length;
    return count === 0 ? "none" : count === ids.length ? "all" : "some";
  }
  toggleAllNested(rootId: string): void {
    const ids = this.nestedIds(rootId);
    const all = ids.every(id => this.isNestedExpanded(rootId, id));
    this.setAllNested(rootId, !(this.isNestedRootExpanded(rootId) && all), ids);
    this.records.get(rootId)?.invalidate?.();
  }
  bind(call: CallIdentity, invalidate: () => void): void {
    const record = this.ensure(call);
    if (record) record.invalidate = invalidate;
  }
  invalidateAll(): void {
    for (const record of this.records.values()) if (!record.parentToolCallId) record.invalidate?.();
  }
  setConfig(config: ToolUiConfig): void {
    this.config = config;
    this.invalidateAll();
  }
  /** 源顺序变化后只重建一次索引；分组查询不再逐行线性查找位置。 */
  private position(toolCallId: string): number {
    if (this.orderIndexDirty) {
      this.orderPositions.clear();
      this.order.forEach((id, i) => { if (id !== null) this.orderPositions.set(id, i); });
      this.orderIndexDirty = false;
    }
    return this.orderPositions.get(toolCallId) ?? -1;
  }
  group(toolCallId: string): GroupPosition | undefined {
    const i = this.position(toolCallId);
    const record = this.records.get(toolCallId);
    if (i < 0 || !record || record.parentToolCallId) return undefined;
    const g = resolveToolGroup(this.config, record.toolName);
    if (!g) return undefined;
    const neighbor = (index: number) => {
      const id = this.order[index];
      const r = id ? this.records.get(id) : undefined;
      return r ? resolveToolGroup(this.config, r.toolName)?.id : undefined;
    };
    return { id: g.id, label: g.label, first: neighbor(i - 1) !== g.id, last: neighbor(i + 1) !== g.id };
  }
  get generation(): number { return this.epoch; }
  /** 先释放回调和详情，再推进 generation；旧 slot 即使持有同 ID，也不能操作新分支。 */
  clear(): void {
    for (const r of this.records.values()) r.invalidate = undefined;
    this.nestedDetails.clear(); this.nestedExpanded.clear();
    this.records.clear(); this.confirmedIdentities = new WeakSet(); this.nested.clear(); this.unresolvedTruncated = false; this.order.length = 0;
    this.orderPositions.clear(); this.orderIndexDirty = false; this.epoch++;
  }
}
