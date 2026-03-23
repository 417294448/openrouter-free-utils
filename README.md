# openrouter-free-utils

这是一个“开箱即用”的 OpenRouter 免费模型工具目录，包含：

- 一个可复用的客户端库（自动选模型、失败自动切换、支持流式输出）
- 一个完整示例页（`openrouter-demo.html`）
- 一个可直接聊天的页面（`openrouter-free.html`）
- TypeScript 类型定义（`openrouter-client.d.ts`）

适合你想快速做这几件事：

- 在浏览器里接 OpenRouter 免费模型
- 避免单个模型不稳定时整段对话失败
- 做“流式打字机输出”
- 查看模型/Provider 的性能统计，判断当前谁更快

---

## 目录结构

- `openrouter-client.js`：核心客户端类 `OpenRouterClient`
- `openrouter-client.d.ts`：TS 类型声明
- `openrouter-demo.html`：功能演示页（按步骤跑完整流程）
- `openrouter-free.html`：可直接使用的聊天 UI（含统计面板、帮助面板）

---

## 快速开始

### 1) 获取 API Key

到 OpenRouter 创建 key：`https://openrouter.ai/keys`

### 2) 直接打开页面

- 想看完整功能演示：打开 `openrouter-demo.html`
- 想直接聊天：打开 `openrouter-free.html`

> 两个页面都依赖同目录下的 `openrouter-client.js`。

---

## 最常用代码（浏览器）

```html
<script src="./openrouter-client.js"></script>
<script>
  const client = new OpenRouterClient({
    timeoutMs: 20000,
    maxRetries: 10,
    persistKey: 'or_perf'
  });

  await client.loadModels('sk-or-v1-...');

  const result = await client.send([
    { role: 'user', content: '你好，介绍一下你自己' }
  ]);
  console.log(result.content, result.modelId);
</script>
```

---

## 核心能力（通俗版）

- 自动选模型  
  会综合“最近成功率、速度、限速压力”挑当前更合适的免费模型。

- 自动失败切换  
  某模型超时/限速/不可用时，会自动换下一个模型重试。

- 流式输出  
  `sendStream()` 可边生成边显示，适合聊天 UI。

- 可取消请求  
  支持 `AbortSignal`，可做“总超时”或“用户手动停止”。

- 统计能力  
  可拿到模型和 Provider 的统计信息，用于诊断和调优。

- 本地持久化（可选）  
  `persistKey` 打开后会把统计存 localStorage，刷新后仍可沿用经验数据。

---

## API 一览

### 构造函数

```js
const client = new OpenRouterClient({
  timeoutMs: 20000,         // 单模型请求超时(ms)
  maxRetries: 10,           // 一次请求最多切换模型次数
  persistKey: 'or_perf',    // 统计持久化 key，null 表示关闭
  debug: false,             // 输出调试日志
  onModelSwitch: (attempt, max, failedModelId, reason) => {}
});
```

### 模型加载

```js
await client.loadModels(apiKey, { retries: 3, backoffMs: 1000 });
await client.refreshModels();
```

### 非流式请求

```js
const { content, modelId, elapsedMs, totalElapsedMs } =
  await client.send(messages, {
    preferredModelId: null,
    temperature: 0.7,
    max_tokens: 1024
  });
```

### 流式请求

```js
for await (const chunk of client.sendStream(messages)) {
  if (chunk.done) {
    console.log(chunk.content, chunk.modelId, chunk.elapsedMs);
  } else {
    process.stdout.write(chunk.delta);
  }
}
```

### 统计与管理

```js
client.getAllModelStats();
client.getAllProviderStats();
client.resetModel(modelId);
client.clearStats();
client.destroy();
```

---

## 事件（可观测性）

你可以监听这些事件做日志、埋点、UI 状态提示：

- `request:start`
- `request:success`
- `request:error`
- `model:blacklist`
- `model:release`

示例：

```js
client.on('request:error', ({ modelId, error, willRetry }) => {
  console.log(modelId, error.message, willRetry);
});
```

---

## 错误码

`OpenRouterClient.ErrorCodes` 提供结构化错误：

- `DESTROYED`：客户端已销毁
- `EMPTY_RESPONSE`：返回为空
- `NO_AVAILABLE_MODEL`：当前无可用模型
- `ALL_MODELS_FAILED`：重试后仍全部失败

---

## Node.js 使用说明

`openrouter-client.js` 自带 CommonJS 导出：

```js
const OpenRouterClient = require('./openrouter-client');
```

在支持 `fetch` 的 Node 版本可直接使用。若你的环境没有 `fetch`，需要先补齐 fetch 能力。

---

## 选哪个页面？

- 想学习用法：`openrouter-demo.html`
- 想直接用聊天成品：`openrouter-free.html`

两者都可以作为你项目里的“可运行模板”。
