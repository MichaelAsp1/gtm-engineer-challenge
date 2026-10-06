import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { resolve } from "node:path";
import { createApp } from "../mock-crm/app.ts";
import { CrmDb } from "../mock-crm/db.ts";
import { chat, listModels } from "../lib/corti.ts";

const CRM_DB = resolve(import.meta.dirname, "..", "data", "crm", "crm.sqlite");
const ANALYTICS_DB = resolve(import.meta.dirname, "..", "data", "analytics", "analytics.sqlite");

describe("data sources", () => {
  test("CRM sqlite database opens and has ~200 accounts", () => {
    const crm = new Database(CRM_DB, { readonly: true });
    const count = (crm.prepare("SELECT COUNT(*) c FROM accounts").get() as { c: number }).c;
    assert.ok(count >= 195 && count <= 205, `expected ~200 accounts, got ${count}`);
    const tables = crm.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const required of ["accounts", "contacts", "activities", "opportunities", "tasks"]) {
      assert.ok(names.includes(required), `missing CRM table ${required}`);
    }
    crm.close();
  });

  test("analytics sqlite database opens and has expected core tables", () => {
    const an = new Database(ANALYTICS_DB, { readonly: true });
    const tables = an.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const required of ["customers", "projects", "usage_events", "api_keys"]) {
      assert.ok(names.includes(required), `missing analytics table ${required}`);
    }
    const customers = (an.prepare("SELECT COUNT(*) c FROM customers").get() as { c: number }).c;
    assert.ok(customers > 0, "expected some analytics customers");
    an.close();
  });
});

describe("mock CRM API", () => {
  let app: ReturnType<typeof createApp>;
  let db: CrmDb;

  beforeEach(() => {
    db = new CrmDb();
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
  });

  test("GET /accounts returns a page with metadata", async () => {
    const res = await app.request("/accounts?page=1&page_size=20");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { accounts: unknown[]; meta: { total: number; has_more: boolean } };
    assert.equal(body.accounts.length, 20);
    assert.ok(body.meta.total > 150);
    assert.equal(body.meta.has_more, true);
  });

  test("pagination advances via offset", async () => {
    const page1 = (await (await app.request("/accounts?limit=5&offset=0")).json()) as { accounts: Array<{ id: string }> };
    const page2 = (await (await app.request("/accounts?limit=5&offset=5")).json()) as { accounts: Array<{ id: string }> };
    assert.equal(page1.accounts.length, 5);
    assert.equal(page2.accounts.length, 5);
    assert.notEqual(page1.accounts[0].id, page2.accounts[0].id);
  });

  test("GET /accounts/:id returns a single account", async () => {
    const list = (await (await app.request("/accounts?limit=1")).json()) as { accounts: Array<{ id: string }> };
    const id = list.accounts[0].id;
    const res = await app.request(`/accounts/${id}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; name: string };
    assert.equal(body.id, id);
    assert.ok(body.name);
  });

  test("GET /accounts/:id returns 404 for unknown id", async () => {
    const res = await app.request("/accounts/acc_nope");
    assert.equal(res.status, 404);
  });

  test("account sub-resources respond", async () => {
    const list = (await (await app.request("/accounts?limit=1")).json()) as { accounts: Array<{ id: string }> };
    const id = list.accounts[0].id;
    for (const sub of ["contacts", "activities", "opportunities", "tasks"]) {
      const res = await app.request(`/accounts/${id}/${sub}`);
      assert.equal(res.status, 200, `${sub} should be 200`);
    }
  });
});

describe("corti client", () => {
  const realFetch = globalThis.fetch;

  function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    (globalThis as any).fetch = handler as typeof fetch;
  }
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  beforeEach(() => {
    process.env.CORTI_API_KEY = "test-key";
    process.env.CORTI_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.CORTI_DEFAULT_MODEL = "corti-s1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.CORTI_API_KEY;
  });

  test("chat uses the default model when none is specified", async () => {
    const sent: Array<Record<string, unknown>> = [];
    mockFetch(async (url, init) => {
      const payload = JSON.parse(String(init?.body));
      sent.push(payload);
      return jsonResponse({ id: "cmpl-1", model: payload.model, choices: [{ message: { content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
    });
    const result = await chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.content, "hello");
    assert.equal(sent[0].model, "corti-s1");
  });

  test("chat honours an explicit model override", async () => {
    let sentModel = "";
    mockFetch(async (url, init) => {
      sentModel = JSON.parse(String(init?.body)).model;
      return jsonResponse({ id: "cmpl-2", model: sentModel, choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
    await chat({ model: "corti-s1-mini", messages: [{ role: "user", content: "hi" }] });
    assert.equal(sentModel, "corti-s1-mini");
  });

  test("chat surfaces non-2xx errors", async () => {
    mockFetch(async () => jsonResponse({ error: { message: "bad key" } }, 401));
    await assert.rejects(() => chat({ messages: [{ role: "user", content: "hi" }] }), /401/);
  });

  test("listModels returns the model list", async () => {
    mockFetch(async () =>
      jsonResponse({ object: "list", data: [{ id: "corti-s1", object: "model", created: 1, owned_by: "Corti" }, { id: "corti-s1-mini", object: "model", created: 1, owned_by: "Corti" }] }),
    );
    const models = await listModels();
    assert.ok(Array.isArray(models));
    assert.ok(models.some((m) => m.id === "corti-s1"));
  });
});
