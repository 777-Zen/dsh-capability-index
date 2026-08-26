# dsh-tool-demo-cap

`dsh-tool-demo` 的副本改造：**带能力声明的样例插件**（阶段二第二轮实验扩容版）。

## 工具库（4 个，全部带能力声明）

| 工具 | 类别 | 说明 | 调用日志 |
|---|---|---|---|
| `echo` | 冒烟 | 原样回显文本（v0 即有） | `echo-cap-calls.log` |
| `concat_text` | 拼接 | 多段文本拼接，可选分隔符 | 同上 |
| `format_text` | 格式化 | 大小写（upper/lower/title）、trim、空白折叠 | 同上 |
| `batch_transform` | 批量操作 | 对列表项统一变换（大小写/trim/前缀/后缀） | 同上 |

能力声明按 dsh-capability-index 的
[能力声明约定](../dsh-capability-index/README.md#能力声明约定capabilities)
经 `ctx.provide('capabilityIndex.declarations', …)` 发布（v0 单聚合器约定：
每个组合只应有一个插件提供该服务，本样例即该形态的演示）。

用途：作为"有声明插件"的测试样例，验证 dsh-capability-index 的富化层——
命中的提示块里会带上 `use_when`/`not_for`，且不标注"未提供能力声明"。

## 验证流水线

```powershell
# 安装到 dsh（<path> 换成本样例插件目录的绝对路径）
pnpm dsh plugin --profile web add <path>\dsh-tool-demo-cap
pnpm dsh --profile web --dump-config | Select-String tool-demo-cap
# 重启 web 应用；会话里发"帮我原样回显一句话"类消息，
# 观察 dsh-capability-index 提示块是否推荐对应工具且带能力声明
```

调用日志默认写当前工作目录的 `echo-cap-calls.log`（可用 `config.logPath`
覆盖，见 `lib/index.js` 注释），用于对照实验的 `tool/call` 真值核验。

## 文件

- `package.json` — 包清单 + `dsh.bundle.patch` 声明
- `cordis.patch.yml` — patch 层：insert `tool-demo-cap` 行
- `lib/index.js` — 插件本体：4 个工具 + capabilities 声明
