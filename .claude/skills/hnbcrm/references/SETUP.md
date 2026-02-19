# HNBCRM Setup Guide

How to connect AI agents to HNBCRM across different platforms.

---

## Prerequisites

1. A running HNBCRM instance (Convex deployment)
2. An API key — generate from **Settings > API Keys** in the HNBCRM UI

You'll need two values:

| Variable | Example |
|----------|---------|
| `HNBCRM_API_URL` | `https://your-app.convex.site` |
| `HNBCRM_API_KEY` | `hc_abc123...` |

---

## Platform Configuration

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Desktop

Add to the Claude config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Gemini CLI

Set environment variables before running:

```bash
export HNBCRM_API_URL="https://your-app.convex.site"
export HNBCRM_API_KEY="your-api-key"
```

Then configure MCP in `~/.gemini/settings.json` (or your project config) following Gemini's MCP setup guide.

### OpenClaw

1. Install the MCP server:

```bash
npm install -g hnbcrm-mcp
```

2. Configure MCP in your OpenClaw settings:

```json
{
  "mcpServers": {
    "hnbcrm": {
      "command": "npx",
      "args": ["-y", "hnbcrm-mcp"],
      "env": {
        "HNBCRM_API_URL": "https://your-app.convex.site",
        "HNBCRM_API_KEY": "your-api-key"
      }
    }
  }
}
```

3. Copy the skill directory to your OpenClaw workspace:

```bash
cp -r .claude/skills/hnbcrm/ ~/.openclaw/workspace/skills/hnbcrm/
```

The agent will automatically detect the skill and begin the bootstrap sequence (discover team, learn pipeline, check handoffs, review leads).

### REST-Only (No MCP)

If your platform doesn't support MCP, you can use the REST API directly. Set environment variables:

```bash
export HNBCRM_API_URL="https://your-app.convex.site"
export HNBCRM_API_KEY="your-api-key"
```

Then make HTTP requests to `/api/v1/*` with the `X-API-Key` header:

```bash
curl -H "X-API-Key: $HNBCRM_API_KEY" "$HNBCRM_API_URL/api/v1/team-members"
```

See [API Reference](API_REFERENCE.md) for all available endpoints.

---

## Verifying Your Connection

Run the included verification script:

```bash
HNBCRM_API_URL="https://your-app.convex.site" \
HNBCRM_API_KEY="your-api-key" \
bash .claude/skills/hnbcrm/scripts/verify-connection.sh
```

Or test manually:

```bash
curl -s -H "X-API-Key: YOUR_KEY" https://your-app.convex.site/api/v1/team-members | jq .
```

You should see a list of team members in the response.

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `Missing required environment variables` | Ensure both `HNBCRM_API_URL` and `HNBCRM_API_KEY` are set |
| `Invalid API key` | Generate a new key from Settings > API Keys in the HNBCRM UI |
| `Connection refused` | Check that `HNBCRM_API_URL` points to your Convex `.convex.site` domain |
| `MCP tools not appearing` | Restart your IDE/agent after adding the MCP config |
| `CORS errors` | REST API includes CORS headers — ensure you're using the correct URL |
