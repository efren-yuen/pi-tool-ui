type TreeRow<T> = ({ kind: "node"; node: T } | { kind: "omitted"; count: number }) & { prefix: string; suffix: string };

/** 只计算可见树行，不读状态、不加颜色；两个渲染路径共用末行和省略提示规则。 */
export function treeRows<T>(nodes: readonly T[], expanded: boolean, maxRows: number, incomplete: boolean): TreeRow<T>[] {
  const limit = !expanded && maxRows > 0 ? maxRows : nodes.length;
  const shown = nodes.slice(0, limit), omitted = nodes.length - shown.length;
  const rows: TreeRow<T>[] = shown.map((node, i) => {
    const last = i === shown.length - 1 && !omitted;
    return { kind: "node", node, prefix: last ? "  └ " : "  ├ ", suffix: last && incomplete ? " · ?" : "" };
  });
  if (omitted) rows.push({ kind: "omitted", count: omitted, prefix: "  └ ", suffix: incomplete ? " · ?" : "" });
  return rows;
}
