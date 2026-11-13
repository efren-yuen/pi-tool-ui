import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Markdown, type DefaultTextStyle, type MarkdownTheme } from "@earendil-works/pi-tui";

const colorKeys = ["heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder", "hr", "listBullet"] as const;
const styleKeys = ["bold", "italic", "strikethrough", "underline"] as const;
const registryKey = Symbol.for("pi-tool-ui/thinking-markdown/v1");
type Render = (this: unknown, width: number) => string[];

// 仅此处描述宿主的运行时私有字段；不得依赖文字颜色或斜体推断消息类型。
interface RuntimeMarkdown {
  theme: MarkdownTheme;
  defaultTextStyle: DefaultTextStyle & { color: (text: string) => string };
  invalidate(): void;
}
interface Adaptation { original: MarkdownTheme; replacement: MarkdownTheme }
interface Installation {
  active: boolean;
  reason?: string;
  owners: Set<symbol>;
  stack: unknown[];
  adapted: WeakMap<object, Adaptation>;
  instances: Set<WeakRef<RuntimeMarkdown>>;
  finalizer: FinalizationRegistry<WeakRef<RuntimeMarkdown>>;
  wrapper: Render;
  retainedRender?: Render;
  stop(reason?: string): void;
}
// 1.5.0 忽略第二参数，1.5.2 支持 surface 筛选；回调仍检查精确类型。
export interface ThinkingMarkdownApi {
  registerMarkdownTransformer(transformer: MarkdownTransformer, options?: { messageTypes: readonly ["assistant-thinking"] }): void;
}
export interface ThinkingMarkdownHandle {
  readonly reason: string | undefined;
  cleanup(): void;
}

function runtimeMarkdown(value: unknown): RuntimeMarkdown | undefined {
  if (!value || typeof value !== "object") return;
  const theme = Object.getOwnPropertyDescriptor(value, "theme");
  const style = Object.getOwnPropertyDescriptor(value, "defaultTextStyle");
  const options = Object.getOwnPropertyDescriptor(value, "options");
  if (!theme?.writable || !theme.value || typeof theme.value !== "object" ||
      !style?.value || typeof style.value.color !== "function" ||
      typeof options?.value?.transform !== "function" ||
      typeof Reflect.get(value, "invalidate") !== "function") return;
  const palette = theme.value as Partial<MarkdownTheme>;
  if (![...colorKeys, ...styleKeys].every(key => typeof palette[key] === "function") ||
      (palette.highlightCode !== undefined && typeof palette.highlightCode !== "function")) return;
  return value as RuntimeMarkdown;
}

function createInstallation(prototype: object, descriptor: PropertyDescriptor, registry: WeakMap<object, Installation>): Installation {
  const original = descriptor.value as Render;
  const instances = new Set<WeakRef<RuntimeMarkdown>>();
  const record: Installation = {
    active: true,
    owners: new Set(),
    stack: [],
    adapted: new WeakMap(),
    instances,
    finalizer: new FinalizationRegistry(ref => instances.delete(ref)),
    wrapper(this: unknown, width: number): string[] {
      if (!record.active) return original.call(this, width);
      record.stack.push(this);
      // 不捕获宿主 render 的异常，更不能在失败后重复绘制。
      try { return original.call(this, width); }
      finally { record.stack.pop(); }
    },
    stop(reason) {
      record.active = false;
      record.reason ??= reason;
      // 只在停用时遍历弱引用，不持有实例、会话或思考正文。
      for (const ref of instances) {
        const instance = ref.deref();
        const adaptation = instance && record.adapted.get(instance);
        if (instance && adaptation) {
          try {
            if (instance.theme === adaptation.replacement) {
              instance.theme = adaptation.original;
              instance.invalidate();
            }
          } catch { /* 其他扩展若随后冻结实例，尽力恢复，不阻断退出。 */ }
        }
        record.finalizer.unregister(ref);
      }
      instances.clear();
      record.adapted = new WeakMap();
      // 外层若已有其他扩展的包装，不覆盖它；留下的本层只做透明转发。
      try {
        record.retainedRender = Object.getOwnPropertyDescriptor(prototype, "render")?.value;
        if (record.retainedRender === record.wrapper) {
          Object.defineProperty(prototype, "render", descriptor);
          if (registry.get(prototype) === record) registry.delete(prototype);
        }
      } catch { /* 原型后来被冻结时，保留已停用的透明包装。 */ }
    },
  };
  Object.defineProperty(prototype, "render", { ...descriptor, value: record.wrapper });
  registry.set(prototype, record);
  return record;
}

export function installThinkingMarkdown(pi: ThinkingMarkdownApi): ThinkingMarkdownHandle {
  let record: Installation | undefined;
  let failure: string | undefined;
  const token = Symbol("thinking-markdown-owner");
  try {
    if (typeof pi.registerMarkdownTransformer !== "function") throw Error("缺少 Markdown transformer API");
    const prototype = Markdown.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
    if (!descriptor?.writable || typeof descriptor.value !== "function" || typeof prototype.invalidate !== "function") {
      throw Error("Markdown 绘制方法不可适配");
    }
    const shared = globalThis as typeof globalThis & { [key: symbol]: WeakMap<object, Installation> | undefined };
    const registry = shared[registryKey] ??= new WeakMap<object, Installation>();
    record = registry.get(prototype);
    // 外层扩展撤销包装时可能重新暴露本层；只有既非本层也非保留外层时才视为脱链。
    if (!record || (record.owners.size === 0 && descriptor.value !== record.wrapper && descriptor.value !== record.retainedRender)) {
      record = createInstallation(prototype, descriptor, registry);
    } else if (record.owners.size === 0) {
      record.active = true;
      record.reason = undefined;
    }
    const installation = record;
    installation.owners.add(token);
    pi.registerMarkdownTransformer((text, context) => {
      if (!installation.active || !installation.owners.has(token) || context.messageType !== "assistant-thinking") return text;
      try {
        const current = installation.stack.at(-1);
        if (!current || typeof current !== "object") throw Error("Markdown transformer 不在同步绘制路径中");
        if (installation.adapted.has(current)) return text;
        const instance = runtimeMarkdown(current);
        if (!instance) throw Error("Markdown 实例字段不兼容");
        const original = instance.theme;
        // 每次调用都读宿主闭包，让主题切换继续使用当前 thinkingText，不缓存 ANSI。
        const color = (value: string) => instance.defaultTextStyle.color(value);
        // 展开只复制可枚举自有属性，排版与缩进还须显式保留继承/不可枚举的值。
        const replacement = { ...original, codeBlockIndent: original.codeBlockIndent, highlightCode: undefined };
        for (const key of styleKeys) replacement[key] = original[key];
        for (const key of colorKeys) replacement[key] = color;
        const ref = new WeakRef(instance);
        installation.adapted.set(instance, { original, replacement });
        installation.instances.add(ref);
        installation.finalizer.register(instance, ref, ref);
        instance.theme = replacement;
        instance.invalidate();
      } catch (error) {
        installation.stop(error instanceof Error ? error.message : "Markdown 局部适配失败");
      }
      return text;
    }, { messageTypes: ["assistant-thinking"] });
  } catch (error) {
    failure = error instanceof Error ? error.message : "Markdown 能力检测失败";
    if (record) {
      record.owners.delete(token);
      if (record.owners.size === 0) record.stop(failure);
    }
  }
  return {
    get reason() { return failure ?? record?.reason; },
    cleanup() {
      if (!record?.owners.delete(token)) return;
      if (record.owners.size === 0) record.stop();
    },
  };
}
