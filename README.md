<p align="center">
  <img src="public/orange_icon_logo_transparent-bg-528x488.png" alt="HNBCRM" width="120" />
</p>

<h1 align="center">HNBCRM</h1>

<p align="center">
  <strong>The CRM where humans and AI agents work together.</strong>
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.22.0-brand" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-blue" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB" />
</p>

---

HNBCRM (Humans & Bots CRM) is a multi-tenant CRM built for teams that combine human agents and AI bots. Leads, conversations, and handoffs flow seamlessly between people and machines through a shared pipeline, unified inbox, and real-time collaboration tools.

<!-- TODO: Add screenshot or demo GIF here -->

## Features

- **AI-Human Collaboration** — Human team members and AI bots are equal participants with shared context
- **Visual Pipeline** — Kanban boards with drag-and-drop, customizable stages, and deal aging indicators
- **Unified Inbox** — WhatsApp, Telegram, email conversations in one place with internal notes
- **Smart Handoffs** — Transfer leads between humans and AI with full conversation history
- **Contact Enrichment** — 20+ fields with social profiles, company data, and custom fields
- **REST API** — Full CRUD at `/api/v1/` with API key authentication and HMAC webhooks
- **MCP Server** — AI agents connect via Model Context Protocol with 26 tools for full CRM access
- **Agent Skills** — Open skill package (AgentSkills.io standard) with workflows, data model, and setup guides
- **Multi-tenant** — Organization-level isolation with role-based access (Admin, Manager, Agent, AI)
- **Real-time** — Powered by Convex for instant updates across all connected clients
- **Calendar** — Day/week/month views with drag-to-reschedule and task integration
- **@Mentions** — Tag team members in internal notes with autocomplete
- **File Storage** — Message attachments, contact photos, lead documents with quota management
- **Embeddable Forms** — WYSIWYG form builder with public URLs, CRM field mapping, spam protection, and embed codes

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | [React 19](https://react.dev) + [TypeScript](https://typescriptlang.org) + [Vite](https://vite.dev) |
| Styling | [TailwindCSS](https://tailwindcss.com) (dark theme, mobile-first) |
| Routing | [react-router v7](https://reactrouter.com) |
| Backend | [Convex](https://convex.dev) (real-time queries, mutations, actions, HTTP endpoints) |
| Auth | [@convex-dev/auth](https://auth.convex.dev) (Email/Password + Anonymous) |
| Drag & Drop | [@dnd-kit](https://dndkit.com) |
| Icons | [Lucide React](https://lucide.dev) |

## Quick Start

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/ericmil87/hnbcrm.git
cd hnbcrm
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The app starts with an anonymous sign-in option for quick exploration.

To populate the database with sample data, run the `seedMockData` mutation from the [Convex dashboard](https://dashboard.convex.dev) or trigger it programmatically.

## Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend (Vite) + backend (Convex) in parallel |
| `npm run dev:frontend` | Start only the Vite dev server |
| `npm run dev:backend` | Start only the Convex dev server |
| `npm run build` | Production build (Vite) |
| `npm run lint` | Full check: TypeScript + Convex deploy + Vite build |

## Project Structure

```
src/
  components/       UI components (pages, layout, ui primitives)
  pages/            Public pages (DevelopersPage)
  lib/              Utilities (routes, mentions, cn())
convex/
  schema.ts         All table definitions and indexes
  router.ts         REST API endpoints (/api/v1/*)
  leads.ts          Lead CRUD, stage moves, assignment
  calendar.ts       Calendar events (time-ranged) CRUD
  contacts.ts       Contact CRUD with enrichment
  conversations.ts  Multi-channel messaging
  handoffs.ts       AI-to-human handoff workflow
  llmsTxt.ts        /llms.txt endpoint content
  seed.ts           Development seed data
mcp-server/         MCP server package (hnbcrm-mcp)
.claude/skills/     Agent Skill (workflows, data model, setup)
public/             Logo assets
```

## API & Integrations

**REST API** — RESTful endpoints at `/api/v1/` authenticated via `X-API-Key` header. Covers leads, contacts, conversations, handoffs, boards, and team members. See `convex/router.ts` for the full reference.

**MCP Server** — The `mcp-server/` directory contains an MCP server (`hnbcrm-mcp`) with 26 tools and 4 resources for AI agent integration. See [mcp-server/README.md](mcp-server/README.md) for setup.

**Agent Skills** — The `.claude/skills/hnbcrm/` directory contains a portable Agent Skill following the [AgentSkills.io](https://agentskills.io) open standard. Includes workflows, data model reference, API mapping, and platform setup guides. Copy the skill into any compatible agent workspace to get started.

**Webhooks** — HMAC-SHA256 signed webhook events for lead, conversation, and handoff state changes.

**llms.txt** — AI-readable documentation at `/llms.txt` (summary) and `/llms-full.txt` (full reference) for LLM-powered tools and agents.

## Email Setup (Resend)

HNBCRM uses [@convex-dev/resend](https://github.com/get-convex/convex-resend) for transactional email delivery. The system sends notifications for team invites, handoff requests, task assignments, lead assignments, overdue reminders, and daily digests.

### Domain Configuration

Since the primary domain (`hnbcrm.com`) uses Gmail for sending/receiving, Resend is configured on a **subdomain** (`mail.hnbcrm.com`) to avoid MX/SPF conflicts.

**Steps:**

1. **Resend Dashboard** → Domains → Add Domain → `mail.hnbcrm.com`
2. **Cloudflare DNS** — Add the records Resend provides:
   - 3x CNAME records for DKIM (e.g., `resend._domainkey.mail.hnbcrm.com`)
   - 1x TXT record for SPF on `mail.hnbcrm.com`
   - 1x TXT record for DMARC (if not already on root domain)
3. **Verify** in Resend dashboard (near-instant with Cloudflare)

### Environment Variables

```bash
npx convex env set RESEND_API_KEY re_xxxxx
npx convex env set APP_URL https://app.hnbcrm.com.br
npx convex env set RESEND_FROM_EMAIL "HNBCRM <noreply@mail.hnbcrm.com>"
npx convex env set RESEND_WEBHOOK_SECRET whsec_xxxxx   # after webhook setup
```

### Webhook Setup

1. In the Resend dashboard, create a webhook pointing to:
   `https://<your-convex-deployment>.convex.site/api/v1/webhooks/resend`
2. Enable all `email.*` events
3. Copy the signing secret to `RESEND_WEBHOOK_SECRET`

### Test Mode

By default, `@convex-dev/resend` runs in **test mode** — only Resend test addresses receive emails. To enable production sending, update `convex/email.ts`:

```typescript
export const resend: Resend = new Resend(components.resend, {
  testMode: false,  // Enable real email delivery
  onEmailEvent: internal.email.handleEmailEvent,
});
```

### Architecture

- **Central dispatch**: `convex/email.ts` → `internal.email.dispatchNotification`
- **Templates**: `convex/emailTemplates.ts` (8 PT-BR templates, dark theme)
- **Preferences**: `notificationPreferences` table (opt-out model)
- **Daily digest**: Cron at 08:00 BRT via `convex/crons.ts`

## Deploy

The backend runs on [Convex Cloud](https://convex.dev) — no infrastructure to manage. The frontend is a static SPA that can be deployed anywhere.

### Vercel (recommended)

1. Import the repo on [vercel.com/new](https://vercel.com/new)
2. Set the environment variable:

   | Variable | Value |
   |----------|-------|
   | `VITE_CONVEX_URL` | Your Convex deployment URL (e.g. `https://your-app.convex.cloud`) |

3. Deploy — Vercel auto-detects Vite, uses `npm run build`, outputs from `dist/`

The included `vercel.json` handles SPA routing (all paths fallback to `index.html`).

### Convex Production

To deploy Convex functions to production:

```bash
npx convex deploy
```

See [Convex Hosting & Deployment](https://docs.convex.dev/production/) for details.

## UI Language

The interface is in **Portuguese (PT-BR)**. English localization is planned.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

## Acknowledgments

Built with [Convex](https://convex.dev), [Lucide](https://lucide.dev), [@dnd-kit](https://dndkit.com), and [Sonner](https://sonner.emilkowal.dev).
