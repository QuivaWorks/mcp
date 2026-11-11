# QuivaWorks MCP: guide for coding agents

This repository holds the QuivaWorks MCP servers (one package per area, plus `quiva-mcp-remote`, which serves them all over HTTP) and a config-as-code skill, `skills/quiva-config`. Use it to build and change flows, record sets, spaces, documents and assistants in a QuivaWorks account from your terminal.

## Safety rules

- Never ask the user to paste an API key into chat, and never print, log or commit one.
- The user creates a key in the app under **Settings → API keys** and enters it in their own terminal (see below).
- Writes are dry runs until `--yes`. Show the user the dry-run output and wait for their yes before re-running with `--yes`.
- Test changes in a non-production account first when the user has one.

## Connect to the hosted MCP server

Export a key in the shell that starts Codex: `export QUIVA_API_KEY=...`. Then add to `~/.codex/config.toml`:

```toml
[mcp_servers.quiva]
url = "https://api.quiva.ai/mcp"
bearer_token_env_var = "QUIVA_API_KEY"
```

`codex mcp list` should show `quiva`. Tools are prefixed by area (`flows_`, `records_`, `documents_`, `workspaces_`, `agents_`, `distribution_`, `coworker_`). Call each area's `*_list_reference_topics` tool before building.

## Run a server locally instead

Clone this repo, copy a package's `.env.example` to `.env` and fill in `QUIVA_API_KEY`, then:

```toml
[mcp_servers.quiva-flows]
command = "sh"
args = ["/absolute/path/to/mcp/quiva-flows-mcp/bin/run.sh"]
```

Repeat for the other packages you need. Each package README lists its variables.

## Config as code with the quiva-config script

`skills/quiva-config/scripts/quiva.mjs` (Node 18+, no dependencies) pulls, diffs, pushes and copies record sets, records, spaces, task templates and flows, and manages secret names. Read `skills/quiva-config/SKILL.md` for the workflow and `skills/quiva-config/reference/routes.md` for API traps. It works the same from Codex and shares profiles with Claude Code (`~/.config/quiva/profiles.json`).

```sh
node skills/quiva-config/scripts/quiva.mjs            # usage
node skills/quiva-config/scripts/quiva.mjs profile list
node skills/quiva-config/scripts/quiva.mjs check <profile>
```

If there is no profile, ask the user to run this themselves (it prompts for the key with hidden input and looks up the account):

```sh
node skills/quiva-config/scripts/quiva.mjs profile add <name>
```

`QUIVA_API_KEY_<PROFILE>` overrides a profile's key. Pulled files go to `./.quiva/` in the directory you run from; keep it out of git.
