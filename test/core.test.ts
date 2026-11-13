import { expect, it } from "vitest";
import type { Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../src/config.ts";
import { createToolRendererResolver } from "../src/rendering/renderer.ts";
import { ToolUiState } from "../src/runtime/state.ts";
import type { ToolRenderContext } from "../src/types.ts";

const theme = { fg: (_role: string, text: string) => text, style: (text: string) => text } as unknown as Theme;
const render = (component: Component) => component.render(120).map(line => stripTerminalSequences(line).trimEnd()).join("\n");

function setup() {
  const state = new ToolUiState();
  const context: ToolRenderContext = {
    toolCallId: "root", args: { path: "README.md" }, expanded: false, isPartial: false, isError: false,
    executionStarted: true, argsComplete: true, durationMs: 5, outputPad: 0, cwd: "/isolated/project", showImages: false,
    lastComponent: undefined, state: {}, invalidate() {}, keyHint: () => "Ctrl+O", keyText: () => "Ctrl+O",
  };
  const resolve = (name = "read", native?: ToolRenderers) => createToolRendererResolver(state)(name, () => native)!;
  return { state, context, resolve };
}

it("普通工具折叠显示紧凑标题，展开显示正文", () => {
  const { context, resolve } = setup();
  const renderer = resolve();
  const result = { content: [{ type: "text" as const, text: "文件首行\n文件末行" }], details: undefined };

  expect(render(renderer.renderCall!(context.args, theme, context))).toBe("✓ read README.md 5ms");
  expect(render(renderer.renderResult!(result, { expanded: false, isPartial: false }, theme, context))).toBe("");
  expect(render(renderer.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...context, expanded: true }))).toBe("文件首行\n文件末行");
});

it("enabled:false 保留原生 renderer 的显示", () => {
  const { state, context, resolve } = setup();
  state.setConfig(mergeConfig(DEFAULT_CONFIG, { enabled: false }));
  const renderer = resolve("read", {
    renderCall: () => new Text("原生调用标题", 0, 0),
    renderResult: () => new Text("原生结果正文", 0, 0),
  });

  expect(render(renderer.renderCall!(context.args, theme, context))).toBe("原生调用标题");
  expect(render(renderer.renderResult!({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, context))).toBe("原生结果正文");
});

it("codemode 默认显示工具树，点击子节点展开结果", () => {
  const { state, context, resolve } = setup();
  context.args = { code: "await ctx.executeTool('read', { path: 'README.md' })" };
  const root = { toolCallId: "root", toolName: "codemode", args: context.args };
  state.start(root);
  state.end({
    toolCallId: "child", toolName: "read", parentToolCallId: "root", args: { path: "README.md" },
    result: { content: [{ type: "text", text: "子工具结果" }] }, isError: false, durationMs: 1,
  });
  state.end({ ...root, result: { content: [] }, isError: false, durationMs: 5 });
  const renderer = resolve("codemode");
  const call = renderer.renderCall!(context.args, theme, context);

  expect(render(call)).toContain("✓ codemode 5ms\n  └ ▸ read README.md");
  expect(render(call)).not.toContain("子工具结果");
  call.handleMouse?.({
    x: 4, y: 1, screenX: 4, screenY: 1, width: 120, height: 30,
    button: "left", type: "click", shift: false, alt: false, ctrl: false,
  });
  const expanded = render(renderer.renderCall!(context.args, theme, context));
  expect(expanded).toContain("▾ read README.md");
  expect(expanded).toContain("子工具结果");
});

it("配置加载全局与可信项目覆盖，不可信项目不读取项目配置", () => {
  const options = { agentDir: "/isolated/agent", cwd: "/isolated/project", projectTrusted: true };
  const globalPath = "/isolated/agent/pi-tool-ui.json";
  const globalConfig = '{"enabled":false}';
  const trusted = loadConfig({ ...options, readFile: path => path === globalPath ? globalConfig : '{"enabled":true}' });
  expect(trusted.config.enabled).toBe(true);
  expect(trusted.diagnostics).toEqual([]);

  const untrusted = loadConfig({ ...options, projectTrusted: false, readFile: path => {
    // 若读取项目配置就会产生诊断，确保不可信项目确实被跳过。
    if (path !== globalPath) throw new Error("不应读取项目配置");
    return globalConfig;
  } });
  expect(untrusted.config.enabled).toBe(false);
  expect(untrusted.diagnostics).toEqual([]);
});
