import { Text, parseColor, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { isSafeColor, type Role, type ToolUiConfig } from "../config.ts";
import { cleanText } from "../format.ts";
import type { GroupPosition } from "../types.ts";

export function colorize(theme: Theme, config: ToolUiConfig, role: Role, text: string): string {
  const color = config.theme.colors[role];
  return color && isSafeColor(color) ? theme.style(text, { fg: parseColor(color) }) : theme.fg(config.theme.semantic[role], text);
}
export class DynamicComponent implements Component {
  constructor(private readonly draw: (width: number) => string[]) {}
  render(width: number): string[] {
    if (width <= 0) return [];
    return this.draw(width).map(line => truncateToWidth(line, width));
  }
  invalidate(): void { /* 每次 render 重新计算主题、宽度和状态，不缓存 ANSI。 */ }
}
export function textLines(text: string, width: number): string[] {
  return width > 0 ? new Text(text, 0, 0).render(width) : [];
}
export function createGroupDecoration(lines: string[], width: number, group: GroupPosition | undefined, theme: Theme, config: ToolUiConfig, call: boolean): string[] {
  if (!group || width < 4) return lines.map(l => truncateToWidth(l, width));
  const header = call && group.first ? [truncateToWidth(colorize(theme, config, "group", `┌ ${cleanText(group.label)}`), width)] : [];
  return [...header, ...lines.map(l => colorize(theme, config, "group", "│ ") + truncateToWidth(l, width - 2))];
}
