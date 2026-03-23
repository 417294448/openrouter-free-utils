# openrouter-free-utils

OpenRouter 免费模型工具集，提供可复用客户端与两个开箱即用的网页示例，适合快速构建“自动切换模型 + 流式输出 + 统计观测”的聊天应用。

> 只需在项目中引入 `openrouter-client.js`，再配置一个 OpenRouter API Key，即可流畅使用 OpenRouter 免费模型能力。

## 目录

- [使用场景](#使用场景)
- [功能特性](#功能特性)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [使用方式](#使用方式)
- [核心 API](#核心-api)
- [事件与错误](#事件与错误)
- [统计能力](#统计能力)
- [示例页面说明](#示例页面说明)

## 使用场景

- 在现有 Web 项目中快速接入 OpenRouter 免费模型：引入 `openrouter-client.js` + 配置 API Key 即可使用
- 需要模型自动兜底的业务场景：当某个免费模型超时或限速时，自动切换到可用模型
- 需要流式响应体验的前端项目：通过 `sendStream()` 实现逐字输出并提升交互体验
- 需要稳定性与性能观测的应用：通过模型/Provider 统计持续优化模型选择策略
- 需要验证接入效果时：使用 `openrouter-demo.html` 与 `openrouter-free.html` 做功能演示和测试验证

> 说明：`openrouter-client.js` 是项目核心能力；HTML 页面主要用于 Demo 与测试。

## 功能特性

- 自动模型选择：基于成功率、响应速度、限速压力综合评分
- 自动失败切换：超时、限速、服务不可用时自动重试其他模型
- 流式输出：支持按增量 token 渲染聊天内容
- 请求取消：支持 `AbortSignal`，可实现总超时和手动中断
- 限速感知：支持 `Retry-After` 与 Provider 级别冷却逻辑
- 统计持久化：可选 localStorage 持久化，刷新后保留模型经验数据
- 类型定义：内置 `openrouter-client.d.ts`，支持 TypeScript 智能提示

## 目录结构

- `openrouter-client.js`：核心客户端 `OpenRouterClient`
- `openrouter-client.d.ts`：TypeScript 类型声明
- `openrouter-demo.html`：完整 API 演示页
- `openrouter-free.html`：可直接使用的聊天页面（含统计与帮助面板）

## 环境要求

- 具备可用的 OpenRouter API Key：<https://openrouter.ai/keys>
- 浏览器环境可直接运行 HTML 文件
- Node.js 场景建议使用支持 `fetch` 的版本

## 快速开始

1. 获取 OpenRouter API Key  
2. 进入本目录，直接打开任一页面：
   - `openrouter-demo.html`：查看完整调用流程
   - `openrouter-free.html`：直接聊天
3. 在页面输入 API Key，点击“加载模型”后开始使用

## 使用方式

### 浏览器

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

### Node.js（CommonJS）

```js
const OpenRouterClient = require('./openrouter-client');
```

## 核心 API

### 创建客户端

```js
const client = new OpenRouterClient({
  timeoutMs: 20000,
  maxRetries: 10,
  persistKey: 'or_perf',
  debug: false,
  onModelSwitch: (attempt, max, failedModelId, reason) => {}
});
```

### 加载模型

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

## 事件与错误

### 事件

- `request:start`
- `request:success`
- `request:error`
- `model:blacklist`
- `model:release`

```js
client.on('request:error', ({ modelId, error, willRetry }) => {
  console.log(modelId, error.message, willRetry);
});
```

### 错误码

`OpenRouterClient.ErrorCodes`：

- `DESTROYED`：客户端已销毁
- `EMPTY_RESPONSE`：返回为空
- `NO_AVAILABLE_MODEL`：当前无可用模型
- `ALL_MODELS_FAILED`：重试后仍全部失败

## 统计能力

- 模型维度：平均耗时、成功率、请求量、冷却状态、综合评分
- Provider 维度：聚合请求量、可用模型数、限速冷却状态
- 评分逻辑：成功率 × 速度加成 × 速率余量 × Provider 惩罚 + 探索奖励

## 示例页面说明

- `openrouter-demo.html`：面向开发调试，覆盖加载模型、非流式、流式、取消、统计等流程
- `openrouter-free.html`：面向实际聊天，包含模型切换、超时设置、Markdown 渲染、统计面板与帮助面板
