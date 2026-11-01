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
      skipPresets: []           # 这些预设的会话不自动进入 plan mode、不做计划审查和完成度检查
      reportFallbackPresets: [] # 这些预设的会话需要人工时，不弹 DSH 的计划审批问题，而是让 agent 自己去问
    completionCheck:
      enabled: false            # 完成度检查
```

两项功能都要求恰好有两个有效 reviewer；不满足时不启用并记一条 warning。计划审查还要求 DSH 里组合了 plan-mode 插件。

`skipPresets` 和 `reportFallbackPresets` 都是预设 id 的字符串数组（非法项忽略）。会话的预设取 DSH 的 `agentPreset` 会话投影（预设注册表最后一次为它选择的预设），取不到再用创建时的 `session.header.agentPreset`；没有预设注册表的 profile（如 headless）里会话没有预设，这两项不起作用。`skipPresets` 里的预设（例如 [dsh-superagent](https://github.com/ckyasb/dsh-superagent) 只做路由、不能进计划模式的 `dsh-superagent-router`）完全不走计划审查流程；`reportFallbackPresets` 里的预设（例如不被人打开、DSH 的计划审批问题没人能回答的执行器 `dsh-superagent-worker`）在审查没通过时改为让 agent 通过自己的渠道（如 `orchestrator_report` 的 `human_action`）去问请求人。

### 启用 plan-mode

plan mode 由 DSH 的 `plan-mode` 插件提供，插件用的是根层 `plan-mode` 行提供的服务。headless 和 web profile 都已组合这一行；如果你的 profile 关掉了它，在 patch 里改成 `disabled: false`。patch 会整体替换这一行的 `config`，要写上完整的 `section`（plan 阶段追加给 Agent 的提示词），例如：

```yaml
- id: plan-mode
  disabled: false
  config:
    section: "调查阶段只读。先完成只读调查，再用 exit_plan_mode 提交计划。"
```

注意：plan 阶段的“只读”依赖提示词约束，plan mode 本身不拦截工具；真正的执行拦截由权限预设负责，或者用风险闸门的 `requirePlan` 模式拒绝计划获批前的有风险调用。

### 人工兜底

以下情况会交给人审批（网页或对应渠道弹出计划确认）：

- 审查要求修改的轮数达到 `maxRevisions`；
- 任一审查模型调用失败（HTTP 错误、超时、输出不合协议）。

会话的预设在 `planReview.reportFallbackPresets` 里时不走上面的路径：插件不弹 DSH 自带的计划审批问题（执行器没有人在网页里回答），而是直接拒绝这次提交并告诉 agent：计划没有获批、仍处于计划模式，要它把计划要做的操作和影响告诉请求人，请求明确同意（用 agent 自己的渠道，例如 `orchestrator_report` 的 `human_action`），得到同意后再次调用 `exit_plan_mode` 提交计划并在计划里写明请求人已同意。之后（请求人的回复开始的新回合里）它提交的第一份计划按请求人的同意直接批准，不再调用审查模型；在问人的同一回合里重新提交仍会被拒绝，批准也只对这一份计划有效。

如果计划审查通过但完成度检查发现任务未完成，Agent 自动续做一次后即使仍未完成也不会再问模型，只会把原因写进它自己的最终结论。

## 风险闸门

v0.4.0 新增第三种与前面两种互相独立、可同时存在的工作流：**只审查有风险的工具调用**。它为 [dsh-superagent](https://github.com/ckyasb/dsh-superagent) 这类没有 plan mode、用自己的预设（如 `danger-full-access`）直接执行任务的执行器设计：从钉钉群和 GitLab 接任务，既改 argo-cd 仓库，也直接做运维操作（kubectl、ssh、MCP）。要求是：**能影响集群或服务器的调用，先由两个审查模型审查，都通过就自动执行；只读和本地操作不审查。**

v0.5.0 给它加了第二种模式：`riskGate.mode: requirePlan`。这个模式**不调用审查模型**：有风险的调用如果发生在计划获批之前（会话当前处于 plan mode，或有未处理的进入请求）就直接拒绝并提示 agent 先提交计划，计划获批后（或用户自己关了计划模式）则直接放行、不审查。`mode` 缺省或非法时按 `review`（v0.4 行为）。`requirePlan` 推荐与计划审查一起用：这样审查模型每个任务只被调用两次——计划一次、完成度一次，执行中不再逐条审查。会话的预设在 `planReview.skipPresets` 里时，`requirePlan` 守卫也不作用于它。子 Agent 自己不做计划，它的有风险调用按最上层父会话的计划状态判定（父会话还在计划模式就拒绝），所以计划获批前也不能把改动交给子 Agent 去做。

### 判定规则

每次工具调用前（子 Agent 会话同样生效），按部署方的正则判定是否有风险：

- 工具名是 `bash`（shell 类）且 `arguments.command` 全文被 `riskGate.commands` 任一正则匹配（按多行模式 `m` 测试）；或
- 工具名被 `riskGate.tools` 任一正则匹配。

不匹配的调用直接放行，不产生任何审查请求。三种跳过情形：会话未挂接 Agent、外层 `run_code` 调用、当前会话已在 Auto 预设（那时逐次审查已经负责，避免重复审查）。

### 审查与合并规则

判定有风险的调用会构建审查输入（对话与当前回合记录，再加一节 `PENDING_ACTION`，即本次工具名与参数的 JSON，超过 4000 字符截断），用固定的风险审查提示词并行调用两个审查模型。合并：

| 两个审查结果 | 处理 |
|---|---|
| 都 `allow` | 执行 |
| 任一 `deny`、任一审查调用失败或输出不合协议 | 拦下，不执行（`RISK_GATE_DENIED`），理由中列出两个模型各自的通过 / 拒绝 / 失败情况 |

审查是**失败关闭**的：只要不是两个明确的 `allow`，一律不执行。审查期间会话中止则取消这次调用。每次审查记一行 info 日志（工具名和两个模型的 allow / deny / failed），不记录参数和理由。

### 被拒之后 Agent 应该怎么做

被拦下时 Agent 收到的提示要求它：**换一种更安全、范围更小的做法；如果确实需要这样做，先向请求人说明要做的操作和影响，得到明确同意后再执行**——也就是回到请求人（钉钉群里的人）确认，而不是自行重试同样的操作。

### 配置

```yaml
- id: dual-review
  config:
    riskGate:
      enabled: false            # 风险闸门总开关
      mode: review              # review（逐次双模型审查）或 requirePlan（计划获批前直接拒绝，不调审查模型）
      commands: []              # 正则字符串数组：对 bash 的 command 全文测试（flags 'm'）
      tools: []                 # 正则字符串数组：对工具名测试
```

`mode: review` 与另两种模式一样要求恰好有两个有效 reviewer，不满足时记一条 warning 并不启用；`mode: requirePlan` 不调用审查模型，所以没有这个要求。无效正则在启动时记 warning 并忽略该条，不影响插件加载。正则是**部署方的策略**，请按自己的集群和服务器实际情况调整。

示例配置（kubectl 非只读子命令、helm 变更类子命令、ssh / scp / rsync、带写方法的 curl，以及 kubernetes MCP 的写操作）：

```yaml
    riskGate:
      enabled: true
      commands:
        - '^kubectl\s+(apply|create|delete|edit|patch|replace|scale|rollout|cordon|drain|taint|label|annotate|set)\b'
        - '^helm\s+(install|upgrade|uninstall|rollback)\b'
        - '^(ssh|scp|rsync)\s'
        - 'curl\s+[^|]*-X\s*(POST|PUT|PATCH|DELETE)\b'
      tools:
        - '^mcp__kubernetes__.*(delete|create|update|patch|scale|exec|apply|run)'
```

### dsh-superagent 的示例配置

dsh-superagent 的路由主 Session 用预设 `dsh-superagent-router`（只路由，不能进计划模式），执行器用 `dsh-superagent-worker`（不被人打开，DSH 自带的计划审批问题没人回答）。推荐配置：路由会话完全跳过计划审查流程，执行器需要人工时让 agent 自己去问请求人，风险闸门用 `requirePlan` 模式配合计划审查（每个任务只调用审查模型两次）：

```yaml
    planReview:
      enabled: true
      autoPlanMode: true
      maxRevisions: 2
      skipPresets: [dsh-superagent-router]
      reportFallbackPresets: [dsh-superagent-worker]
    completionCheck:
      enabled: true
    riskGate:
      enabled: true
      mode: requirePlan
      commands:
        - '^kubectl\s+(apply|create|delete|edit|patch|replace|scale|rollout|cordon|drain|taint|label|annotate|set)\b'
      tools: []
```

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
npm test        # 单元测试和端到端测试，需要全局安装的 dsh 0.2.1-rc.5、pnpm 11 和 Node.js ≥ 24.9
```

端到端测试会把插件打包装进一个临时的 DSH headless profile，用一个脚本化的 OpenAI 兼容服务扮演 Agent 和两个审查模型，覆盖逐次调用审查的五种情况（两个 allow、两个 deny、意见不一致、一个审查失败、未配置审查模型），以及计划审查与完成度检查的五种情况（批准、检查未通过触发自动续做、检查失败、两轮 revise 后人工兜底、审查失败人工兜底），再加 `requirePlan` 模式在计划获批前拒绝有风险调用、获批后放行，以及风险闸门 `review` 模式的四种情况。headless 的一次性运行器不接受带预设的会话，所以 `skipPresets`、`reportFallbackPresets` 和 `requirePlan` 的判定由 `test/unit` 里的单元测试覆盖：它们用桩宿主直接驱动插件的钩子，从全局 dsh 安装里加载插件的 peer 依赖。GitHub Actions 在每次推送时运行这两套测试。

发布新版本：修改 `package.json` 的 `version`，提交后推送同名标签（如 `v0.1.1`）。Actions 跑完测试后会打包并创建对应的 Release。

## 来源

- `lib/index.js` 基于 DeepSeek 官方 `@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.5`（MIT），保留其版权声明。
- 双模型审查部分由 DSH（glm-5.3-flash）按需求说明编写；代码审阅和端到端测试发现的问题反馈给 DSH 修正后，通过了上述端到端测试。

## 许可证

MIT，见 [LICENSE](LICENSE)。
