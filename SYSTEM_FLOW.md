# How the System Actually Runs (low-level walkthrough)

`CODEBASE_GUIDE.md` explains **what** each file is.
This file explains **what happens inside the computer**, in order, from the moment the app starts until an AI answer comes back for a news item, and **why** every line is written the way it is.

---

## 0. Read this first: what is real and what is planned

Every step below is marked:

- **[BUILT]** – the code exists and is tested.
- **[PLANNED]** – the file is still empty. The step describes how it will connect to the built code.

Right now **the app cannot start on its own**, because `main.ts` and `app.module.ts` are empty.
The built code is run by the tests (`npm test`). The tests build the same objects that the real app will build, so the flow is the same.

---

## 1. The big picture: two phases

The system has two completely different phases. Keep them apart in your head.

```
PHASE 1 – STARTUP (happens ONCE when the app starts)
  Node loads the files
  → constants are created
  → decorators record "who needs what"
  → .env is read and checked
  → configuration() builds the settings object
  → NestJS creates every service ONE time
  → SDK clients are created (no internet call yet)
  → app is ready and waiting

PHASE 2 – WORK (happens EVERY time a news item needs AI)
  news item arrives            [PLANNED]
  → queue job                  [PLANNED]
  → workflow / agent           [PLANNED]
  → llmRouter.generate(...)    [BUILT]  ← everything from here on is real
  → provider → SDK → internet
  → answer or error comes back
```

**Why this split matters:**
Anything done in Phase 1 costs nothing later. That is why reading settings, creating SDK clients and building lookup tables all happen in constructors (Phase 1), and Phase 2 only does the actual work.

---

## 2. Phase 1 – Startup, step by step

### Step 1.1 – Node starts the program [PLANNED]

You will run `npm start`. TypeScript is first compiled to JavaScript (`npm run build`), and Node runs the compiled `main.js`.
`main.ts` will do roughly this:

```ts
const app = await NestFactory.create(AppModule);
await app.listen(port);
```

`NestFactory.create` is the moment NestJS starts building everything described below.

### Step 1.2 – Node loads the files (module loading) [BUILT]

When a file says `import { GEMINI } from '../config/constants'`, Node:

1. finds `constants.js`,
2. runs it **from top to bottom, one time**,
3. stores the result in a **cache**,
4. gives every other file that imports it **the same stored result**.

So `constants.ts` runs exactly once:

```ts
export const GEMINI = 'gemini';
export const PROVIDER_PRIORITY = [GEMINI, GROQ, OPENROUTER];
export const DEFAULT_LLM_TIMEOUT = 60000;
```

**Why this matters:**
- Every file sees the exact same values. There is one source of truth.
- `MODEL_CONFIG` in `model-config.ts` is also created once. It is one shared object in memory.
  (The local SDK check even used this: it changed `MODEL_CONFIG.providers.openrouter.baseUrl` once, and every OpenRouter client created afterwards used the new URL.)

**What disappears when TypeScript becomes JavaScript:**

| Written in TypeScript | Exists when the app runs? |
|---|---|
| `type LLMProviderName = ...` | **No** – types are deleted |
| `interface LLMInput {...}` | **No** – interfaces are deleted |
| `interface LLMProvider {...}` | **No** |
| `as LLMProviderName` | **No** – only a hint for the compiler |
| `const GEMINI = 'gemini'` | **Yes** – a real value |
| `class LLMError` | **Yes** – a real class |
| `MODEL_CONFIG` object | **Yes** – a real object |

So `llm.types.ts` and `llm.interface.ts` become almost empty JavaScript files. They only exist to let TypeScript catch mistakes **before** the program runs.

**Why `typeof GEMINI` in `llm.types.ts`?**

```ts
export type LLMProviderName = typeof GEMINI | typeof GROQ | typeof OPENROUTER;
```

Because `GEMINI` is a `const`, TypeScript knows its type is exactly `'gemini'`, not just "some string".
So `LLMProviderName` becomes `'gemini' | 'groq' | 'openrouter'`, and it is built from the constants.
If you ever renamed `'gemini'` in `constants.ts`, the type would follow automatically.

### Step 1.3 – Decorators record "who needs what" [BUILT]

Each service class has `@Injectable()`:

```ts
@Injectable()
export class GeminiProvider implements LLMProvider {
  constructor(private readonly configService: ConfigService) { ... }
}
```

Two things happen while the class is being loaded (before any object exists):

1. `@Injectable()` marks the class as something NestJS is allowed to create.
2. Because `tsconfig.json` has `emitDecoratorMetadata: true`, TypeScript writes a hidden note on the class:
   *"the constructor needs a `ConfigService`"* (this note is called `design:paramtypes`).

NestJS reads that note later to know what to pass into the constructor.

**Why the router injects `GeminiProvider` and not `LLMProvider`:**
The hidden note can only point to things that **exist at runtime**. `LLMProvider` is an interface, and interfaces are deleted (see the table above). So NestJS could never find it. Concrete classes like `GeminiProvider` do exist, so they can be injected.

**Why `implements LLMProvider` is still useful:**
It does nothing at runtime, but if `GeminiProvider` forgot the `generate()` method or returned the wrong shape, TypeScript would refuse to compile.

### Step 1.4 – Reading and checking `.env` [PLANNED wiring, BUILT logic]

`app.module.ts` will contain:

```ts
ConfigModule.forRoot({ load: [configuration], validate: validateEnv })
```

This is exactly what `ConfigModule.forRoot` does inside (checked in the `@nestjs/config` source code), in this order:

```
1. Read the .env file              → { GEMINI_API_KEY: 'abc', PORT: '3000', ... }
2. Copy process.env on top of it   → real environment variables WIN over .env
3. Call validateEnv(thatObject)    → our checks run here
     • problem found → throw Error → THE APP STOPS. Nothing else is created.
     • all fine      → return the object
4. Copy the values into process.env (only keys that are not already there)
5. Remember configuration() as a "factory" to run in the next step
```

**Why step 3 happens before anything else is created:**
If the Gemini key were missing or `PORT` were `"abc"`, we want the app to stop immediately with a clear list of problems, not 20 minutes later in the middle of a news item.

**Why `validateEnv` collects all errors in an array before throwing:**

```ts
const errors: string[] = [];
...
if (errors.length > 0) {
  throw new Error(`Invalid environment variables:\n- ${errors.join('\n- ')}`);
}
```

If it threw on the first problem, you would fix one thing, restart, find the next problem, restart again… Collecting them shows everything in one go.

**Why every value is treated as text:** everything in `.env` and `process.env` is a string. `PORT=3000` arrives as `"3000"`. That is why the code does `Number(config.PORT)` and then checks `Number.isInteger(port)`.

- `Number("abc")` gives `NaN` → not an integer → error.
- `Number("2.5")` gives `2.5` → not an integer → error.
- `Number("")` gives `0` (!) → that is why empty values are skipped **before** converting:

```ts
if (config[name] !== undefined && config[name] !== '') { ... }
```

### Step 1.5 – `configuration()` builds the settings object [BUILT]

NestJS now runs our factory:

```ts
export default function configuration() {
  return {
    gemini: {
      apiKey: process.env.GEMINI_API_KEY,
      timeout: toNumber(process.env.GEMINI_TIMEOUT, DEFAULT_LLM_TIMEOUT),
      ...
```

It runs **after** step 1.4, so `process.env` already contains the values from `.env`.
The returned object is stored inside `ConfigService`.

**Why `toNumber` checks so carefully:**

```ts
function toNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === '') return defaultValue;
  const result = Number(value);
  if (Number.isNaN(result)) return defaultValue;
  return result;
}
```

The simpler-looking `Number(value) || defaultValue` would be wrong: if you set `GEMINI_TEMPERATURE=0`, `Number("0")` is `0`, and `0 || 0.7` gives `0.7`. Your setting would be silently ignored.

**Why `process.env.NODE_ENV || 'development'` is fine with `||`:**
An empty string is never a valid environment name, so replacing `''` with the default is exactly what we want.

### Step 1.6 – How `ConfigService.get()` finds a value [BUILT]

Later, services call `configService.get('gemini.apiKey')`. Inside, it looks in this order:

```
1. the object from configuration()   → follows the dots: config['gemini']['apiKey']
2. the validated .env values         → used for flat names like 'GEMINI_API_KEY'
3. process.env
4. otherwise → undefined
```

So `'gemini.apiKey'` is found in step 1, in the object we built.

### Step 1.7 – NestJS creates every service, once [BUILT]

`LLMModule` lists what to create:

```ts
providers: [GeminiProvider, GroqProvider, OpenRouterProvider,
            RateLimiterService, ProviderHealthService, LLMRouterService],
exports: [LLMRouterService, ProviderHealthService],
```

NestJS reads each class's hidden "needs" note and builds them in dependency order. A class is only created after everything it needs exists:

```
ConfigService              (from ConfigModule)
   │
   ├──► GeminiProvider      constructor(configService)
   ├──► GroqProvider        constructor(configService)
   ├──► OpenRouterProvider  constructor(configService)
   ├──► RateLimiterService  constructor(configService)
   │
ProviderHealthService      (needs nothing)
   │
   └──► LLMRouterService    constructor(gemini, groq, openrouter, rateLimiter, health)
```

By default every service is a **singleton**: NestJS creates **one** object per class and gives that same object to everyone who asks for it.

**Why singletons matter here:**
- There is **one** `RateLimiterService`, so all agents share **one** request count per provider. If the research agent and the editorial agent each had their own counter, together they could break the provider's limit.
- There is **one** `ProviderHealthService`, so when one agent's request finds Gemini rate limited, **every** agent skips Gemini until the pause ends.

#### What each constructor does (and why)

**`GeminiProvider` constructor**

```ts
const apiKey = this.configService.get<string>('gemini.apiKey');
this.model = this.configService.get<string>('gemini.model') || MODEL_CONFIG.models[GEMINI];
this.timeout = this.configService.get<number>('gemini.timeout') || MODEL_CONFIG.timeout;
this.temperature = this.configService.get<number>('gemini.temperature') ?? DEFAULT_TEMPERATURE;

if (apiKey) {
  this.client = new GoogleGenAI({ apiKey });
}
```

- **Why read settings here and not in `generate()`?** The constructor runs once; `generate()` runs thousands of times. Read once, use many times.
- **Why `||` for model and timeout, but `??` for temperature?**
  - `||` replaces **any** "falsy" value: `undefined`, `null`, `''`, `0`.
    An empty `GEMINI_MODEL=` in `.env` gives `''` → replaced by the default model. Good.
    A timeout of `0` makes no sense → replaced. Good.
  - `??` replaces **only** `undefined` and `null`.
    A temperature of `0` is valid (very focused answers) → kept. Good.
- **Why create the client only if there is a key?** Keys are optional in development. Without a key, `client` stays `null` and `generate()` fails instantly with a clear message, without any internet call.
- **Does `new GoogleGenAI(...)` call the internet?** No. It only stores the key and settings. The first network call happens in `generate()`.

**Groq and OpenRouter constructors** are the same, plus:

```ts
this.client = new Groq({ apiKey, maxRetries: 0 });
```

- **Why `maxRetries: 0`?** Both SDKs secretly retry failed requests 2 times by default. If they did, one failure could become 3 requests, and the router would not know. We switch that off so that **only the router** decides about retries. (For Gemini, the same thing is done per request with `retryOptions: { attempts: 1 }`, because its default is 5 tries.)
- OpenRouter also passes `baseURL: 'https://openrouter.ai/api/v1'`. The OpenAI SDK sends requests to that address instead of OpenAI's. That is the whole trick that lets one SDK talk to another company.

**`RateLimiterService` constructor**

```ts
this.limits = {
  [GEMINI]: this.configService.get<number>('gemini.requestsPerMinute') || 0,
  ...
};
private requestTimes = { [GEMINI]: [], [GROQ]: [], [OPENROUTER]: [] };
```

- `[GEMINI]` in square brackets means "use the **value** of `GEMINI` as the key", so the key is `'gemini'`.
- `|| 0` → no setting means `0`, and `0` means "no limit".
- Each provider starts with an empty list of request times.

**`ProviderHealthService`** needs nothing. Each provider starts healthy: `unavailableUntil: 0` (a time in the past, so "available now"), all counters `0`.

**`LLMRouterService` constructor**

```ts
this.providers = {
  [GEMINI]: geminiProvider,
  [GROQ]: groqProvider,
  [OPENROUTER]: openRouterProvider,
};
```

- **Why build this lookup object?** Later the router loops over provider **names** (`'gemini'`, `'groq'`, …) from `MODEL_CONFIG`. With this object it can turn a name into the real provider with `this.providers[name]`, without any `if/else`.
- **Why `Record<LLMProviderName, LLMProvider>`?** TypeScript then forces the object to have **all three** names, and nothing else.

### Step 1.8 – Memory after startup

After Phase 1, this is what lives in memory, ready to be used:

| Object | Holds |
|---|---|
| `ConfigService` | the settings object from `configuration()` |
| `GeminiProvider` | model name, timeout, temperature, a ready `GoogleGenAI` client (or `null`) |
| `GroqProvider` | the same, with a `Groq` client |
| `OpenRouterProvider` | the same, with an `OpenAI` client pointing to OpenRouter |
| `RateLimiterService` | limits `{gemini:10, groq:30, openrouter:20}`, empty time lists |
| `ProviderHealthService` | all providers healthy, all counters 0 |
| `LLMRouterService` | the name → provider lookup object |
| `MODEL_CONFIG`, constants | the fixed settings |

No internet call has been made yet.

---

## 3. Phase 2 – A news item arrives

### Step 2.1 – From news to an agent [PLANNED]

These parts are still empty files. The intended path is:

```
RSS / search finds a news item            (research-tools)
  → a job is added to the queue          (queue/news-queue.service.ts)
      job data: { newsId, workflowId }
  → a worker picks up the job            (queue/news.processor.ts)
  → the workflow runs the agents in order (orchestration/)
  → each agent builds a prompt and calls the router
```

The **only** thing an agent needs to know is this one call:

```ts
const response = await this.llmRouter.generate(
  {
    systemPrompt: 'You are a news editor...',
    userPrompt: `Write a headline for: ${article}`,
    responseFormat: 'json',
    schema: z.object({ headline: z.string() }),
  },
  { workflowId: 'wf-1', newsId: 'news-7', attempt: 1 },
);
```

From here on, everything is **[BUILT]**.

### Step 2.2 – `router.generate()` begins [BUILT]

```ts
async generate(input: LLMInput, metadata?: LLMRequestMetadata): Promise<LLMResponse> {
  this.validateInput(input);
```

**`validateInput` runs first. Why?** If the prompt is empty, every provider will reject it. Checking it ourselves costs nothing; sending it costs 3 network calls that will all fail. It throws `INVALID_REQUEST`, and no provider is touched.

```ts
if (!input || typeof input.userPrompt !== 'string' || input.userPrompt.trim() === '') {
```

- `!input` – protects against `generate(undefined)`.
- `typeof ... !== 'string'` – TypeScript checks types while compiling, but data from a queue or JSON file is only checked at runtime. This line protects against that.
- `.trim() === ''` – a prompt of only spaces is still empty.

```ts
const trace = metadata
  ? ` [workflow ${metadata.workflowId}, news ${metadata.newsId}, attempt ${metadata.attempt}]`
  : '';
```

**Why build `trace` once?** It is added to every log line for this request. When 5 news items are processed at the same time, the logs are mixed together. `trace` lets you search the logs for `news-7` and see only that item's story.

```ts
const providerOrder = [MODEL_CONFIG.primary, ...MODEL_CONFIG.fallback];
const failures: LLMError[] = [];
const attemptedProviders: LLMProviderName[] = [];
```

- `...` (spread) unpacks the fallback array: `['gemini', ...['groq', 'openrouter']]` → `['gemini', 'groq', 'openrouter']`.
- `failures` collects every error, so if everything fails we can explain **all** of them.
- `attemptedProviders` records every provider we actually called.

### Step 2.3 – The provider loop [BUILT]

```ts
for (const providerName of providerOrder) {
  if (!this.providerHealth.isAvailable(providerName)) {
    const waitMs = this.providerHealth.getWaitTime(providerName);
    failures.push(new LLMError('MODEL_UNAVAILABLE', `${providerName} is paused after errors`, providerName, { retryAfterMs: waitMs }));
    continue;
  }
```

- `isAvailable` is just `Date.now() >= unavailableUntil`. No network, almost instant.
- **Why skip a paused provider?** If Gemini just told us "wait 23 seconds", calling it again would only waste time and look bad to Gemini.
- **Why still push a failure when skipping?** So the final error message explains why Gemini was not used, and its wait time can be counted (see step 2.8).
- `continue` jumps straight to the next provider in the loop.

```ts
  try {
    const response = await this.tryProvider(this.providers[providerName], input, metadata, trace, attemptedProviders);
    return response;
  } catch (error) {
```

- **Why `await` inside the `try`?** `tryProvider` is `async`, so it returns a **Promise**. If we returned the Promise without `await`, a failure would happen **after** we left the `try` block, and the `catch` would never see it. `await` makes the failure happen **inside** the `try`.
- **Why `return` inside the loop?** The first success ends everything. Groq and OpenRouter are never called when Gemini works. That is the "no unnecessary requests" rule.
- `attemptedProviders` is an array, and arrays are passed **by reference**: `tryProvider` adds names to the **same** array that `generate` created.

```ts
  } catch (error) {
    const llmError = toLLMError(error, providerName);
    failures.push(llmError);

    if (llmError.type === 'INVALID_REQUEST') {
      throw llmError;
    }
  }
}
```

- `toLLMError` again? `tryProvider` already throws an `LLMError`, so `toLLMError` simply returns it (`instanceof` check). It is there as a safety net in case anything else is thrown.
- **Why stop on `INVALID_REQUEST`?** The provider said "your request is broken". The same request would be broken for Groq and OpenRouter too. Trying them would only waste 2 calls.
- Any other error: the loop simply goes on to the next provider.

### Step 2.4 – Inside `tryProvider()` [BUILT]

```ts
const maxAttempts = MODEL_CONFIG.maxRetries + 1;   // 0 + 1 = 1
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
```

`maxRetries` is "extra tries", so the total is `maxRetries + 1`. With the current `0`, the loop runs once.
**Why a loop at all then?** So that changing one number in `model-config.ts` turns retries on, with no code change. And because the loop has a fixed end, **endless retries are impossible**.

```ts
  if (!this.rateLimiter.tryAcquire(provider.name)) {
    throw new LLMError('RATE_LIMIT', `${provider.name} requests-per-minute limit reached`, provider.name, {
      retryAfterMs: this.rateLimiter.getWaitTime(provider.name),
    });
  }
```

Inside `tryAcquire` ([rate-limiter.service.ts](src/llm/rate-limiter.service.ts)):

```ts
const oneMinuteAgo = Date.now() - ONE_MINUTE;
this.requestTimes[provider] = this.requestTimes[provider].filter((time) => time > oneMinuteAgo);
if (this.requestTimes[provider].length >= limit) return false;
this.requestTimes[provider].push(Date.now());
return true;
```

- `Date.now()` is the current time in milliseconds.
- `filter` keeps only times from the last 60 seconds. Older requests "fall out" of the window. This is called a **sliding window**.
- The count of what is left = requests in the last minute.
- **Why check before calling the provider?** It is free to check our own list; a 429 from the provider costs a network round-trip.
- **Why does this NOT count against the provider's health?** The provider did nothing wrong. We stopped ourselves.

```ts
  const startTime = Date.now();
  attemptedProviders.push(provider.name);

  try {
    const response = await provider.generate(input, metadata);
```

Now we leave the router and go into the provider.

### Step 2.5 – Inside `GeminiProvider.generate()` [BUILT]

```ts
if (!this.client) {
  throw new LLMError('AUTHENTICATION', 'GEMINI_API_KEY is not set', GEMINI);
}
```

No key → fail in under a millisecond, no network.

```ts
const useJsonMode = input.responseFormat === 'json' && MODEL_CONFIG.providers[GEMINI].supportsJsonMode;
const systemPrompt = buildSystemPrompt(input);
```

`buildSystemPrompt` ([llm.utils.ts](src/common/utils/llm.utils.ts)):

```ts
if (input.responseFormat === 'json') {
  return `${systemPrompt}\n\n${JSON_INSTRUCTION}`.trim();
}
```

- The JSON instruction is added for **every** provider, even when native JSON mode is on. Why? It makes the model more reliable, it is the only option for models without JSON mode, and Groq refuses JSON mode unless the word "json" appears in the messages.
- `.trim()` removes the leading `\n\n` when there was no system prompt.

```ts
const response = await this.client.models.generateContent({
  model: this.model,
  contents: input.userPrompt,
  config: {
    systemInstruction: systemPrompt || undefined,
    temperature: input.temperature ?? this.temperature,
    maxOutputTokens: input.maxTokens,
    responseMimeType: useJsonMode ? 'application/json' : 'text/plain',
    httpOptions: { timeout: input.timeout || this.timeout, retryOptions: { attempts: 1 } },
  },
});
```

- **This is the line that goes to the internet.** `await` pauses this function (not the whole app – other news items keep running) until Google answers or the timeout ends.
- `systemPrompt || undefined` – an empty string becomes `undefined`, so the SDK does not send an empty system instruction at all.
- `input.temperature ?? this.temperature` – the agent can override per request; otherwise the configured value.
- `responseMimeType: 'application/json'` – Gemini's native JSON mode: Google forces the answer to be JSON.
- `timeout` – if Google does not answer in time, the SDK cancels the request and throws. This is what stops one slow request from blocking a news item forever.
- `retryOptions: { attempts: 1 }` – one try only (see step 1.7).

```ts
const content = response.text;
if (!content || content.trim() === '') {
  throw new LLMError('INVALID_RESPONSE', 'Gemini returned an empty response', GEMINI);
}
```

**Why is an empty answer an error?** The HTTP request "succeeded", but we got nothing usable. Treating it as success would pass an empty headline to the next agent. Throwing makes the router try the next provider.

```ts
return {
  content,
  provider: GEMINI,
  model: this.model,
  usage: usage ? { inputTokens: usage.promptTokenCount || 0, ... } : undefined,
};
```

This is **normalising**: Google calls tokens `promptTokenCount` and `candidatesTokenCount`; Groq calls them `prompt_tokens` and `completion_tokens`. Each provider translates its own names into our one `TokenUsage` shape, so the router never needs to know the difference.

```ts
} catch (error) {
  throw toLLMError(error, GEMINI, this.getRetryAfterMs(error));
}
```

Everything that can go wrong (network, timeout, 429, our own empty-answer error) ends up here and is turned into one `LLMError`.

`getRetryAfterMs` reads Gemini's wait time from the error text:

```ts
message.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/)
```

Reading the pattern piece by piece:
- `retryDelay` – the literal word
- `"?` – maybe a quote
- `\s*:\s*` – a colon, maybe with spaces around it
- `"?` – maybe a quote
- `(\d+(?:\.\d+)?)` – **captured**: digits, maybe with decimals, like `23` or `23.5`
- `s` – the letter s (seconds)

So `"retryDelay": "23s"` captures `23` → `Math.ceil(23 * 1000)` = `23000` ms.
**Why Gemini is different:** Groq and OpenRouter send a standard `Retry-After` HTTP header. Gemini does not; it hides the delay inside the error body.

### Step 2.6 – How an SDK error becomes an `LLMError` [BUILT]

`toLLMError` ([llm.exception.ts](src/common/exceptions/llm.exception.ts)) checks in a fixed order. **The order matters.**

```ts
if (error instanceof LLMError) return error;   // already ours – keep it as it is
const status = err?.status;                     // all three SDKs put the HTTP code in .status
const text = `${err?.name} ${message}`.toLowerCase();
const details = { statusCode: status, retryAfterMs, originalError: error };
```

- `err?.status` – `?.` means "if `err` is `null` or `undefined`, give `undefined` instead of crashing".
- `text` combines the error's **name** and **message** in lower case, so word checks are simple.
- `originalError: error` – the SDK's own error is kept. The rule is "never hide the original provider error".

Then:

```
1. 401 / 403          → AUTHENTICATION
2. 402 / 404          → MODEL_UNAVAILABLE
3. 408                → TIMEOUT
4. 429                → RATE_LIMIT
5. 500 and above      → PROVIDER_ERROR
6. 400 → look at the words:
     "api key"   → AUTHENTICATION      (Gemini uses 400 for a wrong key)
     "json"      → INVALID_RESPONSE    (Groq uses 400 for broken JSON)
     "model"     → MODEL_UNAVAILABLE   (e.g. "model has been decommissioned")
     otherwise   → INVALID_REQUEST
7. no status code → look at the words:
     "timeout" / "timed out" / "abort"           → TIMEOUT
     "fetch failed" / "connection" / "network" / "econn" → NETWORK
8. anything else      → UNKNOWN
```

**A real example of why the order matters:**
When Groq times out, the SDK throws an error named `APIConnectionTimeoutError`. Its name contains **both** "timeout" **and** "connection". Because the timeout check comes **first**, it is correctly called `TIMEOUT`, not `NETWORK`.

**Why `this.name = 'LLMError'` in the class:** when an error is printed, Node shows its `name` first. Without this line it would just say `Error`.

### Step 2.7 – Back in `tryProvider()`: success [BUILT]

```ts
if (input.responseFormat === 'json') {
  response.data = this.parseJson(response.content, input, provider.name);
}
```

`parseJson`:

```ts
const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
```

- `^` = start of text, `$` = end of text.
- The first `replace` removes an opening ```` ``` ```` or ```` ```json ```` (any case – that is the `i`).
- The second removes a closing ```` ``` ````.
- **Why?** Many models wrap JSON in markdown fences even when told not to. `JSON.parse` would fail on them.

```ts
try { data = JSON.parse(cleaned); }
catch { throw new LLMError('INVALID_RESPONSE', `${providerName} returned invalid JSON`, providerName); }

if (input.schema) {
  const result = input.schema.safeParse(data);
  if (!result.success) throw new LLMError('INVALID_RESPONSE', ...);
  return result.data;
}
```

- `JSON.parse` only checks that the text **is** JSON.
- Zod's `safeParse` checks it has the **right shape** (`{ headline: string }`). `safeParse` returns `{ success: false, error }` instead of throwing, so we can write our own clear message.
- **Why throw instead of returning bad data?** A JSON answer with the wrong shape would crash a later agent in a confusing place. Throwing here makes the router try the next provider, and the failure is logged and recorded.

```ts
const latencyMs = Date.now() - startTime;
const tokens = response.usage ? response.usage.totalTokens : 0;

response.metadata = { latencyMs, attemptedProviders, request: metadata };
this.providerHealth.recordSuccess(provider.name, latencyMs, tokens);
return response;
```

- `latencyMs` – how long this provider took, start to finish.
- `recordSuccess` sets `consecutiveFailures = 0` and `unavailableUntil = 0`, and adds to the totals.
  **Why reset on success?** "3 failures in a row" should mean *in a row*. One success proves the provider works again.

### Step 2.8 – Back in `tryProvider()`: failure [BUILT]

```ts
} catch (error) {
  lastError = toLLMError(error, provider.name);
  const latencyMs = Date.now() - startTime;

  if (lastError.type !== 'INVALID_REQUEST') {
    this.providerHealth.recordFailure(provider.name, lastError, latencyMs);
  }
```

**Why not record `INVALID_REQUEST`?** It is our mistake, not the provider's. Pausing a healthy provider because we sent a bad request would be unfair and would hurt the next, valid request.

Inside `recordFailure` ([provider-health.service.ts](src/llm/provider-health.service.ts)):

```ts
health.consecutiveFailures++;
...
if (error.type === 'RATE_LIMIT' && error.retryAfterMs) {
  this.pause(provider, error.retryAfterMs);                    // wait exactly as long as asked
} else if (error.type === 'AUTHENTICATION') {
  this.pause(provider, MODEL_CONFIG.health.authCooldownMs);    // 5 minutes
} else if (health.consecutiveFailures >= MODEL_CONFIG.health.failureThreshold) {
  this.pause(provider, MODEL_CONFIG.health.cooldownMs);        // 1 minute
}
```

`pause` just does `unavailableUntil = Date.now() + ms`. The next `isAvailable` check compares the clock with that time. **No timers, no background jobs** – the pause "ends" by itself when the clock passes that time.

Then the logs:

```ts
if (lastError.type === 'AUTHENTICATION') {
  this.logger.error(...);   // a wrong key needs YOU to fix it → loud
} else {
  this.logger.warn(...);    // temporary problems → quieter
}
```

Then whether to try the same provider again:

```ts
if (!lastError.isRetryable()) break;   // permanent problem → stop
if (lastError.retryAfterMs) break;     // provider asked us to wait → stop
```

`isRetryable()` is `true` only for `RATE_LIMIT`, `TIMEOUT`, `NETWORK` and `PROVIDER_ERROR` – problems that can disappear by themselves.

After the loop:

```ts
throw lastError;
```

That goes back to the `catch` in `generate()` (step 2.3), which moves on to the next provider.

### Step 2.9 – When every provider failed [BUILT]

```ts
const waitTimes = failures
  .map((failure) => failure.retryAfterMs)
  .filter((ms): ms is number => ms !== undefined);
const retryAfterMs = waitTimes.length > 0 ? Math.min(...waitTimes) : undefined;
```

- `map` takes each failure's wait time (some are `undefined`).
- `filter(... ms is number ...)` removes the `undefined` ones. The `ms is number` part tells TypeScript that after this filter, the array only contains numbers.
- `Math.min(...waitTimes)` finds the shortest wait.

**Why the shortest?** It is the earliest moment **at least one** provider could work again. The queue [PLANNED] can wait exactly that long before retrying the job, instead of guessing.

```ts
throw new LLMError('ALL_PROVIDERS_FAILED', `All LLM providers failed. ${summary}`, undefined, {
  failures,
  retryAfterMs,
});
```

The agent gets one error that contains everything: each provider's own error (with the original SDK error inside), and when to try again.

---

## 4. Three complete timelines

### Timeline A – Everything works

```
t=0ms     validateInput OK
t=0ms     gemini: health OK, rate limit OK (1 of 10 this minute)
t=0ms     → Google
t=900ms   ← answer, parseJson OK, Zod OK
t=900ms   recordSuccess(gemini, 900ms, 230 tokens)
t=900ms   return { provider: 'gemini', metadata: { attemptedProviders: ['gemini'] } }
          Groq and OpenRouter: never called
```

### Timeline B – Gemini rate limited, Groq answers

```
t=0ms     gemini: health OK, rate limit OK → Google
t=120ms   ← HTTP 429, retryDelay "23s"
          toLLMError → RATE_LIMIT, retryAfterMs 23000, originalError = Google's ApiError
          recordFailure → gemini paused until t=23120ms
          retryAfterMs is set → do not retry gemini
t=120ms   groq: health OK, rate limit OK → Groq
t=600ms   ← answer → return { provider: 'groq', attemptedProviders: ['gemini', 'groq'] }

Next news item at t=5000ms:
          gemini: isAvailable? 5000 < 23120 → NO → skipped, not called
          groq answers directly
```

### Timeline C – Everything fails

```
gemini → TIMEOUT after 60s
groq   → RATE_LIMIT, Retry-After: 7  → retryAfterMs 7000
openrouter → 503 → PROVIDER_ERROR

throw ALL_PROVIDERS_FAILED {
  failures: [TIMEOUT, RATE_LIMIT, PROVIDER_ERROR],
  retryAfterMs: 7000          ← the queue [PLANNED] can retry this job in 7 seconds
}
```

---

## 5. "Why this and not that?" – quick answers

| Question | Answer |
|---|---|
| Why three providers? | Free tiers have low limits and sometimes go down. Three providers keep the pipeline running. |
| Why is Gemini first? | It is the primary provider in your plan (`PROVIDER_PRIORITY`). Changing the order is one line in `constants.ts`. |
| Why turn off SDK retries? | Hidden retries multiply requests without the router knowing. One place deciding is easier to understand and control. |
| Why `maxRetries: 0`? | Retrying a rate-limited provider straight away fails again. Moving to the next provider is faster. |
| Why our own rate limiter if the provider already has one? | Checking our own list is free and instant. A 429 costs a network round-trip and can make the provider slow us down more. |
| Why a health service (circuit breaker)? | Without it, every request would first wait for a broken provider to fail (up to 60 s) before trying the next one. |
| Why are rate limits and health kept in memory, not a database? | They change many times per second and only matter for the next few minutes. Memory is the fastest. (Limit: two app processes keep two separate counts.) |
| Why one `LLMError` class? | Three SDKs throw three kinds of errors. One shape means the router has one simple set of rules. |
| Why keep `originalError`? | When debugging, you need the provider's exact error. Our type is for decisions; the original is for humans. |
| Why validate input before any call? | A request that is wrong for one provider is wrong for all. Rejecting it early costs nothing. |
| Why Zod on top of JSON mode? | JSON mode guarantees valid JSON, not the right fields. Zod checks the fields. |
| Why `metadata` (workflowId, newsId)? | Many news items run at once and their logs mix. The trace lets you follow one item. |
| Why are settings read in constructors? | Constructors run once at startup; `generate()` runs for every request. |
| Why `||` sometimes and `??` other times? | `||` also replaces `0` and `''`; `??` only replaces `undefined`/`null`. Use `??` when `0` is a valid value (temperature). |

---

## 6. JavaScript / TypeScript features used, explained

| Code | Meaning |
|---|---|
| `a?.b` | If `a` is `null`/`undefined`, give `undefined` instead of crashing. |
| `a?.[0]` | The same, for array access: `response.choices?.[0]`. |
| `a ?? b` | Use `b` only if `a` is `null` or `undefined`. |
| `a \|\| b` | Use `b` if `a` is any falsy value (`undefined`, `null`, `''`, `0`, `false`). |
| `[...a, ...b]` | Spread: copy the items of arrays into a new array. |
| `{ ...obj, x: 1 }` | Spread: copy an object's fields into a new object. |
| `{ [GEMINI]: x }` | Computed key: the key is the **value** of `GEMINI`, i.e. `'gemini'`. |
| `` `text ${value}` `` | Template string: put a value inside text. |
| `async` / `await` | Wait for slow work (network) without blocking other work. |
| `try { } catch (e) { }` | Run code; if it throws, jump to `catch`. |
| `throw x` | Stop and send the error up to the nearest `catch`. |
| `x instanceof LLMError` | Is `x` an object made from the `LLMError` class? |
| `typeof x === 'string'` | What kind of value is `x` at runtime? |
| `continue` / `break` | Skip to the next loop round / leave the loop. |
| `array.filter(fn)` | Keep only items where `fn` returns `true`. |
| `array.map(fn)` | Turn every item into something else. |
| `array.some(fn)` | `true` if at least one item matches. |
| `Record<K, V>` | An object whose keys are `K` and values are `V`. |
| `x as Type` | Tell TypeScript "trust me, this is `Type`". Has no effect at runtime. |
| `private readonly x` in a constructor | Creates a field `this.x` that cannot be reassigned. |
| `/regex/` | A text pattern, used with `.match()` and `.replace()`. |

---

## 7. What still has to be connected

1. **`app.module.ts`** – must import `ConfigModule.forRoot({ load: [configuration], validate: validateEnv })` and `LLMModule`. Until then, `validateEnv` never runs in a real app.
2. **`main.ts`** – must call `NestFactory.create(AppModule)` and `app.listen(port)`.
3. **Queue and workflow** – will call `llmRouter.generate(input, { workflowId, newsId, attempt })` and use `error.retryAfterMs` to decide when to retry a failed job.
4. **Agents** – will import `LLMModule` and inject `LLMRouterService`.
