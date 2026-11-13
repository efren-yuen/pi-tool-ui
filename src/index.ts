import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, formatConfigDiagnostics } from "./config.ts";
import { cleanText } from "./format.ts";
import { observeMessage, rebuildHistory } from "./runtime/history.ts";
import { createToolRendererResolver } from "./rendering/renderer.ts";
import { ToolUiState } from "./runtime/state.ts";
import { installThinkingMarkdown } from "./thinking-markdown.ts";

export default function toolUi(pi: ExtensionAPI): void {
  const state = new ToolUiState();
  // 必须早于 session_start：宿主可能已在启动事件前重建聊天组件。
  const thinkingMarkdown = installThinkingMarkdown(pi);
  let thinkingWarningShown = false;
  const notify = (ctx: ExtensionContext, text: string, type: "info" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(cleanText(text), type);
  };
  const reportThinkingCompatibility = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || thinkingWarningShown || !thinkingMarkdown.reason) return;
    thinkingWarningShown = true;
    notify(ctx, `思考单色适配已停用，保留 Pi 原显示：${thinkingMarkdown.reason}`, "error");
  };
  const reload = (ctx: ExtensionContext) => {
    const config = loadConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, configDirName: CONFIG_DIR_NAME, projectTrusted: ctx.isProjectTrusted() });
    state.setConfig(config.config);
    if (config.diagnostics.length) notify(ctx, formatConfigDiagnostics(config.diagnostics), "error");
  };
  pi.registerToolRenderer(createToolRendererResolver(state));
  pi.on("session_start", (_event, ctx) => {
    rebuildHistory(state, ctx.sessionManager.getBranch());
    reload(ctx);
    reportThinkingCompatibility(ctx);
  });
  // 在事件提供的新上下文中报告运行期降级，不在绘制时通知或保留旧 ctx。
  pi.on("agent_end", (_event, ctx) => reportThinkingCompatibility(ctx));
  pi.on("session_tree", (_event, ctx) => rebuildHistory(state, ctx.sessionManager.getBranch()));
  pi.on("message_end", event => {
    observeMessage(state, event.message);
    if (event.message.role !== "toolResult" && event.message.role !== "system") state.invalidateAll();
  });
  pi.on("tool_execution_start", event => state.start(event));
  pi.on("tool_execution_update", event => state.update(event));
  pi.on("tool_execution_end", event => state.end(event));
  pi.on("tool_result", event => { state.observeResult({ ...event, args: event.input }); });
  pi.on("session_shutdown", () => {
    thinkingMarkdown.cleanup();
    state.clear();
  });
}
