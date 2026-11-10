# 灵犀模型接点

提供端点配置与必要的消息策略，模型请求直接使用 `@langchain/openai@1.8.0` 的标准 `ChatOpenAI`。HTTP、SSE、工具参数累积、取消与用量解析均由 adapter 处理。没有 provider 注册或另一套模型循环。

```ts
import { createModel, prepareMessages, type ProviderEntry } from 'lingxi-provider';

const entry: ProviderEntry = {
  baseUrl: 'https://api.deepseek.com',
  spec: { model: 'deepseek-flash', thinking: true, reasoningEffort: 'high' },
  multimodal: true,
};
const model = createModel(entry, { apiKey });
// Supply this message transform from the application's existing model-call middleware.
const reply = await model.bindTools(tools).invoke(prepareMessages(messages, entry), { signal });
```

`options.protocol = 'responses'` 使用 Responses，`'chat'` 使用 Chat Completions；未设时沿用供应商表，其余地址默认 Responses。`baseUrl` 是协议路径之前的地址。密钥由调用方传入，不在本包读取个人配置。远程明文 HTTP 端点在创建模型前拒绝，本机与局域网例外沿用原规则。

未传密钥时向标准 SDK 显式提供 `not-required` 占位，避免继承进程中的其他 OpenAI 密钥。端点需接受该占位认证头。

`prepareMessages` 不修改存档，只处理当次标准 LangChain 消息：图片只保留最新用户批次；禁用多模态时不发送图片；Chat 的工具结果图片移到结果之后的用户消息；关闭思考或不保留往轮思考时移除相应推理。DeepSeek Responses 的工具调用缺少推理时保留原有 `'-'` 占位。

已知限制：标准 ChatOpenAI 1.8.0 的 Chat 出站转换没有重放 `reasoning_content`。DeepSeek 的 Chat 思考工具链尚不等同于原兼容实现；当前默认 Responses 已覆盖该占位路径。这里不通过自写传输修补。旧价格表作为带来源日期的数据保留，不声称当前价格已重新核实。

在包目录运行 `pnpm exec vitest run --config vitest.config.ts` 与 `pnpm exec tsc --noEmit -p tsconfig.json`。测试只请求本地 HTTP 替身，不调用真实模型。

标准 adapter 参考：[LangChain ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai)。
