# @sgiq/apitracker

Tiny Node client for the [API-Tracker](https://github.com/SGiQ/API-Tracker) ingest
service. Wrap a provider client once and every LLM call is attributed to your app
for cross-app billing — no database credentials, no pricing logic in your app.

Dependency-free (global `fetch`, Node 18+). The provider SDKs are read
structurally, not imported, so this package stays standalone.

## Install

```bash
npm i github:SGiQ/apitracker-node
```

## Configure

Set two env vars (per app/deployment):

```bash
APITRACKER_URL=https://your-ingest-service.up.railway.app
APITRACKER_KEY=atk_…        # issue with: apitracker issue-key <app>
```

With either unset, the client is a **no-op** — safe to leave wired in any env.

## Use

Wrap the client once; calls record themselves (fire-and-forget, never blocks):

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { track, trackOpenAI } from '@sgiq/apitracker';

const anthropic = track(new Anthropic(), { app: 'dca-bot' });
await anthropic.messages.create({ model: 'claude-opus-4-8', max_tokens: 1024, messages: [...] });

const openai = track(new OpenAI(), { app: 'dca-bot' });
await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });

// Perplexity (OpenAI-compatible) — set the provider so it bills correctly:
const pplx = trackOpenAI(new OpenAI({ baseURL: 'https://api.perplexity.ai', apiKey }), {
  app: 'dca-bot',
  provider: 'perplexity',
});
```

The wrappers proxy the real client — every other method/property passes through,
so they're drop-in replacements. Both `create` **and** `parse` (the structured-output
helpers, `messages.parse` / `chat.completions.parse`) are auto-recorded. `app` must
match the app your ingest key was issued for.

### Streaming / manual

Streaming responses carry usage only on the final message, so record explicitly:

```ts
import { record } from '@sgiq/apitracker';

const final = await stream.finalMessage(); // Anthropic
record({
  provider: 'anthropic',
  model: final.model,
  usage: {
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
    cachedInputTokens: final.usage.cache_read_input_tokens,
    cacheWriteTokens: final.usage.cache_creation_input_tokens,
  },
  requestId: final.id,
  app: 'dca-bot',
});
```

### Gemini

Both Gemini SDKs are supported — `track()` auto-detects either:

```ts
// old @google/generative-ai
import { GoogleGenerativeAI } from '@google/generative-ai';
const genAI = track(new GoogleGenerativeAI(apiKey), { app: 'thematic-bot' });
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
await model.generateContent('hi');               // recorded

// new @google/genai
import { GoogleGenAI } from '@google/genai';
const ai = track(new GoogleGenAI({ apiKey }), { app: 'thematic-bot' });
await ai.models.generateContent({ model: 'gemini-2.5-pro', contents: 'hi' });   // recorded
```

Thinking tokens are billed as output; cached-content tokens are split out. Gemini
streaming isn't auto-recorded — use `record()` for that.

## API

- `track(client, opts)` — auto-detect Anthropic / OpenAI / Gemini and wrap.
- `trackAnthropic` / `trackOpenAI` / `trackGemini` (client, opts) — explicit.
- `record(args)` — post one event manually.

`opts` / `args` accept `{ app, provider?, metadata?, url?, key?, timeoutMs?, onError? }`.
`url`/`key` default to `APITRACKER_URL` / `APITRACKER_KEY`.
