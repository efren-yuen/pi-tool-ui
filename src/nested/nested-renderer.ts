import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { colorize, createGroupDecoration, DynamicComponent, textLines } from "../rendering/components.ts";
import { callHeadings, nodeHeading, rootCallHeading } from "../rendering/headings.ts";
import { nestedDetailNotices } from "./nested.ts";
import type { NestedToolView } from "./nested-view.ts";
import { treeRows } from "../rendering/tree-layout.ts";
import type { ToolRenderContext } from "../types.ts";

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
type ViewFactory = (args: unknown, context: ToolRenderContext) => NestedToolView;
interface Hit { row: number; start: number; end: number; id?: string }

/** 只处理布局与命中，不读聚合状态；正文 click 消费，选择生命周期不 capture、不抢焦点。 */
export class NestedTreeComponent implements Component {
  private hits: Hit[] = [];
  private width = 0;
  private height = 0;
  constructor(private readonly theme: Theme, private readonly view: NestedToolView) {}
  invalidate(): void { this.hits = []; this.height = 0; }
  render(width: number): string[] {
    this.width = width; this.hits = []; this.height = 0;
    if (width <= 0) return [];
    const frame = this.view.frame(width >= 4);
    if (!frame) return [];
    const { config, group, expanded, tree, nodes } = frame, theme = this.theme;
    const rail = group ? 2 : 0, header = group?.first ? 1 : 0, inner = width - rail;
    const lines: string[] = [];
    const add = (line: string, start?: number, id?: string) => {
      const rendered = truncateToWidth(line, inner);
      if (start !== undefined) {
        // 分组标题和 rail 改变坐标原点；截断省略号不属于可点击的原始标题。
        const end = visibleWidth(line) > inner ? visibleWidth(truncateToWidth(line, Math.max(0, inner - 3), "")) : visibleWidth(line);
        if (end > start) this.hits.push({ row: header + lines.length, start: rail + start, end: rail + end, id });
      }
      lines.push(rendered);
    };
    if (!tree) callHeadings(frame.heading, theme, config).forEach((title, i) => add(title, i === 0 ? 0 : undefined));
    else {
      add(rootCallHeading(frame.heading, theme, config) + (frame.emptyIncomplete ? colorize(theme, config, "meta", " · ?") : ""), 0);
      for (const row of treeRows(nodes, expanded, config.summaryMaxRows, frame.incomplete)) {
        if (row.kind === "omitted") { add(colorize(theme, config, "meta", `${row.prefix}… +${row.count}${row.suffix}`)); continue; }
        const node = row.node;
        const title = nodeHeading(node.name, node.label, theme, config, config.codemodeShowArguments ? node.argumentSummary : undefined);
        const glyph = frame.isExpanded(node.id) ? "▾ " : "▸ ";
        add(colorize(theme, config, "meta", row.prefix + glyph) + title + (row.suffix ? colorize(theme, config, "meta", row.suffix) : ""), 4, node.id);
        if (frame.isExpanded(node.id)) {
          const detail = frame.detail(node.id);
          for (const line of [...detail.lines, ...nestedDetailNotices(detail)]) {
            for (const physical of textLines(colorize(theme, config, "result", line), Math.max(1, inner - 4))) add("    " + physical);
          }
        }
      }
    }
    if (expanded) for (const line of frame.rootArguments()) {
      for (const physical of textLines(colorize(theme, config, "args", line), inner)) add(physical);
    }
    const decorated = createGroupDecoration(lines, width, group, theme, config, true);
    this.height = decorated.length;
    return decorated;
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.view.valid || event.width !== this.width || event.type !== "click" || event.button !== "left" ||
      event.x < 0 || event.x >= this.width || event.y < 0 || event.y >= this.height) return undefined;
    const hit = this.hits.find(hit => event.y === hit.row && event.x >= hit.start && event.x < hit.end);
    if (!hit) return { handled: true, render: false };
    this.view.toggle(hit.id);
    this.hits = [];
    return { handled: true };
  }
}
export function createInlineNestedCallRenderer(createView: ViewFactory): CallRenderer {
  return (args, theme, ctx) => new NestedTreeComponent(theme, createView(args, ctx));
}
/** result slot 也阻断外层 MouseRegion 的 click，但不拦截 press/drag/release。 */
class NestedResultComponent extends DynamicComponent {
  private width = 0;
  private height = 0;
  constructor(draw: (width: number) => string[], private readonly view: NestedToolView) { super(draw); }
  override render(width: number): string[] {
    this.width = width;
    const lines = this.view.valid && width > 0 ? super.render(width) : [];
    this.height = lines.length;
    return lines;
  }
  override invalidate(): void { this.height = 0; }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.view.valid || event.width !== this.width || event.x < 0 || event.x >= this.width || event.y < 0 || event.y >= this.height || event.button !== "left" || event.type !== "click") return undefined;
    return { handled: true, render: false };
  }
}
export function createInlineNestedResultRenderer(createView: ViewFactory, generic: ResultRenderer): ResultRenderer {
  return (result, options, theme, ctx) => {
    const view = createView(ctx.args, ctx);
    return new NestedResultComponent(width => {
      const frame = view.resultFrame(result, width >= 4);
      if (!frame) return [];
      // 根结果已由视图做白名单投影；通用 renderer 仍负责错误、图片元信息与正文排版。
      const lines = generic(frame.result, { ...options, expanded: frame.expanded }, theme, frame.context).render(width - (frame.group ? 2 : 0));
      return createGroupDecoration(lines, width, frame.group, theme, frame.config, false);
    }, view);
  };
}
