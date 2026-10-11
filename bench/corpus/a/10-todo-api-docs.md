# Taskly REST API Reference

**Version:** v1 · **Base URL:** `https://api.taskly.example.com/v1` · **Last updated:** October 2026

Taskly is a to-do list service. This API lets you create, read, update and delete to-dos and the lists that contain them. It uses predictable resource-oriented URLs, accepts and returns JSON, and uses standard HTTP status codes and verbs.

## Contents

1. [Getting started](#getting-started)
2. [Authentication](#authentication)
3. [Conventions](#conventions)
4. [The Todo object](#the-todo-object)
5. [Todos endpoints](#todos-endpoints)
6. [Lists endpoints](#lists-endpoints)
7. [Errors](#errors)
8. [Rate limits](#rate-limits)
9. [Webhooks](#webhooks)
10. [Changelog](#changelog)

## Getting started

Here is a complete round trip: create a to-do, then fetch it.

```bash
export TASKLY_TOKEN="tk_live_..."   # your API key

curl -X POST https://api.taskly.example.com/v1/todos \
  -H "Authorization: Bearer $TASKLY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy oat milk", "due_date": "2026-10-09"}'
```

```json
{
  "id": "todo_8f3k2m",
  "title": "Buy oat milk",
  "notes": null,
  "status": "open",
  "priority": "normal",
  "due_date": "2026-10-09",
  "list_id": "list_inbox",
  "tags": [],
  "created_at": "2026-10-07T14:03:11Z",
  "updated_at": "2026-10-07T14:03:11Z",
  "completed_at": null
}
```

```bash
curl https://api.taskly.example.com/v1/todos/todo_8f3k2m \
  -H "Authorization: Bearer $TASKLY_TOKEN"
```

## Authentication

All requests must be made over HTTPS and must include an API key in the `Authorization` header using the Bearer scheme:

```http
Authorization: Bearer tk_live_your_api_key_here
```

Create and revoke keys under **Settings → Developer → API keys**. Keys come in two kinds:

| Prefix | Environment | Notes |
|---|---|---|
| `tk_live_` | Production | Acts on your real data |
| `tk_test_` | Sandbox | Isolated data store, reset every 24 hours |

Treat keys like passwords. Do not embed them in client-side code or commit them to version control. A request without a valid key returns `401 Unauthorized`.

## Conventions

- **Content type.** Send request bodies as JSON with `Content-Type: application/json`. Responses are always JSON encoded as UTF-8.
- **Timestamps** are ISO 8601 strings in UTC, for example `2026-10-07T14:03:11Z`. **Dates** without a time (such as `due_date`) use `YYYY-MM-DD`.
- **IDs** are opaque strings with a type prefix (`todo_`, `list_`, `wh_`). Do not parse them.
- **Partial updates.** `PATCH` changes only the fields you send. Send `null` to clear an optional field.
- **Idempotency.** For `POST` requests, you may send an `Idempotency-Key` header with a unique value (such as a UUID). If you retry with the same key within 24 hours, you get the original response instead of a duplicate resource.

### Pagination

List endpoints use cursor-based pagination. Responses have this shape:

```json
{
  "data": [ { "id": "todo_8f3k2m", "...": "..." } ],
  "has_more": true,
  "next_cursor": "eyJpZCI6InRvZG9fOGYzazJtIn0"
}
```

Pass `next_cursor` as the `cursor` query parameter to get the next page. `limit` controls the page size: default 25, maximum 100.

## The Todo object

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier. Read-only. |
| `title` | string | Required. 1–500 characters. |
| `notes` | string or null | Free-form text, up to 10,000 characters. Markdown is stored as-is. |
| `status` | string | `open` or `completed`. Defaults to `open`. |
| `priority` | string | `low`, `normal` or `high`. Defaults to `normal`. |
| `due_date` | string or null | Due date in `YYYY-MM-DD` format. |
| `list_id` | string | The list containing this to-do. Defaults to your Inbox, `list_inbox`. |
| `tags` | array of strings | Up to 20 tags, each 1–40 characters. |
| `created_at` | string | Creation time. Read-only. |
| `updated_at` | string | Last modification time. Read-only. |
| `completed_at` | string or null | Time the to-do was completed; `null` while open. Read-only. |

## Todos endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/todos` | List to-dos |
| `POST` | `/todos` | Create a to-do |
| `GET` | `/todos/{id}` | Retrieve a to-do |
| `PATCH` | `/todos/{id}` | Update a to-do |
| `DELETE` | `/todos/{id}` | Delete a to-do |
| `POST` | `/todos/{id}/complete` | Mark a to-do completed |
| `POST` | `/todos/{id}/reopen` | Mark a completed to-do open again |

### List to-dos

```http
GET /todos
```

Returns to-dos sorted by `created_at` descending unless `sort` says otherwise.

**Query parameters**

| Parameter | Type | Description |
|---|---|---|
| `status` | string | Filter by `open` or `completed`. |
| `list_id` | string | Only to-dos in this list. |
| `tag` | string | Only to-dos with this tag. Repeat the parameter to require several tags. |
| `due_before` | date | Only to-dos due on or before this date. |
| `due_after` | date | Only to-dos due on or after this date. |
| `q` | string | Case-insensitive search in `title` and `notes`. |
| `sort` | string | `created_at`, `-created_at`, `due_date` or `-due_date`. A leading `-` means descending. |
| `limit` | integer | Page size, 1–100. Default 25. |
| `cursor` | string | Cursor from a previous response's `next_cursor`. |

**Example**

```bash
curl -G https://api.taskly.example.com/v1/todos \
  -H "Authorization: Bearer $TASKLY_TOKEN" \
  -d status=open \
  -d due_before=2026-10-31 \
  -d sort=due_date \
  -d limit=2
```

```json
{
  "data": [
    {
      "id": "todo_8f3k2m",
      "title": "Buy oat milk",
      "status": "open",
      "priority": "normal",
      "due_date": "2026-10-09",
      "list_id": "list_inbox",
      "tags": ["errands"],
      "created_at": "2026-10-07T14:03:11Z",
      "updated_at": "2026-10-07T14:03:11Z",
      "completed_at": null,
      "notes": null
    },
    {
      "id": "todo_2b9x7q",
      "title": "Submit expense report",
      "status": "open",
      "priority": "high",
      "due_date": "2026-10-15",
      "list_id": "list_work",
      "tags": ["finance"],
      "created_at": "2026-10-01T09:12:44Z",
      "updated_at": "2026-10-05T16:40:02Z",
      "completed_at": null,
      "notes": "Receipts are in the shared drive."
    }
  ],
  "has_more": true,
  "next_cursor": "eyJpZCI6InRvZG9fMmI5eDdxIn0"
}
```

### Create a to-do

```http
POST /todos
```

**Body parameters:** `title` (required), `notes`, `priority`, `due_date`, `list_id`, `tags`.

Returns `201 Created` with the new Todo object and a `Location` header pointing to it.

**Python**

```python
import os
import requests

API = "https://api.taskly.example.com/v1"
headers = {"Authorization": f"Bearer {os.environ['TASKLY_TOKEN']}"}

resp = requests.post(
    f"{API}/todos",
    headers=headers,
    json={
        "title": "Book dentist appointment",
        "priority": "high",
        "due_date": "2026-10-20",
        "tags": ["health"],
    },
    timeout=10,
)
resp.raise_for_status()
todo = resp.json()
print(todo["id"], todo["status"])   # todo_5h1v0c open
```

**JavaScript (fetch)**

```javascript
const API = "https://api.taskly.example.com/v1";

async function createTodo(token, todo) {
  const res = await fetch(`${API}/todos`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(todo),
  });
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(`${error.code}: ${error.message}`);
  }
  return res.json();
}

const todo = await createTodo(process.env.TASKLY_TOKEN, {
  title: "Book dentist appointment",
  priority: "high",
  due_date: "2026-10-20",
});
```

### Retrieve a to-do

```http
GET /todos/{id}
```

Returns `200 OK` with the Todo object, or `404 Not Found` if no to-do with that ID exists in your account.

### Update a to-do

```http
PATCH /todos/{id}
```

Send only the fields you want to change. Read-only fields are ignored. To move a to-do to another list, set `list_id`. To clear the due date:

```bash
curl -X PATCH https://api.taskly.example.com/v1/todos/todo_2b9x7q \
  -H "Authorization: Bearer $TASKLY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"due_date": null, "priority": "normal"}'
```

Setting `status` directly is allowed, but prefer the `/complete` and `/reopen` endpoints, which also set `completed_at` and fire the corresponding webhooks.

**Optimistic concurrency.** Every Todo response includes an `ETag` header. Send it back in `If-Match` to make the update conditional; if the to-do changed in the meantime, you get `412 Precondition Failed` instead of overwriting someone else's edit.

### Delete a to-do

```http
DELETE /todos/{id}
```

Returns `204 No Content`. Deleted to-dos go to the trash and can be restored in the app for 30 days. After 30 days they are removed permanently. Deleting a to-do that is already deleted returns `404`.

### Complete or reopen a to-do

```http
POST /todos/{id}/complete
POST /todos/{id}/reopen
```

No request body. Both return `200 OK` with the updated Todo. Completing an already completed to-do is a no-op and does not change `completed_at`.

## Lists endpoints

Lists group to-dos. Every account has a built-in Inbox, `list_inbox`, which cannot be renamed or deleted.

| Method | Path | Description |
|---|---|---|
| `GET` | `/lists` | List all lists |
| `POST` | `/lists` | Create a list (`name` required, optional `color` as a hex string) |
| `GET` | `/lists/{id}` | Retrieve a list, including `open_count` and `completed_count` |
| `PATCH` | `/lists/{id}` | Rename or recolor a list |
| `DELETE` | `/lists/{id}` | Delete a list. Pass `?move_to={list_id}` to keep its to-dos; otherwise they are deleted too |

```json
{
  "id": "list_work",
  "name": "Work",
  "color": "#3D7EF0",
  "open_count": 12,
  "completed_count": 87,
  "created_at": "2026-03-02T08:00:00Z"
}
```

## Errors

Errors use conventional HTTP status codes and a consistent JSON body:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "title must be between 1 and 500 characters",
    "field": "title",
    "request_id": "req_7Qm2LxP0"
  }
}
```

Include the `request_id` when contacting support.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed JSON or invalid query parameter |
| 401 | `unauthorized` | Missing, invalid or revoked API key |
| 403 | `forbidden` | The key lacks permission for this resource |
| 404 | `not_found` | The resource does not exist or belongs to another account |
| 409 | `conflict` | Idempotency key reused with a different request body |
| 412 | `precondition_failed` | `If-Match` ETag no longer matches |
| 422 | `validation_failed` | A field failed validation; see `field` |
| 429 | `rate_limited` | Too many requests; see [Rate limits](#rate-limits) |
| 500 | `internal_error` | Something went wrong on our side; safe to retry |
| 503 | `unavailable` | Temporary outage or maintenance; retry with backoff |

## Rate limits

Each API key may make **120 requests per minute** with bursts up to 20 requests per second. Every response carries these headers:

| Header | Meaning |
|---|---|
| `X-RateLimit-Limit` | Requests allowed in the current window |
| `X-RateLimit-Remaining` | Requests left in the current window |
| `X-RateLimit-Reset` | Unix time (seconds) when the window resets |
| `Retry-After` | On `429` responses only: seconds to wait before retrying |

A simple retry loop with exponential backoff:

```python
import time
import requests

def request_with_retry(method, url, max_attempts=5, **kwargs):
    for attempt in range(max_attempts):
        resp = requests.request(method, url, timeout=10, **kwargs)
        if resp.status_code not in (429, 500, 503):
            return resp
        wait = float(resp.headers.get("Retry-After", 2 ** attempt))
        time.sleep(wait)
    return resp
```

## Webhooks

Webhooks notify your server when to-dos change. Register an endpoint with `POST /webhooks`:

```bash
curl -X POST https://api.taskly.example.com/v1/webhooks \
  -H "Authorization: Bearer $TASKLY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.org/hooks/taskly", "events": ["todo.created", "todo.completed"]}'
```

Available events: `todo.created`, `todo.updated`, `todo.completed`, `todo.reopened`, `todo.deleted`, `list.created`, `list.deleted`.

Each delivery is a `POST` with this body:

```json
{
  "id": "evt_0Zk4Rt",
  "type": "todo.completed",
  "created_at": "2026-10-07T15:22:09Z",
  "data": { "object": { "id": "todo_8f3k2m", "status": "completed", "...": "..." } }
}
```

**Verifying signatures.** Each request includes a `Taskly-Signature` header containing `t=<timestamp>,v1=<signature>`, where the signature is the hex-encoded HMAC-SHA256 of `"{timestamp}.{raw_body}"` using your webhook's signing secret. Reject requests whose timestamp is more than 5 minutes old.

```python
import hashlib
import hmac
import time

def verify(header: str, raw_body: bytes, secret: str, tolerance: int = 300) -> bool:
    parts = dict(item.split("=", 1) for item in header.split(","))
    timestamp, signature = parts["t"], parts["v1"]
    if abs(time.time() - int(timestamp)) > tolerance:
        return False
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
```

Respond with any `2xx` status within 10 seconds. Failed deliveries are retried with exponential backoff for up to 3 days.

## Changelog

| Date | Change |
|---|---|
| 2026-09-15 | Added `POST /todos/{id}/reopen` and the `todo.reopened` webhook event. |
| 2026-06-02 | Added `ETag` / `If-Match` support for optimistic concurrency on `PATCH`. |
| 2026-03-10 | Added `q` full-text search parameter to `GET /todos`. |
| 2026-01-20 | v1 general availability. |
