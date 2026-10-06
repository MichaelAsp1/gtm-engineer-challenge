import { Hono } from "hono";
import { z } from "zod";
import { CrmDb } from "./db.ts";

const MAX_PAGE_SIZE = 100;

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(20),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function parsePagination(query: Record<string, string | undefined>) {
  const p = pageQuery.parse(query);
  const limit = p.limit ?? p.page_size;
  const offset = p.offset ?? (p.page - 1) * limit;
  return { limit, offset };
}

function pageMeta(len: number, limit: number, offset: number, total: number) {
  const page = Math.floor(offset / limit) + 1;
  const hasMore = offset + len < total;
  return { total, page, page_size: limit, has_more: hasMore, next_offset: hasMore ? offset + len : null };
}

export type { Hono };
export type App = ReturnType<typeof createApp>;

export function createApp(db: CrmDb) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/accounts", (c) => {
    let limit: number, offset: number;
    try {
      ({ limit, offset } = parsePagination(c.req.query()));
    } catch {
      return c.json({ error: "Invalid pagination parameters" }, 400);
    }
    const accounts = db.listAccounts({ offset, limit });
    const total = db.countAccounts();
    return c.json({ accounts, meta: pageMeta(accounts.length, limit, offset, total) });
  });

  app.get("/accounts/:id", (c) => {
    const account = db.getAccount(c.req.param("id"));
    if (!account) return c.json({ error: "Account not found" }, 404);
    return c.json(account);
  });

  app.get("/accounts/:id/contacts", (c) => {
    const acc = db.getAccount(c.req.param("id"));
    if (!acc) return c.json({ error: "Account not found" }, 404);
    let limit: number, offset: number;
    try {
      ({ limit, offset } = parsePagination(c.req.query()));
    } catch {
      return c.json({ error: "Invalid pagination parameters" }, 400);
    }
    const contacts = db.listContacts(acc.id, { offset, limit });
    const total = db.countContacts(acc.id);
    return c.json({ contacts, meta: pageMeta(contacts.length, limit, offset, total) });
  });

  app.get("/accounts/:id/activities", (c) => {
    const acc = db.getAccount(c.req.param("id"));
    if (!acc) return c.json({ error: "Account not found" }, 404);
    let limit: number, offset: number;
    try {
      ({ limit, offset } = parsePagination(c.req.query()));
    } catch {
      return c.json({ error: "Invalid pagination parameters" }, 400);
    }
    const activities = db.listActivities(acc.id, { offset, limit });
    const total = db.countActivities(acc.id);
    return c.json({ activities, meta: pageMeta(activities.length, limit, offset, total) });
  });

  app.get("/accounts/:id/opportunities", (c) => {
    const acc = db.getAccount(c.req.param("id"));
    if (!acc) return c.json({ error: "Account not found" }, 404);
    const opportunities = db.listOpportunities(acc.id);
    return c.json({ opportunities });
  });

  app.get("/accounts/:id/tasks", (c) => {
    const acc = db.getAccount(c.req.param("id"));
    if (!acc) return c.json({ error: "Account not found" }, 404);
    let limit: number, offset: number;
    try {
      ({ limit, offset } = parsePagination(c.req.query()));
    } catch {
      return c.json({ error: "Invalid pagination parameters" }, 400);
    }
    const tasks = db.listTasks(acc.id, { offset, limit });
    const total = db.countTasks(acc.id);
    return c.json({ tasks, meta: pageMeta(tasks.length, limit, offset, total) });
  });

  const patchBody = z.object({
    nextStep: z.string().optional(),
    stage: z.string().optional(),
    ownerId: z.string().optional(),
  }).passthrough();

  app.patch("/accounts/:id", async (c) => {
    const acc = db.getAccount(c.req.param("id"));
    if (!acc) return c.json({ error: "Account not found" }, 404);
    let data: unknown;
    try {
      data = await c.req.json();
      patchBody.parse(data);
    } catch {
      return c.json({ error: "Invalid body" }, 400);
    }
    const patch = data as Record<string, unknown>;
    return c.json({ ...acc, ...patch });
  });

  const noteBody = z.object({ text: z.string().min(1) });
  app.post("/accounts/:id/notes", async (c) => {
    const acc = db.getAccount(c.req.param("id"));
    if (!acc) return c.json({ error: "Account not found" }, 404);
    let data;
    try {
      data = noteBody.parse(await c.req.json().catch(() => null));
    } catch {
      return c.json({ error: "Body must include a non-empty text field" }, 400);
    }
    const note = { id: `note_${Date.now()}`, accountId: acc.id, type: "note", timestamp: new Date().toISOString(), text: data.text };
    return c.json({ note }, 201);
  });

  const taskBody = z.object({
    accountId: z.string(),
    ownerId: z.string().optional(),
    title: z.string().min(1),
    dueDate: z.string().optional(),
  });
  app.post("/tasks", async (c) => {
    let data;
    try {
      data = taskBody.parse(await c.req.json().catch(() => null));
    } catch {
      return c.json({ error: "Invalid task body" }, 400);
    }
    const account = db.getAccount(data.accountId);
    if (!account) return c.json({ error: "Account not found" }, 404);
    const task = {
      id: `tsk_${Date.now()}`,
      accountId: data.accountId,
      ownerId: data.ownerId ?? account.ownerId ?? null,
      title: data.title,
      dueDate: data.dueDate ?? null,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    return c.json({ task }, 201);
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
