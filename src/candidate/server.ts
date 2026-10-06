import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  initApp,
  handleMessageStream,
  refreshTokenIfNeeded,
  BRIEFING_PROMPT,
  type AppState,
} from "./core.js";

const PORT = Number(process.env.WEB_PORT ?? 3002);
const __dir = dirname(fileURLToPath(import.meta.url));

// ─── App State ────────────────────────────────────────────────────────────

let state: AppState | null = null;
let ready = false;
let startupError: string | null = null;

// Boot in background so the server starts accepting connections immediately
(async () => {
  try {
    console.log("Starting up...");
    state = await initApp();
    console.log(`✓ Loaded ${state.accountCount} accounts, computed signals, fetched sentiment`);

    // Run opening briefing and seed history
    await refreshTokenIfNeeded();
    const { chat } = await import("../../lib/corti.js");
    const briefing = await chat({
      messages: [
        { role: "system", content: state.systemPrompt },
        { role: "user", content: BRIEFING_PROMPT },
      ],
      temperature: 0.3,
    });
    state.history.push(
      { role: "user", content: "Give me my morning briefing." },
      { role: "assistant", content: briefing.content }
    );

    ready = true;
    console.log(`✓ Morning briefing ready. Open http://localhost:${PORT}`);
  } catch (err) {
    startupError = err instanceof Error ? err.message : String(err);
    console.error("Startup failed:", startupError);
    console.error("Make sure the CRM is running: npm run dev");
  }
})();

// ─── Routes ───────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/", (c) => {
  const html = readFileSync(resolve(__dir, "public/index.html"), "utf8");
  return c.html(html);
});

app.get("/api/status", (c) => {
  if (startupError) return c.json({ ready: false, error: startupError }, 503);
  if (!ready || !state) return c.json({ ready: false }, 200);

  const atRiskPipeline = state.scored
    .filter((sa) => sa.score >= 30 && sa.account.opportunityAmount)
    .reduce((sum, sa) => sum + (sa.account.opportunityAmount ?? 0), 0);

  const contractsExpiringSoon = state.scored.filter(
    (sa) => sa.analytics && (
      (sa.analytics.projectedDaysToZero !== null && sa.analytics.projectedDaysToZero <= 14) ||
      (sa.analytics.daysToContractExpiry !== null && sa.analytics.daysToContractExpiry <= 14)
    )
  ).length;

  return c.json({
    ready: true,
    accountCount: state.accountCount,
    highPriorityCount: state.highPriorityCount,
    atRiskPipeline,
    contractsExpiringSoon,
  });
});

app.get("/api/accounts", (c) => {
  if (!ready || !state) return c.json({ atRisk: [], growing: [] });

  const atRisk = state.scored.slice(0, 12).map((sa) => ({
    id: sa.account.id,
    name: sa.account.name,
    stage: sa.account.stage,
    score: sa.score,
    topSignal: sa.reasons[0] ?? null,
    trend: sa.analytics?.trend ?? null,
    contractPct: sa.analytics?.contractBalancePct !== null
      ? Math.round((sa.analytics?.contractBalancePct ?? 0) * 100)
      : null,
  }));

  const growing = state.scored
    .filter((sa) => sa.analytics?.trend === "growing")
    .slice(0, 5)
    .map((sa) => ({
      id: sa.account.id,
      name: sa.account.name,
      stage: sa.account.stage,
      topSignal: sa.analytics?.transcribeTrend === "growing"
        ? "API + transcription both growing"
        : `API requests up vs prior 30d`,
      contractPct: sa.analytics?.contractBalancePct !== null
        ? Math.round((sa.analytics?.contractBalancePct ?? 0) * 100)
        : null,
    }));

  const all = state.scored.map((sa) => ({
    id: sa.account.id,
    name: sa.account.name,
    stage: sa.account.stage,
    score: sa.score,
    trend: sa.analytics?.trend ?? null,
    topSignal: sa.reasons[0] ?? null,
    contractPct: sa.analytics?.contractBalancePct !== null
      ? Math.round((sa.analytics?.contractBalancePct ?? 0) * 100)
      : null,
  }));

  return c.json({ atRisk, growing, all });
});

app.get("/api/briefing", (c) => {
  if (!ready || !state) return c.json({ ready: false, briefing: null });
  const briefingMsg = state.history.find((m) => m.role === "assistant");
  return c.json({ ready: true, briefing: briefingMsg?.content ?? null });
});

app.post("/api/chat", async (c) => {
  if (!ready || !state) return c.json({ error: "Not ready yet" }, 503);
  const body = await c.req.json<{ message: string }>();
  if (!body?.message?.trim()) return c.json({ error: "Empty message" }, 400);

  const enc = new TextEncoder();
  const snap = state; // capture so TS knows it's non-null in async scope

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        const { cleanReply, actionResult } = await handleMessageStream(
          body.message,
          snap.scored,
          snap.systemPrompt,
          snap.history,
          (token) => send({ token })
        );
        send({ done: true, cleanReply, actionResult: actionResult ?? null });
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "LLM error" });
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

serve({ fetch: app.fetch, port: PORT });
console.log(`Web server starting at http://localhost:${PORT}`);
console.log("Loading accounts and computing signals — this takes 1-2 minutes...");
