# Codebase Guide (for beginners)

This guide explains everything that has been built so far, in plain English.
Read it from top to bottom. Each part builds on the one before it.

---

## 1. What is this project?

The final goal is an app that:

1. finds news,
2. uses AI (LLMs) to research, write and check social media content,
3. turns it into Instagram carousel images,
4. sends it to you on Telegram for approval,
5. and then posts it on Instagram.

**What is built so far is only the foundation:**

- **Configuration** – reading settings (API keys, ports, limits) from the `.env` file and checking them.
- **The LLM layer** – one service that talks to three AI providers (Gemini, Groq, OpenRouter). If one fails, it automatically tries the next one.

Everything else (agents, queue, Telegram, Instagram, carousel, database) is still empty files.
The app cannot be started yet, because `main.ts` and `app.module.ts` are empty.
Right now, the code is run through the **tests**.

---

## 2. Words you need to know first

| Word | Simple meaning |
|---|---|
| **LLM** | Large Language Model. An AI that reads text and writes text, like Gemini. |
| **Provider** | A company that gives access to an LLM through the internet: Gemini (Google), Groq, OpenRouter. |
| **API key** | A secret password that proves to the provider who you are. Each provider gives you one. |
| **SDK** | A library made by the provider that makes calling their API easy. We use `@google/genai`, `groq-sdk` and `openai`. |
| **Prompt** | The text we send to the AI. A *system prompt* sets the AI's role or rules. A *user prompt* is the actual question. |
| **Tokens** | Pieces of words. Providers count tokens to measure (and charge for) usage. |
| **Temperature** | A number from 0 to 2. Low = focused and predictable answers. High = more creative answers. |
| **Fallback** | When the first provider fails, try the next one. |
| **Retry** | Try the same thing again. |
| **Rate limit** | A provider only allows a certain number of requests per minute. Going over gives an HTTP **429** error. |
| **Timeout** | If a request takes too long, we give up on it. |
| **HTTP status code** | A number the server sends back. 200 = OK, 400 = bad request, 401 = wrong key, 429 = too many requests, 5xx = server problem. |
| **NestJS** | The framework this app is built with. It organises code into *modules* and *services*. |
| **Dependency Injection (DI)** | NestJS creates objects for you and passes them into constructors. You write `constructor(private configService: ConfigService)` and NestJS gives you a ready ConfigService. |
| **Interface** | A TypeScript "contract". It says which properties and methods an object must have. It contains no logic. |
| **Zod** | A library that checks if data has the right shape (for example: "must be an object with a `title` string"). |
| **async / await** | Calling a provider takes time. `await` waits for the answer without freezing the app. |

---

## 3. Folder map – what is in each folder right now

```
ai-social-content-agent/
├── src/
│   ├── main.ts, app.module.ts   EMPTY – the app starting point (not built yet)
│   ├── config/                  BUILT – settings and their checks
│   ├── llm/                     BUILT – everything about talking to AI providers
│   │   └── providers/           BUILT – one file per AI provider
│   ├── common/
│   │   ├── exceptions/          BUILT – llm.exception.ts (our error class)
│   │   ├── utils/               BUILT – llm.utils.ts (small helper functions)
│   │   ├── types/               empty
│   │   └── interfaces/          empty
│   ├── agents/                  EMPTY – the AI "workers" (research, editorial, …)
│   ├── orchestration/           EMPTY – runs the agents in the right order
│   ├── research-tools/          EMPTY – search, RSS, article reading
│   ├── carousel/                EMPTY – makes the Instagram images
│   ├── telegram/                EMPTY – the Telegram bot for approvals
│   ├── approval/                EMPTY – approve / revise logic
│   ├── publishing/              EMPTY – posts to Instagram
│   └── database/                EMPTY – Prisma database connection
├── prompts/                     EMPTY – the text instructions for each agent
├── prisma/                      EMPTY – database schema
├── storage/                     EMPTY – saved research, scripts, images
├── tests/integration/           BUILT – llm-router.spec.ts (all the tests)
├── .env.example                 BUILT – list of every setting the app reads
├── package.json                 BUILT – libraries and scripts
└── tsconfig.json                BUILT – TypeScript settings
```

---

## 4. The order to study the files

Follow this order. Each file only uses files that come before it.

| Step | File | What you learn |
|---|---|---|
| 1 | `package.json`, `tsconfig.json`, `.env.example` | What libraries we use, and what settings exist |
| 2 | `src/config/constants.ts` | Fixed values used everywhere |
| 3 | `src/config/configuration.ts` | How `.env` values become a settings object |
| 4 | `src/config/env.validation.ts` | How wrong settings are caught at startup |
| 5 | `src/llm/llm.types.ts` | The shapes of data: what goes in, what comes out |
| 6 | `src/llm/llm.interface.ts` | The contract every provider must follow |
| 7 | `src/common/exceptions/llm.exception.ts` | How every error becomes one clear type |
| 8 | `src/common/utils/llm.utils.ts` | Small shared helpers |
| 9 | `src/llm/model-config.ts` | All LLM settings in one place |
| 10 | `src/llm/providers/gemini.provider.ts` | How one provider works (read this one carefully) |
| 11 | `groq.provider.ts`, `openrouter.provider.ts` | Same idea, different SDK |
| 12 | `src/llm/rate-limiter.service.ts` | Our own requests-per-minute limit |
| 13 | `src/llm/provider-health.service.ts` | Pausing providers that keep failing |
| 14 | `src/llm/llm-router.service.ts` | **The most important file.** Puts everything together |
| 15 | `src/llm/llm.module.ts` | How NestJS connects all of it |
| 16 | `tests/integration/llm-router.spec.ts` | Proof that everything works, and examples of how to use it |

---

## 5. Every file explained

### 5.1 Project setup files

**`package.json`** – the list of libraries the project needs, and the commands you can run.

- `@nestjs/common`, `@nestjs/core`, `@nestjs/config` – the NestJS framework (version 11) and its settings module.
- `@google/genai` – Google's SDK for Gemini.
- `groq-sdk` – Groq's SDK.
- `openai` – OpenAI's SDK. We use it for OpenRouter, because OpenRouter copies OpenAI's API.
- `zod` – checks the shape of JSON answers.
- `jest`, `ts-jest` – run the tests.
- `npm test` runs the tests. `npm run build` compiles the TypeScript.

*Why NestJS 11 and TypeScript 5, not the newest?* The test tool (`ts-jest`) does not support TypeScript 7 yet, and NestJS 12 caused problems with it.

**`tsconfig.json`** – settings for the TypeScript compiler. The important ones:
- `strict: true` – TypeScript checks the code strictly, which catches mistakes early.
- `experimentalDecorators` and `emitDecoratorMetadata` – needed for NestJS decorators like `@Injectable()`.

**`.env.example`** – a template of every setting. You copy it to `.env` and fill in your real keys.
The real `.env` is in `.gitignore`, so your secrets are never saved to Git.

---

### 5.2 `src/config/` – settings

#### `constants.ts`
Fixed values that never come from `.env`:

- `GEMINI = 'gemini'`, `GROQ = 'groq'`, `OPENROUTER = 'openrouter'` – the provider names.
- `PROVIDER_PRIORITY = [GEMINI, GROQ, OPENROUTER]` – the order we try providers in.
- `DEFAULT_LLM_TIMEOUT = 60000` – 60 seconds.
- `DEFAULT_TEMPERATURE = 0.7`.
- `DEFAULT_HTTP_TIMEOUT = 15000` – not used yet; meant for normal web requests later.

**Logic:** if a value is written in one place only, you change it once and the whole app follows.
API keys are NOT here, because this file is saved in Git and keys must stay secret.

#### `configuration.ts`
Reads `process.env` (the values from `.env`) and groups them into sections:

```
app        → name, nodeEnv, port
gemini     → apiKey, model, timeout, temperature, requestsPerMinute
groq       → same as gemini
openrouter → same as gemini
database   → url
redis      → host, port, password
queue      → concurrency, maxAttempts, backoffDelay, jobTimeout
telegram   → botToken, chatId
instagram  → accessToken, accountId
```

Other code then asks for a value like this: `configService.get('gemini.apiKey')`.

**The `toNumber` helper:** everything in `.env` is text. `"3000"` is not the number `3000`.
`toNumber` turns text into a number. If the value is missing or not a number, it uses a default.
It checks for "missing" carefully, so a temperature of `0` still works (a simple `|| default` would wrongly replace `0`).

**Why no default for API keys?** If we invented a fake key, the app would fail later in a confusing way. It is better to leave it empty and let the validation catch it.

#### `env.validation.ts`
Checks the settings once, when the app starts. If something is wrong, the app stops and shows **all** problems at once (not one at a time).

What it checks:
1. `NODE_ENV` must be `development`, `production` or `test`.
2. `PORT` and `REDIS_PORT` must be whole numbers from 1 to 65535.
3. Queue numbers and requests-per-minute must be whole numbers of 0 or more.
4. **At least one** LLM API key must be set. Each single key is optional, so "no Gemini key but Groq key set" is fine.
5. In `production` only: database, Telegram and Instagram settings are required.

A key with only spaces counts as empty.

**Logic:** it is much better to fail at startup with a clear message than to fail an hour later in the middle of making a post.

> Note: this function is not connected yet. It will be connected in `app.module.ts`.

---

### 5.3 `src/llm/llm.types.ts` – the shapes of data

This file has no logic. It only describes data.

- **`LLMProviderName`** – can only be `'gemini'`, `'groq'` or `'openrouter'`.
- **`LLMResponseFormat`** – `'text'` or `'json'`.
- **`LLMInput`** – what we send:
  - `userPrompt` (required) – the question.
  - `systemPrompt` – the rules for the AI.
  - `responseFormat` – text or JSON.
  - `schema` – an optional Zod schema to check a JSON answer.
  - `temperature`, `maxTokens`, `timeout` – optional overrides.
- **`LLMRequestMetadata`** – `workflowId`, `newsId`, `attempt`. Only used for logs, so you can follow one news item through the logs.
- **`TokenUsage`** – input, output and total tokens.
- **`LLMResponse`** – what we get back:
  - `content` – the AI's answer as text.
  - `provider` and `model` – who answered.
  - `usage` – tokens (optional, because a provider might not send it).
  - `data` – the parsed JSON object (only for JSON requests).
  - `metadata` – latency, which providers were tried, and the request metadata.
- **`LLMErrorType`** – every kind of error we know (see section 7).

**Logic:** all three providers return the **same** shape. The rest of the app never needs to know which provider answered.

### 5.4 `src/llm/llm.interface.ts` – the contract

```ts
interface LLMProvider {
  name: LLMProviderName;
  generate(input, metadata?): Promise<LLMResponse>;
}
```

Every provider class must have a `name` and a `generate()` method.
It imports no SDK. That is the point: the router only knows this contract, so you could swap or add a provider without touching the router logic.

---

### 5.5 `src/common/exceptions/llm.exception.ts` – one error for everything

Each SDK throws its own kind of error. Gemini throws `ApiError`, Groq throws `RateLimitError`, and so on.
This file turns all of them into **one** class: `LLMError`.

An `LLMError` has:
- `type` – what kind of error (for example `RATE_LIMIT`).
- `provider` – which provider failed.
- `statusCode` – the HTTP status, if there was one.
- `retryAfterMs` – how long the provider asked us to wait.
- `originalError` – the SDK's own error, kept so nothing is hidden when debugging.
- `failures` – only used when all providers fail; it lists each provider's error.
- `isRetryable()` – `true` for temporary problems: `RATE_LIMIT`, `TIMEOUT`, `NETWORK`, `PROVIDER_ERROR`.

**`toLLMError(error, provider, retryAfterMs)`** looks at the status code and the message, and decides the type. Some special cases:
- Gemini sends **400** (not 401) when the API key is wrong. So a 400 that mentions "api key" becomes `AUTHENTICATION`.
- Groq sends **400** when the AI produced broken JSON. So a 400 that mentions "json" becomes `INVALID_RESPONSE`.
- Errors with no status code are timeouts or network problems. We find them by words like "timeout" or "fetch failed".

### 5.6 `src/common/utils/llm.utils.ts` – small helpers

- **`buildSystemPrompt(input)`** – when JSON is wanted, it adds: *"Reply with valid JSON only…"* to the system prompt. This works on every model, even ones without a special JSON mode. (Groq actually requires the word "json" in the prompt when JSON mode is on.)
- **`getRetryAfterFromHeaders(error)`** – reads the `Retry-After` header from a Groq or OpenRouter error. The header can be seconds (`"20"`) or a date. It returns milliseconds.

---

### 5.7 `src/llm/model-config.ts` – all LLM settings in one place

```
primary     → 'gemini'
fallback    → ['groq', 'openrouter']
models      → default model names (used only when *_MODEL is empty in .env)
timeout     → 60 seconds
maxRetries  → 0
health      → failureThreshold 3, cooldownMs 1 min, authCooldownMs 5 min
providers   → supportsJsonMode per provider, and OpenRouter's baseUrl
```

**Why `maxRetries: 0`?** If Gemini is rate limited, trying Gemini again straight away will just fail again and waste time. It is faster to go to Groq immediately.

**Why is OpenRouter's `supportsJsonMode` false?** The default model `openrouter/free` picks a random free model each time. Some of them do not support JSON mode. So we only ask for JSON in the prompt, and the router checks the answer with Zod.

**Rule:** agents never write a model name themselves. All model choices live here or in `.env`.

> The default model names were not confirmed against the official docs. Check them, or set them in `.env`.

---

### 5.8 `src/llm/providers/` – one file per AI provider

All three files follow the **same 4 steps**. Read `gemini.provider.ts` first; the other two will then be easy.

**Step 1 – Constructor (runs once when the app starts)**
- Reads the API key, model, timeout and temperature from `ConfigService`.
- If there is an API key, it creates the SDK client. If not, the client stays `null`. (Keys are optional in development.)
- It turns OFF the SDK's own hidden retries (Gemini retries 5 times by default, Groq and OpenAI 2 times). Why? So the **router** is the only place that decides about retries. Otherwise one failure could secretly become 5 requests.

**Step 2 – `generate(input)` sends the request**
- No client? Throw `AUTHENTICATION` ("API key is not set") without making any request.
- Builds the system prompt (adds the JSON instruction if needed).
- Calls the SDK with: model, system prompt, user prompt, temperature, max tokens, JSON mode, timeout.

**Step 3 – Read the answer**
- Takes the text out of the SDK's answer.
- Empty answer? Throw `INVALID_RESPONSE`. An empty answer is a failure, not a success.
- Takes the token counts out (each SDK names them differently).
- Returns a normal `LLMResponse`.

**Step 4 – If anything goes wrong**
- `catch (error)` → `throw toLLMError(error, provider, retryAfterMs)`.

**The differences between the three:**

| | Gemini | Groq | OpenRouter |
|---|---|---|---|
| SDK | `@google/genai` | `groq-sdk` | `openai` (with OpenRouter's URL) |
| System prompt goes in | `config.systemInstruction` | a `system` message | a `system` message |
| JSON mode | `responseMimeType: 'application/json'` | `response_format: json_object` | prompt only (see 5.7) |
| Token names | `promptTokenCount`, `candidatesTokenCount` | `prompt_tokens`, `completion_tokens` | same as Groq |
| Wait time on 429 | read `retryDelay` from the error message | `Retry-After` header | `Retry-After` header |
| `model` in the answer | the configured model | the model Groq reports | the real model that answered |

---

### 5.9 `src/llm/rate-limiter.service.ts` – our own speed limit

Each provider has a requests-per-minute limit in `.env` (Gemini 10, Groq 30, OpenRouter 20).

**How it works:**
- It keeps a list of the times of the last requests to each provider.
- `tryAcquire(provider)` removes times older than 1 minute, then counts what is left.
  - Under the limit → it adds "now" to the list and returns `true`.
  - At the limit → it returns `false`.
- `getWaitTime(provider)` says how long until the oldest request is more than 1 minute old.

**Logic:** it is better to skip a busy provider ourselves than to send a request, get a 429 and waste time.

> Limitation: the list is kept in memory. If you run the app twice, each copy has its own count.

### 5.10 `src/llm/provider-health.service.ts` – pausing broken providers

It remembers how each provider is doing: failures in a row, total requests, tokens, latency, and the last error.

A provider is **paused** (the router skips it) when:
1. it sends **429 with a wait time** → paused for exactly that time,
2. the **API key is wrong** → paused for 5 minutes (a wrong key will not fix itself),
3. it fails **3 times in a row** → paused for 1 minute.

One success resets the "failures in a row" counter.

**Logic:** this is called a *circuit breaker*. Without it, if Gemini is down, every single request would first wait for Gemini to fail before trying Groq.

---

### 5.11 `src/llm/llm-router.service.ts` – the heart of the LLM layer

This is the **only** LLM service that agents will use. They call:

```ts
const response = await llmRouter.generate(
  { systemPrompt: '...', userPrompt: '...', responseFormat: 'json', schema: mySchema },
  { workflowId: 'wf-1', newsId: 'news-7', attempt: 1 },
);
```

It has 4 parts:

**1. `generate()` – the main loop**
1. Check the input (`validateInput`). Bad input → throw `INVALID_REQUEST` and call **no** provider.
2. Go through the providers in order: Gemini → Groq → OpenRouter.
3. For each provider:
   - Is it paused? → skip it and record why.
   - Otherwise call `tryProvider()`.
   - Success → return the answer immediately. The other providers are never called.
   - Failure → record it and move to the next provider.
   - Exception: if the provider says our request is **invalid** (`INVALID_REQUEST`), stop. The others would reject it too.
4. If all providers failed → throw one `ALL_PROVIDERS_FAILED` error. It contains every provider's error and the **shortest wait time**, so the queue (built later) knows when to try again.

**2. `tryProvider()` – one provider**
1. Check our own rate limit. Over the limit → throw `RATE_LIMIT` (this does not count against the provider's health, because it is our limit).
2. Start a timer and call `provider.generate()`.
3. JSON wanted? → `parseJson()`.
4. Success → add metadata (latency, providers tried), tell the health service, log it, return.
5. Failure → tell the health service (except for `INVALID_REQUEST`, which is our mistake), log it.
   - Wrong key → logged as an **error**, so you notice it.
   - Not retryable, or the provider asked us to wait → stop trying this provider.

**3. `parseJson()` – checking JSON answers**
1. Remove ```` ```json ```` fences (some models add them even when told not to).
2. `JSON.parse()`. Broken JSON → `INVALID_RESPONSE`, and the router tries the next provider. The failure is logged and recorded, never hidden.
3. If a Zod `schema` was given → check the shape. Wrong shape → `INVALID_RESPONSE`.
4. The result goes into `response.data`.

**4. `validateInput()` – rules for the input**
- `userPrompt` must not be empty.
- `responseFormat` must be `text` or `json`.
- `schema` only works with `json`.
- `temperature` must be 0 to 2.
- `maxTokens` must be a whole number above 0.

### 5.12 `src/llm/llm.module.ts` – connecting it with NestJS

```ts
@Module({
  imports: [ConfigModule],
  providers: [GeminiProvider, GroqProvider, OpenRouterProvider,
              RateLimiterService, ProviderHealthService, LLMRouterService],
  exports: [LLMRouterService, ProviderHealthService],
})
```

- `providers` – the classes NestJS should create. NestJS sees that `LLMRouterService` needs the three providers, the rate limiter and the health service in its constructor, and passes them in automatically.
- `exports` – what other modules may use. Agents will import `LLMModule` and get `LLMRouterService`. They never see the individual providers.

---

### 5.13 `tests/integration/llm-router.spec.ts` – the tests

Run them with `npm test`.

**Fake providers:** most tests use a `fakeProvider` instead of the real AI. It returns a fixed answer or throws a fixed error. This makes the tests fast, free, and the same every time.

| Group | What it proves |
|---|---|
| A | Real API calls to each provider. **Skipped** unless the key is in `.env`. |
| B | Fallback: Gemini fails → Groq; Groq fails → OpenRouter; all fail → one clear error; invalid input → nothing is called. |
| C | Output: valid JSON, JSON in fences, broken JSON, wrong schema, empty answer, missing usage, correct names. |
| D | Cost: token and latency tracking, no endless retries, no extra calls when Gemini works, correct switching order. |
| E | Request metadata is passed through and returned. |
| F | Rate limiter: blocks over the limit, allows again after 1 minute, router skips the busy provider. |
| G | Health: pause after 3 failures, success resets, Retry-After respected, wrong key pauses. |
| Errors | Every SDK error becomes the right `LLMErrorType`, and the original error is kept. |
| Module | NestJS can create `LLMRouterService` with all its parts. |

Current result: **54 passed, 6 skipped** (group A, no keys yet).

---

## 6. The full flow of one request, step by step

Example: an agent asks for JSON. Gemini is rate limited. Groq works.

```
Agent
  │  llmRouter.generate({ userPrompt, responseFormat: 'json', schema }, metadata)
  ▼
LLMRouterService.generate()
  │  1. validateInput()                         → input is fine
  │
  │  2. Gemini
  │     ├─ providerHealth.isAvailable(gemini)?  → yes
  │     ├─ rateLimiter.tryAcquire(gemini)?      → yes (under 10 per minute)
  │     ├─ GeminiProvider.generate()
  │     │     └─ Google SDK → HTTP 429, retryDelay "23s"
  │     ├─ toLLMError()                         → RATE_LIMIT, retryAfterMs 23000
  │     ├─ providerHealth.recordFailure()       → Gemini paused for 23 seconds
  │     └─ provider asked us to wait            → do not retry Gemini
  │
  │  3. Groq
  │     ├─ isAvailable(groq)?                   → yes
  │     ├─ tryAcquire(groq)?                    → yes
  │     ├─ GroqProvider.generate()
  │     │     └─ Groq SDK → HTTP 200, '{"title": "..."}'
  │     ├─ parseJson() + Zod check              → OK → response.data
  │     ├─ providerHealth.recordSuccess()
  │     └─ return response
  ▼
Agent gets:
  { content, data, provider: 'groq', model, usage,
    metadata: { latencyMs, attemptedProviders: ['gemini', 'groq'], request } }
```

If another request comes in during the next 23 seconds, the router **skips Gemini** without calling it and goes straight to Groq.

---

## 7. Error types – what each one means and what the router does

| Type | When it happens | Same provider again? | Next provider? |
|---|---|---|---|
| `RATE_LIMIT` | HTTP 429, or our own per-minute limit | Only if no wait time and `maxRetries` > 0 | Yes |
| `TIMEOUT` | The provider took too long | If `maxRetries` > 0 | Yes |
| `NETWORK` | Could not reach the provider | If `maxRetries` > 0 | Yes |
| `PROVIDER_ERROR` | HTTP 5xx | If `maxRetries` > 0 | Yes |
| `AUTHENTICATION` | HTTP 401/403, Gemini's 400 "API key", or no key set | No (paused 5 min) | Yes, and logged as an error |
| `MODEL_UNAVAILABLE` | HTTP 402 (no credits), 404, or a 400 about the model | No | Yes |
| `INVALID_RESPONSE` | Empty answer, broken JSON, wrong schema | No | Yes |
| `INVALID_REQUEST` | Our input is wrong (checked by us, or HTTP 400 from the provider) | No | **No – stop** |
| `ALL_PROVIDERS_FAILED` | Every provider failed | – | – (thrown to the caller) |
| `UNKNOWN` | Anything else | No | Yes |

With the current setting `maxRetries: 0`, the router never calls the same provider twice in one request.

---

## 8. The ideas behind the design

1. **One door for AI.** Agents only use `LLMRouterService`. They do not know or care which provider answered.
2. **Same shape everywhere.** Every provider returns `LLMResponse` and throws `LLMError`. Different SDKs are hidden inside the provider files.
3. **Fail early.** Bad settings stop the app at startup. Bad input is rejected before any request is sent.
4. **Never waste requests.** SDK hidden retries are off, busy providers are skipped, and paused providers are not called.
5. **Never hide errors.** Every failure is logged and recorded, and the SDK's original error is kept in `originalError`.
6. **Settings in one place.** Constants in `constants.ts`, secrets in `.env`, LLM choices in `model-config.ts`.

---

## 9. What is not built or connected yet

- `main.ts` and `app.module.ts` are empty, so the app cannot start yet. `app.module.ts` must load `configuration` and `validateEnv` through `ConfigModule.forRoot(...)`.
- The queue files (`src/queue/`), `workflow.context.ts` and `workflow.types.ts` are waiting for their implementation points.
- Agents, prompts, research tools, carousel, Telegram, approval, publishing and database are empty.
- The real API tests (group A) have not been run, because there is no `.env` with keys yet.

---

## 10. How to try it yourself

1. Copy `.env.example` to `.env`.
2. Add at least one API key (for example `GEMINI_API_KEY=...`).
3. Run the tests:

```bash
npm test
```

4. Then read the test file. Each test is a small, working example of how to use the router.
