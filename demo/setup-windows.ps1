# Installs the /multiverse-demo command for Claude Code and connects the PayBox MCP server.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Write-Host "Claude Code CLI not found. Install it first: npm install -g @anthropic-ai/claude-code"; exit 1 }
claude mcp add --transport http --scope user paybox https://api.paybox.sh/mcp
New-Item -ItemType Directory -Force "$HOME\.claude\commands" | Out-Null
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/bahramgg/Paybox/master/demo/multiverse-demo.md -OutFile "$HOME\.claude\commands\multiverse-demo.md"
Write-Host "Done. In Claude Code: run /mcp, choose paybox, Authenticate. Then run /multiverse-demo"
