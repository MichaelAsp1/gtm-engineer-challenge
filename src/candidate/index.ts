/**
 * GTM Engineer Challenge — AE Sales Intelligence Tool (terminal)
 *
 * Run: npm run challenge  (start mock CRM first with: npm run dev)
 */

import * as readline from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatMessage } from "../../lib/corti.js";
import { chat } from "../../lib/corti.js";
import {
  refreshTokenIfNeeded,
  initApp,
  handleMessage,
  BRIEFING_PROMPT,
  MAX_HISTORY_TURNS,
  parseAction,
  executeAction,
} from "./core.js";

export async function run(): Promise<void> {
  console.log("Starting up — this can take a minute or two while we load all accounts and compute signals.\n");

  let app;
  process.stdout.write("Loading accounts from CRM...");
  try {
    app = await initApp();
    console.log(` done (${app.accountCount} accounts)`);
  } catch (err) {
    console.error("\nCannot reach CRM API. Start it first with: npm run dev");
    return;
  }

  console.log("Computing analytics signals and activity sentiment... done");

  const { scored, systemPrompt, history } = app;

  console.log(`\n✓ Ready. ${app.highPriorityCount} accounts flagged as high-priority.\n`);
  console.log("─".repeat(60));

  // Opening briefing
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIdx = 0;
  let briefingSpinner: ReturnType<typeof setInterval> | null = null;

  process.stdout.write("\nAssistant: thinking ");
  briefingSpinner = setInterval(() => {
    process.stdout.write(`\r\x1b[2KAssistant: thinking ${spinnerFrames[spinnerIdx++ % spinnerFrames.length]}`);
  }, 80);

  try {
    await refreshTokenIfNeeded();
    const { chat: chatFn } = await import("../../lib/corti.js");
    const briefingResult = await chatFn({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: BRIEFING_PROMPT },
      ],
      temperature: 0.3,
    });
    if (briefingSpinner) clearInterval(briefingSpinner);
    process.stdout.write(`\r\x1b[2K`);
    console.log("Assistant: " + briefingResult.content);
    history.push(
      { role: "user", content: "Give me my morning briefing." },
      { role: "assistant", content: briefingResult.content }
    );
  } catch {
    if (briefingSpinner) clearInterval(briefingSpinner);
    process.stdout.write(`\r\x1b[2K`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("Ask a follow-up question, or type 'exit' to quit.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    if (!rl.terminal && process.stdin.readableEnded) { app.db.close(); rl.close(); return; }
    rl.question("\nYou: ", async (input) => {
      const question = input.trim();
      if (!question || question.toLowerCase() === "exit") {
        app.db.close();
        rl.close();
        return;
      }

      let spinner: ReturnType<typeof setInterval> | null = null;

      try {
        process.stdout.write("\nAssistant: thinking ");
        spinner = setInterval(() => {
          process.stdout.write(`\r\x1b[2KAssistant: thinking ${spinnerFrames[spinnerIdx++ % spinnerFrames.length]}`);
        }, 80);

        const { reply, actionResult } = await handleMessage(question, scored, systemPrompt, history);

        if (spinner) clearInterval(spinner);
        process.stdout.write(`\r\x1b[2K`);
        console.log("Assistant: " + reply);

        if (actionResult) console.log(`\n✓ ${actionResult}`);
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
