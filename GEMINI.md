# BriefGate

BriefGate lets an AI agent collect files, text, choices, or credentials from
a human who is not in this conversation (a client, colleague, or customer).
It emails them a no-account portal link and chases them automatically until
everything is submitted; the agent retrieves typed results.

## When to use the `briefgate` tools

The task is blocked on input that only a specific outside person can
provide — a logo or other brand assets, copy, a login/API credential, or an
answer to a question — especially when that person may take hours or days
to respond and will need reminders.

## When NOT to use them

- The needed information is already available to you.
- The person who needs to answer is the user in this session — ask them
  directly instead of creating an intake.

## Normal flow

1. `define_intake` with the items you need. This emails the client and
   starts automatic chasing. Save the returned `intake_id`.
2. Tell the user it was sent — this is not the same as the work being done.
3. Check back later with `get_intake_status`. A "not ready" / pending result
   is normal, not an error.
4. Once status is `completed`, call `get_intake_results` to retrieve the
   typed values. Use `request_revision` if a submitted item is unusable.

Secret-type items (passwords, API keys) are included only in the first
`get_intake_results` response and cannot be shown again, so make sure the
user is ready to receive them.
