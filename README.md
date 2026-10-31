# dsh-dual-review

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：在 Agent 执行每一次工具调用之前，让**两个不同的模型**分别审查这次调用，按两者的结论决定执行、拦下，还是交给人确认。

它以官方 `@deepseek-ai/dsh-experimental-auto-review`（Auto 权限预设的单模型审查）为基础，把审查者换成可配置的两个模型。

## 行为

插件注册 DSH 的 **Auto** 权限预设。处于 Auto 的会话里，每次工具调用执行前，两个审查模型使用官方 auto-review 的审查提示词与输出协议，各自给出 `risk`（low / medium / high）和 `decision`（allow / deny）：

| 两个审查结果 | 处理 |
|---|---|
| 都 allow | 执行 |
| 都 deny | 拦下，不执行（`AUTO_REVIEW_DENIED`），理由中列出两个模型的意见 |
| 一个 allow 一个 deny，或任一审查调用失败 | 交给人确认，提示中列出两个模型各自的结论、风险和理由；会话审批策略为 `never`（例如委派出去的子 Agent）时直接拦下 |

- 人工确认走会话自己的审批通道：网页会话在网页里弹出确认，钉钉等渠道的会话由对应连接器处理。
- `defaultForNewSessions: true` 时，全新的顶层会话默认进入 Auto；已有会话和手动改过权限的会话不受影响，之后仍可在网页里切换。
- 两个审查模型没有都配置好时，插件与官方 auto-review 行为相同（单模型、使用会话自己的模型），也不会改动新会话的默认权限。
- 每次审查记一行 info 日志：工具名和两个模型的 allow / deny / failed，不记录理由和调用参数。

注意：Auto 预设的沙箱是 `danger-full-access`，由审查模型代替人工逐次把关；每次工具调用会额外产生两次模型请求。

## 兼容性

- DSH `0.2.1-rc.5`（peer 依赖按该版本锁定），Node.js ≥ 24.9。
- **不能与官方 `@deepseek-ai/dsh-experimental-auto-review` 同时安装**，两者都会注册 Auto 预设。

## 安装

```sh
dsh plugin --profile web add github:ckyasb/dsh-dual-review#v0.1.0
```

安装后需要重启 DSH。

## 配置

1. 在 `llm-pi-ai` 中为两个审查模型各配一条 provider 路由（OpenAI 兼容接口为例，key 通过环境变量提供）：

   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         review-gpt:
           displayName: GPT reviewer
           api: openai-completions
           baseURL: https://example.com/v1
           apiKeyEnv: REVIEW_GPT_API_KEY
           models:
             - { id: <model-id>, name: GPT reviewer }
         review-deepseek:
           displayName: DeepSeek Flash reviewer
           api: openai-completions
           baseURL: https://api.deepseek.com/v1
           apiKeyEnv: REVIEW_DEEPSEEK_API_KEY
           models:
             - { id: <model-id>, name: DeepSeek Flash reviewer }
   ```

   注意：patch 会整体替换该行的 `config`，已有的 provider 路由也要一并写上。

2. 配置插件（profile 的 `cordis.patch.yml` 或 `dsh --patch` 叠加文件）：

   ```yaml
   - id: dual-review
     config:
       defaultForNewSessions: true
       reviewers:
         - { name: GPT, provider: review-gpt, model: <model-id> }
         - { name: DeepSeek Flash, provider: review-deepseek, model: <model-id> }
   ```

   | 字段 | 说明 |
   |---|---|
   | `reviewers` | 取前两个 `provider`、`model` 都非空的条目；`name` 可省略（缺省 `reviewer-1` / `reviewer-2`）；`temperature` 缺省 0，设为 `null` 时请求不带 temperature |
   | `defaultForNewSessions` | 为 `true` 且两个审查模型都已配置时，全新顶层会话默认进入 Auto |

## 开发与测试

```sh
npm run check   # 语法检查
npm test        # 端到端测试，需要 PATH 中有 dsh 0.2.1-rc.5、pnpm 11 和 Node.js ≥ 24.9
```

端到端测试会把插件打包装进一个临时的 DSH headless profile，用一个脚本化的 OpenAI 兼容服务扮演 Agent 和两个审查模型，覆盖五种情况：两个 allow、两个 deny、意见不一致、一个审查失败、未配置审查模型。GitHub Actions 在每次推送时运行这套测试。

## 来源

- `lib/index.js` 基于 DeepSeek 官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.5`（MIT），保留其版权声明。
- 双模型审查部分由 DSH（glm-5.3-flash）按需求说明编写；代码审阅和端到端测试发现的问题反馈给 DSH 修正后，通过了上述端到端测试。

## 许可证

MIT，见 [LICENSE](LICENSE)。
