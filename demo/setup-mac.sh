#!/usr/bin/env bash
# Installs the /multiverse-demo command for Claude Code and connects the PayBox MCP server.
set -euo pipefail
command -v claude >/dev/null || { echo "Claude Code CLI not found. Install it first: npm install -g @anthropic-ai/claude-code"; exit 1; }
claude mcp add --transport http --scope user paybox https://api.paybox.sh/mcp || echo "(paybox MCP server may already be configured)"
mkdir -p "$HOME/.claude/commands"
curl -fsSL https://raw.githubusercontent.com/bahramgg/Paybox/master/demo/multiverse-demo.md -o "$HOME/.claude/commands/multiverse-demo.md"
echo "Done. In Claude Code: run /mcp, choose paybox, Authenticate. Then run /multiverse-demo"
