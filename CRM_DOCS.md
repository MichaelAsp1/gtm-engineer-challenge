# Mock CRM API

The mock CRM exposes a read-mostly HTTP API over the CRM data. It runs locally
at `http://localhost:3001` (see `mock-crm/` for the source).

Interact with the CRM **only through this HTTP API** — the underlying SQLite
database is not meant to be queried directly. Treat responses as you would any
external API.

## General notes

- **Base URL:** `http://localhost:3001`
- **Errors:** endpoints return JSON with an `error` string and the appropriate
  HTTP status (`400` invalid input, `404` unknown account, `500` internal).
- **Pagination:** collection endpoints are paginated. Use either
  `page`/`page_size` (1-indexed page) **or** `limit`/`offset` (offset-based).
  `page_size` and `limit` are capped at `100`.
- **Missing/optional fields:** some fields are absent. Do not assume every
  object has every field.
- **Writes:** `PATCH` and `POST` endpoints are in-memory only (not persisted).

## Pagination response shape

Collection endpoints that paginate return an array under a named key plus a `meta` object:

```json
{
  "<items>": [ ... ],
  "meta": {
    "total": 200,
    "page": 1,
    "page_size": 20,
    "has_more": true,
    "next_offset": 20
  }
}
```

---

## Endpoints

### `GET /health`

Health check.

**Response `200`:**
```json
{ "ok": true }
```

---

### `GET /accounts`

List all accounts (paginated).

**Query params:** `page` (default `1`), `page_size` (default `20`, max `100`),
or `limit` (max `100`) / `offset` (default `0`).

**Response `200`:** `{ "accounts": Account[], "meta": {...} }`

**Account object:**
```json
{
  "id": "acc_001",
  "name": "hearthpediatrics-prod",
  "domain": "hearthpediatrics.example",
  "industry": "healthcare",
  "employeeCount": 1200,
  "ownerId": "usr_01",
  "stage": "customer",
  "createdAt": "2024-01-04T08:00:00.000Z",
  "updatedAt": "2025-03-14T08:00:00.000Z",
  "lastContactAt": "2025-03-14T08:00:00.000Z",
  "nextStep": "Execute renewal",
  "opportunityAmount": 120000,
  "closeDate": "2025-05-01",
  "icpTier": "mid_market"
}
```

**Fields:**
| Field | Type | Notes |
|---|---|---|
| `id` | string | Account id (e.g. `acc_001`) |
| `name` | string | Display name |
| `domain` | string? | Company domain (may be missing) |
| `industry` | string? | |
| `employeeCount` | number? | |
| `ownerId` | string? | Assigned owner |
| `stage` | string | One of `prospect`, `evaluation`, `mvp`, `customer`, `closed_lost` |
| `createdAt` / `updatedAt` | string | ISO timestamps |
| `lastContactAt` | string? | Most recent contact timestamp |
| `nextStep` | string? | |
| `opportunityAmount` | number? | Open/active opportunity value |
| `closeDate` | string? | `YYYY-MM-DD` |
| `icpTier` | string? | e.g. `enterprise`, `mid_market`, `smb`, `none` |

---

### `GET /accounts/:id`

Get a single account.

**Path:** `:id` — account id (e.g. `acc_001`).

**Response `200`:** a single `Account` object (see above).
**Response `404`:** `{ "error": "Account not found" }`

---

### `GET /accounts/:id/contacts`

List contacts for an account (paginated).

**Query params:** as with `/accounts`.

**Response `200`:** `{ "contacts": Contact[], "meta": {...} }`

**Contact object:**
```json
{
  "id": "ctc_001",
  "accountId": "acc_001",
  "name": "Alex Rivera",
  "email": "alex@hearthpediatrics.example",
  "title": "Chief Medical Officer",
  "persona": "champion",
  "lastContactedAt": "2025-03-10T08:00:00.000Z"
}
```

**Fields:**
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `accountId` | string | |
| `name` | string | |
| `email` | string | |
| `title` | string? | |
| `persona` | string? | e.g. `champion`, `economic_buyer` |
| `lastContactedAt` | string? | ISO timestamp |

**Response `404`:** if the account does not exist.

---

### `GET /accounts/:id/activities`

List activities for an account (paginated, **newest first**).

**Query params:** as with `/accounts`.

**Response `200`:** `{ "activities": Activity[], "meta": {...} }`

Activities are **discriminated by `type`**:

**`email`** — `type: "email"`, `direction: "inbound" | "outbound"`, optional `contactId`, `subject`.
**`meeting`** — `type: "meeting"`, `contactIds: string[]`, optional `outcome: "positive" | "neutral" | "negative"`.
**`stage_change`** — `type: "stage_change"`, optional `from`, `to` (stage).
**`note`** — `type: "note"`, `text`.

All activities have `id`, `accountId`, and `timestamp` (ISO, `createdAt`-style).

**Response `404`:** if the account does not exist.

---

### `GET /accounts/:id/opportunities`

List opportunities for an account (not paginated).

**Response `200`:** `{ "opportunities": Opportunity[] }`

**Opportunity object:**
```json
{
  "id": "opp_001",
  "accountId": "acc_001",
  "name": "Enterprise license - hearthpediatrics",
  "stage": "evaluation",
  "value": 150000,
  "openedAt": "2025-01-10T08:00:00.000Z",
  "closeDate": "2025-04-01",
  "lastStageChangeAt": "2025-02-20T08:00:00.000Z",
  "nextStep": "Send proposal",
  "ownerId": "usr_01",
  "status": "open"
}
```

**Response `404`:** if the account does not exist.

---

### `GET /accounts/:id/tasks`

List tasks for an account (paginated, newest first by `createdAt`).

**Query params:** as with `/accounts`.

**Response `200`:** `{ "tasks": Task[], "meta": {...} }`

**Task object:**
```json
{
  "id": "tsk_001",
  "accountId": "acc_001",
  "contactId": "ctc_001",
  "ownerId": "usr_01",
  "title": "Follow up on security questionnaire",
  "description": "...",
  "dueDate": "2025-03-20",
  "completed": false,
  "createdAt": "2025-03-14T08:00:00.000Z"
}
```

**Fields:**
| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `accountId` | string | |
| `contactId` | string? | |
| `ownerId` | string | |
| `title` | string? | |
| `description` | string? | |
| `dueDate` | string? | `YYYY-MM-DD` |
| `completed` | boolean | |
| `createdAt` | string | ISO timestamp |

**Response `404`:** if the account does not exist.

---

### `PATCH /accounts/:id`

Update fields on an account (in-memory only). Returns the merged account.

**Body (JSON):** any subset of `{ "nextStep": string, "stage": string, "ownerId": string }` (other fields are passed through).

**Response `200`:** the updated `Account` object.
**Response `400`:** `{ "error": "Invalid body" }`
**Response `404`:** `{ "error": "Account not found" }`

---

### `POST /accounts/:id/notes`

Add a note to an account (in-memory only).

**Body (JSON):** `{ "text": string }` (non-empty).

**Response `201`:** the created note:
```json
{
  "note": {
    "id": "note_...",
    "accountId": "acc_001",
    "type": "note",
    "timestamp": "...",
    "text": "..."
  }
}
```

**Response `400`:** `{ "error": "Body must include a non-empty text field" }`
**Response `404`:** if the account does not exist.

---

### `POST /tasks`

Create a task (in-memory only).

**Body (JSON):**
```json
{
  "accountId": "acc_001",
  "ownerId": "usr_01",
  "title": "Schedule technical deep-dive",
  "dueDate": "2025-03-22"
}
```
`ownerId` and `dueDate` are optional; `title` is required (non-empty); `accountId` is required.

**Response `201`:** the created task:
```json
{
  "task": {
    "id": "tsk_...",
    "accountId": "acc_001",
    "ownerId": "usr_01",
    "title": "Schedule technical deep-dive",
    "dueDate": "2025-03-22",
    "completed": false,
    "createdAt": "..."
  }
}
```

**Response `400`:** `{ "error": "Invalid task body" }`
**Response `404`:** if the account does not exist.
