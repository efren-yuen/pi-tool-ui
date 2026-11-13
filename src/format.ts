import type { ToolUiConfig } from "./config.ts";
import { truncateToWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ImagePlaceholder, ToolResultData, ToolStatus } from "./types.ts";

/** 不接受来自参数、结果或配置的终端指令（包括 OSC 链接和剪贴板）。 */
export function cleanText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/data:[^\s;]+;base64,[A-Za-z0-9+/=_-]+/gi, "[图片/二进制数据已省略]");
}
function safeValue(value: unknown, ancestors: Set<object>, redactBinary: boolean): unknown {
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return String(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[循环引用]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(v => safeValue(v, ancestors, redactBinary));
    const out: Record<string, unknown> = Object.create(null);
    const image = (value as { type?: unknown }).type === "image";
    for (const key of Object.keys(value).sort()) {
      if ((image || redactBinary) && /^(data|base64|bytes|blob)$/i.test(key)) out[cleanText(key)] = "[二进制数据已省略]";
      else {
        try { out[cleanText(key)] = safeValue((value as Record<string, unknown>)[key], ancestors, redactBinary); }
        catch { out[cleanText(key)] = "[字段不可读取]"; }
      }
    }
    return out;
  } finally { ancestors.delete(value); }
}
export function safeStringify(value: unknown, indent = 2, redactBinary = false): string {
  try { return cleanText(JSON.stringify(safeValue(value, new Set(), redactBinary), null, indent) ?? String(value)); }
  catch { return "[无法安全序列化的值]"; }
}
export function formatArguments(args: unknown): string {
  return safeStringify(args);
}
export type ResultLine = { kind: "text"; text: string } | { kind: "image"; image: ImagePlaceholder };
export interface ParsedResult { lines: ResultLine[]; images: ImagePlaceholder[] }
export function formatImageMetadata(image: ImagePlaceholder, host = false): string {
  const metadata = `${image.mimeType}${image.alt ? ` · ${image.alt}` : ""}`;
  return host ? `[图片 ${metadata}；由宿主图片层显示]` : `▧ ${metadata}`;
}
/** 类型身份一直保留到布局层，不再从合成提示文字反推内容类型。 */
export function parseResultContent(result: ToolResultData, mode: "full" | "diagnostic" | "images" = "full"): ParsedResult {
  const lines: ResultLine[] = [];
  const images: ImagePlaceholder[] = [];
  let diagnostic = false;
  for (const block of result.content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text") {
        if (mode === "images" || mode === "diagnostic" && diagnostic) continue;
        const text = b.text;
        if (typeof text === "string") {
          const cleaned = cleanText(text);
          if (mode === "full") for (const line of cleaned.split("\n")) lines.push({ kind: "text", text: line });
          else {
            // 只寻找首条有效诊断，不为大正文 split 或保留后续行对象。
            for (let start = 0; start <= cleaned.length;) {
              const end = cleaned.indexOf("\n", start);
              const line = cleaned.slice(start, end < 0 ? undefined : end);
              if (line.trim()) { lines.push({ kind: "text", text: line }); diagnostic = true; break; }
              if (end < 0) break;
              start = end + 1;
            }
          }
          continue;
        }
      }
      if (b.type === "image") {
        const image: ImagePlaceholder = { type: "image", mimeType: cleanText(typeof b.mimeType === "string" ? b.mimeType : "未知媒体类型"), alt: typeof b.alt === "string" ? cleanText(b.alt) : undefined };
        images.push(image);
        // 始终保留安全元信息：公开 API 无法确认图片是否真正成功呈现。
        lines.push({ kind: "image", image });
        continue;
      }
    }
    if (mode === "full" || mode === "diagnostic" && !diagnostic) {
      lines.push({ kind: "text", text: `[未知内容块] ${safeStringify(block, 2, true)}` });
      diagnostic = true;
    }
  }
  return { lines, images };
}
export function formatDuration(durationMs: number): string {
  const ms = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const value = ms < 60000 ? ms / 1000 : ms / 60000;
  return `${Number(value.toFixed(1))}${ms < 60000 ? "s" : "min"}`;
}
export function formatStatusLine(status: ToolStatus, durationMs?: number, statusStyle: ToolUiConfig["statusStyle"] = "icon", showDuration = true): string {
  const token = statusStyle === "none" ? "" : statusStyle === "icon"
    ? { pending: "…", running: "…", success: "✓", error: "✗", cancelled: "⊘" }[status]
    : { pending: "run", running: "run", success: "ok", error: "err", cancelled: "cancel" }[status];
  return [token, showDuration && durationMs !== undefined ? formatDuration(durationMs) : ""].filter(Boolean).join(" ");
}
export function formatErrorDiagnostic(status: ToolStatus): string {
  return status === "cancelled" ? "Not executed or cancelled · reason unavailable" : "Tool failed · no diagnostic";
}
/** codemode 各布局共用名称清理与长度限制，不接受不可见方向控制符。 */
export function formatCodemodeNodeName(name: string): string {
  return cleanText(name).replace(/[\s\u2028\u2029]+/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").slice(0, 512);
}
export const CALL_SUMMARY_MAX_CHARS = 512;
const boundedSummary = (text: string): string => truncateToWidth(text.slice(0, CALL_SUMMARY_MAX_CHARS), 80).slice(0, CALL_SUMMARY_MAX_CHARS);
/** 折叠摘要仅读取白名单字符串字段，不序列化完整参数或脚本。 */
export function formatCallSummary(toolName: string, args: unknown): string {
  const field = (...keys: string[]): string => {
    for (const key of keys) {
      try {
        const value = args !== null && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
        if (typeof value === "string") {
          const text = cleanText(value).replace(/\s+/g, " ").trim();
          if (text) return boundedSummary(text);
        }
      } catch { /* 不读取其他字段，也不回显异常对象。 */ }
    }
    return "";
  };
  switch (toolName) {
    case "read": case "write": case "edit": case "ls": return field("path", "file_path");
    case "grep": case "find": return boundedSummary([field("pattern"), field("path", "file_path")].filter(Boolean).join(" "));
    case "bash": case "powershell": return field("command");
    case "codemode": return field("title", "description");
    case "todo": return "";
    default: return field("title", "description", "label", "name");
  }
}
