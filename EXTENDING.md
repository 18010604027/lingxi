# 扩展灵犀

灵犀的运行时分成三层：前台负责当前对话和表达，行为系统负责动作与移动，后台负责较长任务和外部执行器。扩展时先选择所属层，不要把决策塞进启动器或 UI。

## 常见扩展点

| 想增加的东西 | 修改位置 | 约束 |
|---|---|---|
| 新模型或 API 服务 | `packages/lingxi-provider/` | 返回标准 LangChain chat model；不要在身体或工作台里拼请求 |
| 新前台工具 | `core/pet/`、`core/persona.ts` 的工具组装 | 实现 `ToolDef`，由 `runtime/tools.ts` 转成标准工具；返回工具结果，面向用户的呈现走共享输出 |
| 记忆写入、召回或整理 | `core/memory/` | 通过记忆服务读写，不直接操作 SQLite checkpoint |
| 新动作或心情表达 | 形象包的 `figure.json`、`words`、`vocab` | 代码只发动作意图；片段和运动算法由形象包提供 |
| 新日常行为 | `core/behavior/`、`core/daily/` | 行为系统决定怎么执行，前台只请求或记录结果 |
| 新代码执行器 | `core/agents/` 的 adapter | 实现通用任务接口，优先接现成 harness；普通聊天不得依赖它 |
| 身体气泡、输入或互动 | `body/` | 只消费共享事件；不要在身体窗口内重新决定任务或记忆 |
| 工作台页面 | `workbench/` | 通过 Core API 读写状态；不要复制一套业务状态 |

## 加一个功能的顺序

1. 先写清楚它属于哪一层，以及输入、输出和失败结果。
2. 先复用已有事件、工具或 adapter 接口；只有接口确实不够时才扩展接口。
3. 在所属目录实现，并给同目录的替身测试；不要把实现塞进 `core/application.ts`、`body/main.cjs` 或工作台渲染器。
4. 更新 README 或形象包说明，再运行：

```sh
pnpm exec tsc --noEmit -p .
pnpm test
pnpm test:body
```

5. 只有改变了固定常规样例的行为，才补相应验收；通过后冻结该阶段，不顺手扩大测试范围。

## 当前接口入口

- 模型：`packages/lingxi-provider/src/model.ts` 的 `createModel`，由 `core/application.ts` 装配；前台循环位于 `core/runtime/front-agent.ts`，接收标准 `BaseChatModel`。
- 工具：`core/contracts.ts` 的 `ToolDef` 定义名称、JSON schema、标签和 handler。`core/runtime/tools.ts` 负责转换，不在每个工具里重写循环。
- 记忆：`core/memory/recall.ts`、`graph-recall.ts` 和 `hints.ts` 管召回，`core/persona.ts` 负责将结果带入上下文；调整评分不用修改 UI 或模型传输。
- 鼠标：`body/body.js` 识别手势，`core/pet/world.ts` 记录互动并按已有策略交给行为系统；只改一次点击反应时，不应修改 agent 循环。
- 执行器：`core/agents/code-agent.ts` 的 `CodeAgentAdapter`、`CodeTask`、`CodeAgentEvent` 是接口；在 `code-agent-registry.ts` 注册，在配置和设置中声明真实支持的能力。

这些是当前真实接点，不是免改核心的动态插件平台。新增工具仍需在工具组装处接线，新增 adapter 仍需注册；不必修改模型循环、业务记忆或身体播放。身体主进程和渲染脚本仍有集中实现，修改时保持窗口生命周期、手势与显示状态的边界，不借新功能进行整体重写。

## 状态和事件边界

- Core 是对话、任务、记忆和共享输出的唯一事实来源。
- 身体和工作台是两个投影，不各自保存一份任务或聊天状态。
- agent 执行状态可以进入 SQLite checkpoint；业务记忆仍走 `core/memory/`。
- 模型没有公开的思考内容时，UI 只能展示已公开的输入、进度、工具、后台记录和回复，不能生成所谓“思考内容”。

## 形象包和执行器

形象包是使用者提供的配置，不是灵犀源码的一部分。它必须包含 `figure.json` 和 `motion.cjs`，片段放在 `clips/` 或由 `LINGXI_CLIPS` 指定。先运行 `pnpm check:pack <目录>`，再启动。

`core/behavior/pack-resources.ts` 是启动、检查与首次配置共用的资源校验。新增形象包字段时同步调整 `pack.ts` 和 `packs/figure.schema.json`；不要在三个入口各补一份规则。使用 `pnpm run setup:app -- --pack <目录>` 可检查并保存选择，不需要修改源码。

执行器通过 adapter 接入。adapter 负责把通用任务转换成某个 harness 的调用，并把进度、结果、取消和未知状态转换回通用事件。不要在灵犀里重新实现完整 coding harness、沙箱或审批系统。

`pnpm test` 先并行跑功能测试，再单独跑工作区的 20ms 耗时基准，避免同时编译和启动测试进程污染单次耗时。它没有放宽阈值或跳过基准。

## 不要做的事

- 不在 UI 里直接请求模型、写记忆或启动执行器。
- 不把个人 `build/`、形象包、密钥和运行日志加入 Git。
- 不把旧宿主兼容代码当成普通运行时依赖。
- 不为了“模块化”复制一份状态或再造一套协议。
