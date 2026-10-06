/**
 * GTM Engineer Challenge — AE Sales Intelligence Tool
 *
 * A conversational terminal tool that helps an AE decide what deserves
 * attention today across their 200-account book of business.
 *
 * Architecture:
 *  1. On startup: load all accounts from CRM + compute analytics signals
 *  2. Pre-rank accounts by urgency (risk score)
 *  3. Build a rich system prompt grounded in real data
 *  4. Run a readline chat loop — AE asks, LLM answers from grounded context
 *
 * For specific account questions, we inject full detail (contacts, recent
 * activities, opportunities) into the user message before sending to the LLM.
 *
 * Run: npm run challenge  (starts mock CRM first with: npm run dev)
 */

import Database from "better-sqlite3";
import * as readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "../../lib/corti.js";
import type { ChatMessage } from "../../lib/corti.js";

// ─── Config ────────────────────────────────────────────────────────────────

const CRM_BASE = process.env.CRM_BASE_URL ?? "http://localhost:3001";

// ─── OAuth2 Token Management ───────────────────────────────────────────────
// Corti uses Keycloak OAuth2 client credentials. Token expires every 5 minutes.
// We refresh proactively and patch process.env.CORTI_API_KEY so lib/corti.ts
// always picks up a valid token.

const OAUTH_TOKEN_URL = "https://auth.eu.corti.app/realms/base/protocol/openid-connect/token";
let tokenExpiresAt = 0;

async function refreshTokenIfNeeded(): Promise<void> {
  if (Date.now() < tokenExpiresAt - 30_000) return; // 30s buffer

  const clientId = process.env.CORTI_CLIENT_ID;
  const clientSecret = process.env.CORTI_CLIENT_SECRET;
  if (!clientId || !clientSecret) return; // fall through to static CORTI_API_KEY

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: HTTP ${res.status}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  process.env.CORTI_API_KEY = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
}
const ANALYTICS_PATH =
  process.env.ANALYTICS_DB ??
  resolve(fileURLToPath(new URL("../..", import.meta.url)), "data/analytics/analytics.sqlite");

// Reference date: use max event date from analytics so signals are meaningful.
// The analytics data runs through 2025-03-14, which is "today" in this dataset.
const REF_DATE_STR = "2025-03-14";
const REF_DATE = new Date(REF_DATE_STR);

// ─── CRM Types ─────────────────────────────────────────────────────────────

interface Account {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  ownerId?: string;
  stage: string;
  lastContactAt?: string;
  nextStep?: string;
  opportunityAmount?: number;
  closeDate?: string;
  icpTier?: string;
  createdAt: string;
}

interface Contact {
  id: string;
  name: string;
  title?: string;
  persona?: string;
  lastContactedAt?: string;
}

interface Activity {
  id: string;
  type: string;
  timestamp: string;
  direction?: string;
  subject?: string;
  outcome?: string;
  text?: string;
  contactIds?: string[];
  from?: string;
  to?: string;
}

interface Opportunity {
  id: string;
  name: string;
  stage: string;
  value?: number;
  closeDate?: string;
  status: string;
  nextStep?: string;
  lastStageChangeAt?: string;
}

// ─── Analytics Signal Types ────────────────────────────────────────────────

interface AnalyticsSignal {
  customerId: string;
  // API request signals
  usage7d: number;
  usage30d: number;
  usagePrev30d: number;
  trend: "growing" | "stable" | "declining" | "dark" | "new";
  // Transcription signals (Corti's core clinical speech product)
  transcribe30d: number;
  transcribePrev30d: number;
  transcribeTrend: "growing" | "stable" | "declining" | "dark" | "new";
  // Token consumption (depth of usage per request)
  tokens30d: number;
  // Contract signals
  contractBalancePct: number | null;
  contractBalance: number | null;
  contractAmount: number | null;
  daysToContractExpiry: number | null;
  contractEndsAt: string | null;
  // Burn rate: estimated weekly credit spend, projected days to zero
  weeklyBurnRate: number | null;
  projectedDaysToZero: number | null;
  hasActiveAlerts: boolean;
  topAgent: string | null;
}

// Maximum turns to keep in conversation history (older turns are dropped).
// Prevents context window overflow on long sessions.
const MAX_HISTORY_TURNS = 10;

interface ActivitySentiment {
  negativeMeetings30d: number;   // meetings with outcome="negative" in last 30d
  negativeMeetings14d: number;   // subset in last 14d — more urgent
  lastNegativeOutcomeAt: string | null; // ISO timestamp of most recent negative meeting
}

interface ScoredAccount {
  account: Account;
  analytics: AnalyticsSignal | null;
  sentiment: ActivitySentiment | null;
  score: number;
  reasons: string[];
}

// ─── CRM Fetch Helpers ─────────────────────────────────────────────────────

async function crmGet<T>(path: string): Promise<T> {
  const res = await fetch(`${CRM_BASE}${path}`);
  if (!res.ok) throw new Error(`CRM ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function loadAllAccounts(): Promise<Account[]> {
  const accounts: Account[] = [];
  let offset = 0;
  while (true) {
    const data = await crmGet<{ accounts: Account[]; meta: { has_more: boolean; next_offset: number } }>(
      `/accounts?limit=100&offset=${offset}`
    );
    accounts.push(...data.accounts);
    if (!data.meta.has_more) break;
    offset = data.meta.next_offset;
  }
  return accounts;
}

async function loadAccountDetail(id: string): Promise<{
  contacts: Contact[];
  activities: Activity[];
  opportunities: Opportunity[];
}> {
  const [contactsData, activitiesData, oppsData] = await Promise.all([
    crmGet<{ contacts: Contact[] }>(`/accounts/${id}/contacts?limit=10`),
    crmGet<{ activities: Activity[] }>(`/accounts/${id}/activities?limit=10`),
    crmGet<{ opportunities: Opportunity[] }>(`/accounts/${id}/opportunities`),
  ]);
  return {
    contacts: contactsData.contacts,
    activities: activitiesData.activities,
    opportunities: oppsData.opportunities,
  };
}

async function loadActivitySentiment(accountId: string): Promise<ActivitySentiment> {
  const empty: ActivitySentiment = { negativeMeetings30d: 0, negativeMeetings14d: 0, lastNegativeOutcomeAt: null };
  try {
    // Fetch enough activities to cover 30 days — newest first
    const data = await crmGet<{ activities: Activity[] }>(`/accounts/${accountId}/activities?limit=50`);
    const d30 = daysBefore(REF_DATE, 30);
    const d14 = daysBefore(REF_DATE, 14);

    const negatives = data.activities.filter(
      (a) => a.type === "meeting" && a.outcome === "negative" && a.timestamp >= d30
    );

    return {
      negativeMeetings30d: negatives.length,
      negativeMeetings14d: negatives.filter((a) => a.timestamp >= d14).length,
      lastNegativeOutcomeAt: negatives[0]?.timestamp ?? null,
    };
  } catch {
    return empty;
  }
}

// ─── Analytics Query Helpers ───────────────────────────────────────────────

function daysBefore(refDate: Date, days: number): string {
  const d = new Date(refDate.getTime() - days * 86_400_000);
  return d.toISOString().split("T")[0];
}

function computeAnalyticsSignal(db: Database.Database, domain: string | undefined): AnalyticsSignal | null {
  if (!domain) return null;

  // Strip .example TLD — analytics domain field has no TLD
  const normalizedDomain = domain.replace(/\.example$/, "");

  const customer = db
    .prepare("SELECT * FROM customers WHERE domain = ? AND archived_at IS NULL LIMIT 1")
    .get(normalizedDomain) as { id: string } | undefined;

  if (!customer) return null;

  const d7 = daysBefore(REF_DATE, 7);
  const d30 = daysBefore(REF_DATE, 30);
  const d60 = daysBefore(REF_DATE, 60);

  const eventQuery = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) as total
     FROM usage_events
     WHERE customer_id = ? AND is_nfr = 0 AND environment_type = 'PRODUCTION'
       AND event_type = ? AND event_date >= ? AND event_date <= ?`
  );

  // API request signals
  const usage7d = (eventQuery.get(customer.id, "request", d7, REF_DATE_STR) as { total: number }).total;
  const usage30d = (eventQuery.get(customer.id, "request", d30, REF_DATE_STR) as { total: number }).total;
  const usagePrev30d = (eventQuery.get(customer.id, "request", d60, daysBefore(REF_DATE, 1)) as { total: number }).total;

  // Transcription signals — Corti's core clinical speech product
  const transcribe30d = (eventQuery.get(customer.id, "transcribe", d30, REF_DATE_STR) as { total: number }).total;
  const transcribePrev30d = (eventQuery.get(customer.id, "transcribe", d60, daysBefore(REF_DATE, 1)) as { total: number }).total;

  // Token consumption — depth of LLM usage per session
  const tokens30d = (eventQuery.get(customer.id, "tokens", d30, REF_DATE_STR) as { total: number }).total;

  const calcTrend = (current: number, prior: number): AnalyticsSignal["trend"] => {
    if (current === 0) return "dark";
    if (prior === 0) return "new";
    if (current > prior * 1.15) return "growing";
    if (current < prior * 0.85) return "declining";
    return "stable";
  };

  const trend = calcTrend(usage30d, usagePrev30d);
  const transcribeTrend = calcTrend(transcribe30d, transcribePrev30d);

  // Contract
  const contract = db
    .prepare("SELECT * FROM contracts WHERE customer_id = ? ORDER BY ending_before DESC LIMIT 1")
    .get(customer.id) as { balance: number; amount: number; ending_before: string; starting_at: string } | undefined;

  const contractBalancePct = contract ? contract.balance / contract.amount : null;
  const daysToExpiry = contract
    ? Math.ceil((new Date(contract.ending_before).getTime() - REF_DATE.getTime()) / 86_400_000)
    : null;

  // Burn rate: estimate weekly credit consumption from contract start → now
  // then project days until balance hits zero at that rate
  let weeklyBurnRate: number | null = null;
  let projectedDaysToZero: number | null = null;
  if (contract) {
    const contractStartDate = new Date(contract.starting_at);
    const weeksElapsed = (REF_DATE.getTime() - contractStartDate.getTime()) / (7 * 86_400_000);
    const totalConsumed = contract.amount - contract.balance;
    if (weeksElapsed > 0 && totalConsumed > 0) {
      weeklyBurnRate = totalConsumed / weeksElapsed;
      projectedDaysToZero = weeklyBurnRate > 0
        ? Math.ceil((contract.balance / weeklyBurnRate) * 7)
        : null;
    }
  }

  // Alerts
  const alerts = db
    .prepare(
      "SELECT * FROM customer_alert_history WHERE customer_id = ? AND alert_status = 'triggered' ORDER BY created_at DESC LIMIT 1"
    )
    .all(customer.id) as unknown[];

  // Top agent used
  const topAgentRow = db
    .prepare(
      `SELECT agent_used FROM usage_events WHERE customer_id = ? AND agent_used != ''
       GROUP BY agent_used ORDER BY COUNT(*) DESC LIMIT 1`
    )
    .get(customer.id) as { agent_used: string } | undefined;

  return {
    customerId: customer.id,
    usage7d,
    usage30d,
    usagePrev30d,
    trend,
    transcribe30d,
    transcribePrev30d,
    transcribeTrend,
    tokens30d,
    contractBalancePct,
    contractBalance: contract?.balance ?? null,
    contractAmount: contract?.amount ?? null,
    daysToContractExpiry: daysToExpiry,
    contractEndsAt: contract?.ending_before ?? null,
    weeklyBurnRate,
    projectedDaysToZero,
    hasActiveAlerts: alerts.length > 0,
    topAgent: topAgentRow?.agent_used ?? null,
  };
}

// ─── Risk Scoring ──────────────────────────────────────────────────────────

function scoreSentiment(sentiment: ActivitySentiment | null): { score: number; reasons: string[] } {
  if (!sentiment) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 0;
  if (sentiment.negativeMeetings14d > 0) {
    score += 20;
    reasons.push(`${sentiment.negativeMeetings14d} negative meeting(s) in last 14d`);
  } else if (sentiment.negativeMeetings30d > 0) {
    score += 10;
    reasons.push(`${sentiment.negativeMeetings30d} negative meeting(s) in last 30d`);
  }
  return { score, reasons };
}

function scoreAccount(account: Account, analytics: AnalyticsSignal | null, sentiment: ActivitySentiment | null): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // --- CRM signals ---
  if (account.closeDate) {
    const daysToClose = Math.ceil((new Date(account.closeDate).getTime() - REF_DATE.getTime()) / 86_400_000);
    if (daysToClose < 0) { score += 30; reasons.push(`Close date overdue by ${-daysToClose}d`); }
    else if (daysToClose <= 7) { score += 25; reasons.push(`Close date in ${daysToClose}d`); }
    else if (daysToClose <= 14) { score += 15; reasons.push(`Close date in ${daysToClose}d`); }
  }

  if (account.lastContactAt) {
    const daysSince = Math.ceil((REF_DATE.getTime() - new Date(account.lastContactAt).getTime()) / 86_400_000);
    if (daysSince > 30) { score += 20; reasons.push(`No contact in ${daysSince}d`); }
    else if (daysSince > 14) { score += 10; reasons.push(`No contact in ${daysSince}d`); }
  } else if (account.stage !== "closed_lost") {
    score += 10;
    reasons.push("No contact on record");
  }

  // Active prospects/evaluations are time-sensitive
  if (account.stage === "evaluation") score += 5;
  if (account.stage === "mvp") score += 5;

  // ICP enterprise accounts weighted higher
  if (account.icpTier === "enterprise") score += 5;

  // --- Analytics signals ---
  if (analytics) {
    // Request trend — but check transcribe before penalising a "declining" account
    if (analytics.trend === "dark" && analytics.transcribeTrend === "dark") {
      score += 30; reasons.push("Zero API + transcription usage in last 30d");
    } else if (analytics.trend === "dark" && analytics.transcribeTrend !== "dark") {
      score += 10; reasons.push("No API requests but still transcribing — usage shifting to speech");
    } else if (analytics.trend === "declining" && analytics.transcribeTrend === "declining") {
      score += 25; reasons.push(`Both API requests AND transcription declining`);
    } else if (analytics.trend === "declining" && analytics.transcribeTrend !== "declining") {
      score += 10; reasons.push(`API requests declining but transcription ${analytics.transcribeTrend} — mixed signals`);
    }

    // Burn rate — projected days to zero is more actionable than balance %
    if (analytics.projectedDaysToZero !== null && analytics.projectedDaysToZero <= 14) {
      score += 30; reasons.push(`Contract exhausts in ~${analytics.projectedDaysToZero}d at current burn rate`);
    } else if (analytics.projectedDaysToZero !== null && analytics.projectedDaysToZero <= 30) {
      score += 20; reasons.push(`Contract exhausts in ~${analytics.projectedDaysToZero}d at current burn rate`);
    } else if (analytics.contractBalancePct !== null && analytics.contractBalancePct < 0.15) {
      score += 15; reasons.push(`Contract balance critical: ${Math.round(analytics.contractBalancePct * 100)}% remaining`);
    } else if (analytics.contractBalancePct !== null && analytics.contractBalancePct < 0.3) {
      score += 8; reasons.push(`Contract balance low: ${Math.round(analytics.contractBalancePct * 100)}% remaining`);
    }

    if (analytics.daysToContractExpiry !== null && analytics.daysToContractExpiry <= 30) {
      score += 15; reasons.push(`Contract expires in ${analytics.daysToContractExpiry}d`);
    } else if (analytics.daysToContractExpiry !== null && analytics.daysToContractExpiry <= 60) {
      score += 8; reasons.push(`Contract expires in ${analytics.daysToContractExpiry}d`);
    }

    if (analytics.hasActiveAlerts) { score += 15; reasons.push("Active platform alerts"); }
  } else if (account.stage === "customer") {
    score += 5;
    reasons.push("Customer with no analytics match (domain mismatch?)");
  }

  return { score, reasons };
}

// ─── Prompt Builder ────────────────────────────────────────────────────────

function fmtUsage(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtAccount(sa: ScoredAccount, rank: number): string {
  const { account: a, analytics: an, reasons } = sa;
  const lines: string[] = [
    `${rank}. ${a.name} [id:${a.id}] [${a.stage}] (ICP: ${a.icpTier ?? "unknown"}, ${a.industry ?? "unknown industry"})`,
  ];
  if (a.opportunityAmount) lines.push(`   Opportunity: $${a.opportunityAmount.toLocaleString()} — close ${a.closeDate ?? "no date"}`);
  if (a.lastContactAt) {
    const days = Math.ceil((REF_DATE.getTime() - new Date(a.lastContactAt).getTime()) / 86_400_000);
    lines.push(`   Last contact: ${days}d ago`);
  }
  if (a.nextStep) lines.push(`   Next step: ${a.nextStep}`);
  if (an) {
    lines.push(`   API requests (30d/prev): ${fmtUsage(an.usage30d)} / ${fmtUsage(an.usagePrev30d)} — trend: ${an.trend}`);
    if (an.transcribe30d > 0 || an.transcribePrev30d > 0) {
      lines.push(`   Transcription (30d/prev): ${fmtUsage(an.transcribe30d)} / ${fmtUsage(an.transcribePrev30d)} — trend: ${an.transcribeTrend}`);
    }
    if (an.tokens30d > 0) lines.push(`   Token events (30d): ${fmtUsage(an.tokens30d)}`);
    if (an.contractBalancePct !== null) {
      const burnStr = an.projectedDaysToZero !== null
        ? `, ~${an.projectedDaysToZero}d to exhaustion at current burn`
        : "";
      lines.push(`   Contract: ${Math.round(an.contractBalancePct * 100)}% balance remaining${burnStr}, expires ${an.contractEndsAt?.split("T")[0]}`);
    }
    if (an.topAgent) lines.push(`   Primary agent: ${an.topAgent}`);
  }
  if (sa.sentiment && sa.sentiment.negativeMeetings30d > 0) {
    const recency = sa.sentiment.negativeMeetings14d > 0 ? "last 14d" : "last 30d";
    lines.push(`   Relationship: ${sa.sentiment.negativeMeetings30d} negative meeting(s) in ${recency}`);
  }
  if (reasons.length) lines.push(`   ⚠ Signals: ${reasons.join(" | ")}`);
  return lines.join("\n");
}

function buildSystemPrompt(scored: ScoredAccount[]): string {
  const byStage = (s: string) => scored.filter((x) => x.account.stage === s);
  const customers = byStage("customer");
  const evaluations = byStage("evaluation");
  const prospects = byStage("prospect");
  const mvp = byStage("mvp");

  const totalPipeline = scored
    .filter((x) => x.account.opportunityAmount)
    .reduce((s, x) => s + (x.account.opportunityAmount ?? 0), 0);

  const atRisk = scored.filter((x) => x.score >= 30).slice(0, 15);
  const expansionCandidates = scored
    .filter((x) => x.analytics?.trend === "growing" && x.analytics.contractBalancePct !== null && x.analytics.contractBalancePct < 0.4)
    .slice(0, 5);

  return `You are an AI sales intelligence assistant helping an Account Executive prioritise their day.

REFERENCE DATE: ${REF_DATE_STR} (all signals are computed relative to this date)
You have access to data from a CRM (accounts, contacts, activities, opportunities, tasks) and a product analytics database (API usage, contract balances, alerts).

BOOK OF BUSINESS SUMMARY (200 accounts total):
- Customers: ${customers.length}
- Evaluations / pilots: ${evaluations.length}
- Prospects: ${prospects.length}
- MVP / early stage: ${mvp.length}
- Total open pipeline: $${totalPipeline.toLocaleString()}

TOP ACCOUNTS NEEDING ATTENTION TODAY (ranked by urgency score):
${atRisk.map((sa, i) => fmtAccount(sa, i + 1)).join("\n\n")}

EXPANSION OPPORTUNITIES (customers with growing usage + contract renewal approaching):
${expansionCandidates.length > 0
  ? expansionCandidates.map((sa, i) => fmtAccount(sa, i + 1)).join("\n\n")
  : "None identified in current data"}

HOW TO ANSWER:
- Ground every answer in the data above. Do not invent signals.
- When you are uncertain (e.g. no analytics match for an account), say so explicitly.
- For specific account questions, use the account detail injected in the user message.
- Be direct and actionable: the AE has 30 minutes before standup.
- Lead with the most important thing. Use short lists, not paragraphs.
- State your confidence where it matters: high (data confirms), medium (inferred), low (limited data).

CRM WRITE-BACK:
When the AE explicitly asks to create a task, set a reminder, or log/add a note to an account, include an ACTION block at the very end of your response in this exact format (no extra text after it):

For a task:
[ACTION:{"type":"task","accountId":"<id>","accountName":"<name>","title":"<task title>","dueDate":"<YYYY-MM-DD or null>"}]

For a note:
[ACTION:{"type":"note","accountId":"<id>","accountName":"<name>","text":"<note text>"}]

Only include an ACTION block when the AE explicitly asks to create or log something. Use the account id from the data above. If you cannot match an account, do not include the ACTION block and say so.`;
}

// ─── CRM Write-back ────────────────────────────────────────────────────────

interface CrmAction {
  type: "task" | "note";
  accountId: string;
  accountName: string;
  title?: string;
  dueDate?: string | null;
  text?: string;
}

function parseAction(reply: string): { cleanReply: string; action: CrmAction | null } {
  const match = reply.match(/\[ACTION:(\{.*?\})\]/s);
  if (!match) return { cleanReply: reply, action: null };
  try {
    const action = JSON.parse(match[1]) as CrmAction;
    const cleanReply = reply.replace(match[0], "").trimEnd();
    return { cleanReply, action };
  } catch {
    return { cleanReply: reply, action: null };
  }
}

async function executeAction(action: CrmAction): Promise<string> {
  if (action.type === "note") {
    const res = await fetch(`${CRM_BASE}/accounts/${action.accountId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: action.text ?? "" }),
    });
    if (!res.ok) throw new Error(`CRM note failed: HTTP ${res.status}`);
    return `✓ Note added to ${action.accountName}: "${action.text}"`;
  }

  if (action.type === "task") {
    const body: Record<string, string> = { accountId: action.accountId, title: action.title ?? "Follow up" };
    if (action.dueDate) body.dueDate = action.dueDate;
    const res = await fetch(`${CRM_BASE}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`CRM task failed: HTTP ${res.status}`);
    const data = await res.json() as { task: { id: string; dueDate?: string } };
    return `✓ Task created for ${action.accountName}: "${action.title}"${data.task.dueDate ? ` — due ${data.task.dueDate}` : ""}`;
  }

  return "Unknown action type";
}

// ─── Main Chat Loop ────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  console.log("Starting up — this can take a minute or two while we load all accounts and compute signals.\n");

  await refreshTokenIfNeeded();

  const db = new Database(ANALYTICS_PATH, { readonly: true });

  let accounts: Account[];
  process.stdout.write("Loading accounts from CRM...");
  try {
    accounts = await loadAllAccounts();
    console.log(` done (${accounts.length} accounts)`);
  } catch (err) {
    console.error("\nCannot reach CRM API. Start it first with: npm run dev");
    db.close();
    return;
  }

  process.stdout.write("Computing analytics signals and activity sentiment...");

  const scored: ScoredAccount[] = accounts.map((account) => {
    const analytics = computeAnalyticsSignal(db, account.domain);
    const { score, reasons } = scoreAccount(account, analytics, null);
    return { account, analytics, sentiment: null, score, reasons };
  });

  scored.sort((a, b) => b.score - a.score);

  // Fetch activity sentiment for top 20 at-risk accounts in parallel.
  // We only do this for the accounts that actually matter to keep startup fast.
  const sentimentTargets = scored.slice(0, 20);
  const sentiments = await Promise.all(
    sentimentTargets.map((sa) => loadActivitySentiment(sa.account.id))
  );
  sentimentTargets.forEach((sa, i) => {
    sa.sentiment = sentiments[i];
    const sentimentScore = scoreSentiment(sentiments[i]);
    sa.score += sentimentScore.score;
    sa.reasons.push(...sentimentScore.reasons);
  });
  scored.sort((a, b) => b.score - a.score);
  console.log(" done");

  const systemPrompt = buildSystemPrompt(scored);
  const history: ChatMessage[] = [];

  console.log(`\n✓ Ready. ${scored.filter((x) => x.score >= 30).length} accounts flagged as high-priority.\n`);
  console.log("AE Sales Assistant — type your question, or 'exit' to quit.\n");
  console.log("─".repeat(60));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    if (!rl.terminal && process.stdin.readableEnded) { db.close(); rl.close(); return; }
    rl.question("\nYou: ", async (input) => {
      const question = input.trim();
      if (!question || question.toLowerCase() === "exit") {
        db.close();
        rl.close();
        return;
      }

      // Check if the question mentions a specific account name
      let contextInjection = "";
      const mentionedAccount = scored.find((sa) => {
        const q = question.toLowerCase();
        return (
          q.includes(sa.account.name.toLowerCase()) ||
          (sa.account.domain && q.includes(sa.account.domain.replace(".example", "").toLowerCase()))
        );
      });

      if (mentionedAccount) {
        try {
          const detail = await loadAccountDetail(mentionedAccount.account.id);
          const contactSummary = detail.contacts
            .map((c) => `${c.name} (${c.title ?? "unknown title"}, ${c.persona ?? "unknown persona"})`)
            .join(", ");
          const recentActivities = detail.activities.slice(0, 5)
            .map((a) => {
              const d = a.timestamp.split("T")[0];
              if (a.type === "meeting") return `${d}: Meeting — outcome: ${a.outcome ?? "unknown"}`;
              if (a.type === "email") return `${d}: Email (${a.direction}) — ${a.subject ?? "no subject"}`;
              if (a.type === "stage_change") return `${d}: Stage change → ${a.to ?? "?"}`;
              if (a.type === "note") return `${d}: Note — ${a.text?.slice(0, 80) ?? ""}`;
              return `${d}: ${a.type}`;
            })
            .join("\n");
          const opps = detail.opportunities
            .map((o) => `${o.name} [${o.stage}] $${o.value?.toLocaleString() ?? "?"} — close ${o.closeDate ?? "?"}`)
            .join(", ");

          contextInjection = `\n\n[ACCOUNT DETAIL: ${mentionedAccount.account.name} id:${mentionedAccount.account.id}]
Contacts: ${contactSummary || "none found"}
Recent activities:\n${recentActivities || "none"}
Opportunities: ${opps || "none"}`;
        } catch {
          // detail fetch failed — proceed without it
        }
      }

      const userMessage = question + contextInjection;
      history.push({ role: "user", content: userMessage });

      const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
      let spinnerIdx = 0;
      let spinner: ReturnType<typeof setInterval> | null = null;

      try {
        await refreshTokenIfNeeded();

        process.stdout.write("\nAssistant: thinking ");
        spinner = setInterval(() => {
          process.stdout.write(`\r\x1b[2KAssistant: thinking ${spinnerFrames[spinnerIdx++ % spinnerFrames.length]}`);
        }, 80);

        // Trim to last MAX_HISTORY_TURNS exchanges (2 messages each) to prevent context overflow
        const trimmedHistory = history.slice(-(MAX_HISTORY_TURNS * 2));
        const result = await chat({
          messages: [{ role: "system", content: systemPrompt }, ...trimmedHistory],
          temperature: 0.3,
        });
        if (spinner) clearInterval(spinner);
        process.stdout.write(`\r\x1b[2K`);

        const { cleanReply, action } = parseAction(result.content);
        console.log("Assistant: " + cleanReply);

        // Execute CRM write-back if the LLM detected intent
        if (action) {
          try {
            const confirmation = await executeAction(action);
            console.log(`\n${confirmation}`);
          } catch (err) {
            console.error(`\n✗ CRM write failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        history.push({ role: "assistant", content: cleanReply });
      } catch (err) {
        if (spinner) clearInterval(spinner);
        process.stdout.write(`\r\x1b[2K`);
        console.error("Error:", err instanceof Error ? err.message : err);
      }

      ask();
    });
  };

  ask();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
