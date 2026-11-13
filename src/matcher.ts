import type { GroupConfig, ToolUiConfig } from "./config.ts";

/** 仅支持 * 和 ?，其余字符按字面量处理；避免用户 glob 被当成正则执行。 */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map(pattern => new RegExp(`^${Array.from(pattern, c => c === "*" ? "[\\s\\S]*" : c === "?" ? "[\\s\\S]" : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`, "u"));
}
const compiledPatterns = new WeakMap<readonly string[], { source: string[]; patterns: RegExp[] }>();
/** 按规则数组缓存；比较内容以支持原地修改，不缓存随配置变化的匹配结果。 */
function patternsFor(source: readonly string[]): RegExp[] {
  let cached = compiledPatterns.get(source);
  if (!cached || cached.source.length !== source.length || cached.source.some((pattern, i) => pattern !== source[i])) {
    cached = { source: [...source], patterns: compilePatterns(source) };
    compiledPatterns.set(source, cached);
  }
  return cached.patterns;
}
export function isToolIncluded(config: ToolUiConfig, toolName: string): boolean {
  return config.enabled && patternsFor(config.include).some(p => p.test(toolName)) && !patternsFor(config.exclude).some(p => p.test(toolName));
}
export function resolveToolGroup(config: ToolUiConfig, toolName: string): GroupConfig | undefined {
  if (!isToolIncluded(config, toolName)) return undefined;
  const first = config.groups.find(g => patternsFor(g.tools).some(p => p.test(toolName)));
  return first?.enabled ? first : undefined;
}
