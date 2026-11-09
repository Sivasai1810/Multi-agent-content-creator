# AI Social Content Agent

An AI-powered multi-agent system that transforms manually submitted news and X (Twitter) posts into fact-checked, researched, professionally written Instagram carousel content.

The system uses multiple specialized AI agents to verify information, gather supporting evidence, develop an editorial narrative, generate carousel slides, and evaluate content quality.

Human approval is mandatory before publishing.

## 🎯 Project Objective

Build an autonomous AI content production pipeline that:

- Accepts news articles, URLs, and X posts.
- Verifies claims using reliable sources.
- Researches relevant information from the internet.
- Creates engaging Instagram carousel scripts.
- Generates visually consistent carousel slides.
- Evaluates factual accuracy and content quality.
- Sends the final content to Telegram for human approval.
- Publishes only after explicit approval.

## 🏗️ System Architecture

```text
                Telegram
                    |
                    v
             News Submission
                    |
                    v
               Batch Service
                    |
                    v
              Redis + BullMQ
                    |
             Independent Jobs
                    |
                    v
              News Processor
                    |
                    v
             Workflow Context
                    |
                    v
             Workflow Service
                    |
        +-----------+-----------+
        |           |           |
        v           v           v
   Verification  Research   Editorial
      Agent       Agent       Agent
        |           |           |
        +-----------+-----------+
                    |
                    v
              Creative Agent
                    |
                    v
               Review Agent
                    |
                    v
             Carousel Output
                    |
                    v
           Telegram Approval
                    |
             +------+------+
             |             |
           Approve       Reject
             |
             v
       Instagram Publishing
```

## 🤖 AI Agents

| Agent | Responsibility |
|---|---|
| Verification Agent | Extract claims and verify factual accuracy. |
| Research Agent | Discover supporting articles, official sources, and evidence. |
| Editorial Agent | Create engaging narratives and slide-by-slide scripts. |
| Creative Agent | Generate Instagram carousel slides using HTML/CSS. |
| Review Agent | Evaluate factual accuracy, storytelling, readability, and design. |

## 🧠 LLM Infrastructure

The application uses a provider-independent LLM architecture.

**Provider priority:**

1. Google Gemini – Primary
2. Groq – Secondary
3. OpenRouter – Fallback

Core capabilities:

- Provider routing and fallback.
- Retry and error normalization.
- Provider health tracking.
- Request rate limiting.
- Configurable model selection.
- Structured output validation using Zod.
- Request cancellation using AbortController.

Provider quotas depend on the selected model and account limits.

## ⚙️ Technology Stack

| Category | Technologies |
|---|---|
| Backend | Node.js, NestJS, TypeScript |
| AI Models | Gemini, Groq, OpenRouter |
| Validation | Zod |
| Queue | BullMQ |
| Queue Storage | Redis |
| Database | PostgreSQL |
| ORM | Prisma |
| Carousel Generation | HTML, CSS, Playwright |
| Notifications | Telegram Bot API |
| Publishing | Instagram Graph API |

## 📁 Project Structure

```text
src/
├── config/
├── agents/
│   ├── verification/
│   ├── research/
│   ├── editorial/
│   ├── creative/
│   └── review/
│
├── orchestration/
├── llm/
│   ├── providers/
│   ├── llm.interface.ts
│   └── llm-router.service.ts
│
├── queue/
│   ├── queue.types.ts
│   ├── queue.constants.ts
│   ├── queue.module.ts
│   ├── news-queue.service.ts
│   ├── batch.service.ts
│   └── news.processor.ts
│
├── research-tools/
├── carousel/
├── telegram/
├── approval/
├── publishing/
├── database/
└── common/

prompts/
prisma/
storage/
tests/
```

## 🔄 Multi-News Processing

The application supports submitting multiple news items in a single batch.

For example, submitting 10 news items creates 10 independent jobs.

Each job maintains its own:

- `workflowId`
- `newsId`
- `batchId`
- Processing state
- Workflow context
- Agent outputs

BullMQ controls execution concurrency, while provider-specific rate limiting controls API request frequency.

One job failing must not interrupt other jobs.

## 💾 Workflow Context

Every news item maintains an independent workflow context.

The context stores:

- Original submitted content.
- Verification results.
- Research findings.
- Editorial scripts.
- Generated carousel information.
- Review results.
- Workflow status and execution metadata.

PostgreSQL is the persistent source of truth.

The workflow must support recovery after worker restarts and retries without unnecessarily repeating completed stages.

## 🔐 Human Approval

Human approval is mandatory.

The system will send the generated carousel, research evidence, editorial script, and review results through Telegram.

Available actions:

- Approve.
- Request revisions.
- Reject.

Every revision creates a new version. Publishing must verify that the exact version being published was explicitly approved.

## 📊 Implementation Status

### Completed

- [x] Environment configuration and validation.
- [x] Shared types and error handling.
- [x] Gemini, Groq, and OpenRouter integrations.
- [x] LLM provider router.
- [x] Rate limiter and provider health tracking.
- [x] Redis and BullMQ integration.
- [x] Queue types and constants.
- [x] News queue service.
- [x] Batch submission and validation.
- [x] Independent news job processing.
- [x] Retry, timeout, and cancellation handling.
- [x] Initial Prisma Workflow schema.

### In Progress

- [ ] Prisma installation and database migration.
- [ ] Persistent workflow context.
- [ ] Workflow orchestration service.

### Upcoming

- [ ] Verification Agent.
- [ ] Research Agent.
- [ ] Editorial Agent.
- [ ] Creative Agent.
- [ ] Review Agent.
- [ ] Research and source extraction tools.
- [ ] Carousel generation and rendering.
- [ ] Telegram integration.
- [ ] Approval and revision management.
- [ ] Instagram publishing integration.
- [ ] End-to-end integration testing.

## 🚀 Development Principles

1. Independent workflow per news item.
2. Provider-independent LLM architecture.
3. Persistent workflow state.
4. Retryable and recoverable job execution.
5. Structured and validated agent outputs.
6. Separation of queue execution and AI orchestration.
7. Evidence-based content generation.
8. Human approval before publishing.
9. Version-controlled content revisions.
10. Configurable infrastructure and model providers.

## 🎯 Final Vision

Build a reliable multi-agent AI content production system that transforms raw information into verified, researched, engaging, and visually appealing social media content with minimal manual effort while keeping humans in control of the final publishing decision.
