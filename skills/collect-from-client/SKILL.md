---
name: collect-from-client
description: Collects files, text, choices, or credentials from a client, colleague, or other person who is not in this conversation, then chases them automatically and lets you retrieve typed results. Use when a task is blocked on something only that outside person can supply — a logo or other brand assets, copy, login/API credentials, or answers to questions — especially if they may take days and need reminders. Trigger phrases: "need the logo/texts/credentials from the client", "waiting on the client for materials", "chase the client", "ask the client to fill this in". Do not use when the needed information is already available in this conversation or the user you're talking to can just answer it directly.
---

# Collect from client

Uses the BriefGate MCP tools (configured by this plugin against the hosted
endpoint at `mcp.briefgate.dev`) to request materials from someone outside
this conversation and pick up the results once they respond.

## When to use

The task is blocked on input that only a specific outside person can provide
— a client, a colleague, a customer — and that person is not part of this
chat. Typical cases: brand assets (logo, colors), marketing copy, files,
decisions between options, or credentials (a WordPress login, an API key)
needed to proceed with the work. Especially useful when the person may take
hours or days to respond and will need reminders.

## When NOT to use

- The information is already available to you (in the repo, the
  conversation, a doc you can read) — just use it, don't create an intake.
- The person who needs to answer is the user in THIS conversation — ask them
  directly instead of routing it through an intake portal.

## Steps

1. **`define_intake`** — create the intake with `project_name`, `client`
   (email, name, language), and an `items` array describing exactly what you
   need (type: `file`, `image`, `file_list`, `longtext`, `secret`, `select`,
   `multiselect`, etc., with constraints). This emails the client a
   no-account portal link and starts automatic chasing. Save the returned
   `intake_id`.
2. **Tell the user it was sent.** Report the `portal_url` and that BriefGate
   will chase the client automatically — do not treat this as done.
3. **Set up how you'll learn it's done.** Nothing pushes to you: follow the
   `follow_up` block in the `define_intake` response — either a webhook is
   already configured (`manage_webhook` to set one up if not), or you/the
   user need to poll `get_intake_status` periodically.
4. **`get_intake_status`** — check progress later. A "not ready" / pending
   result is normal, not an error; keep waiting or chase again.
5. **`send_chase`** — send a manual reminder if you want to nudge the client
   outside the automatic cadence.
6. **`request_revision`** — if a submitted item is unusable (blurry logo,
   copy too long, broken credential), send it back with a plain-language
   note instead of accepting bad data.
7. **`get_intake_results`** — once status is `completed` (or to check partial
   progress), fetch the typed values and carry on with the work that was
   waiting on them.

## Important: secrets are revealed once

If an item is `type: secret` (a password, API key, or similar credential),
`get_intake_results` includes the value only in the first response. A later
call reports that it was already revealed but does not return the value
again, so make sure the user is ready to receive it.

## Other tools available

`add_items` / `update_item` / `update_intake` to change an intake after
creation, `list_intakes` / `list_folders` / `create_folder` to organize
multiple intakes, `manage_recipients` to change who receives an intake, and
`manage_webhook` to register a completion webhook instead of polling.
