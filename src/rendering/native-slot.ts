import { isFocusable, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../types.ts";

// 此模块只适配宿主组件，不读取工具状态、配置或协议载荷。
interface NativeArea { x: number; y: number; width: number; height: number; rowWidths: number[] }
interface SlotDrawing { lines: string[]; native?: NativeArea }
// 与宿主鼠标分发形状保持一致；公开包尚未导出这些辅助类型，升级 Pi 时必须跑真实宿主测试。
interface MouseTarget { component: Component; originX: number; originY: number; width: number; height: number }
interface MouseDispatch extends TuiMouseEventResult { handled: true; target: MouseTarget; focusTarget?: Component }
type DrawSlot = (child: Component, width: number, failed: boolean) => SlotDrawing;

/** 包装组件而非改写原型；工厂、延迟 render 和 invalidate 失败后都不再向原生组件发送输入。 */
export class SlotComponent implements Component {
  private failed = false;
  private drawing?: SlotDrawing;
  private width = 0;
  // 同一组件也可能因宽度、分组或预览变化而改变命中区，不能仅按组件身份保留输入目标。
  private layoutKey?: string;
  private layoutVersion = 0;
  private focusTarget?: { component: Component; version: number };
  private readonly mouseTargets = new WeakMap<Component, { signature: string; component: Component }>();
  constructor(
    readonly nativeChild: Component | undefined,
    private readonly fallback: () => Component,
    private readonly draw: DrawSlot,
  ) { this.failed = !nativeChild; }
  render(width: number): string[] {
    this.width = width;
    this.drawing = undefined;
    if (width <= 0) { this.layoutKey = undefined; this.advanceLayout(); return []; }
    try { this.drawing = this.draw(this.failed ? this.fallback() : this.nativeChild!, width, this.failed); }
    catch { this.failed = true; this.drawing = this.draw(this.fallback(), width, true); }
    const key = JSON.stringify(this.drawing.native);
    if (key !== this.layoutKey) { this.layoutKey = key; this.advanceLayout(); }
    return this.drawing.lines.map(l => truncateToWidth(l, width));
  }
  invalidate(): void {
    this.drawing = undefined;
    this.layoutKey = undefined;
    this.advanceLayout();
    if (this.failed) return;
    try { this.nativeChild?.invalidate(); }
    catch { this.failed = true; }
  }
  private advanceLayout(): void {
    this.layoutVersion++;
    const child = this.focusTarget?.component;
    if (child && isFocusable(child)) child.focused = false;
  }
  // 未重建布局或目标来自旧布局时，阻断键盘委托，避免焦点仍指向已经隐藏的子组件。
  private get inputBlocked(): boolean {
    return this.failed || !!this.focusTarget && (!this.drawing || this.focusTarget.version !== this.layoutVersion);
  }
  private get inputTarget(): Component | undefined {
    return this.inputBlocked ? undefined : this.focusTarget?.component ?? this.nativeChild;
  }
  get focused(): boolean { const child = this.inputTarget; return !!child && isFocusable(child) && child.focused; }
  set focused(value: boolean) {
    const child = value ? this.inputTarget : this.focusTarget?.component ?? this.nativeChild;
    if (child && isFocusable(child)) child.focused = value;
  }
  get wantsKeyRelease(): boolean | undefined { return this.inputBlocked ? false : this.inputTarget?.wantsKeyRelease; }
  get capturesViewportInput(): boolean | undefined { return this.inputBlocked ? false : this.inputTarget?.capturesViewportInput; }
  handleInput(data: string): void { this.inputTarget?.handleInput?.(data); }
  private contains(x: number, y: number): boolean {
    const area = this.drawing?.native;
    const row = area && y - area.y;
    return !this.failed && !!area && row !== undefined && row >= 0 && row < area.rowWidths.length && x >= area.x && x < area.x + area.rowWidths[row]!;
  }
  handleMouse(event: TuiMouseEvent): MouseDispatch | undefined {
    const area = this.drawing?.native;
    if (event.width !== this.width || !area || !this.contains(event.x, event.y)) return undefined;
    const local = { ...event, x: event.x - area.x, y: event.y - area.y, width: area.width, height: area.height };
    return this.dispatch(this.nativeChild!, local, event.screenX - event.x, event.screenY - event.y);
  }
  private dispatch(component: Component, event: TuiMouseEvent, originX: number, originY: number): MouseDispatch | undefined {
    const result = component.handleMouse?.(event);
    if (!result || (!result.handled && !result.capture && !result.focus)) return undefined;
    const target = "target" in result ? (result as MouseDispatch).target : {
      component, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height,
    };
    // capture 也经过可见区域和布局版本检查，不能让宿主绕回已经失效的原生组件。
    // 深层 target 保留原坐标系，否则拖动时 Container 会重新命中其他子组件。
    const version = this.layoutVersion;
    const signature = JSON.stringify([version, originX, originY, target.originX, target.originY, target.width, target.height]);
    let cached = this.mouseTargets.get(target.component);
    if (cached?.signature !== signature) {
      const guarded: Component = {
        render: () => [], invalidate() {},
        handleMouse: next => {
          if (this.layoutVersion !== version || !this.contains(next.screenX - originX, next.screenY - originY)) return undefined;
          return this.dispatch(target.component, {
            ...next, x: next.screenX - target.originX, y: next.screenY - target.originY, width: target.width, height: target.height,
          }, originX, originY);
        },
      };
      cached = { signature, component: guarded };
      this.mouseTargets.set(target.component, cached);
    }
    if (result.focus) {
      // 宿主把 Slot 作为委托焦点；记住原生返回的实际焦点，不能只把输入转发给根容器。
      const explicit = "focusTarget" in result ? (result as MouseDispatch).focusTarget : undefined;
      const child = explicit ?? (component.handleInput ? component : target.component);
      const previous = this.focusTarget?.component;
      if (previous && previous !== child && isFocusable(previous)) previous.focused = false;
      this.focusTarget = { component: child, version };
    }
    return { ...result, handled: true, target: { ...target, component: cached.component }, ...(result.focus ? { focusTarget: this } : {}) };
  }
}
/** width/height 是原生完整边界；rowWidths 只覆盖折叠、横向裁剪后真正可见的内容。 */
export function nativeArea(full: string[], width: number, count: number, x: number, y: number, available = width): NativeArea {
  return { x, y, width, height: full.length, rowWidths: full.slice(0, count).map(line => {
    if (available <= 0) return 0;
    // SDK 的省略号占三列；宽字符放不下留下的空隙也不能成为原生命中区。
    return visibleWidth(line) > available ? visibleWidth(truncateToWidth(line, Math.max(0, available - visibleWidth("...")), "")) : available;
  }) };
}
export function previousContext(context: ToolRenderContext): ToolRenderContext {
  // 作者只看到自己的上次组件，不能把外层装饰误认为自己的 Text/Container。
  return { ...context, lastComponent: context.lastComponent instanceof SlotComponent ? context.lastComponent.nativeChild : context.lastComponent };
}
export function wrapNativeSlotRenderer(makeNative: () => Component, fallback: () => Component, draw: DrawSlot): SlotComponent {
  let child: Component | undefined;
  try {
    child = makeNative();
    if (!child || typeof child.render !== "function" || typeof child.invalidate !== "function") child = undefined;
  } catch { /* 可见失败提示由 draw 负责，不回显可能包含敏感参数的异常对象。 */ }
  return new SlotComponent(child, fallback, draw);
}
