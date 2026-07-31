#!/bin/sh
# Launcher for the Quiva Flows MCP server.
#
# 1. Loads quiva-flows-mcp/.env (already-exported vars take precedence).
# 2. Finds a Node >= 18 binary (global fetch is required): $QUIVA_NODE, then
#    PATH, then common nvm installs, then /usr/local/bin and /opt/homebrew/bin.
# 3. Runs src/index.js over stdio.

set -e

# Resolve the package directory (parent of bin/), independent of CWD.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PKG_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# --- Load .env (without clobbering already-exported variables) ---
ENV_FILE="$PKG_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key=${line%%=*}
    # Trim surrounding whitespace from the key.
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    [ -z "$key" ] && continue
    # Only set if not already present in the environment.
    if [ -z "$(eval "printf '%s' \"\${$key:-}\"")" ]; then
      val=${line#*=}
      export "$key=$val"
    fi
  done < "$ENV_FILE"
fi

# --- Find a Node >= 18 binary ---
node_major() {
  "$1" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0
}

NODE_BIN=""
try_node() {
  [ -n "$1" ] || return 1
  [ -x "$1" ] || command -v "$1" >/dev/null 2>&1 || return 1
  major=$(node_major "$1")
  if [ "$major" -ge 18 ] 2>/dev/null; then
    NODE_BIN="$1"
    return 0
  fi
  return 1
}

# 1. Explicit override.
try_node "$QUIVA_NODE" \
  || try_node "$(command -v node 2>/dev/null)"

# 2. nvm installs (highest version first).
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for candidate in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -rV); do
    try_node "$HOME/.nvm/versions/node/$candidate/bin/node" && break
  done
fi

# 3. Common install locations.
[ -z "$NODE_BIN" ] && try_node "/opt/homebrew/bin/node"
[ -z "$NODE_BIN" ] && try_node "/usr/local/bin/node"

if [ -z "$NODE_BIN" ]; then
  echo "[quiva-flows-mcp] No Node >= 18 found. Set QUIVA_NODE to a Node 18+ binary in $ENV_FILE." >&2
  exit 1
fi

exec "$NODE_BIN" "$PKG_DIR/src/index.js"
