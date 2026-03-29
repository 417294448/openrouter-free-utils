/**
 * Type definitions for openrouter-client.js
 */

export interface OpenRouterClientOptions {
  /** Per-model request abort timeout in ms (default: 20000) */
  timeoutMs?: number;
  /** Max model switches per send()/sendStream() (default: 10) */
  maxRetries?: number;
  /** localStorage key for stats persistence; null to disable (default: null) */
  persistKey?: string | null;
  /** Enable console.debug diagnostic output (default: false) */
  debug?: boolean;
  /** Called when a model fails and the client switches to the next one */
  onModelSwitch?: (attempt: number, max: number, failedModelId: string, reason: string) => void;
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: { prompt: string; completion: string };
  [key: string]: any;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SendOptions {
  /** Specific model id; null = auto-select (default: null) */
  preferredModelId?: string | null;
  /** External abort signal for cancellation */
  signal?: AbortSignal | null;
  /** API param passthrough */
  temperature?: number;
  /** API param passthrough */
  max_tokens?: number;
  /** Any other OpenRouter API parameter */
  [key: string]: any;
}

export interface SendResult {
  content: string;
  modelId: string;
  /** Time for the successful model attempt only */
  elapsedMs: number;
  /** Total wall-clock time including retries */
  totalElapsedMs: number;
}

export type StreamChunk =
  | { done?: false; delta: string; modelId: string }
  | { done: true; content: string; modelId: string; elapsedMs: number };

export interface ModelStats {
  /** Time-decay weighted average response time (ms), null if no successes */
  avgMs: number | null;
  /** Time-decay weighted success rate (0–1) */
  successRate: number;
  /** Total request count in the rolling window */
  count: number;
  /** Requests in the last 60 seconds */
  recentMin: number;
}

export interface ModelStat {
  modelId: string;
  stats: ModelStats | null;
  score: number;
  blacklistedUntil: number | null;
  blacklistReason: string | null;
}

export interface ProviderStat {
  provider: string;
  models: Array<{
    modelId: string;
    stats: ModelStats | null;
    score: number;
    blacklistedUntil: number | null;
  }>;
  totalModels: number;
  availableModels: number;
  totalRequests: number;
  successRate: number | null;
  weightedAvgMs: number | null;
  totalRecentMin: number;
  isRateLimited: boolean;
  rateLimitCooldownMs: number;
  bestScore: number;
}

export interface OpenRouterEventMap {
  'request:start': { modelId: string; attempt: number };
  'request:success': { modelId: string; elapsedMs: number };
  'request:error': { modelId: string; error: Error; willRetry: boolean };
  'model:blacklist': { modelId: string; reason: string; duration: number };
  'model:release': { modelId: string };
}

declare class OpenRouterClient {
  // ── Static config ──
  static BASE_URL: string;
  static PERF_WINDOW_MS: number;
  static RATE_LIMIT_EST: number;
  static PROVIDER_COOLDOWN_MS: number;
  static DECAY_TIME_CONSTANT: number;
  static UCB_C: number;
  static STREAM_STALL_MS: number;
  static PERSIST_VERSION: number;

  static ErrorCodes: {
    readonly DESTROYED: 'DESTROYED';
    readonly EMPTY_RESPONSE: 'EMPTY_RESPONSE';
    readonly NO_AVAILABLE_MODEL: 'NO_AVAILABLE_MODEL';
    readonly ALL_MODELS_FAILED: 'ALL_MODELS_FAILED';
  };

  constructor(options?: OpenRouterClientOptions);

  // ── Properties ──
  readonly freeModels: OpenRouterModel[];
  timeoutMs: number;

  // ── Lifecycle ──
  destroy(): void;

  // ── Events ──
  on<K extends keyof OpenRouterEventMap>(event: K, fn: (detail: OpenRouterEventMap[K]) => void): this;
  on(event: string, fn: (detail: any) => void): this;
  off<K extends keyof OpenRouterEventMap>(event: K, fn: (detail: OpenRouterEventMap[K]) => void): this;
  off(event: string, fn: (detail: any) => void): this;

  // ── Model loading ──
  loadModels(apiKey: string, options?: { retries?: number; backoffMs?: number }): Promise<OpenRouterModel[]>;
  refreshModels(options?: { retries?: number; backoffMs?: number }): Promise<OpenRouterModel[]>;

  // ── Chat ──
  send(messages: ChatMessage[], options?: SendOptions): Promise<SendResult>;
  sendStream(messages: ChatMessage[], options?: SendOptions): AsyncGenerator<StreamChunk, void, undefined>;

  // ── Stats ──
  getAllModelStats(): ModelStat[];
  getAllProviderStats(): ProviderStat[];
  clearStats(): void;
  resetModel(modelId: string): void;
}

export default OpenRouterClient;
export { OpenRouterClient };
