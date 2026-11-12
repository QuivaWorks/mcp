# QuivaWorks plugin for Claude Code

This repository is a Claude Code plugin and marketplace. It adds:

- the hosted QuivaWorks MCP server (`https://api.quiva.ai/mcp`), from the root `.mcp.json`
- the `quiva-config` skill, which pulls, edits, diffs, pushes and copies account configuration with dry runs and backups

## Install

Create an API key in the app under **Settings → API keys** and export it in the shell that starts Claude Code:

```sh
export QUIVA_API_KEY=...
```

Then, in Claude Code:

```
/plugin marketplace add QuivaWorks/mcp
/plugin install quiva@quivaworks
```

Or from a shell: `claude plugin marketplace add QuivaWorks/mcp` then `claude plugin install quiva@quivaworks`. Run `/mcp` to check that `quiva` is connected.

## Use the skill

Needs Node 18+. Save a profile once, in your own terminal (the key is typed at a hidden prompt, never in chat):

```sh
node "<plugin dir>/skills/quiva-config/scripts/quiva.mjs" profile add main
```

The script finds the account from the key. Profiles live in `~/.config/quiva/profiles.json` (mode 600). Then ask Claude to pull, edit or copy something; writes are dry runs until you approve.

## Codex

Codex uses the root `AGENTS.md` instead: see it for `config.toml` snippets and the same script.
