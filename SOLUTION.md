# AE Sales Intelligence Tool — Solution

## How to run

**Terminal 1 — start the mock CRM:**
```bash
npm install
npm run dev
```

**Terminal 2 — start the tool:**
```bash
npm run challenge
```

Then just type your question. Examples:
```
what needs attention today?
which accounts are at risk of churning?
tell me about IronwoodHealth
which customers are about to run out of contract?
who should i call first?
which customers are growing?
create a task for IronwoodHealth: send expansion proposal by end of week
add a note to AspenContinuum: called Sarah, renewal confirmed, closing end of March
```

Type `exit` to quit.

**Environment:** Copy `.env.example` to `.env.local` and set:
```
CORTI_CLIENT_ID=<your client id>
CORTI_CLIENT_SECRET=<your client secret>
CORTI_BASE_URL=https://ai.eu.corti.app/v1
```

The tool handles OAuth2 token refresh automatically (Keycloak client credentials flow, tokens expire every 5 minutes).

---

## Approach

### The problem framing

An AE has 30 minutes before standup and 200 accounts. The bottleneck is not information — it's prioritisation. The tool's job is to collapse 200 accounts into a ranked, grounded action list, then let the AE drill into specifics conversationally.

### Data architecture

Two imperfect systems that need joining:

- **CRM API** — commercial context: stage, owner, opportunity value, close dates, contacts, activities
- **Analytics SQLite** — product reality: API usage volume, contract balances, alerts

The join key is `domain`. CRM accounts have a `.example` TLD (e.g. `hearthpediatrics.example`); analytics customers store the bare domain (`hearthpediatrics`). I strip the TLD to join. Where no analytics match exists, I note it explicitly rather than silently treating the account as healthy.

### Signal computation

For each account I compute 7 signals relative to a reference date (the max event date in the analytics DB — `2025-03-14`). Using the data's own reference date rather than wall-clock time ensures signals are meaningful against the synthetic dataset.

| Signal | Source | What it means |
|---|---|---|
| `usage30d` vs `usagePrev30d` | Analytics | Are API requests growing or declining? |
| `trend` | Analytics | growing / stable / declining / dark / new |
| `transcribe30d` vs `transcribePrev30d` | Analytics | Transcription volume trend — Corti's core clinical speech product |
| `transcribeTrend` | Analytics | Separate trend for speech/transcription usage |
| `tokens30d` | Analytics | Depth of LLM usage — high tokens = deep integration |
| `contractBalancePct` | Analytics | How much committed spend is left? |
| `weeklyBurnRate` + `projectedDaysToZero` | Analytics | How fast are they burning through the contract? When does it hit zero? |
| `daysToContractExpiry` | Analytics | Renewal urgency |
| `hasActiveAlerts` | Analytics | Platform has already flagged this customer |
| `daysSinceLastContact` | CRM | Are we engaged? |
| `daysToCloseDate` | CRM | Is a deal overdue or imminent? |

**Why transcription matters:** Corti's core product is clinical speech AI. A customer whose API request count is declining but transcription volume is growing is not churning — they're shifting to the speech product. Treating them the same as a fully dark account would be wrong. The tool distinguishes these cases explicitly.

### Risk scoring

Each signal contributes to a numeric urgency score (0–100+). Higher score = more urgent. Examples:
- Close date overdue: +30
- Zero API usage in 30d (dark): +30
- Usage declining >15%: +20
- Contract balance <15%: +25
- No contact in >30d: +20
- Active alerts: +15

Scores are additive and transparent — every account surfaces a `reasons` list explaining exactly why it scored the way it did.

### System prompt design

Rather than giving the LLM raw data dumps and asking it to reason from scratch, I pre-compute the signals and inject a structured, ranked summary into the system prompt:

- Book of business summary (counts by stage, total pipeline)
- Top 15 at-risk accounts with full signal detail
- Top 5 expansion candidates (growing usage + contract renewal approaching)
- Today's reference date

This grounds the LLM in verified data and prevents hallucination of signals that aren't there.

### On-demand account detail

When the AE mentions a specific account by name, I fetch its contacts, last 5 activities and opportunities from the CRM in real time and inject that context into the user message. This means the LLM has full detail for named accounts without bloating the system prompt with 200 × full account records.

### Confidence communication

The system prompt instructs the LLM to express confidence explicitly:
- **High** — data directly confirms the signal
- **Medium** — inferred from partial data
- **Low / uncertain** — analytics match not found, or conflicting signals

---

## Key assumptions

1. **PRODUCTION, non-NFR events only** — sandbox and NFR usage is filtered out when computing usage signals. Only real production consumption reflects true customer health.

2. **`request` event type as the primary usage metric** — the analytics DB has `request`, `tokens` and `transcribe` event types. I use `request` count as the primary volume signal since it's the most direct measure of active use. Token counts vary by model and input size; transcription events are a separate product motion.

3. **Domain join is reliable enough** — most accounts match. Where no match exists I flag it rather than silently skipping. A few accounts may be mislabelled or have domain mismatches; in production you'd want a proper foreign key relationship.

4. **Latest contract per customer** — where a customer has multiple contracts I take the one expiring latest. This may overstate remaining balance for customers mid-transition between contracts.

5. **Reference date = max analytics date** — the dataset ends at 2025-03-14. Using wall-clock time would make all "recent usage" windows return zero. I use the data's own reference date to keep signals meaningful.

---

## Tradeoffs

**Read-only analysis vs. CRM write-back**

The tool supports bidirectional interaction — the AE can create tasks and add notes to the CRM from natural language mid-conversation. The LLM emits a structured `[ACTION:{...}]` block when it detects write intent; the tool strips it from the displayed response, executes the CRM write, and confirms the result. This turns the tool from a read-only dashboard into something the AE actually uses to log their work.

**Pre-computed context vs. tool use / dynamic retrieval**

I chose to pre-compute all signals at startup and inject them into the system prompt rather than giving the LLM tools to query data on demand.

*Why:* More predictable, faster at query time, and directly demonstrates the signal extraction and data joining — which is the core of the challenge. Tool-calling would delegate the join logic to the LLM, which would obscure the engineering.

*Cost:* The system prompt is large (~3K tokens for 15 accounts). Scaling to 500+ accounts would require a retrieval layer (e.g. vector search or a pre-filter step).

**Terminal CLI vs. web UI**

A terminal REPL keeps the focus on the data and LLM logic rather than UI scaffolding. The challenge explicitly said frontend polish is not evaluated.

**Startup load vs. lazy fetch**

Loading all 200 accounts at startup (3 paginated CRM requests + analytics queries) takes ~2–3 seconds but means every subsequent answer is instantaneous. A lazy approach would be faster to start but slower per query.

---

## What I'd do next

**Immediate (within a sprint):**

1. **Token-level usage signals** — `tokens` events give a richer picture of how heavily customers are using the API per request. High request count + low token count may indicate shallow use; high tokens = deep integration.

2. **Activity sentiment analysis** — the CRM activity feed has meeting outcomes (`positive/neutral/negative`) and email threads. Running a quick sentiment pass over recent activities would surface accounts where the relationship is cooling even if usage looks healthy.

3. **Expansion scoring** — mirror the risk score with an expansion score: growing usage + contract >50% consumed + enterprise ICP tier = proactive upsell conversation. Surface this as a separate "growth opportunities" list.

4. **Proactive daily digest** — run the signal computation on a schedule and send the AE a Slack message at 8am with their top 5 for the day. Conversational Q&A is valuable; proactive push is better.

**With more time:**

5. **Proper domain resolution** — replace the string-strip join with a managed mapping table or CRM custom field. Catch the ~5% of accounts that fail to match today.

6. **Historical trend** — extend beyond 30d/60d windows to show whether an account's decline started last week or 3 months ago. Slope matters more than absolute level.

7. **CRM write-back** — the tool already has access to `PATCH /accounts/:id` and `POST /accounts/:id/notes`. Let the AE say "add a note: called Alex, decision pushed to Q3" and write it back to the CRM mid-conversation.

8. **Confidence calibration** — log which answers the AE acts on vs. ignores. Over time, use this signal to tune the risk score weights.
