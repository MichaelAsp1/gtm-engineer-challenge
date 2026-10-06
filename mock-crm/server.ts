import { serve } from "@hono/node-server";
import { CrmDb } from "./db.ts";
import { createApp } from "./app.ts";

const db = new CrmDb();
const app = createApp(db);

const port = Number(process.env.CRM_PORT ?? 3001);
const hostname = process.env.CRM_HOST ?? "localhost";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Mock CRM API running at http://${hostname}:${info.port}`);
  console.log(`Accounts available: ${db.countAccounts()}`);
});

function shutdown() {
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
