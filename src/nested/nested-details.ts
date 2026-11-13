import { boundDetail, detailBytes, NESTED_ITEM_BYTES, NESTED_ROOT_BYTES, type NestedNodeDetail, type NestedSnapshot } from "./nested.ts";

type DetailKind = "args" | "result" | "metadata";

/** 只接收状态层已经确认归属的有界详情；不解析载荷，不建立身份，也不触发协调或刷新。 */
export class NestedDetails {
  private readonly snapshots = new Map<string, Map<string, NestedSnapshot>>();
  get(rootId: string, childId: string): NestedSnapshot | undefined { return this.snapshots.get(rootId)?.get(childId); }
  retain(rootId: string, childId: string, kind: DetailKind, detail: NestedNodeDetail, final = false): void {
    let cache = this.snapshots.get(rootId);
    // 先排除将被替换的旧 slot；partial 被 final 替换时释放旧预算，而不是追加占用。
    const snapshot: NestedSnapshot = { ...cache?.get(childId), [kind]: undefined };
    const bytes = (entry: NestedSnapshot) => detailBytes(entry.args) + detailBytes(entry.result) + detailBytes(entry.metadata);
    let total = 0;
    for (const [id, entry] of cache ?? []) if (id !== childId) total += bytes(entry);
    if (kind === "metadata") {
      // 迟到错误/cost 优先占用本 child 的额度；先保留 args，再裁剪 result，不能挤占其他 root。
      const metadata = boundDetail(detail, Math.min(NESTED_ITEM_BYTES, NESTED_ROOT_BYTES - total));
      let remaining = Math.min(NESTED_ITEM_BYTES, NESTED_ROOT_BYTES - total) - detailBytes(metadata);
      if (snapshot.args) { snapshot.args = boundDetail(snapshot.args, remaining); remaining -= detailBytes(snapshot.args); }
      if (snapshot.result) snapshot.result = boundDetail(snapshot.result, remaining);
      snapshot.metadata = metadata;
    } else {
      const retained = bytes(snapshot);
      snapshot[kind] = boundDetail(detail, Math.min(NESTED_ITEM_BYTES - retained, NESTED_ROOT_BYTES - total - retained));
    }
    if (kind === "result") snapshot.final = final;
    if (!cache) { cache = new Map(); this.snapshots.set(rootId, cache); }
    cache.set(childId, snapshot);
  }
  /** 状态层决定真实归属；容量删除或重新归属后，旧根的详情必须同步释放。 */
  prune(owns: (rootId: string, childId: string) => boolean): void {
    for (const [rootId, cache] of this.snapshots) {
      for (const id of cache.keys()) if (!owns(rootId, id)) cache.delete(id);
      if (!cache.size) this.snapshots.delete(rootId);
    }
  }
  clear(): void { this.snapshots.clear(); }
}
