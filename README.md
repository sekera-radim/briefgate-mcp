# BriefGate

**Client intake for AI coding agents.**

Your agent can build the website.
BriefGate gets the missing things from the client.

```
Claude Code / Cursor / Codex → BriefGate → Client portal
  → Files · copy · credentials · structured data → Agent continues building
```

![BriefGate demo: an intake being defined, the client filling the portal, results coming back](https://briefgate.dev/assets/demo/killer-demo.gif)

[Watch as MP4 (25 s)](https://briefgate.dev/assets/demo/killer-demo.mp4) · [Full 47 s walkthrough](https://briefgate.dev/assets/demo/briefgate-demo.mp4)

[Website](https://briefgate.dev?utm_source=github&utm_medium=readme&utm_campaign=mcp_launch) · [MCP reference](https://briefgate.dev/docs/mcp) · [llms.txt](https://briefgate.dev/llms.txt) · [Guides and checklists](https://briefgate.dev/guides)

Not working with an agent? The same intakes can be created from the browser dashboard — see the [dashboard quickstart](https://briefgate.dev/docs/dashboard-quickstart).

## The problem

Agents are fast. The bottleneck is the human on the other side of the project.

Somewhere in the middle of building, the agent needs something only the client has: a logo, homepage copy, brand colors, opening hours, hosting credentials, an API key, a piece of structured data like a price list. None of that exists in the chat, and none of it can be guessed.

The usual move is to stop and ask the developer to go chase the client by email. Instead, the agent creates a BriefGate intake. BriefGate emails the client, collects what comes back, chases automatically when it doesn't, and returns typed results the agent can use directly. The agent keeps building in the meantime.

## Quickstart

**Claude Code — hosted, no key to manage:**

```bash
claude mcp add --transport http briefgate https://mcp.briefgate.dev/mcp
```

Then run `/mcp` in Claude Code, pick **briefgate**, and choose **Authenticate**.

**Claude Code — local package:**

```bash
claude mcp add briefgate -- npx -y @briefgate/mcp
npx -y @briefgate/mcp login
```

Prefer to skip sign-in entirely? Get a key at [briefgate.dev](https://briefgate.dev?utm_source=github&utm_medium=readme&utm_campaign=mcp_launch) (free tier, no card) and pass it as `BRIEFGATE_API_KEY`.

**Cursor** — add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "briefgate": {
      "command": "npx",
      "args": ["-y", "@briefgate/mcp"]
    }
  }
}
```

Then run `npx -y @briefgate/mcp login`, or ask the agent to call the `login` tool.

**Codex:**

```bash
codex mcp add briefgate --env BRIEFGATE_API_KEY=bg_live_xxxxx -- npx -y @briefgate/mcp
```

**Gemini CLI** — installs as an extension from this repo's [`gemini-extension.json`](gemini-extension.json), pointed at the hosted endpoint:

```bash
gemini extensions install https://github.com/sekera-radim/briefgate-mcp
```

It authenticates the same way as the other hosted clients above — via OAuth, on first use.

Full setup details, manual config, and API-key precedence: see [Reference](#reference) below.

## Example: building a client's website

An agent is building a website for a restaurant. It has the layout and the booking flow, but it still needs the logo, a hero photo, the opening hours, a short description of the restaurant, the social media links, and admin access to the client's WordPress install. It calls `define_intake`:

```json
{
  "project_name": "Website for Trattoria Bella",
  "client": { "email": "owner@trattoriabella.example", "name": "Marco", "language": "en" },
  "items": [
    { "key": "logo", "type": "image", "label": "Restaurant logo",
      "constraints": { "formats": ["svg", "png"], "min_width": 512 } },
    { "key": "hero_image", "type": "image", "label": "Hero photo for the homepage" },
    { "key": "opening_hours", "type": "structured", "label": "Opening hours",
      "schema": { "type": "object", "properties": { "mon_fri": { "type": "string" }, "sat": { "type": "string" }, "sun": { "type": "string" } } } },
    { "key": "about_copy", "type": "longtext", "label": "Short description of the restaurant" },
    { "key": "social_links", "type": "structured", "label": "Social media links" },
    { "key": "wp_admin", "type": "secret", "label": "WordPress admin credentials" }
  ]
}
```

From there, BriefGate (1) creates a branded portal, (2) emails the client, (3) validates each asset as it comes in, (4) chases the client automatically until everything is submitted, and (5) notifies the agent when it's done.

The agent keeps building the layout, the booking flow, and everything else that doesn't depend on this — then calls `get_intake_results(intake_id)` and gets back typed data and signed URLs for the files, plus a one-time reveal of the WordPress credentials. It stores the secret and continues.

## Why not a form?

| Generic form | BriefGate |
|---|---|
| Human creates the form | Agent declares what it needs |
| Human reads results | Agent consumes typed results |
| Generic answers | Typed items |
| Manual follow-up | Automatic chasing |
| Spreadsheet mindset | API / MCP workflow |
| Credentials are awkward | Secret item + controlled reveal |
| Human workflow | Agent workflow |

BriefGate is not trying to replace every form builder. It is designed for the point where an AI agent needs information from a human.

Free tier, no card required. BriefGate is a hosted service — this repository is the open-source MCP client, MIT licensed. Sign up at [briefgate.dev](https://briefgate.dev?utm_source=github&utm_medium=readme&utm_campaign=mcp_launch).

## Reference

Everything below is unchanged technical detail: manual setup, environment variables, HTTP/OAuth mode, the full tool reference, webhooks, pricing, and legal.

### Claude Code: manual setup and API keys

**Paste an API key** (for CI, scripts, or if you'd rather manage the key yourself). Get one at [briefgate.dev](https://briefgate.dev) (free tier available, no card required):

```bash
claude mcp add briefgate \
  -e BRIEFGATE_API_KEY=bg_live_... \
  -- npx -y @briefgate/mcp
```

Or add manually to `~/.claude/settings.json`:

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

`BRIEFGATE_API_KEY` (or `--api-key` on the command line), if set, always takes precedence over a key `login` stored locally — running `login` while one is configured just says so instead of doing anything.

**Verify it loaded** — run `/mcp` in Claude Code and look for `briefgate` with 15 tools.

The same local-package and API-key setup works for any MCP client that runs the package locally (Cursor, Codex, others) — register it with no key at all and run `login`, or paste `BRIEFGATE_API_KEY` into that client's own MCP config the same way.

### Sign in without an API key

Two ways to get a key onto this machine without pasting one — both run the same device-authorization flow (RFC 8628) against the same credential file, so pick whichever fits how you're using the package.

**From a terminal — the `login` / `logout` subcommands:**

```bash
npx -y @briefgate/mcp login     # prints a code + URL, waits for approval, saves the key
npx -y @briefgate/mcp logout    # removes the local key, best-effort revokes it remotely
```

`login` blocks until you approve it (or it times out at 10 minutes), then prints `Signed in as <account_name>` and exits `0` — or prints why it didn't work (denied, expired, an error) and exits `1`. `logout` always removes the local copy; it also sends `DELETE /v1/keys/current` using that same key to revoke it server-side, and if that call fails (no network, API unreachable) it says so and points at the BriefGate dashboard instead of leaving you unsure whether the key is still live.

**From an agent — the `login` / `logout` tools** (see [Tools](#tools)):

Same flow, for a client that can't block a terminal on your click. `login` is **two-phase** because a tool call can't sit open for minutes:

1. The first call starts the flow and returns immediately with the code and URL. A browser is opened automatically where possible.
2. Call `login` again — any time, or once you've approved it — to check progress. While it's still waiting, it says so; once approved, that same call reports success and the key is saved. No restart needed: the very next tool call is signed in.

`logout` as a tool does exactly what the subcommand does, including the best-effort remote revoke.

**Either way**, the key lands in `~/.briefgate/credentials.json` (directory mode `0700`, file mode `0600`; override the path with `BRIEFGATE_CREDENTIALS_FILE`), keyed by which BriefGate server it's for so a staging `BRIEFGATE_BASE_URL` and production never collide. An explicit key always wins over a stored one — `--api-key`, then `BRIEFGATE_API_KEY`, then whatever `login` last saved — and `login` says so instead of running the flow when one of those is already set. Neither the subcommands nor the tools apply to the shared hosted endpoint (`mcp.briefgate.dev`) — see [Hosted endpoint + OAuth](#hosted-endpoint--oauth), where connecting a client triggers real OAuth instead.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRIEFGATE_API_KEY` | No | — | API key (`bg_live_...` or `bg_test_...`). Takes precedence over a credential stored by `login`. If nothing is configured, tool calls fail with a message pointing at `login`. |
| `BRIEFGATE_BASE_URL` | No | `https://api.briefgate.dev` | Override for staging or local development. |
| `BRIEFGATE_CREDENTIALS_FILE` | No | `~/.briefgate/credentials.json` | Where `login`/`logout` store the key. Mainly for tests and unusual setups. |
| `BRIEFGATE_NO_BROWSER` | No | unset | Set to `1` to stop `login` from opening a browser (headless servers, CI); the URL is printed either way. |
| `BRIEFGATE_MCP_HTTP` | No | — | Set to `1` to start Streamable HTTP instead of stdio. |
| `BRIEFGATE_MCP_PORT` | No | `3000` | Port for HTTP mode. |
| `BRIEFGATE_MCP_PUBLIC_HOST` | No | — | Publishes the server as a shared, multi-customer OAuth endpoint. See [Hosted endpoint + OAuth](#hosted-endpoint--oauth). |
| `BRIEFGATE_MCP_AUTH_SERVER` | No | `BRIEFGATE_BASE_URL` | The OAuth authorization server advertised to clients in published mode. Defaults to `BRIEFGATE_BASE_URL` for local dev, where they're usually the same address; a real deployment behind a container network sets this explicitly (see below). |

`--api-key bg_live_...` is also accepted on the command line, ahead of `BRIEFGATE_API_KEY` in priority. `login` and `logout` are also accepted as the first command-line argument (`npx @briefgate/mcp login`), instead of `--http`/no flag.

### HTTP (Streamable HTTP) mode

For remote or multi-session deployments, start the server in HTTP mode:

```bash
BRIEFGATE_API_KEY=bg_live_... npx @briefgate/mcp --http --port 3000
```

The server binds to `127.0.0.1` only and includes DNS-rebinding protection. Behind a reverse proxy, terminate TLS there and forward to the local port — do not expose the port directly.

### Hosted endpoint + OAuth

Set `BRIEFGATE_MCP_PUBLIC_HOST` to the hostname the server is published under and
it becomes a shared, multi-customer endpoint: each caller sends its own key as
`Authorization: Bearer bg_live_...` (an OAuth access token, for this API, *is*
that same key — see below), and the server speaks to the BriefGate API as that
caller. The public instance is `https://mcp.briefgate.dev/mcp`.

```bash
BRIEFGATE_MCP_PUBLIC_HOST=mcp.example.com npx @briefgate/mcp --http --port 3000
```

Several things change, on purpose:

- the listener binds `0.0.0.0` and the Host guard accepts that name, because a
  server behind a reverse proxy is reached by its public name;
- **the `BRIEFGATE_API_KEY` fallback and the local `login` credential are both
  switched off.** Leaving either on would let an anonymous caller spend the
  operator's key, or read whatever the machine's own `login` last stored;
- **`login`/`logout`, tools and subcommands alike, are unavailable** —
  connecting a client triggers real OAuth instead, described below;
- the server becomes an OAuth 2.1 *resource server*, per the MCP authorization
  spec, so an OAuth-aware client can add it with nothing but the URL. This
  package never runs the authorization flow itself — it only advertises where
  to find it and enforces that a request carries a token:
  - it serves `GET /.well-known/oauth-protected-resource` (RFC 9728), and the
    same content again under `/.well-known/oauth-protected-resource/mcp` (the
    resource-scoped path the MCP spec also has clients try), both with open
    CORS and naming the BriefGate API as the authorization server — see
    `BRIEFGATE_MCP_AUTH_SERVER` above;
  - **every** MCP request now needs a Bearer token — including `initialize`
    and `tools/list`, which used to work without one so a registry could
    introspect the tool list. One with no token gets HTTP `401` and a
    `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`
    header, which is the signal an OAuth client uses to start signing in;
  - if a tool call's key turns out to be expired or revoked (the API answers
    `401`), the response is rewritten into a real HTTP `401` with the same
    header plus `error="invalid_token"`, rather than an ordinary tool error —
    so the client knows to refresh rather than just reporting the call failed.

What a connecting client actually does, against the authorization server named
in that metadata: standard OAuth 2.1 discovery
(`GET /.well-known/oauth-authorization-server`), dynamic client registration
(`POST /v1/oauth/register`), then an authorization-code exchange with PKCE
(S256) at `POST /v1/oauth/token` — no client secret, since MCP clients are
public clients — and `POST /v1/oauth/revoke` to end a session. None of that is
this package's concern; it only has to be a correct resource server pointing
at it. The access token that comes out the other end is a `bg_live_...` key
like any other, with a one-hour expiry the API enforces.

None of this applies without `BRIEFGATE_MCP_PUBLIC_HOST`: a local `--http` run
keeps behaving exactly as before, including an absent key reaching
`initialize`/`tools/list` and a plain `Authorization: Bearer ...` header
working with no OAuth involved.

### Tools

#### `define_intake`

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
// folder_id: "fld_1"
//   Put the intake straight into an existing folder from list_folders instead
//   of leaving it unfiled.
// client_brief: "Here's the offer we agreed on, plus a few notes on scope..."
//   Free text shown to the client above the requested items — information from
//   you to them, not another thing you're asking them for. Up to 5000 characters.
//   Documents go through POST /v1/intakes/:id/brief/files (dashboard or REST,
//   not through MCP).
```

**Item key rules:** must be `snake_case` (e.g. `logo`, `hero_copy`, `ga4_id`). Keys become property names in `get_intake_results` — no uppercase, no spaces, no hyphens.

Returns `{ intake_id, portal_url, status }`. Save `intake_id` for all follow-up calls.

#### `get_intake_status`

Check which items are submitted, pending, or need revision. Includes the history of automated chase emails and when the client last opened the portal.

```
intake_id: "in_8f3k"
```

Returns per-item status and a full chase history.

#### `get_intake_results`

Retrieve typed submitted values. Files are signed URLs (valid 24 hours). **Secrets are one-time** — decrypted and returned on the first call only; store them before moving on.

```
intake_id: "in_8f3k"
only_new: true          // only items new since last call
include_pending: false  // omit unsubmitted items
```

Returns `{ results: { logo: "https://signed...", hero_copy: "text...", wp_admin: "s3cr3t" }, meta: { ... } }`.

#### `request_revision`

Ask the client to resubmit an item with a note explaining what is wrong.

```
intake_id: "in_8f3k"
item_key: "logo"
note: "Logo is blurry — we need at least 512 px wide in SVG or PNG with a transparent background"
```

Returns `{ status: "revision_requested", item_key }`.

#### `send_chase`

Send a manual reminder outside the automatic schedule. Use when a deadline is approaching or email attempts have failed.

```
intake_id: "in_8f3k"
```

Returns `{ sent: true }`.

#### `list_intakes`

List all intakes across projects, optionally filtered by status, client email, folder, or a text search.

```
status: "in_progress"   // draft | sent | in_progress | completed | archived
client_email: "john@example.com"
folder_id: "fld_1"      // or "none" for intakes not in any folder
q: "Finance"             // substring match on project name, client name, or client email
limit: 20
offset: 0
```

Returns `{ intakes: [...], total }`.

#### `add_items`

Add new items to an already-sent intake — for example a favicon you forgot, or additional credentials needed mid-project.

```
intake_id: "in_8f3k"
items:
  - { key: "favicon", type: "image", label: "Favicon (32×32 PNG or ICO)" }
```

Returns the updated intake.

#### `update_item`

Change an item's definition after the intake was sent — the type, label, help text or constraints. Use this when you asked for the wrong thing, e.g. you requested an image but the client has a PDF.

```
intake_id: "in_8f3k"
item_key: "logo"
type: "file"                        // was "image"
constraints: { formats: ["pdf","ai","svg"] }
discard_submitted_value: false      // true is required if the change invalidates what the client already sent
```

Returns the updated item. If the client already submitted a value that the new definition would reject, the call fails with `item_answer_would_be_discarded` until you pass `discard_submitted_value: true`.

#### `update_intake`

Change settings on an already-sent intake — project name, due date, reminder cadence, quiet hours, the client brief, or the client's name, phone, language, and timezone. Use this instead of deleting and recreating the intake, which would re-send the invite.

```
intake_id: "in_8f3k"
due_date: "2026-12-01"
chase_schedule: "gentle"            // was "default"
max_reminders: "unlimited"          // reactivates a stalled intake if it had hit its cap
// folder_id: "fld_1"                // move it into a folder; null removes it from any folder
// client_brief: "Updated offer..."  // replaces the brief shown above the items; null clears it
```

If any chase-related field changes (`chase_schedule`, `chase_interval`, `chase_interval_unit`, `chase_at_time`, `max_reminders`, `respect_quiet_hours`, `due_date`, `client.timezone`) on a sent intake, every pending reminder is cancelled and re-planned from now — reminders already sent still count toward `max_reminders`. `folder_id` never touches the chase schedule.

The client's e-mail address cannot be changed here — the portal link and login are bound to it. Use `manage_recipients` for that. Fails if the intake is archived. Returns the full, updated intake object.

#### `manage_recipients`

Add, remove, or reinstate a person who receives an intake's invite and reminders, alongside or instead of the primary client.

```
intake_id: "in_8f3k"
action: "reinstate"                 // add | remove | reinstate
email: "extra@example.com"
name: "Petr"                        // only used with action="add"
```

`action="add"` invites another address the same way `also_notify` does at `define_intake` time. `action="remove"` stops future reminders to that address. `action="reinstate"` is for a bounce that was wrong — the person did get the e-mail — it clears the bounce flag so reminders resume, and re-plans the chase schedule from now if that address was the only one still being chased.

#### `manage_webhook`

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

#### `list_folders`

List the folders in your account, used to group intakes by client or project. Takes no arguments.

Call this before `create_folder` or before setting `folder_id` on `define_intake`, `update_intake`, or `list_intakes` — reuse an existing folder for a returning client instead of creating a duplicate.

Returns `{ folders: [{ id, name, sort_order, intake_count, created_at }] }`.

#### `create_folder`

Create a new folder to group intakes, e.g. one per client.

```
name: "Acme Inc"
```

Call `list_folders` first and reuse a matching folder — only create one when none of the existing folders fits. Fails with `folder_exists` if a folder with this name already exists. Returns the created folder.

#### `login`

Sign in without an API key — see [Sign in without an API key](#sign-in-without-an-api-key). Takes no arguments.

Call it whenever another tool reports "Not signed in" or that the stored key was revoked or expired. The first call starts a device-authorization flow and returns a URL and a short code immediately; call it again (any time) to check whether it's been approved yet. Has no effect — it says so instead — if `--api-key` or `BRIEFGATE_API_KEY` already supplies a key. Not available on the hosted endpoint. Same flow as running `npx @briefgate/mcp login` from a terminal (which blocks until approved instead of needing a second call) — see [Sign in without an API key](#sign-in-without-an-api-key).

#### `logout`

Removes the API key `login` stored locally for this BriefGate server, and best-effort revokes it on the server too. Takes no arguments.

If the revoke call fails — no network, the API unreachable — the local copy is still removed; the response says so and points at the BriefGate dashboard to revoke it there instead. Not available on the hosted endpoint. Same effect as running `npx @briefgate/mcp logout` from a terminal — see [Sign in without an API key](#sign-in-without-an-api-key).

### Decisions — questions for the developer

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

### Knowing when the client is done

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

### End-to-end example

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

5. If the client is still unresponsive after 9 days, call send_chase for an
   extra nudge outside the automatic schedule, or tell the developer the intake
   is stuck and let them pick up the phone.
```

### Verifying webhooks

BriefGate signs every webhook with HMAC-SHA256 to prevent forgery and replay attacks. The `@briefgate/mcp` package exports a ready-made helper:

```typescript
import { verifyWebhookSignature, parseWebhookEvent } from "@briefgate/mcp/webhook";
```

The signature lives in the `X-BriefGate-Signature` header as `t=<unix>,v1=<hex>`:

#### Fastify (recommended)

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

#### Express

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

#### Webhook events

| Event | When | Key fields |
|---|---|---|
| `item.submitted` | Client submits an item | `item_key`, `item_status` |
| `intake.completed` | All required items approved | — |
| `client.viewed` | Client opens the portal | `client_email` |
| `chase.bounced` | A reminder bounced | `channel`, `reason`, `recipient`, `still_chasing` |
| `intake.stalled` | 3 reminders sent, no response | `attempts` |

### Pricing

Launch offer: code `LAUNCH20` gives 20% off Solo and Agency for the lifetime of the subscription, valid until 4 October 2026 (new customers, plans only).

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

### Data residency

BriefGate is hosted in the EU: application servers at netcup GmbH in Nuremberg, Germany; files in Cloudflare R2 under EU jurisdiction. See the [GDPR notes](https://briefgate.dev/docs/gdpr) and the [DPA](https://briefgate.dev/docs/dpa).

### Privacy Policy

This package is a thin client: it holds no data of its own and sends nothing
anywhere except to the BriefGate API at `api.briefgate.dev`, using the API key
you configure. It writes no telemetry and no analytics.

What BriefGate itself collects, how long it keeps it, who it is shared with and
how to have it deleted is covered in full here:

- **Privacy Policy** — https://briefgate.dev/docs/privacy
- **Security** — https://briefgate.dev/docs/security
- **Data Processing Agreement** — https://briefgate.dev/docs/dpa

Contact for privacy requests: privacy@briefgate.dev

### Contributing

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

### License

MIT — use freely in commercial projects.

---

Made by [Radim Sekera](https://briefgate.dev). Related project: [impri.dev](https://impri.dev) — human-in-the-loop approval inbox for AI agents.
