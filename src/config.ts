import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ConfigDiagnostic } from "./types.ts";

export const SEMANTIC_COLORS = ["toolTitle", "muted", "toolOutput", "success", "error", "warning", "accent", "dim", "text", "border", "borderAccent", "borderMuted", "thinkingText", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext"] as const satisfies readonly ThemeColor[];
export const ROLES = ["call", "args", "result", "success", "error", "cancelled", "group", "meta"] as const;
export type Role = typeof ROLES[number];
export type SemanticColor = typeof SEMANTIC_COLORS[number];
export interface GroupConfig { id: string; label: string; enabled: boolean; tools: string[] }
export interface ThemeConfig { semantic: Record<Role, SemanticColor>; colors: Partial<Record<Role, string>> }
export interface ToolUiConfig {
  enabled: boolean;
  include: string[];
  exclude: string[];
  groups: GroupConfig[];
  collapsedPreviewLines: number;
  statusStyle: "icon" | "text" | "none";
  showDuration: boolean;
  codemodeSummary: boolean;
  codemodeShowArguments: boolean;
  subagentSummary: boolean;
  nestedExpansion: "inline" | "native";
  codemodeLayout: "tree" | "summary";
  subagentLayout: { single: "tree" | "inline" | "summary"; parallel: "tree" | "summary"; chain: "flow" | "tree" };
  summaryMaxRows: number;
  appendRawOnExpand: boolean;
  theme: ThemeConfig;
}
export type ConfigPatch = Partial<Omit<ToolUiConfig, "theme" | "subagentLayout">> & {
  subagentLayout?: Partial<ToolUiConfig["subagentLayout"]>;
  theme?: { semantic?: Partial<ThemeConfig["semantic"]>; colors?: ThemeConfig["colors"] };
};
export const DEFAULT_CONFIG: ToolUiConfig = {
  enabled: true, include: ["*"], exclude: [], groups: [], collapsedPreviewLines: 0, statusStyle: "icon", showDuration: true, codemodeSummary: true, codemodeShowArguments: true, subagentSummary: true, appendRawOnExpand: false,
  nestedExpansion: "inline", codemodeLayout: "tree", subagentLayout: { single: "tree", parallel: "tree", chain: "tree" }, summaryMaxRows: 0,
  theme: { semantic: { call: "toolTitle", args: "muted", result: "toolOutput", success: "success", error: "error", cancelled: "warning", group: "accent", meta: "dim" }, colors: {} },
};
export const isSafeColor = (value: unknown): value is string => typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
const printable = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(v);

/** 按文件整体校验；诊断不回显配置值，避免把错误配置中的敏感内容带入终端。 */
export function validateConfig(value: unknown): { valid: boolean; config?: ConfigPatch; errors: string[] } {
  const errors: string[] = [];
  if (!object(value)) return { valid: false, errors: ["配置必须是 JSON 对象"] };
  const keys = ["$schema", "enabled", "include", "exclude", "groups", "collapsedPreviewLines", "statusStyle", "showDuration", "codemodeSummary", "codemodeShowArguments", "subagentSummary", "nestedExpansion", "codemodeLayout", "subagentLayout", "summaryMaxRows", "appendRawOnExpand", "theme"];
  if (Object.keys(value).some(k => !keys.includes(k))) errors.push("存在未知配置字段");
  if ("$schema" in value && typeof value.$schema !== "string") errors.push("$schema 必须是字符串");
  if ("enabled" in value && typeof value.enabled !== "boolean") errors.push("enabled 必须是布尔值");
  if ("statusStyle" in value && !["icon", "text", "none"].includes(value.statusStyle as string)) errors.push("statusStyle 必须是 icon、text 或 none");
  if ("showDuration" in value && typeof value.showDuration !== "boolean") errors.push("showDuration 必须是布尔值");
  if ("codemodeSummary" in value && typeof value.codemodeSummary !== "boolean") errors.push("codemodeSummary 必须是布尔值");
  if ("codemodeShowArguments" in value && typeof value.codemodeShowArguments !== "boolean") errors.push("codemodeShowArguments 必须是布尔值");
  if ("subagentSummary" in value && typeof value.subagentSummary !== "boolean") errors.push("subagentSummary 必须是布尔值");
  if ("nestedExpansion" in value && !["inline", "native"].includes(value.nestedExpansion as string)) errors.push("nestedExpansion 必须是 inline 或 native");
  if ("codemodeLayout" in value && !["tree", "summary"].includes(value.codemodeLayout as string)) errors.push("codemodeLayout 必须是 tree 或 summary");
  if ("summaryMaxRows" in value && !(Number.isSafeInteger(value.summaryMaxRows) && Number(value.summaryMaxRows) >= 0)) errors.push("summaryMaxRows 必须是非负安全整数");
  if ("subagentLayout" in value) {
    const layout = value.subagentLayout;
    const enums = { single: ["tree", "inline", "summary"], parallel: ["tree", "summary"], chain: ["flow", "tree"] };
    if (!object(layout) || Object.keys(layout).some(k => !["single", "parallel", "chain"].includes(k))) errors.push("subagentLayout 字段非法");
    else for (const k of ["single", "parallel", "chain"] as const) {
      if (k in layout && !enums[k].includes(layout[k] as string)) errors.push(`subagentLayout.${k} 布局非法`);
    }
  }
  if ("appendRawOnExpand" in value && typeof value.appendRawOnExpand !== "boolean") errors.push("appendRawOnExpand 必须是布尔值");
  for (const k of ["include", "exclude"] as const) if (k in value && !strings(value[k])) errors.push(`${k} 必须是字符串数组`);
  if ("collapsedPreviewLines" in value && !(Number.isInteger(value.collapsedPreviewLines) && Number(value.collapsedPreviewLines) >= 0 && Number(value.collapsedPreviewLines) <= 100)) errors.push("collapsedPreviewLines 必须是 0–100 的整数");
  if ("groups" in value) {
    if (!Array.isArray(value.groups)) errors.push("groups 必须是数组");
    else {
      const ids = new Set<string>();
      for (const g of value.groups) {
        if (!object(g) || Object.keys(g).some(k => !["id", "label", "enabled", "tools"].includes(k)) || !printable(g.id) || !printable(g.label) || typeof g.enabled !== "boolean" || !strings(g.tools)) {
          errors.push("分组需要非空 id、label、布尔 enabled 和字符串数组 tools");
          continue;
        }
        if (ids.has(g.id)) errors.push("分组 id 不能重复");
        ids.add(g.id);
      }
    }
  }
  if ("theme" in value) {
    if (!object(value.theme) || Object.keys(value.theme).some(k => !["semantic", "colors"].includes(k))) errors.push("theme 字段非法");
    else for (const k of ["semantic", "colors"] as const) {
      if (!(k in value.theme)) continue;
      const entries = value.theme[k];
      if (!object(entries)) { errors.push(`theme.${k} 必须是对象`); continue; }
      for (const [role, color] of Object.entries(entries)) {
        if (!ROLES.includes(role as Role) || (k === "colors" ? !isSafeColor(color) : !SEMANTIC_COLORS.includes(color as SemanticColor))) errors.push(`theme.${k} 包含非法角色或颜色`);
      }
    }
  }
  const { $schema: _schema, ...patch } = value;
  return errors.length ? { valid: false, errors } : { valid: true, config: patch as ConfigPatch, errors };
}
export function mergeConfig(base: ToolUiConfig, patch: ConfigPatch): ToolUiConfig {
  return {
    ...base, ...patch,
    subagentLayout: {
      single: patch.subagentLayout?.single ?? base.subagentLayout.single,
      parallel: patch.subagentLayout?.parallel ?? base.subagentLayout.parallel,
      chain: patch.subagentLayout?.chain ?? base.subagentLayout.chain,
    },
    include: [...(patch.include ?? base.include)], exclude: [...(patch.exclude ?? base.exclude)],
    groups: (patch.groups ?? base.groups).map(g => ({ ...g, tools: [...g.tools] })),
    theme: { semantic: { ...base.theme.semantic, ...patch.theme?.semantic }, colors: { ...base.theme.colors, ...patch.theme?.colors } },
  };
}
export interface LoadedConfig {
  config: ToolUiConfig;
  diagnostics: ConfigDiagnostic[];
  sources: string[];
  globalPath: string;
  projectPath: string;
  projectTrusted: boolean;
}
export interface LoadConfigOptions {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  configDirName?: string;
  readFile?: (path: string) => string;
}
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const globalPath = join(options.agentDir, "pi-tool-ui.json");
  const projectPath = join(options.cwd, options.configDirName ?? ".pi", "pi-tool-ui.json");
  const loaded: LoadedConfig = { config: mergeConfig(DEFAULT_CONFIG, {}), diagnostics: [], sources: [], globalPath, projectPath, projectTrusted: options.projectTrusted };
  const read = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  for (const path of options.projectTrusted ? [globalPath, projectPath] : [globalPath]) {
    let text: string;
    try { text = read(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") loaded.diagnostics.push({ path, message: "配置读取失败，已回退到上一层" });
      continue;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { loaded.diagnostics.push({ path, message: "JSON 格式错误，已回退到上一层" }); continue; }
    const validated = validateConfig(value);
    if (!validated.valid) { loaded.diagnostics.push({ path, message: validated.errors.join("；") }); continue; }
    loaded.config = mergeConfig(loaded.config, validated.config!);
    loaded.sources.push(path);
  }
  return loaded;
}
export function formatConfigDiagnostics(diagnostics: ConfigDiagnostic[]): string {
  return diagnostics.length ? diagnostics.map(d => `${d.path}: ${d.message}`).join("\n") : "无配置错误";
}
