# AE Sales Intelligence Tool

## How to run

**Terminal 1 - start the mock CRM:**
```bash
npm install
npm run dev
```

**Terminal 2 - start the tool:**
```bash
npm run challenge
```

Then type your question. Some examples:
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

**Environment:** Copy `.env.example` to `.env.local` and fill in:
```
CORTI_CLIENT_ID=<your client id>
CORTI_CLIENT_SECRET=<your client secret>
CORTI_BASE_URL=https://ai.eu.corti.app/v1
```

The tool handles OAuth2 token refresh automatically (Keycloak client credentials flow, tokens expire every 5 minutes).

---

## Approach

### The problem framing

An AE has 30 minutes before standup and 200 accounts. The bottleneck is not information, it is prioritisation. The tool collapses 200 accounts into a ranked, grounded action list and lets the AE drill into specifics conversationally.

### Data architecture

Two imperfect systems that need joining:

- **CRM API** - commercial context: stage, owner, opportunity value, close dates, contacts, activities
- **Analytics SQLite** - product reality: API usage volume, contract balances, alerts

The join key is `domain`. CRM accounts have a `.example` TLD (e.g. `hearthpediatrics.example`); analytics customers store the bare domain (`hearthpediatrics`). Stripping the TLD makes the join work. Where no analytics match exists, the account is flagged explicitly rather than silently treated as healthy.

### Signal computation

For each account, signals are computed relative to a reference date (the max event date in the analytics DB: `2025-03-14`). Using the data's own reference date rather than wall-clock time keeps the signals meaningful against the synthetic dataset.

| Signal | Source | What it means |
|---|---|---|
| `usage30d` vs `usagePrev30d` | Analytics | Are API requests growing or declining? |
| `trend` | Analytics | growing / stable / declining / dark / new |
| `transcribe30d` vs `transcribePrev30d` | Analytics | Transcription volume trend |
| `transcribeTrend` | Analytics | Separate trend for speech/transcription usage |
| `tokens30d` | Analytics | Depth of LLM usage per session |
| `contractBalancePct` | Analytics | How much committed spend is left |
| `weeklyBurnRate` + `projectedDaysToZero` | Analytics | How fast the contract is burning and when it hits zero |
| `daysToContractExpiry` | Analytics | Renewal urgency |
| `hasActiveAlerts` | Analytics | Platform has already flagged this customer |
| `daysSinceLastContact` | CRM | Are we engaged? |
| `daysToCloseDate` | CRM | Is a deal overdue or imminent? |
| `negativeMeetings30d / 14d` | CRM activities | Are recent meetings going badly? |

**Why transcription is tracked separately:** Corti's core product is clinical speech AI. A customer whose API request count is declining but transcription volume is growing is not churning, they are shifting to the speech product. Treating them the same as a fully dark account would produce the wrong signal. The tool distinguishes these cases.

### Risk scoring

Each signal contributes to a numeric urgency score. Higher score means more urgent. Scores are additive and every account surfaces a `reasons` list explaining exactly why it scored the way it did.

Some example weights:
- Close date overdue: +30
- Zero API and transcription usage in 30d: +30
- Contract balance exhausted in under 14 days at current burn rate: +30
- Usage declining across both API and transcription: +25
- No contact in over 30 days: +20
- Negative meeting in the last 14 days: +20
- Active platform alerts: +15

After initial scoring, activities are fetched for the top 20 accounts in parallel to layer in relationship sentiment before the final sort.

### System prompt design

Rather than passing the LLM raw data and asking it to reason from scratch, signals are pre-computed and a structured, ranked summary is injected into the system prompt:

- Book of business summary (counts by stage, total pipeline)
- Top 15 at-risk accounts with full signal detail
- Top 5 expansion candidates (growing usage with contract renewal approaching)
- Reference date

This grounds the LLM in verified data and prevents hallucination of signals that are not in the data.

### On-demand account detail

When the AE mentions a specific account by name, its contacts, last 5 activities and opportunities are fetched from the CRM and injected into the user message. The LLM gets full detail for named accounts without bloating the system prompt with 200 full account records.

### CRM write-back

The tool is bidirectional. The AE can create tasks and add notes mid-conversation in plain language. The LLM emits a structured `[ACTION:{...}]` block when it detects write intent; the tool strips it from the displayed response, executes the CRM write, and confirms the result.

### Confidence communication

The system prompt instructs the LLM to state its confidence explicitly:
- **High** - data directly confirms the signal
- **Medium** - inferred from partial data
- **Low / uncertain** - no analytics match, or conflicting signals

---

## Key assumptions

1. **PRODUCTION, non-NFR events only** - sandbox and NFR usage is filtered out. Only real production consumption reflects true customer health.

2. **`request` events as the primary usage metric** - the analytics DB has `request`, `tokens` and `transcribe` event types. Request count is the most direct measure of active use. Token counts vary by model and input size; transcription events are tracked separately since they reflect a different product motion.

3. **Domain join is reliable enough** - most accounts match. Where there is no match, it is flagged rather than silently skipped. A few accounts may have domain mismatches; in production you would want a proper foreign key relationship.

4. **Latest contract per customer** - where a customer has multiple contracts, the one expiring latest is used. This may overstate remaining balance for customers mid-transition between contracts.

5. **Reference date = max analytics date** - the dataset ends at 2025-03-14. Using wall-clock time would make all recent usage windows return zero.

---

## Tradeoffs

**Pre-computed context vs. dynamic retrieval**

All signals are pre-computed at startup and injected into the system prompt rather than giving the LLM tools to query data on demand. This is more predictable, faster at query time, and keeps the join logic in code where it can be reasoned about directly. The cost is a larger system prompt (~3K tokens for 15 accounts). Scaling to 500+ accounts would need a retrieval layer.

**Terminal CLI vs. web UI**

A terminal REPL keeps the focus on the data and reasoning logic. The challenge said frontend polish is not evaluated, so time went into signal quality instead.

**Startup load vs. lazy fetch**

Loading all 200 accounts at startup takes a few seconds but means every subsequent answer is instantaneous. A lazy approach would start faster but be slower per query.

---

## What I would do next

**Short term:**

1. **Opportunity stage stagnation** - an evaluation stuck at the same stage for 45+ days is a risk signal that is not currently scored. The CRM has `lastStageChangeAt` on opportunities; this is straightforward to add.

2. **Historical trend slope** - the current signals look at 30d vs. prior 30d. Extending the window to show whether a decline started last week or three months ago would make the urgency clearer.

3. **Proactive daily digest** - run the signal computation on a schedule and push the AE their top 5 accounts at the start of the day. Conversational Q&A is useful; proactive push is better.

**Longer term:**

4. **Proper domain resolution** - replace the string-strip join with a managed mapping table or a CRM custom field. Catch the accounts that fail to match today.

5. **Confidence calibration** - log which answers the AE acts on vs. ignores and use that signal over time to tune the risk score weights.

6. **Multi-owner support** - the current tool loads the full book of business. In practice, each AE would only want their own accounts. Filtering by `ownerId` at load time would make this production-ready.
