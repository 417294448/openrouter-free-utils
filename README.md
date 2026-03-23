# openrouter-free-utils

Lightweight toolkit for integrating OpenRouter free models.

> Just include `openrouter-client.js` + an OpenRouter API Key to use free models smoothly.

## Core Focus

- **Core**: `openrouter-client.js`
- **Types**: `openrouter-client.d.ts`
- **Demo & Test**: `openrouter-demo.html`, `openrouter-free.html`

## Use Cases

- Quick free-model integration with minimal changes
- Automatic fallback when a model times out or gets rate-limited
- Streaming UX for token-by-token response rendering
- Model selection optimization using runtime stats

## Quick Start

1. Get API Key: <https://openrouter.ai/keys>  
2. Include `openrouter-client.js` in your project  
3. Call `loadModels()`, then `send()` or `sendStream()`

```html
<script src="./openrouter-client.js"></script>
<script>
  const client = new OpenRouterClient({ timeoutMs: 20000, maxRetries: 10 });
  await client.loadModels('sk-or-v1-...');
  const { content, modelId } = await client.send([{ role: 'user', content: 'Hello' }]);
  console.log(modelId, content);
</script>
```

## Key APIs

- `loadModels(apiKey)`: Load free model list
- `send(messages, options)`: Non-streaming request
- `sendStream(messages, options)`: Streaming request
- `getAllModelStats()`: Model-level stats
- `getAllProviderStats()`: Provider-level stats

## Error Codes

- `DESTROYED`
- `EMPTY_RESPONSE`
- `NO_AVAILABLE_MODEL`
- `ALL_MODELS_FAILED`

