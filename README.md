# BriefGate plugin for Claude

BriefGate collects files, texts, choices and logins from someone outside the
conversation (a client, a colleague, a customer). It emails them a no-account
portal link, sends the reminders, and hands the answers back to Claude.

This branch is the plugin listed in the Claude directory. A GitHub Action
rebuilds it from `main` with `scripts/build-claude-plugin-branch.sh` after
every change to the plugin files, so change them on `main`, not here.

## What it installs

- The hosted BriefGate MCP server, `https://mcp.briefgate.dev/mcp`
  (`.mcp.json`). It signs in with OAuth on first use. In Claude Code, run
  `/mcp`, pick **briefgate** and choose **Authenticate**. In Claude apps and
  Cowork, sign-in goes through the
  [BriefGate connector](https://claude.ai/directory/briefgate). The plugin
  itself reads no credentials from your machine.
- The `collect-from-client` skill, which tells Claude when to create an
  intake and how to follow it up.

Requires a BriefGate account. A free plan is available at
[briefgate.dev](https://briefgate.dev). Secret items and revision requests
need a paid plan.

- Documentation: https://briefgate.dev/docs/mcp
- Privacy policy: https://briefgate.dev/docs/privacy
- MCP server and npm package source: the `main` branch of this repository
