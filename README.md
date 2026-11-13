# pi-tool-ui

让 [Pi](https://pi.dev) 的工具调用更紧凑：单行标题、状态与耗时，可展开的 subagent / codemode 工具树。

支持内置工具、MCP 和自定义工具，只改变显示，不改变工具执行、模型上下文或会话历史。

```text
✓ read README.md 3ms
✓ subagent parallel 67ms
  ├ ▸ worker
  └ ▸ reviewer
✓ codemode 12ms
  ├ ▸ read src/index.ts
  └ ▾ bash echo hello
    command: echo hello
    hello
    耗时: 1ms
```

## 安装

```sh
pi install npm:pi-tool-ui
```

## 许可证

[MIT](LICENSE)
