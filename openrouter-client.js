/**
 * openrouter-client.js
 * Production-grade OpenRouter free-model client with adaptive model selection.
 *
 * Features:
 *   - Automatic model fallback with scoring (time-decay + UCB exploration)
 *   - Streaming (SSE) and non-streaming modes
 *   - External AbortSignal support for cancellation
 *   - API parameter passthrough (temperature, max_tokens, etc.)
 *   - Provider-level rate-limit awareness with Retry-After parsing
 *   - Graduated blacklist release (timeout → network → 429 → 503)
 *   - Optional localStorage persistence for stats across page reloads
 *   - Event system for observability (on/off)
 *   - Debug mode for model selection diagnostics
 *
 * Usage:
 *   const client = new OpenRouterClient({
 *     timeoutMs:   15000,        // per-model request timeout (ms)
 *     maxRetries:  10,           // max model switches per send/sendStream
 *     persistKey:  'or_perf',    // localStorage key for stats persistence (null to disable)
 *     debug:       false,        // enable console.debug output
 *     onModelSwitch: (attempt, max, failedModelId, reason) => {},
 *   });
 *
 *   client.on('request:start', ({ modelId, attempt }) => { ... });
 *   client.on('request:error', ({ modelId, error, willRetry }) => { ... });
 *
 *   await client.loadModels('sk-or-v1-...');
 *
 *   // Non-streaming
 *   const { content, modelId, elapsedMs, totalElapsedMs } = await client.send(messages, {
 *     preferredModelId: null,    // null = auto, or specify model id
 *     signal: controller.signal, // optional AbortSignal
 *     temperature: 0.7,          // any OpenRouter API param
 *   });
 *
 *   // Streaming
 *   for await (const chunk of client.sendStream(messages, { signal })) {
 *     if (chunk.done) { /* { done, content, modelId, elapsedMs } *\/ }
 *     else            { /* { delta, modelId } *\/ process.stdout.write(chunk.delta); }
 *   }
 *
 *   // Stats & cleanup
 *   const stats   = client.getAllModelStats();
 *   const pvStats = client.getAllProviderStats();
 *   client.destroy();
 */
class OpenRouterClient {
  // ── Static config ──────────────────────────────────────────────────────────
  static BASE_URL             = 'https://openrouter.ai/api/v1';
  static PERF_WINDOW_MS       = 3_600_000;   // 1-hour rolling window
  static RATE_LIMIT_EST       = 20;           // estimated req/min per model (free tier)
  static PROVIDER_COOLDOWN_MS = 90_000;       // provider-level 429 suppression window
  static DECAY_TIME_CONSTANT  = 900_000;      // τ for exponential decay (weight = e^(-Δt/τ))
  static UCB_C                = 0.3;          // UCB exploration coefficient
  static STREAM_STALL_MS      = 30_000;       // max silence during stream before abort
  static PERSIST_VERSION      = 1;            // localStorage schema version

  /** Structured error codes for programmatic handling / i18n. */
  static ErrorCodes = {
    DESTROYED:          'DESTROYED',
    EMPTY_RESPONSE:     'EMPTY_RESPONSE',
    NO_AVAILABLE_MODEL: 'NO_AVAILABLE_MODEL',
    ALL_MODELS_FAILED:  'ALL_MODELS_FAILED',
  };

  // ── Private fields ─────────────────────────────────────────────────────────
  #apiKey = '';
  #freeModels = [];
  #blacklist = new Map();    // modelId → { until, reason, escalation, released }
  #perfDB = {};              // modelId → [{ ts, elapsedMs, success, errorCode }]
  #providerRateHits = {};    // providerName → lastHitTimestamp
  #inflight = new Map();     // modelId → count of in-flight requests
  #destroyed = false;
  #listeners = {};           // event → Set<fn>
  #lastGcTs = 0;             // timestamp of last perfDB garbage collection

  #timeoutMs;
  #maxRetries;
  #onModelSwitch;
  #persistKey;
  #saveTimer = null;
  #debugMode;

  /**
   * @param {object}   [options]
   * @param {number}   [options.timeoutMs=20000]    Per-model request abort timeout in ms
   * @param {number}   [options.maxRetries=10]      Max model switches per send()/sendStream()
   * @param {string}   [options.persistKey=null]    localStorage key for stats; null to disable
   * @param {boolean}  [options.debug=false]         Enable console.debug diagnostic output
   * @param {function} [options.onModelSwitch]       (attempt, max, failedModelId, reason) => void
   */
  constructor({ timeoutMs = 20_000, maxRetries = 10, onModelSwitch = null, persistKey = null, debug = false } = {}) {
    this.#timeoutMs     = timeoutMs;
    this.#maxRetries    = maxRetries;
    this.#onModelSwitch = onModelSwitch;
    this.#persistKey    = persistKey;
    this.#debugMode     = debug;
    this.#loadPersisted();
  }

  // ── Public properties ──────────────────────────────────────────────────────
  get freeModels() { return [...this.#freeModels]; }
  get timeoutMs()  { return this.#timeoutMs; }
  set timeoutMs(v) { this.#timeoutMs = v; }

  /** Release internal timers and mark this client as destroyed. */
  destroy() {
    this.#destroyed = true;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
  }

  // ── Event system ──────────────────────────────────────────────────────────
  /**
   * Subscribe to client events.
   * Events: request:start, request:success, request:error, model:blacklist, model:release
   * @param {string} event
   * @param {function} fn
   * @returns {OpenRouterClient} this (for chaining)
   */
  on(event, fn) {
    (this.#listeners[event] ??= new Set()).add(fn);
    return this;
  }

  /**
   * Unsubscribe from client events.
   * @param {string} event
   * @param {function} fn
   * @returns {OpenRouterClient} this
   */
  off(event, fn) {
    this.#listeners[event]?.delete(fn);
    return this;
  }

  // ── loadModels(apiKey) ─────────────────────────────────────────────────────
  /**
   * Fetch the free-model list from OpenRouter and cache it.
   * @param {string} apiKey
   * @param {object} [options]
   * @param {number} [options.retries=3]     Max retry attempts
   * @param {number} [options.backoffMs=1000] Initial backoff (doubles each retry)
   * @returns {Promise<Array>} Sorted array of free model objects
   */
  async loadModels(apiKey, { retries = 3, backoffMs = 1000 } = {}) {
    this.#apiKey = apiKey;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(`${OpenRouterClient.BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { data } = await res.json();

        this.#freeModels = data
          .filter(m =>
            m.id.includes(':free') ||
            (parseFloat(m.pricing?.prompt) === 0 && parseFloat(m.pricing?.completion) === 0)
          )
          .sort((a, b) => a.id.localeCompare(b.id));

        this.#log(`Loaded ${this.#freeModels.length} free models`);
        return [...this.#freeModels];
      } catch (e) {
        lastErr = e;
        if (i < retries) await new Promise(r => setTimeout(r, backoffMs * (2 ** i)));
      }
    }
    throw lastErr;
  }

  /**
   * Re-fetch the model list using the previously stored API key.
   * @param {object} [options]  Same options as loadModels (retries, backoffMs)
   * @returns {Promise<Array>}
   */
  async refreshModels(options) {
    if (!this.#apiKey) throw new Error('No API key stored — call loadModels(apiKey) first');
    return this.loadModels(this.#apiKey, options);
  }

  // ── send(messages, options) ────────────────────────────────────────────────
  /**
   * Non-streaming chat completion with automatic model fallback.
   * @param {Array}  messages
   * @param {object} [options]
   * @returns {Promise<{ content: string, modelId: string, elapsedMs: number, totalElapsedMs: number }>}
   */
  async send(messages, options = {}) {
    if (this.#destroyed) throw this.#error('Client has been destroyed', OpenRouterClient.ErrorCodes.DESTROYED);
    const t0 = Date.now();
    let result = null;
    for await (const chunk of this.sendStream(messages, options)) {
      if (chunk.done) result = chunk;
    }
    if (!result) throw this.#error('Empty response', OpenRouterClient.ErrorCodes.EMPTY_RESPONSE);
    return { content: result.content, modelId: result.modelId, elapsedMs: result.elapsedMs, totalElapsedMs: Date.now() - t0 };
  }

  // ── sendStream(messages, options) ──────────────────────────────────────────
  /**
   * Streaming chat completion with automatic model fallback.
   * @param {Array}  messages
   * @param {object} [options]
   * @yields {{ delta: string, modelId: string }}
   * @yields {{ done: true, content: string, modelId: string, elapsedMs: number }}
   */
  async *sendStream(messages, { preferredModelId = null, signal = null, ...requestParams } = {}) {
    if (this.#destroyed) throw this.#error('Client has been destroyed', OpenRouterClient.ErrorCodes.DESTROYED);
    const maxTries = Math.min(this.#freeModels.length, this.#maxRetries);
    let lastError = null;

    for (let attempt = 0; attempt < maxTries; attempt++) {
      if (signal?.aborted) throw this.#createAbortError();

      let model = this.#pickModel(preferredModelId);
      if (!model) {
        model = this.#releaseGraduated(preferredModelId);
        if (!model) throw this.#error('No available model', OpenRouterClient.ErrorCodes.NO_AVAILABLE_MODEL);
      }

      this.#emit('request:start', { modelId: model.id, attempt });
      this.#inflight.set(model.id, (this.#inflight.get(model.id) || 0) + 1);
      try {
        yield* this.#tryStreamRequest(model, messages, requestParams, signal);
        return;
      } catch (e) {
        lastError = e;
        if (e.name === 'AbortError' && signal?.aborted) throw e;
        if (this.#isGlobalNetworkError(e)) throw e;

        const reason = e.message;
        let duration = 60_000;
        if (reason.includes('429') || reason.includes('rate')) {
          duration = e.retryAfterMs || 120_000;
          this.#recordProviderRateLimit(model.id);
        } else if (reason.includes('timeout')) {
          duration = 30_000;
        } else if (reason.includes('503') || reason.includes('unavailable')) {
          duration = 180_000;
        }
        const prev = this.#blacklist.get(model.id);
        const escalation = prev?.released ? Math.min((prev.escalation || 1) * 2, 16) : 1;
        if (prev?.released) duration = Math.min(duration * escalation, 600_000);
        this.#blacklist.set(model.id, { until: Date.now() + duration, reason, escalation });

        const willRetry = attempt + 1 < maxTries;
        this.#emit('request:error', { modelId: model.id, error: e, willRetry });
        this.#emit('model:blacklist', { modelId: model.id, reason, duration });
        this.#log(`Blacklisted ${model.id.split('/').pop()} for ${(duration/1000).toFixed(0)}s (${reason.slice(0,30)})`);
        this.#onModelSwitch?.(attempt + 1, maxTries, model.id, reason);
      } finally {
        this.#inflight.set(model.id, (this.#inflight.get(model.id) || 1) - 1);
      }
    }

    throw lastError || this.#error('All models failed', OpenRouterClient.ErrorCodes.ALL_MODELS_FAILED);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  /** Per-model stats for all loaded models. */
  getAllModelStats() {
    const now = Date.now();
    return this.#freeModels.map(m => {
      const bl = this.#blacklist.get(m.id);
      return {
        modelId:          m.id,
        stats:            this.#computeStats(m.id),
        score:            this.#scoreModel(m.id),
        blacklistedUntil: bl && now < bl.until ? bl.until : null,
        blacklistReason:  bl && now < bl.until ? bl.reason : null,
      };
    });
  }

  /** Provider-level aggregated stats (request-count-weighted). */
  getAllProviderStats() {
    const now = Date.now();
    const map = new Map();
    for (const m of this.#freeModels) {
      const p = m.id.split('/')[0];
      if (!map.has(p)) map.set(p, []);
      map.get(p).push(m);
    }

    return [...map.entries()].map(([name, models]) => {
      const modelData = models.map(m => {
        const bl = this.#blacklist.get(m.id);
        return {
          modelId:          m.id,
          stats:            this.#computeStats(m.id),
          score:            this.#scoreModel(m.id),
          blacklistedUntil: bl && now < bl.until ? bl.until : null,
        };
      });

      const withData  = modelData.filter(x => x.stats);
      const totalReqs = withData.reduce((s, x) => s + x.stats.count, 0);
      const totalOk   = withData.reduce((s, x) => s + Math.round(x.stats.count * x.stats.successRate), 0);
      const withAvg   = withData.filter(x => x.stats.avgMs !== null);

      const rateHit       = this.#providerRateHits[name];
      const isRateLimited = !!(rateHit && now - rateHit < OpenRouterClient.PROVIDER_COOLDOWN_MS);

      return {
        provider:         name,
        models:           modelData,
        totalModels:      models.length,
        availableModels:  modelData.filter(x => !x.blacklistedUntil).length,
        totalRequests:    totalReqs,
        successRate:      totalReqs > 0 ? totalOk / totalReqs : null,
        weightedAvgMs:    withAvg.length
          ? withAvg.reduce((s, x) => s + x.stats.avgMs * x.stats.count, 0) /
            withAvg.reduce((s, x) => s + x.stats.count, 0)
          : null,
        totalRecentMin:   withData.reduce((s, x) => s + x.stats.recentMin, 0),
        isRateLimited,
        rateLimitCooldownMs: isRateLimited
          ? OpenRouterClient.PROVIDER_COOLDOWN_MS - (now - rateHit) : 0,
        bestScore: Math.max(...modelData.map(x => x.score), 0),
      };
    });
  }

  /** Clear all performance stats and blacklist state. */
  clearStats() {
    this.#perfDB = {};
    this.#providerRateHits = {};
    this.#blacklist.clear();
    this.#savePersisted();
  }

  /** Reset stats for a single model and remove it from blacklist. */
  resetModel(modelId) {
    delete this.#perfDB[modelId];
    this.#blacklist.delete(modelId);
    this.#savePersisted();
  }

  // ── Private: helpers ──────────────────────────────────────────────────────
  #emit(event, detail) {
    for (const fn of this.#listeners[event] || []) {
      try { fn(detail); } catch (e) { console.warn('[OpenRouterClient] Event listener error:', e.message); }
    }
  }

  #log(...args) {
    if (this.#debugMode) console.debug('[OpenRouterClient]', ...args);
  }

  #error(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  #createAbortError(message = 'Aborted') {
    if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError');
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
  }

  #parseRetryAfter(header) {
    if (!header) return null;
    const secs = parseInt(header, 10);
    if (!isNaN(secs)) return secs * 1000;
    const date = Date.parse(header);
    if (!isNaN(date)) return Math.max(0, date - Date.now());
    return null;
  }

  // ── Private: perf DB ──────────────────────────────────────────────────────
  #recordPerf(modelId, elapsedMs, success, errorCode = null) {
    const now = Date.now();
    // Lazy GC: prune expired records every 60s instead of every write
    if (now - this.#lastGcTs > 60_000) {
      this.#lastGcTs = now;
      for (const id in this.#perfDB) {
        this.#perfDB[id] = this.#perfDB[id].filter(r => now - r.ts < OpenRouterClient.PERF_WINDOW_MS);
        if (!this.#perfDB[id].length) delete this.#perfDB[id];
      }
    }
    (this.#perfDB[modelId] ??= []).push({ ts: now, elapsedMs, success, errorCode });
    this.#savePersisted();
  }

  /** Time-decay weighted stats for a single model. */
  #computeStats(modelId) {
    const recs = this.#perfDB[modelId];
    if (!recs?.length) return null;
    const now    = Date.now();
    const recent = recs.filter(r => now - r.ts < OpenRouterClient.PERF_WINDOW_MS);
    if (!recent.length) return null;

    const tau = OpenRouterClient.DECAY_TIME_CONSTANT;
    let wSum = 0, wOkSum = 0, wMsSum = 0, wOkCount = 0;
    for (const r of recent) {
      const w = Math.exp(-(now - r.ts) / tau);
      wSum += w;
      if (r.success) {
        wOkSum  += w;
        wMsSum  += w * r.elapsedMs;
        wOkCount += w;
      }
    }

    return {
      avgMs:       wOkCount > 0 ? wMsSum / wOkCount : null,
      successRate: wSum > 0 ? wOkSum / wSum : 0,
      count:       recent.length,
      recentMin:   recent.filter(r => now - r.ts < 60_000).length,
    };
  }

  #recordProviderRateLimit(modelId) {
    const provider = modelId.split('/')[0];
    if (provider) this.#providerRateHits[provider] = Date.now();
  }

  /** Detect global network failures (DNS, offline, TLS) that affect all models equally. */
  #isGlobalNetworkError(error) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
    if (error instanceof TypeError) return true;
    const msg = (error.message || '').toLowerCase();
    return ['failed to fetch', 'networkerror', 'enotfound', 'dns',
            'err_network', 'err_internet', 'getaddrinfo'].some(k => msg.includes(k));
  }

  /** Validate a persisted performance record's schema. */
  #isValidRecord(r) {
    return r && typeof r.ts === 'number' && typeof r.success === 'boolean'
      && (!r.success || typeof r.elapsedMs === 'number');
  }

  #getTotalRequests() {
    return Object.values(this.#perfDB)
      .reduce((s, recs) => s + recs.length, 0);
  }

  // ── Private: scoring & picking ────────────────────────────────────────────
  /**
   * Score = successRate × speedMult × rateMult × providerMult + UCB exploration bonus.
   * @param {string} modelId
   * @param {number|null} totalN  Pre-computed total requests (avoids redundant O(M) scan)
   */
  #scoreModel(modelId, totalN = null) {
    const s = this.#computeStats(modelId);
    if (totalN === null) totalN = this.#getTotalRequests();

    if (!s) {
      const bonus = OpenRouterClient.UCB_C * Math.sqrt(Math.log(totalN + 1));
      return 0.5 + Math.min(bonus, 1.0);
    }

    const speedMult = s.avgMs !== null
      ? Math.min(2000 / Math.max(s.avgMs, 200), 3.0) : 1.0;

    const inflight = this.#inflight.get(modelId) || 0;
    const fill     = (s.recentMin + inflight) / OpenRouterClient.RATE_LIMIT_EST;
    const rateMult = fill >= 0.8 ? Math.max(0, 1 - (fill - 0.8) / 0.2) : 1.0;

    const lastHit      = this.#providerRateHits[modelId.split('/')[0]];
    const providerMult = lastHit && (Date.now() - lastHit < OpenRouterClient.PROVIDER_COOLDOWN_MS)
      ? 0.15 : 1.0;

    const base = s.successRate * speedMult * rateMult * providerMult;
    const ucb  = OpenRouterClient.UCB_C * Math.sqrt(Math.log(totalN + 1) / (s.count + 1));
    return base + ucb;
  }

  #getAvailableModels() {
    const now = Date.now();
    return this.#freeModels.filter(m => {
      const b = this.#blacklist.get(m.id);
      return !b || now >= b.until || b.released;
    });
  }

  #pickModel(preferredId = null) {
    const available = this.#getAvailableModels();
    if (!available.length) return null;

    if (preferredId) {
      const found = available.find(m => m.id === preferredId);
      if (found) return found;
    }

    // Single-pass max instead of .map().sort() — O(N) vs O(N log N)
    const totalN = this.#getTotalRequests();
    let best = null, bestScore = -Infinity;
    for (const m of available) {
      const score = this.#scoreModel(m.id, totalN) + Math.random() * 0.04;
      if (score > bestScore) { bestScore = score; best = m; }
    }

    this.#log(`pickModel → ${best.id.split('/').pop()} (score=${bestScore.toFixed(3)}, candidates=${available.length})`);
    return best;
  }

  /**
   * Graduated blacklist release: free models by error severity, lightest first.
   */
  #releaseGraduated(preferredId) {
    const levels = ['timeout', 'empty', 'network', null, '429', 'rate', '503', 'unavailable'];
    const classified = new Set(['timeout', 'empty', 'network', '429', 'rate', '503', 'unavailable']);

    for (const level of levels) {
      for (const [id, bl] of this.#blacklist) {
        if (bl.released) continue;
        const matches = level === null
          ? ![...classified].some(k => bl.reason.includes(k))
          : bl.reason.includes(level);
        if (matches) {
          bl.released = true;
          this.#emit('model:release', { modelId: id });
          this.#log(`Released ${id.split('/').pop()} from blacklist (level=${level})`);
        }
      }
      const m = this.#pickModel(preferredId);
      if (m) return m;
    }
    return null;
  }

  // ── Private: HTTP (streaming) ─────────────────────────────────────────────
  async *#tryStreamRequest(model, messages, requestParams, externalSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    const t0 = Date.now();
    this.#log(`Request → ${model.id}`);
    let res;

    try {
      res = await fetch(`${OpenRouterClient.BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization':  `Bearer ${this.#apiKey}`,
          'Content-Type':   'application/json',
          'HTTP-Referer':   typeof location !== 'undefined' ? location.href : '',
          'X-Title':        'OpenRouter Free Chat',
        },
        body: JSON.stringify({ model: model.id, messages, stream: true, ...requestParams }),
      });
    } catch (e) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      const ms = Date.now() - t0;
      if (e.name === 'AbortError') {
        if (externalSignal?.aborted) {
          this.#recordPerf(model.id, ms, false, 'aborted');
          throw this.#createAbortError();
        }
        this.#recordPerf(model.id, ms, false, 'timeout');
        throw new Error('timeout');
      }
      this.#recordPerf(model.id, ms, false, 'network');
      throw e;
    }

    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);

    if (!res.ok) {
      const retryAfter = res.headers.get('Retry-After');
      const body = await res.text().catch(() => '');
      this.#recordPerf(model.id, Date.now() - t0, false, String(res.status));
      const err = new Error(`${res.status} ${body.slice(0, 100)}`);
      err.retryAfterMs = this.#parseRetryAfter(retryAfter);
      throw err;
    }

    // ── Parse SSE stream ──
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    const stallMs = OpenRouterClient.STREAM_STALL_MS;
    let stallTimer = null;

    const onStreamAbort = () => reader.cancel().catch(() => {});
    externalSignal?.addEventListener('abort', onStreamAbort, { once: true });

    try {
      while (true) {
        const stallPromise = new Promise((_, reject) => {
          stallTimer = setTimeout(() => {
            reader.cancel().catch(() => {});
            reject(new Error('timeout'));
          }, stallMs);
        });
        const { done, value } = await Promise.race([reader.read(), stallPromise]);
        clearTimeout(stallTimer);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);
          if (payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullContent += delta;
              yield { delta, modelId: model.id };
            }
          } catch { /* skip malformed JSON lines */ }
        }
      }
    } finally {
      clearTimeout(stallTimer);
      reader.cancel().catch(() => {});
      externalSignal?.removeEventListener('abort', onStreamAbort);
    }

    if (externalSignal?.aborted) {
      this.#recordPerf(model.id, Date.now() - t0, false, 'aborted');
      throw this.#createAbortError();
    }

    if (!fullContent) {
      this.#recordPerf(model.id, Date.now() - t0, false, 'empty');
      throw this.#error('Empty response', OpenRouterClient.ErrorCodes.EMPTY_RESPONSE);
    }

    const elapsedMs = Date.now() - t0;
    this.#recordPerf(model.id, elapsedMs, true);
    this.#emit('request:success', { modelId: model.id, elapsedMs });
    this.#log(`Success ← ${model.id.split('/').pop()} (${(elapsedMs / 1000).toFixed(2)}s)`);
    yield { done: true, content: fullContent, modelId: model.id, elapsedMs };
  }

  // ── Private: persistence ──────────────────────────────────────────────────
  #loadPersisted() {
    if (!this.#persistKey) return;
    try {
      const raw = localStorage.getItem(this.#persistKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.v !== OpenRouterClient.PERSIST_VERSION) return;
      const now = Date.now();
      if (data.perfDB) {
        for (const [id, recs] of Object.entries(data.perfDB)) {
          if (!Array.isArray(recs)) continue;
          const valid = recs.filter(r =>
            this.#isValidRecord(r) && now - r.ts < OpenRouterClient.PERF_WINDOW_MS
          );
          if (valid.length) this.#perfDB[id] = valid;
        }
      }
      if (data.providerRateHits) {
        for (const [p, ts] of Object.entries(data.providerRateHits)) {
          if (typeof ts === 'number' && now - ts < OpenRouterClient.PROVIDER_COOLDOWN_MS) {
            this.#providerRateHits[p] = ts;
          }
        }
      }
    } catch (e) { console.warn('[OpenRouterClient] Failed to load persisted data:', e.message); }
  }

  #savePersisted() {
    if (!this.#persistKey) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(this.#persistKey, JSON.stringify({
          v: OpenRouterClient.PERSIST_VERSION,
          perfDB: this.#perfDB,
          providerRateHits: this.#providerRateHits,
        }));
      } catch (e) { console.warn('[OpenRouterClient] Failed to save:', e.message); }
    }, 2000);
  }
}

// ── Module export ────────────────────────────────────────────────────────
// CJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OpenRouterClient;
}
// Ensure availability in all environments (Workers, Deno, ESM side-effect import)
if (typeof globalThis !== 'undefined') {
  globalThis.OpenRouterClient = OpenRouterClient;
}
