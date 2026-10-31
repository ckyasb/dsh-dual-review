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

## 计划审查与完成度检查

v0.3.0 新增一种与逐次调用审查并存的工作流：不再对每一次工具调用把关，而是审查**计划**和**完成度**。

1. **自动进入 plan mode**（`planReview.autoPlanMode`）：每个新的顶层会话（子 Agent 除外）自动进入 plan mode。Agent 先做只读调查，再用 `exit_plan_mode` 提交计划；回合结束后（无论走完还是中断）都会自动回到 plan mode。因此 `/plan off` 只对当前请求生效。
2. **双模型计划审查**（`planReview.enabled`）：Agent 提交计划时，两个审查模型并行审查，主要任务是**补充计划的漏洞**——遗漏的步骤、验证、备份/回滚、未覆盖的请求部分等。两者都 `approve` 就自动批准并退出 plan mode，不再问人；批准消息会列出所有审查补充项，要求 Agent 执行时一并完成并逐项验证。任一 `revise` 则把阻断问题和补充项回给 Agent，让它继续只读调查并修订计划；最多 `maxRevisions` 轮（0–5，缺省 2），超过后交给人审批。审查调用失败时同样交给人审批，不计轮数。
3. **完成度检查**（`completionCheck.enabled`）：执行结束、回合即将关闭时，两个审查模型对照用户请求、批准的计划、审查补充项和当前回合的工具调用与结果，检查任务是否真正完成（只有工具结果证实了的步骤才算完成）。只要有一个人认为未完成，就把遗漏项回给 Agent 并让同一回合**自动续做一次**；这次续做结束后不再检查。

### 配置

```yaml
- id: dual-review
  config:
    reviewers: [...]            # 同上，两个审查模型共用
    defaultForNewSessions: false
    planReview:
      enabled: false            # 计划审查总开关
      autoPlanMode: true        # 每个新请求自动进入 plan mode
      maxRevisions: 2           # 审查要求修改的最多轮数，超过后交给人工审批
    completionCheck:
      enabled: false            # 完成度检查
```

两项功能都要求恰好有两个有效 reviewer；不满足时不启用并记一条 warning。计划审查还要求 DSH 里组合了 plan-mode 插件。

### 启用 plan-mode

plan mode 由 DSH 的 `plan-mode` 插件提供；web profile 里它默认 `disabled: true`，需要在 patch 里改成 `disabled: false` 并提供完整的 `section`（plan 阶段追加给 Agent 的提示词），例如：

```yaml
- id: plan-mode
  disabled: false
  config:
    section: "调查阶段只读。先完成只读调查，再用 exit_plan_mode 提交计划。"
```

注意：plan 阶段的“只读”依赖提示词约束，plan mode 本身不拦截工具；真正的执行拦截仍由权限预设负责。

### 人工兜底

以下情况会交给人审批（网页或对应渠道弹出计划确认）：

- 审查要求修改的轮数达到 `maxRevisions`；
- 任一审查模型调用失败（HTTP 错误、超时、输出不合协议）。

如果计划审查通过但完成度检查发现任务未完成，Agent 自动续做一次后即使仍未完成也不会再问模型，只会把原因写进它自己的最终结论。

## 兼容性

- DSH `0.2.1-rc.5`（peer 依赖按该版本锁定），Node.js ≥ 24.9。
- **不能与官方 `@deepseek-ai/dsh-experimental-auto-review` 同时安装**，两者都会注册 Auto 预设。

## 安装

从 GitHub Release 安装打包好的 tarball：

```sh
dsh plugin --profile web add https://github.com/ckyasb/dsh-dual-review/releases/download/v0.1.0/dsh-dual-review-0.1.0.tgz
```

安装后需要重启 DSH。不建议用 `github:ckyasb/dsh-dual-review` 这种写法：pnpm 会把它当作 git 依赖，需要运行环境里有 git，还会要求放行构建脚本。

## 配置

推荐用**直连模式**：插件直接调用审查模型的 OpenAI 兼容 `chat/completions` 接口，审查模型不经过 DSH 的 provider 路由，因此**不会出现在 DSH 的模型目录里**，Agent 也就无法在网页模型选择器、钉钉 `/model` 或子 agent 中选用它们。

1. 配置插件（profile 的 `cordis.patch.yml` 或 `dsh --patch` 叠加文件）：

   ```yaml
   - id: dual-review
     config:
       defaultForNewSessions: true
       reviewers:
         - { name: GPT, baseURL: https://example.com/v1, apiKeyEnv: REVIEW_GPT_API_KEY, model: <model-id> }
         - { name: DeepSeek Flash, baseURL: https://api.deepseek.com/v1, apiKeyEnv: REVIEW_DEEPSEEK_API_KEY, model: <model-id> }
   ```

   | 字段 | 说明 |
   |---|---|
   | `reviewers` | 取前两个有效条目（直连与路由模式可以混用）；`name` 可省略（缺省 `reviewer-1` / `reviewer-2`）；`temperature` 缺省 0，设为 `null` 时请求不带 temperature |
   | `baseURL` | 直连模式的 OpenAI 兼容接口地址；非空时该条按直连模式处理 |
   | `apiKeyEnv` | 存放 API key 的环境变量名（直连模式必填） |
   | `model` / `timeoutMs` | 直连模式的模型 id（必填）与请求超时毫秒数（缺省 120000） |
   | `defaultForNewSessions` | 为 `true` 且两个审查模型都已配置时，全新顶层会话默认进入 Auto |

   注意：DSH 会从 Agent 的 shell 环境中过滤名字含 `KEY` / `TOKEN` / `SECRET` / `PASSWORD` 的变量，所以 key 的环境变量名应包含 `KEY`（如上例），这样 Agent 的 shell 命令默认看不到它。这不是完全隔离：Auto 预设下 Agent 与 DSH 是同一用户、沙箱为完全访问，仍可能通过读取进程信息拿到 key；需要彻底隔离时应把审查放到独立的服务里。

2. 设置两个环境变量（如 `REVIEW_GPT_API_KEY`、`REVIEW_DEEPSEEK_API_KEY`）后重启 DSH。

### 路由模式（兼容）

旧配置仍可用：把审查模型注册成 DSH `llm-pi-ai` 的一条 provider 路由（OpenAI 兼容接口为例，key 通过环境变量提供），再在插件配置里用 `provider` + `model` 引用：

   ```yaml
   # llm-pi-ai 的 providers：
   review-gpt:
     displayName: GPT reviewer
     api: openai-completions
     baseURL: https://example.com/v1
     apiKeyEnv: REVIEW_GPT_API_KEY
     models:
       - { id: <model-id>, name: GPT reviewer }
   ```

   ```yaml
   - id: dual-review
     config:
       reviewers:
         - { name: GPT, provider: review-gpt, model: <model-id> }
   ```

   注意：patch 会整体替换该行的 `config`，已有的 provider 路由也要一并写上。这种方式下审查模型会进入 DSH 的模型目录，Agent 可以选用；建议改用直连模式。

## 开发与测试

```sh
npm run check   # 语法检查
npm test        # 端到端测试，需要 PATH 中有 dsh 0.2.1-rc.5、pnpm 11 和 Node.js ≥ 24.9
```

端到端测试会把插件打包装进一个临时的 DSH headless profile，用一个脚本化的 OpenAI 兼容服务扮演 Agent 和两个审查模型，覆盖逐次调用审查的五种情况（两个 allow、两个 deny、意见不一致、一个审查失败、未配置审查模型），以及计划审查与完成度检查的五种情况（批准、检查未通过触发自动续做、检查失败、两轮 revise 后人工兜底、审查失败人工兜底）。GitHub Actions 在每次推送时运行这套测试。

发布新版本：修改 `package.json` 的 `version`，提交后推送同名标签（如 `v0.1.1`）。Actions 跑完测试后会打包并创建对应的 Release。

## 来源

- `lib/index.js` 基于 DeepSeek 官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.5`（MIT），保留其版权声明。
- 双模型审查部分由 DSH（glm-5.3-flash）按需求说明编写；代码审阅和端到端测试发现的问题反馈给 DSH 修正后，通过了上述端到端测试。

## 许可证

MIT，见 [LICENSE](LICENSE)。
