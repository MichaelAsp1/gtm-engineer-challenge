# GTM Engineer Challenge

## Scenario

Sales has 200 accounts and an AE has 30 minutes before standup.

Build a tool the AE **talks to**. They can ask whatever they want — about a
specific account, about their book of business, about what's risky or ready to
grow, about what happened last week. The tool should help them figure out what
deserves attention **today** and why.

You have access to:

- a **mock CRM API** containing commercial and account context
- an **analytics SQLite database** containing product usage and consumption data
- **Corti Models** (via `lib/corti.ts`) for reasoning and natural language

This is deliberately open-ended. There is **no prescribed number of accounts**,
**no required output shape**, and **no single correct answer**. You decide what
is relevant, how much of the data you explore, and how the AE experiences the
tool. The AE should be able to converse with it, but the form is your choice —
a terminal app, a web page, an HTTP endpoint, or something else. How you build
it, what you surface, and how you ground answers in the data is up to you.

## Time expectation

Please **Do not spend more than 3 hours.** on this exercise.

We do not expect a production-ready system.

Prioritise the parts you think matter most.

If you run out of time, leave notes explaining what you would do next and why.

## What we care about

We are interested in:

- how you interpret the problem and decide what is relevant
- which signals you consider useful, and how you find them in the data
- how you join imperfect data across systems
- how your tool helps an AE act — and how confident it is
- how you give an LLM useful, accurate context rather than letting it guess
- how you communicate confidence and uncertainty
- how easy your solution is to understand and extend

We are **not** evaluating frontend/UI polish.

## Getting started

```bash
unzip gtm-engineer-challenge.zip
cd gtm-engineer-challenge
npm install
```

Configure the environment. Copy the template and add the Corti Models API key
you were provided (see the Corti Models section below):

```bash
cp .env.example .env.local
# then edit .env.local and set CORTI_API_KEY=<your provided key>
```

Start the mock CRM API in one terminal:

```bash
npm run dev
```

The CRM API runs at `http://localhost:3001`. There is no database setup step — the SQLite databases are provided with the challenge.

A minimal starter is provided. It opens both data sources and runs a trivial no-op (you decide how the AE talks to your tool):

```bash
npm run challenge
```

## What you have access to

### Mock CRM API (`http://localhost:3001`)

A read-mostly HTTP API over the CRM data. Interact with the CRM through the HTTP API (this boundary is intentional).

**See [`CRM_DOCS.md`](./CRM_DOCS.md) for the full API reference** — every
endpoint, query parameter, and response shape, with examples.

Note that some optional fields may be missing, collection endpoints are paginated, and requests can fail with standard HTTP errors.

| Method | Endpoint | Notes |
| ------ | -------- | ----- |
| `GET` | `/accounts` | Paginated. Use `page`/`page_size` or `limit`/`offset` |
| `GET` | `/accounts/:id` | Single account |
| `GET` | `/accounts/:id/contacts` | Paginated |
| `GET` | `/accounts/:id/activities` | Paginated, newest first |
| `GET` | `/accounts/:id/opportunities` | |
| `GET` | `/accounts/:id/tasks` | Paginated |
| `PATCH` | `/accounts/:id` | Update fields (in-memory) |
| `POST` | `/accounts/:id/notes` | Add a note |
| `POST` | `/tasks` | Create a task |

`GET /accounts` returns:

```json
{
  "accounts": [ ... ],
  "meta": { "total": 200, "page": 1, "page_size": 20, "has_more": true, "next_offset": 20 }
}
```

The server source is in `mock-crm/` if you want to understand the schema.

### Analytics database (`data/analytics/analytics.sqlite`)

A SQLite database you can query directly (for example with `better-sqlite3`). It contains product usage and consumption data. Open it read-only:

```ts
import Database from "better-sqlite3";
const db = new Database("data/analytics/analytics.sqlite", { readonly: true });
```

`node_modules/.bin/sqlite3` is not bundled, but you can use any SQLite client. The tables are described by no single precomputed "score" — meaningful dimensions are for you to explore and derive.

### Corti Models

You have been provided with a Corti Models API key for this exercise.

Add it to `.env.local` (see Getting started):

```bash
# .env.local
CORTI_API_KEY=<your provided key>
```

The `challenge`, `dev` and `test` scripts load `.env.local` automatically when
it exists (via Node's `--env-file-if-exists` flag), so no extra step is needed
at runtime.

A small client for the Corti Models API is available in `lib/corti.ts`.

You can list the models available to your key and specify a model when making a completion request.

If no model is specified, the client uses a default model.

## Deliverables

Please:

1. implement your solution — a conversational AE-facing tool
2. provide a simple command for running it
3. document:
   - your approach
   - key assumptions
   - important tradeoffs
   - what you would do next with more time
4. commit your completed solution to a **public Git repository**
5. send us the public repository URL

The AE should be able to start your tool and have a conversation that helps them
decide what deserves attention today. There is **no prescribed output shape** —
the value is in what the tool communicates and how confidently, accurately, and
usefully it does so. Whatever you surface should ultimately be grounded in the
supplied data, and where you are uncertain, say so.

## Notes

- The data is entirely synthetic: company names and domains are fictional (`.example`), and no real customer, billing, or credential data is present.
- There is **no single "correct" answer** and no fixed number of accounts to surface. Prioritisation frameworks, what counts as relevant, and how the AE experiences the tool are open to your judgement.
- You are expected to use your agentic tooling of choice to complete the task and build, run, and reason about your solution. This is a normal, expected workflow for this exercise.
- Where your solution uses an LLM **within the AE-facing tool itself**, use only the provided **Corti Models** (via `lib/corti.ts`) — not third-party/hosted models. The choice of model, how you give it context, and what you prompt it with is otherwise up to you, and you may combine it with deterministic code wherever you think it helps.
