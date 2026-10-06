import Database from "better-sqlite3";
import { resolve } from "node:path";
import type { Account, Activity, Contact, Opportunity, Task } from "./schema.ts";

export class CrmDb {
  private db: Database.Database;

  constructor(path?: string) {
    const resolved = path ?? resolve(import.meta.dirname, "..", "data", "crm", "crm.sqlite");
    this.db = new Database(resolved, { readonly: true });
  }

  close(): void {
    this.db.close();
  }

  listAccounts(opts: { offset: number; limit: number }): Account[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts ORDER BY id LIMIT ? OFFSET ?")
      .all(opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return rows.map((r) => mapAccount(r));
  }

  countAccounts(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM accounts").get() as { c: number }).c;
  }

  getAccount(id: string): Account | null {
    const r = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? mapAccount(r) : null;
  }

  listContacts(accountId: string, opts: { offset: number; limit: number }): Contact[] {
    const rows = this.db
      .prepare("SELECT * FROM contacts WHERE account_id = ? ORDER BY id LIMIT ? OFFSET ?")
      .all(accountId, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return rows.map(mapContact);
  }

  countContacts(accountId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM contacts WHERE account_id = ?").get(accountId) as { c: number }).c;
  }

  listActivities(accountId: string, opts: { offset: number; limit: number }): Activity[] {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE account_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?")
      .all(accountId, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return rows.map(mapActivity);
  }

  countActivities(accountId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM activities WHERE account_id = ?").get(accountId) as { c: number }).c;
  }

  listOpportunities(accountId: string): Opportunity[] {
    const rows = this.db
      .prepare("SELECT * FROM opportunities WHERE account_id = ? ORDER BY id")
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map(mapOpportunity);
  }

  listTasks(accountId: string, opts: { offset: number; limit: number }): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(accountId, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    return rows.map(mapTask);
  }

  countTasks(accountId: string): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM tasks WHERE account_id = ?").get(accountId) as { c: number }).c;
  }
}

function mapAccount(r: Record<string, unknown>): Account {
  return {
    id: r.id as string,
    name: r.name as string,
    domain: r.domain as string | undefined,
    industry: r.industry as string | undefined,
    employeeCount: r.employee_count as number | undefined,
    ownerId: r.owner_id as string | undefined,
    stage: r.stage as Account["stage"],
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    lastContactAt: r.last_contact_at as string | undefined,
    nextStep: r.next_step as string | undefined,
    opportunityAmount: r.opportunity_amount as number | undefined,
    closeDate: r.close_date as string | undefined,
    icpTier: r.icp_tier as string | undefined,
  };
}

function mapContact(r: Record<string, unknown>): Contact {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    name: r.name as string,
    email: r.email as string,
    title: r.title as string | undefined,
    persona: r.persona as string | undefined,
    lastContactedAt: r.last_contacted_at as string | undefined,
  };
}

function mapActivity(r: Record<string, unknown>): Activity {
  const type = r.activity_type as string;
  switch (type) {
    case "email":
      return {
        id: r.id as string,
        accountId: r.account_id as string,
        type: "email",
        direction: r.direction as "inbound" | "outbound",
        timestamp: r.timestamp as string,
        contactId: r.contact_id as string | undefined,
        subject: r.subject as string | undefined,
      };
    case "meeting":
      return {
        id: r.id as string,
        accountId: r.account_id as string,
        type: "meeting",
        timestamp: r.timestamp as string,
        contactIds: r.contact_id ? [r.contact_id as string] : [],
        outcome: r.outcome as "positive" | "neutral" | "negative" | undefined,
      };
    case "stage_change":
      return {
        id: r.id as string,
        accountId: r.account_id as string,
        type: "stage_change",
        timestamp: r.timestamp as string,
        from: r.from_stage as string | undefined,
        to: r.to_stage as string,
      };
    case "note":
      return {
        id: r.id as string,
        accountId: r.account_id as string,
        type: "note",
        timestamp: r.timestamp as string,
        text: r.text as string,
      };
    default:
      throw new Error(`Unknown activity type: ${type}`);
  }
}

function mapOpportunity(r: Record<string, unknown>): Opportunity {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    name: r.name as string | undefined,
    stage: r.stage as string,
    value: r.value as number | undefined,
    openedAt: r.opened_at as string | undefined,
    closeDate: r.close_date as string | undefined,
    lastStageChangeAt: r.last_stage_change_at as string | undefined,
    nextStep: r.next_step as string | undefined,
    ownerId: r.owner_id as string | undefined,
    status: r.status as string | undefined,
  };
}

function mapTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    accountId: r.account_id as string,
    contactId: r.contact_id as string | undefined,
    ownerId: r.owner_id as string,
    title: r.title as string | undefined,
    description: r.description as string | undefined,
    dueDate: r.due_date as string | undefined,
    completed: (r.completed as number) === 1,
    createdAt: r.created_at as string,
  };
}
