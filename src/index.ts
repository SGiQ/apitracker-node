/**
 * @sgiq/apitracker — tiny Node client for the API-Tracker ingest service.
 *
 * Two ways to use it:
 *   1. Wrap a provider client once; every call records itself:
 *        const anthropic = track(new Anthropic(), { app: 'dca-bot' });
 *   2. Record manually (streaming, or any code path):
 *        record({ provider: 'anthropic', model, usage: { inputTokens, outputTokens } });
 *
 * Config comes from the environment by default — APITRACKER_URL and
 * APITRACKER_KEY — or pass it explicitly via opts. With no URL/key the client is
 * a no-op: it never throws into, blocks, or slows your LLM calls.
 *
 * Dependency-free: uses global fetch (Node 18+). The provider SDKs are not
 * imported — responses are read structurally — so this package stays standalone.
 */

export type Provider = 'anthropic' | 'openai' | 'perplexity' | 'gemini';

/** Normalized token usage. Buckets are disjoint. */
export interface TrackUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface TrackerConfig {
  /** Ingest service base URL. Defaults to $APITRACKER_URL. */
  url?: string;
  /** Per-app ingest key. Defaults to $APITRACKER_KEY. */
  key?: string;
  /** Request timeout in ms (default 4000). */
  timeoutMs?: number;
  /** Called when a record fails to post. Default logs a warning to console. */
  onError?: (err: unknown) => void;
}

export interface RecordArgs extends TrackerConfig {
  provider: Provider;
  model: string;
  usage: TrackUsage;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

const defaultOnError = (err: unknown) =>
  // eslint-disable-next-line no-console
  console.warn('[apitracker] failed to post usage (non-fatal):', (err as Error)?.message ?? err);

const nonNeg = (v: number | undefined) => Math.max(0, Math.trunc(v || 0));

/**
 * Post a single usage event. Fire-and-forget: returns immediately, never throws,
 * and is a no-op when no URL/key is configured.
 */
export function record(args: RecordArgs): void {
  const url = (args.url ?? process.env.APITRACKER_URL)?.replace(/\/+$/, '');
  const key = args.key ?? process.env.APITRACKER_KEY;
  if (!url || !key) return;

  const onError = args.onError ?? defaultOnError;
  const timeoutMs = args.timeoutMs ?? 4000;

  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/v1/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-App-Key': key },
        body: JSON.stringify({
          provider: args.provider,
          model: args.model,
          input_tokens: nonNeg(args.usage.inputTokens),
          output_tokens: nonNeg(args.usage.outputTokens),
          cached_input_tokens: nonNeg(args.usage.cachedInputTokens),
          cache_write_tokens: nonNeg(args.usage.cacheWriteTokens),
          request_id: args.requestId ?? null,
          metadata: args.metadata ?? {},
        }),
        signal: controller.signal,
      });
      if (!res.ok) onError(new Error(`ingest responded ${res.status}`));
    } catch (err) {
      onError(err);
    } finally {
      clearTimeout(timer);
    }
  })();
}

// ── Usage normalization (structural — no SDK imports) ─────────────────────────

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function fromAnthropic(u: AnthropicUsage | undefined): TrackUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cachedInputTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

function fromOpenAI(u: OpenAIUsage | undefined): TrackUsage {
  // prompt_tokens is cache-inclusive; subtract the cached portion out.
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u?.completion_tokens ?? 0,
    cachedInputTokens: cached,
  };
}

// ── Client wrappers ───────────────────────────────────────────────────────────

export interface TrackOptions extends TrackerConfig {
  /** App slug this client's usage bills under (must match the ingest key's app). */
  app?: string;
  /** Provider override (e.g. 'perplexity' for an OpenAI-compatible client). */
  provider?: Provider;
  /** Extra metadata attached to every recorded event from this client. */
  metadata?: Record<string, unknown>;
}

/**
 * Replace a deeply-nested method on `target` with `wrap(originalMethod)`, leaving
 * every other property/method passing through unchanged (via Proxy).
 * `path` is e.g. ['messages','create'] or ['chat','completions','create'].
 */
function deepWrap<T extends object>(target: T, path: string[], wrap: (fn: Function) => Function): T {
  const [head, ...rest] = path;
  return new Proxy(target, {
    get(t, prop, recv) {
      if (prop !== head) return Reflect.get(t, prop, recv);
      const child = (t as Record<string, unknown>)[head];
      if (rest.length === 0) return wrap((child as Function).bind(t));
      return deepWrap(child as object, rest, wrap);
    },
  }) as T;
}

function instrument<T extends object>(
  client: T,
  path: string[],
  provider: Provider,
  normalize: (res: any) => TrackUsage,
  opts: TrackOptions,
): T {
  const wrap = (orig: Function) =>
    async function (this: unknown, ...args: unknown[]) {
      const result = await (orig as (...a: unknown[]) => Promise<any>)(...args);
      // Only auto-record non-streaming responses that carry a usage object.
      if (result && typeof result === 'object' && 'usage' in result && (result as any).usage) {
        record({
          ...opts,
          provider: opts.provider ?? provider,
          model: (result as any).model ?? 'unknown',
          usage: normalize(result),
          requestId: (result as any).id ?? null,
          metadata: opts.metadata,
        });
      }
      return result;
    };
  return deepWrap(client, path, wrap);
}

/** Wrap an Anthropic client so `messages.create` records usage automatically. */
export function trackAnthropic<T extends object>(client: T, opts: TrackOptions = {}): T {
  return instrument(client, ['messages', 'create'], 'anthropic', (r) => fromAnthropic(r.usage), opts);
}

/**
 * Wrap an OpenAI (or OpenAI-compatible) client so `chat.completions.create`
 * records usage automatically. Pass `{ provider: 'perplexity' }` for Perplexity.
 */
export function trackOpenAI<T extends object>(client: T, opts: TrackOptions = {}): T {
  const provider = opts.provider ?? 'openai';
  return instrument(client, ['chat', 'completions', 'create'], provider, (r) => fromOpenAI(r.usage), opts);
}

/**
 * Auto-detect the client type (Anthropic vs OpenAI) and wrap it. For Perplexity
 * or other OpenAI-compatible endpoints, use `trackOpenAI(client, { provider })`.
 */
export function track<T extends object>(client: T, opts: TrackOptions = {}): T {
  const c = client as any;
  if (c?.messages && typeof c.messages.create === 'function') return trackAnthropic(client, opts);
  if (c?.chat?.completions && typeof c.chat.completions.create === 'function') return trackOpenAI(client, opts);
  throw new Error(
    '@sgiq/apitracker: could not detect provider client. Use trackAnthropic() or trackOpenAI() explicitly.',
  );
}
