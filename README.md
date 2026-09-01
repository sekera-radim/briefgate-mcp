# @briefgate/mcp

**Stop your coding agent stalling on client logos, copy and credentials.**

BriefGate is the first client intake tool built for AI agents. Your agent declares what it needs (`define_intake`), BriefGate generates a branded portal and chases the client automatically with email reminders, and your agent retrieves fully typed assets (`get_intake_results`) and keeps building.

```
Agent: define_intake(items=[logo, copy, wp_admin])
BriefGate: → sends invite email → chases client every few days
Client:    fills in the portal (mobile-friendly, no login required)
Agent: get_intake_results() → { logo: "https://signed-url/logo.svg", wp_admin: "s3cr3t" }
Agent: keeps building the website ✅
```

## Quickstart — Claude Code

**1. Get an API key** at [briefgate.dev](https://briefgate.dev) (free tier available, no card required):

**2. Register the MCP server:**

```bash
claude mcp add briefgate \
  -e BRIEFGATE_API_KEY=bg_live_... \
  -- npx @briefgate/mcp
```

Or add manually to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "briefgate": {
      "command": "npx",
      "args": ["@briefgate/mcp"],
      "env": {
        "BRIEFGATE_API_KEY": "bg_live_..."
      }
    }
  }
}
```

**3. Verify it loaded** — run `/mcp` in Claude Code and look for `briefgate` with 7 tools.

## Quickstart — Cursor / Codex / other MCP clients

Add to your MCP config (usually `.cursor/mcp.json` or similar):

```json
{
  "mcpServers": {
    "briefgate": {
      "command": "npx",
      "args": ["-y", "@briefgate/mcp"],
      "env": {
        "BRIEFGATE_API_KEY": "bg_live_..."
      }
    }
  }
}
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRIEFGATE_API_KEY` | Yes | — | API key (`bg_live_...` or `bg_test_...`). Obtain from the BriefGate dashboard. |
| `BRIEFGATE_BASE_URL` | No | `https://api.briefgate.dev` | Override for staging or local development. |
| `BRIEFGATE_MCP_HTTP` | No | — | Set to `1` to start Streamable HTTP instead of stdio. |
| `BRIEFGATE_MCP_PORT` | No | `3000` | Port for HTTP mode. |

## HTTP (Streamable HTTP) mode

For remote or multi-session deployments, start the server in HTTP mode:

```bash
BRIEFGATE_API_KEY=bg_live_... npx @briefgate/mcp --http --port 3000
```

The server binds to `127.0.0.1` only and includes DNS-rebinding protection. Behind a reverse proxy, terminate TLS there and forward to the local port — do not expose the port directly.

### Published mode (one endpoint, many customers)

Set `BRIEFGATE_MCP_PUBLIC_HOST` to the hostname the server is published under and
it becomes a multi-customer endpoint: each caller sends its own key as
`Authorization: Bearer bg_live_...`, and the server speaks to the BriefGate API
as that caller.

```bash
BRIEFGATE_MCP_PUBLIC_HOST=mcp.example.com npx @briefgate/mcp --http --port 3000
```

Three things change, on purpose:

- the listener binds `0.0.0.0` and the Host guard accepts that name, because a
  server behind a reverse proxy is reached by its public name;
- **the `BRIEFGATE_API_KEY` fallback is switched off.** Leaving it on would let
  an anonymous caller spend the operator's key;
- requests still reach `initialize` and `tools/list` without a key, so a client
  or registry can read the tool list before anyone has signed up. A tool call
  without a key fails with a sentence saying what to send.

The public instance is `https://mcp.briefgate.dev/mcp`.

## Tools

### `define_intake`

Create a new client intake — a branded portal where the client submits the assets you need. BriefGate sends the invite email and chases the client automatically until everything is collected.

```
project_name: "Website for John Finance"
client: { email: "john@example.com", name: "John", language: "cs" }
// also_notify: [{ email: "jane@example.com", name: "Jane" }]
//   Others at the client who get the same link and the same reminders — either of
//   them can supply the material. Each gets their own email; nobody sees the rest.
due_date: "2026-08-15"
branding: { accent_color: "#1B2A4A", sender_name: "Radim" }
chase_schedule: "default"   // default | gentle | aggressive | custom | off
// chase_interval: 5, chase_interval_unit: "minutes"   // only with "custom"; omit for every 3 days
// respect_quiet_hours: false, max_reminders: 12       // for a deliberately rapid cadence
items:
  - { key: "logo",       type: "image",    label: "Company logo",
      constraints: { formats: ["svg","png"], min_width: 512 } }
  - { key: "hero_copy",  type: "longtext", label: "Homepage headline",
      constraints: { max_chars: 400 } }
  - { key: "brand_colors", type: "color_list", label: "Brand colors", required: false }
  - { key: "ga4_id",    type: "text",     label: "Google Analytics ID",
      pattern: "^G-[A-Z0-9]+$", required: false }
  - { key: "wp_admin",  type: "secret",   label: "WordPress admin credentials" }
  - { key: "photos",    type: "file_list", label: "Photos (5–10 images)",
      constraints: { formats: ["jpg","png","heic"], min_count: 5, max_count: 15 } }
  - { key: "opening_hours", type: "structured", label: "Opening hours",
      schema: { type: "object", properties: { mon_fri: { type: "string" }, sat: { type: "string" } } } }
  - { key: "has_existing_site", type: "boolean", label: "Does the client have an existing website?" }
  - { key: "website_url", type: "url", label: "Current website URL", required: false }
  - { key: "service_tier", type: "select", label: "Service package",
      options: [{ value: "basic", label: "Basic" }, { value: "pro", label: "Pro" }] }
```

**Item key rules:** must be `snake_case` (e.g. `logo`, `hero_copy`, `ga4_id`). Keys become property names in `get_intake_results` — no uppercase, no spaces, no hyphens.

Returns `{ intake_id, portal_url, status }`. Save `intake_id` for all follow-up calls.

### `get_intake_status`

Check which items are submitted, pending, or need revision. Includes the history of automated chase emails and when the client last opened the portal.

```
intake_id: "in_8f3k"
```

Returns per-item status and a full chase history.

### `get_intake_results`

Retrieve typed submitted values. Files are signed URLs (valid 24 hours). **Secrets are one-time** — decrypted and returned on the first call only; store them before moving on.

```
intake_id: "in_8f3k"
only_new: true          // only items new since last call
include_pending: false  // omit unsubmitted items
```

Returns `{ results: { logo: "https://signed...", hero_copy: "text...", wp_admin: "s3cr3t" }, meta: { ... } }`.

### `request_revision`

Ask the client to resubmit an item with a note explaining what is wrong.

```
intake_id: "in_8f3k"
item_key: "logo"
note: "Logo is blurry — we need at least 512 px wide in SVG or PNG with a transparent background"
```

Returns `{ status: "revision_requested", item_key }`.

### `send_chase`

Send a manual reminder outside the automatic schedule. Use when a deadline is approaching or email attempts have failed.

```
intake_id: "in_8f3k"
channel: "sms"   // "email" (default) | "sms"
```

Returns `{ sent: true }`.

### `list_intakes`

List all intakes across projects, optionally filtered by status or client email.

```
status: "in_progress"   // draft | sent | in_progress | completed | archived
client_email: "john@example.com"
limit: 20
offset: 0
```

Returns `{ intakes: [...], total }`.

### `add_items`

Add new items to an already-sent intake — for example a favicon you forgot, or additional credentials needed mid-project.

```
intake_id: "in_8f3k"
items:
  - { key: "favicon", type: "image", label: "Favicon (32×32 PNG or ICO)" }
```

Returns the updated intake.

### `update_item`

Change an item's definition after the intake was sent — the type, label, help text or constraints. Use this when you asked for the wrong thing, e.g. you requested an image but the client has a PDF.

```
intake_id: "in_8f3k"
item_key: "logo"
type: "file"                        // was "image"
constraints: { formats: ["pdf","ai","svg"] }
discard_submitted_value: false      // true is required if the change invalidates what the client already sent
```

Returns the updated item. If the client already submitted a value that the new definition would reject, the call fails with `item_answer_would_be_discarded` until you pass `discard_submitted_value: true`.

### `manage_webhook`

Register, list or remove a webhook endpoint so events are pushed to your service instead of you polling.

```
action: "create"                    // create | list | delete
url: "https://your.service/hooks/briefgate"
events: ["intake.completed", "intake.overdue"]
format: "raw"                       // raw | slack | discord
```

`action: "create"` returns a `secret` **once** — store it, it verifies every delivery signature and cannot be retrieved again. Remove with `action: "delete"` and `webhook_id`.

Because an agent receives the secret in a tool result, it can come to rest wherever that conversation is stored. There is no rotation endpoint: if a transcript leaks, delete the endpoint and create a new one to get a fresh secret.

Only register an endpoint you can actually receive on. An agent running in a terminal has no public HTTPS address; for that case register nothing and check on a schedule instead (see below).

## Decisions — questions for the developer

An agent building something hits things only the account holder can settle: *does the discounted plan cost $19 or $29?* Stopping to wait wastes the run; picking silently buries the assumption. A decision is the third option — pose the question, record the answer you are proceeding on, keep building.

```jsonc
{ "key": "discount_price", "type": "select", "assignee": "owner",
  "label": "What does the discounted subscription cost?",
  "options": [ { "value": "19", "label": "$19/month" },
               { "value": "29", "label": "$29/month" } ],
  "proposed": { "value": "19", "rationale": "matches the competitor we benchmarked" } }
```

`type: "multiselect"` takes several answers, bounded by `constraints.min_count` / `max_count`.

The proposal is stored apart from the real answer, so it can never be mistaken for one the developer gave — and it survives being overruled, which is the point: in three months you can still see that $19 was assumed, not agreed. Read it back from `get_intake_results`:

```jsonc
"results": { "discount_price": "19" },
"meta": { "discount_price": { "decided_by": "agent_proposal", "proposed_value": "19" } }
```

`decided_by` is `"owner"` once a person has settled it and `"agent_proposal"` while it is still your own pick. A proposed decision comes back even without `include_pending` — you need the assumption you are building on. It does not bump `revision`, so an `only_new` read surfaces exactly the decisions someone has since answered.

**You cannot answer your own question.** The answer endpoint takes a dashboard session, not an API key: if the agent could confirm its own proposal and have it recorded as the developer's, the distinction would be worth nothing. Decisions are answered in the BriefGate dashboard.

Owner items never reach the client portal, never appear in a reminder, and never hold up completion — the intake is finished when the *client* is finished.

## Knowing when the client is done

Nothing pushes to an MCP client on its own — MCP is request/response, so the server cannot wake your agent when the client finishes. `define_intake` therefore returns a `follow_up` block naming the mechanism that fits your setup:

```jsonc
"follow_up": {
  "recommended": "schedule",        // or "webhook" when an endpoint already exists
  "webhook": { "active_endpoints": 0, "events": ["intake.completed", "item.submitted"],
               "register_with": "manage_webhook" },
  "schedule": { "check_with": "get_intake_status", "every_hours": 24,
                "until": "2026-10-01T08:00:00.000Z" }
}
```

- **You run a service** → register a webhook with `manage_webhook` and act on `intake.completed`.
- **You are an agent in a terminal** → set up a recurring check that calls `get_intake_status` every `every_hours` hours until `until`. A cron entry, a systemd timer, or your agent host's own scheduler all work.

Events worth acting on: `intake.completed` (everything is in) and `intake.overdue` (the deadline passed with required items missing — the project is blocked and the client needs a human, not another reminder).

The cadence tightens near the deadline (24h normally, 12h inside a week, 6h inside two days) and is not tied to the reminder schedule: a client can submit everything at 2am having never opened a reminder.

## End-to-end example

```
# System prompt excerpt
You are a web development agent. When you need client assets:

1. Call define_intake with all assets needed for this project.
   Use type=secret for passwords/credentials.
   The chase engine runs automatically — do not poll more often than once per day.

2. Read follow_up in the response and set up how you will hear back:
   register a webhook with manage_webhook if you have an HTTPS endpoint,
   otherwise schedule a get_intake_status check at follow_up.schedule.every_hours.

3. When intake.completed arrives (or the scheduled check reports "completed"),
   call get_intake_results. Download file URLs within 24 hours.
   Store secrets immediately — they are one-time.

4. If a submitted asset does not meet requirements (blurry logo, broken URL),
   call request_revision with a clear note for the client.
   If the client has the asset in another form, call update_item to change the type.

5. If the client is unresponsive after 9 days, call send_chase with channel="sms"
   (only if a phone number was collected).
```

## Verifying webhooks

BriefGate signs every webhook with HMAC-SHA256 to prevent forgery and replay attacks. The `@briefgate/mcp` package exports a ready-made helper:

```typescript
import { verifyWebhookSignature, parseWebhookEvent } from "@briefgate/mcp/webhook";
```

The signature lives in the `X-BriefGate-Signature` header as `t=<unix>,v1=<hex>`:

### Fastify (recommended)

```typescript
import Fastify from "fastify";
import { verifyWebhookSignature, parseWebhookEvent } from "@briefgate/mcp/webhook";

const app = Fastify();

// Parse body as raw string — JSON-parsing before verification breaks the HMAC.
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  done(null, body);
});

app.post("/briefgate/webhook", (request, reply) => {
  const rawBody = request.body as string;

  const ok = verifyWebhookSignature(
    process.env.BRIEFGATE_WEBHOOK_SECRET!,
    request.headers["x-briefgate-signature"] as string,
    rawBody,
    // { toleranceSec: 300 }  ← default; increase for slow networks
  );

  if (!ok) {
    return reply.status(401).send({ error: "Invalid signature" });
  }

  const event = parseWebhookEvent(rawBody);
  console.log("BriefGate event:", event.event, event.intake_id);
  reply.send({ ok: true });
});
```

### Express

```typescript
import express from "express";
import { verifyWebhookSignature, parseWebhookEvent } from "@briefgate/mcp/webhook";

const app = express();

// raw body parser — must come before express.json()
app.post(
  "/briefgate/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body);

    const ok = verifyWebhookSignature(
      process.env.BRIEFGATE_WEBHOOK_SECRET!,
      req.headers["x-briefgate-signature"] as string,
      rawBody,
    );

    if (!ok) return res.status(401).json({ error: "Invalid signature" });

    const event = parseWebhookEvent(rawBody);
    console.log("BriefGate event:", event.event, event.intake_id);
    res.sendStatus(200);
  },
);
```

### Webhook events

| Event | When | Key fields |
|---|---|---|
| `item.submitted` | Client submits an item | `item_key`, `item_status` |
| `intake.completed` | All required items approved | — |
| `client.viewed` | Client opens the portal | `client_email` |
| `chase.bounced` | Reminder email/SMS bounced | `channel`, `reason` |
| `intake.stalled` | 3 reminders sent, no response | `attempts` |

## Pricing

| | Free | Solo — $29/mo | Agency — $79/mo |
|---|---|---|---|
| Active intakes | 1 | 15 | 60 |
| Items per intake | 10 | unlimited | unlimited |
| Storage | 1 GB | 25 GB | 100 GB |
| Branding | "powered by" | custom logo + colors | + custom sending domain |
| Chase | email, default | email, all schedules | email, all schedules |
| Secrets vault | — | yes | yes |
| Webhooks + REST + MCP | yes | yes | yes |

Full pricing at `GET https://api.briefgate.dev/pricing.json` (no auth required — agents can read it directly).

## Data residency

BriefGate is hosted in the EU: application servers at netcup GmbH in Nuremberg, Germany; files in Cloudflare R2 under EU jurisdiction. See the [GDPR notes](https://briefgate.dev/docs/gdpr) and the [DPA](https://briefgate.dev/docs/dpa).

## Privacy Policy

This package is a thin client: it holds no data of its own and sends nothing
anywhere except to the BriefGate API at `api.briefgate.dev`, using the API key
you configure. It writes no telemetry and no analytics.

What BriefGate itself collects, how long it keeps it, who it is shared with and
how to have it deleted is covered in full here:

- **Privacy Policy** — https://briefgate.dev/docs/privacy
- **Security** — https://briefgate.dev/docs/security
- **Data Processing Agreement** — https://briefgate.dev/docs/dpa

Contact for privacy requests: privacy@briefgate.dev

## Contributing

This repository is the BriefGate MCP client only — a thin wrapper over the
public BriefGate REST API. The BriefGate service itself is closed source.

```bash
npm install
npm run typecheck   # TypeScript check
npm run lint        # ESLint
npm run test        # Vitest
npm run check       # all three
npm run build       # compile to dist/
```

## License

MIT — use freely in commercial projects.

---

Made by [Radim Sekera](https://briefgate.dev). Related project: [impri.dev](https://impri.dev) — human-in-the-loop approval inbox for AI agents.
