import type { Theme, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { colorize, createGroupDecoration, DynamicComponent, textLines } from "./components.ts";
import { cleanText, formatArguments, formatErrorDiagnostic, formatImageMetadata, parseResultContent, type ParsedResult, type ResultLine } from "../format.ts";
import { callHeadings, statusRole } from "./headings.ts";
import { nativeArea, previousContext, SlotComponent, wrapNativeSlotRenderer } from "./native-slot.ts";
import { isToolIncluded } from "../matcher.ts";
import { deriveDisplayStatus } from "../status.ts";
import { ToolUiState } from "../runtime/state.ts";
import { createInlineNestedCallRenderer, createInlineNestedResultRenderer } from "../nested/nested-renderer.ts";
import { subagentSummary } from "../nested/nested.ts";
import { NestedToolView } from "../nested/nested-view.ts";
import type { GroupPosition, ToolRenderContext } from "../types.ts";

type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ResultRenderer = NonNullable<ToolRenderers["renderResult"]>;
function renderHeadings(toolName: string, args: unknown, theme: Theme, state: ToolUiState, context: ToolRenderContext): string[] {
  const record = state.records.get(context.toolCallId), config = state.config;
  return callHeadings({ toolName, args, context, status: deriveDisplayStatus(context, record),
    subagent: toolName === "subagent" && config.subagentSummary && record ? subagentSummary(record) : null,
    codemode: toolName === "codemode" && config.codemodeSummary ? state.nestedSummary(context.toolCallId) : null,
  }, theme, config);
}
const resultLineText = (line: ResultLine): string => line.kind === "image" ? formatImageMetadata(line.image) : line.text;
function diagnostic(content: ParsedResult, ctx: ToolRenderContext): string {
  const line = content.lines.find(line => line.kind === "text" && line.text.trim());
  return line?.kind === "text" ? line.text : formatErrorDiagnostic(deriveDisplayStatus(ctx));
}
function previewHint(ctx: ToolRenderContext, omitted?: number): string {
  return `… ${omitted === undefined ? "" : `${omitted} more · `}${cleanText(ctx.keyHint("app.tools.expand", "expand"))}`;
}

export function createGenericCallRenderer(toolName: string, state: ToolUiState): CallRenderer {
  return (args, theme, context) => new DynamicComponent(width => {
    const config = state.config;
    const toolTitle = colorize(theme, config, "call", cleanText(toolName));
    if (!isToolIncluded(config, toolName)) return textLines(`${toolTitle}\n${formatArguments(args)}`, width);
    const title = renderHeadings(toolName, args, theme, state, context).map(line => truncateToWidth(line, width));
    if (!context.expanded) return title;
    return [...title, ...textLines(colorize(theme, config, "args", formatArguments(args)), width)];
  });
}
export function createGenericResultRenderer(state: ToolUiState, toolName: string): ResultRenderer {
  return (result, options, theme, context) => new DynamicComponent(width => {
    const config = state.config;
    const active = isToolIncluded(config, toolName);
    const zeroPreview = active && !options.expanded && config.collapsedPreviewLines === 0;
    const content = parseResultContent(result, zeroPreview ? context.isError ? "diagnostic" : "images" : "full");
    // 零预览不需要统计省略行数，跳过整个正文的颜色化与物理排版。
    // 正数预览仍按真实物理行计数，保留精确的 more 提示与窄宽换行语义。
    const all: string[] = [];
    if (!zeroPreview) for (const line of content.lines) {
      for (const physical of textLines(colorize(theme, config, line.kind === "image" ? "meta" : context.isError ? "error" : "result", resultLineText(line)), width)) all.push(physical);
    }
    if (!active) return all;
    const shown = options.expanded ? [...all] : all.slice(0, config.collapsedPreviewLines);
    if (context.isError) {
      const detail = diagnostic(content, context);
      if (!containsText(shown, detail)) for (const line of textLines(colorize(theme, config, statusRole(context), detail), width).slice(0, options.expanded ? undefined : 1)) shown.push(line);
    }
    appendImages(content, shown, width, theme, state);
    const omitted = all.length - (options.expanded ? all.length : Math.min(all.length, config.collapsedPreviewLines));
    if (!options.expanded && config.collapsedPreviewLines > 0 && omitted > 0) shown.push(truncateToWidth(colorize(theme, config, "meta", previewHint(context, omitted)), width));
    return shown;
  });
}

export function createToolRendererResolver(state: ToolUiState): ToolRendererResolver {
  return (toolName, next) => {
    if (!isToolIncluded(state.config, toolName) || toolName !== "subagent" && toolName !== "codemode") return createNativeToolRendererResolver(state)(toolName, next);
    const inline = () => isToolIncluded(state.config, toolName) && state.config.nestedExpansion === "inline" &&
      (toolName === "subagent" ? state.config.subagentSummary : state.config.codemodeSummary);
    let legacy: ToolRenderers | undefined, author: ToolRenderers | undefined, resolved = false;
    const native = () => {
      if (!resolved) { author = next(); resolved = true; }
      if (legacy) return legacy;
      if (!isToolIncluded(state.config, toolName)) return author;
      return legacy = createNativeToolRendererResolver(state)(toolName, () => author);
    };
    const createView = (args: unknown, ctx: ToolRenderContext) => new NestedToolView(state, toolName, args, ctx);
    const call = createInlineNestedCallRenderer(createView);
    const result = createInlineNestedResultRenderer(createView, createGenericResultRenderer(state, toolName));
    // inline 不解析、更不调用作者 aggregate renderer；配置回滚时才解析旧路径。
    if (!inline()) native();
    return {
      renderShell: "self",
      renderCall: (args, theme, ctx) => inline() ? call(args, theme, ctx) :
        (native()?.renderCall ?? createGenericCallRenderer(toolName, state))(args, theme, { ...ctx, lastComponent: ctx.lastComponent instanceof SlotComponent ? ctx.lastComponent : undefined }),
      renderResult: (value, options, theme, ctx) => inline() ? result(value, options, theme, ctx) :
        (native()?.renderResult ?? createGenericResultRenderer(state, toolName))(value, options, theme, { ...ctx, lastComponent: ctx.lastComponent instanceof SlotComponent ? ctx.lastComponent : undefined }),
    };
  };
}
function createNativeToolRendererResolver(state: ToolUiState): ToolRendererResolver {
  return (toolName, next) => {
    const native = next();
    if (!isToolIncluded(state.config, toolName)) return native;
    const genericCall = createGenericCallRenderer(toolName, state);
    const genericResult = createGenericResultRenderer(state, toolName);
    const bind = (ctx: ToolRenderContext) => state.bind({ toolCallId: ctx.toolCallId, toolName, args: ctx.args }, ctx.invalidate);
    const decorate = (lines: string[], width: number, theme: Theme, group: GroupPosition | undefined, call: boolean) => createGroupDecoration(lines, width, group, theme, state.config, call);
    const wrapped: ToolRenderers = {
      ...native,
      renderShell: "self",
      renderCall(args, theme, ctx) {
        bind(ctx);
        const fallback = () => genericCall(args, theme, ctx);
        if (!native?.renderCall) return new DynamicComponent(width => {
          const group = isToolIncluded(state.config, toolName) && width >= 4 ? state.group(ctx.toolCallId) : undefined;
          return decorate(fallback().render(group ? width - 2 : width), width, theme, group, true);
        });
        return wrapNativeSlotRenderer(() => native.renderCall!(args, theme, previousContext(ctx)), fallback, (child, width, failed) => {
          const active = isToolIncluded(state.config, toolName);
          const group = active && width >= 4 ? state.group(ctx.toolCallId) : undefined;
          const rail = group ? 2 : 0, w = width - rail;
          const full = [...child.render(w)];
          let lines = full, count = full.length, y = group?.first ? 1 : 0;
          if (active && !failed) {
            const title = renderHeadings(toolName, args, theme, state, ctx).map(line => truncateToWidth(line, w));
            count = ctx.expanded ? full.length : 0;
            y += title.length;
            lines = ctx.expanded ? [...title, ...full] : title;
            if (ctx.expanded && state.config.appendRawOnExpand) for (const line of textLines(colorize(theme, state.config, "args", `Full args\n${formatArguments(args)}`), w)) lines.push(line);
          }
          if (failed) {
            const fallbackLines = textLines(colorize(theme, state.config, "error", "! native renderer failed · fallback"), w);
            for (const line of lines) fallbackLines.push(line);
            lines = fallbackLines;
          }
          return { lines: active ? decorate(lines, width, theme, group, true) : lines, native: failed ? undefined : nativeArea(full, w, count, rail, y) };
        });
      },
      renderResult(result, options, theme, ctx) {
        bind(ctx);
        const fallback = () => genericResult(result, options, theme, ctx);
        if (!native?.renderResult) return new DynamicComponent(width => {
          const group = isToolIncluded(state.config, toolName) && width >= 4 ? state.group(ctx.toolCallId) : undefined;
          return decorate(fallback().render(group ? width - 2 : width), width, theme, group, false);
        });
        return wrapNativeSlotRenderer(() => native.renderResult!(result, options, theme, previousContext(ctx)), fallback, (child, width, failed) => {
          const active = isToolIncluded(state.config, toolName);
          const group = active && width >= 4 ? state.group(ctx.toolCallId) : undefined;
          const rail = group ? 2 : 0, w = width - rail;
          const full = [...child.render(w)];
          let lines = full, shown = full.length;
          if (active && !failed) {
            const count = state.config.collapsedPreviewLines;
            shown = options.expanded ? full.length : count;
            lines = options.expanded ? [...full] : full.slice(0, count);
            if (!options.expanded && count > 0 && full.length > count) lines.push(colorize(theme, state.config, "meta", previewHint(ctx)));
            const appendRaw = options.expanded && state.config.appendRawOnExpand;
            const content = parseResultContent(result, appendRaw ? "full" : ctx.isError ? "diagnostic" : "images");
            // 追加原文只作用于已有原生 slot；通用展开始终显示完整内容。
            if (appendRaw) {
              for (const line of textLines(colorize(theme, state.config, "meta", "Raw result"), w)) lines.push(line);
              appendRawResult(content, w, theme, state, lines);
            }
            if (ctx.isError) {
              // 原生统计不一定包含真实错误；优先保证实际诊断可见，合成行不属于原生命中区。
              const detail = diagnostic(content, ctx);
              if (!containsText(lines, detail)) for (const line of textLines(colorize(theme, state.config, statusRole(ctx), detail), w).slice(0, options.expanded ? undefined : 1)) lines.push(line);
            }
            // 图片安全元信息不受原文开关、展开或宿主图片可见性影响；已显示的提示（含换行）不再重复。
            appendImages(content, lines, w, theme, state);
          }
          if (failed) {
            const fallbackLines = textLines(colorize(theme, state.config, "error", "! native renderer failed · fallback"), w);
            for (const line of lines) fallbackLines.push(line);
            lines = fallbackLines;
          }
          return { lines: active ? decorate(lines, width, theme, group, false) : lines, native: failed ? undefined : nativeArea(full, w, shown, rail, 0) };
        });
      },
    };
    return wrapped;
  };
}
function stripPreview(lines: string[]): string {
  return cleanText(lines.join("\n"));
}
function containsText(lines: string[], text: string): boolean {
  return stripPreview(lines).replace(/\s/g, "").includes(text.replace(/\s/g, ""));
}
// 作者 slot 只有终端文字可供比较；仅用于避免重复提示，不据此判断原始正文类型。
function imageAlreadyShown(image: ParsedResult["images"][number], visible: string): boolean {
  return [formatImageMetadata(image), formatImageMetadata(image, true)].some(hint => visible.includes(hint.replace(/\s/g, "")));
}
function appendImages(content: ParsedResult, lines: string[], width: number, theme: Theme, state: ToolUiState): void {
  if (!content.images.length) return;
  let visible = stripPreview(lines).replace(/\s/g, "");
  for (const image of content.images) {
    if (imageAlreadyShown(image, visible)) continue;
    const added = textLines(colorize(theme, state.config, "meta", formatImageMetadata(image)), width);
    for (const line of added) lines.push(line);
    visible += stripPreview(added).replace(/\s/g, "");
  }
}
function appendRawResult(content: ParsedResult, width: number, theme: Theme, state: ToolUiState, lines: string[]): void {
  const visible = content.images.length ? stripPreview(lines).replace(/\s/g, "") : "";
  for (const line of content.lines) {
    if (line.kind === "image" && imageAlreadyShown(line.image, visible)) continue;
    for (const physical of textLines(colorize(theme, state.config, line.kind === "image" ? "meta" : "result", resultLineText(line)), width)) lines.push(physical);
  }
}
