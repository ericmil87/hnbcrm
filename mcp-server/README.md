# HNBCRM MCP Server

[![npm version](https://img.shields.io/npm/v/hnbcrm-mcp.svg)](https://www.npmjs.com/package/hnbcrm-mcp)

MCP (Model Context Protocol) server for [HNBCRM](https://github.com/hnbcrm/hnbcrm) — the CRM where humans and AI agents work together. Provides **46 tools across 9 categories** to manage leads, contacts, pipeline, tasks, calendar, and notification preferences via AI agents.

## Prerequisites

- Node.js 18 or later
- A HNBCRM instance with a valid API key (generate one from Settings > API Keys)

## Installation

Run directly with npx:

```bash
npx hnbcrm-mcp
```

Or install globally:

```bash
npm install -g hnbcrm-mcp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HNBCRM_API_URL` | Yes | Your Convex deployment URL (e.g. `https://your-app.convex.site`) |
| `HNBCRM_API_KEY` | Yes | API key generated from HNBCRM Settings |

## Configuration

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Add to your VS Code settings or workspace `.vscode/mcp.json`:

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

### OpenClaw

Add to your OpenClaw MCP configuration:

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

To also install the agent skill:

```bash
cp -r .claude/skills/hnbcrm/ ~/.openclaw/workspace/skills/hnbcrm/
```

## Tools Reference

### Leads (7 tools)

| Tool | Description |
|------|-------------|
| `crm_create_lead` | Create a new lead with optional contact and initial message |
| `crm_list_leads` | List leads, filtered by board, stage, or assignee |
| `crm_get_lead` | Get full details of a specific lead |
| `crm_update_lead` | Update lead properties (title, value, priority, tags, etc.) |
| `crm_delete_lead` | Permanently delete a lead |
| `crm_move_lead` | Move a lead to a different pipeline stage |
| `crm_assign_lead` | Assign a lead to a team member or unassign |

### Contacts (7 tools)

| Tool | Description |
|------|-------------|
| `crm_list_contacts` | List all contacts in the organization |
| `crm_get_contact` | Get full contact details including enrichment data |
| `crm_create_contact` | Create a new contact |
| `crm_update_contact` | Update contact information |
| `crm_enrich_contact` | Write enrichment data (fields + source + confidence) to a contact |
| `crm_get_contact_gaps` | Get which fields are missing on a contact |
| `crm_search_contacts` | Search contacts by name, email, or company |

### Conversations (3 tools)

| Tool | Description |
|------|-------------|
| `crm_list_conversations` | List conversations, optionally filtered by lead |
| `crm_get_messages` | Get all messages in a conversation thread |
| `crm_send_message` | Send a message or internal note in a conversation |

### Handoffs (4 tools)

| Tool | Description |
|------|-------------|
| `crm_request_handoff` | Request AI-to-human handoff for a lead |
| `crm_list_handoffs` | List handoff requests by status |
| `crm_accept_handoff` | Accept a pending handoff |
| `crm_reject_handoff` | Reject a pending handoff with optional feedback |

### Pipeline & Analytics (3 tools)

| Tool | Description |
|------|-------------|
| `crm_list_boards` | List pipeline boards and their stages |
| `crm_list_team` | List team members (humans and AI agents) |
| `crm_get_dashboard` | Get pipeline analytics (stages, sources, team, handoffs) |

### Activities (2 tools)

| Tool | Description |
|------|-------------|
| `crm_get_activities` | Get activity timeline for a lead |
| `crm_create_activity` | Log a note, call, or email on a lead |

### Tasks (12 tools)

| Tool | Description |
|------|-------------|
| `crm_create_task` | Create a task with optional checklist and recurrence |
| `crm_list_tasks` | List tasks with filtering and pagination |
| `crm_get_task` | Get full task details |
| `crm_update_task` | Update task properties |
| `crm_complete_task` | Mark a task as complete |
| `crm_delete_task` | Delete a task |
| `crm_list_my_tasks` | Get the agent's task queue sorted by urgency |
| `crm_snooze_task` | Reschedule a task reminder |
| `crm_add_task_comment` | Add a comment to a task |
| `crm_list_task_comments` | Get comments on a task |
| `crm_search_tasks` | Search tasks by text |
| `crm_bulk_complete_tasks` | Batch complete multiple tasks |

### Calendar (6 tools)

| Tool | Description |
|------|-------------|
| `calendar_list_events` | List events in a date range with filters |
| `calendar_create_event` | Create an event with attendees, recurrence, and meeting URL |
| `calendar_get_event` | Get event details |
| `calendar_update_event` | Update event properties |
| `calendar_delete_event` | Delete an event |
| `calendar_reschedule_event` | Quickly reschedule an event |

### Notifications (2 tools)

| Tool | Description |
|------|-------------|
| `crm_get_notification_preferences` | Get email notification preferences for the current agent |
| `crm_update_notification_preferences` | Update email notification preferences (e.g., disable dailyDigest) |

## Resources

| URI | Description |
|-----|-------------|
| `hnbcrm://boards` | Pipeline boards and stages (JSON) |
| `hnbcrm://team` | Team members in the organization (JSON) |
| `hnbcrm://fields` | Custom field definitions (JSON) |
| `hnbcrm://lead-sources` | Lead sources configured in the organization (JSON) |

## Agent Skills

HNBCRM also ships an open Agent Skill (following the [AgentSkills.io](https://agentskills.io) standard) with detailed workflows, data model reference, and multi-platform setup guides. Find it at `.claude/skills/hnbcrm/` in the main repository.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode
npm run dev
```

## License

[MIT](LICENSE)
