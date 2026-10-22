<p align="center">
  <img src="public/orange_icon_logo_transparent-bg-528x488.png" alt="HNBCRM" width="120" />
</p>

<h1 align="center">HNBCRM</h1>

<p align="center">
  <strong>The CRM where humans and AI agents work together.</strong>
</p>

<p align="center">
  <a href="https://github.com/ericmil87/hnbcrm/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/ericmil87/hnbcrm/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.68.0-brand" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-blue" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB" />
</p>

---

HNBCRM (Humans & Bots CRM) is a multi-tenant CRM built for teams that combine human agents and AI bots. Leads, conversations, and handoffs flow seamlessly between people and machines through a shared pipeline, unified inbox, and real-time collaboration tools.

<!-- TODO: Add screenshot or demo GIF here -->

## Features

- **AI-Human Collaboration** — Human team members and AI bots are equal participants with shared context
- **AI Copilot** — In-app assistant (opt-in per org) that reads and edits the CRM as the logged-in user (their RBAC), with streaming chat, tool use, and two-phase confirmation for destructive actions, and a floating button you can drag (and that remembers its position) so it never covers the composer
- **AI WhatsApp Attendant** — Virtual attendant that drafts replies to customers (suggest mode with human review by default; autopilot gated behind acceptance metrics), with per-record scoping, LGPD disclosure, deterministic human-handoff keywords, configurable pipeline rules and an anti-bot guardrail (stops replying to auto-responders, newsletters or other AI assistants, opens a handoff for a human to verify and tags the lead — on by default)
- **Anti-ban Send Queue** — Two-level pacing per conversation (Meta pair rate) and per phone number, humanized typing simulation on unofficial channels, official 4^X retry backoff, and automatic channel freeze on quality flags
- **Visual Pipeline** — Kanban boards with drag-and-drop, customizable stages, and deal aging indicators
- **Unified Inbox** — Multi-channel conversations with internal notes, reactions, replies/forwarding, emoji picker, full-text message search (including voice transcripts), quick replies (`/` shortcuts), scheduled messages with live countdown, labels & archiving with bulk actions, starting a conversation from the inbox (new or existing contact; the lead is reused or created in the chosen pipeline; the number is verified against WhatsApp on the unofficial gateway; explicit acknowledgement for opted-out numbers) and permanent lead deletion from the conversation menu
- **WhatsApp Channel** — Official Cloud API (24h window, templates) or self-hosted gateway (QR pairing), with media, voice notes, delivery/read ticks, typing presence both ways, and a channel health panel. Messages typed in the phone's own WhatsApp app are captured too, so the inbox matches the real conversation. A number can be active in only one account: pairing it elsewhere unlinks the previous device automatically, with a warning. Phone numbers are international: each organization sets a default country (Settings → Organization profile) applied to numbers typed without a country code, while `+`/`00` numbers keep their own country rules
- **WhatsApp Groups** (self-hosted gateway only) — Follow group rooms opt-in per group (members never become contacts/leads automatically), with AI mention/keyword replies, scheduled posts, and campaign audiences. Media downloads follow a per-type policy (image/audio/video/document: always, only when directed at us — the default — or never), set per number with per-group overrides; anything skipped stays downloadable on demand for 14 days instead of failing
- **Voice Transcription** — Self-hosted Whisper service transcribes voice notes locally (opt-in per org, no paid API), transcripts are searchable
- **Smart Handoffs** — Transfer leads between humans and AI with full conversation history
- **Contact Enrichment** — 20+ fields with social profiles, company data, and custom fields
- **Data Export/Import** — Per-entity CSV exports (denormalized columns + custom fields, BOM, formula-injection safe) and versioned full-org JSON backup (secrets always stripped, LGPD art. 18 portability); CSV import wizard for contacts and leads with PT-BR/EN header mapping suggestions, dry-run preview, duplicate strategies, and one-click rollback
- **REST API** — Full CRUD at `/api/v1/` with API key authentication, per-route RBAC enforcement (mirrors in-app permissions, fail-closed 403), 300 req/min rate limit per key, and HMAC webhooks
- **MCP Server** — AI agents connect via Model Context Protocol with 68 tools for full CRM access (leads, pipeline, tasks, calendar, WhatsApp campaigns, WhatsApp groups)
- **Agent Skills** — Open skill package (AgentSkills.io standard) with workflows, data model, and setup guides
- **Multi-tenant** — Organization-level isolation with role-based access (Admin, Manager, Agent, AI)
- **Real-time** — Powered by Convex for instant updates across all connected clients
- **Task Manager** — Projects with customizable kanban columns, colored labels, multiple assignees (human or AI), real subtasks with progress, informational dependencies, early + due-date reminders, @mentions, in-app notification bell, and saved filters
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

To populate the DEV database with sample data, run the internal mutation from the CLI: `npx convex run seed:seedMockData '{"organizationId":"<id>"}'`. It is an `internalMutation` on purpose and can never be called from a client.

## Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Start frontend (Vite) + backend (Convex) in parallel |
| `npm run dev:frontend` | Start only the Vite dev server |
| `npm run dev:backend` | Start only the Convex dev server |
| `npm run build` | Production build (Vite) |
| `npm run test` | Test suite (vitest + convex-test, ~2.4k tests) |
| `npm run lint` | Full check: TypeScript + Convex push to the **dev** deployment + Vite build |

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
  conversations.ts  Multi-channel messaging, labels, message search
  whatsapp.ts       WhatsApp ingress + outbound dispatch (Cloud API / bridge)
  transcription.ts  Voice-note transcription (self-hosted Whisper)
  quickReplies.ts   Quick replies ("/" shortcuts in the composer)
  scheduledMessages.ts  Scheduled message delivery
  handoffs.ts       AI-to-human handoff workflow
  attendant.ts      AI WhatsApp attendant (queue, eligibility, transactional commits)
  copilot.ts        AI copilot tools + threads (SSE streaming in copilotHttp.ts)
  aiSettings.ts     Org AI config: activation + LGPD ack, toggles, models, budget
  lib/llm/          Provider-agnostic LLM layer (OpenAI-compatible, ZDR registry)
  lib/whatsappDispatch.ts  Two-level anti-burst send pacing + humanized typing
  llmsTxt.ts        /llms.txt endpoint content
  seed.ts           Development seed data
mcp-server/         MCP server package (hnbcrm-mcp)
docs/architecture/  Decisions, measured gotchas and version history per area (index: README.md)
.claude/rules/      Path-scoped rules for Claude Code (Convex, backend invariants, bridge, AI, frontend, tests)
.claude/agents/     Project subagents (frontend-specialist, convex-backend, reviewer)
.claude/skills/     Skills: hnbcrm (operate the CRM via MCP), convex-ops, release, review-checklist
scripts/claude/     Hook scripts and the docs no-loss guard
public/             Logo assets
```

### Working with Claude Code

The repo is set up so that each agent only pays for the context it needs. The root `CLAUDE.md` is short (stack, commands, dev × prod, invariants); everything else loads on demand: `convex/CLAUDE.md` and `src/CLAUDE.md` when files in those folders are touched, `.claude/rules/*.md` by path glob, and `docs/architecture/<area>.md` holds the decisions and measured gotchas to read before changing an area. `scripts/claude/check-no-loss.mjs` (run in CI) guarantees nothing from that documentation disappears. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Orchestrate with Fable, delegate to Opus/Sonnet.** The main session runs on Fable (the default model in `~/.claude/settings.json`) and acts as the orchestrator: it holds the conversation with you, reads the plan, splits the work, reviews what comes back and keeps the summary. Delegate anything that is well-specified or read-heavy so the orchestrator's context stays small:

| Task | Delegate to | Why |
|---|---|---|
| Find where something lives, sweep many files | built-in `Explore` (Sonnet) | read-only, skips `CLAUDE.md`, returns only the conclusion |
| Design an implementation strategy | built-in `Plan` (Opus) | read-only, returns the plan and critical files |
| Research docs, libraries, vendors, best practices | `scout` (web) or `claude-code-guide` (Claude Code itself) | reports with sources, no repo context needed |
| Implement a UI change under `src/` | `frontend-specialist` (Sonnet) | gets `.claude/rules/frontend.md` + `src/CLAUDE.md` automatically, nothing else |
| Implement a backend change under `convex/` | `convex-backend` (Sonnet) | gets the Convex rules, backend invariants and the area rule (bridge, AI, tests) by path |
| Review a diff or a branch before merge | `reviewer` (Opus, read-only) | preloads the review checklist; findings ranked, never edits |
| Mechanical multi-file edits, scripts, cleanups | `general-purpose` with `model: sonnet` | cheap, gets the full `CLAUDE.md` |
| Risky or long experiments (upgrades, migrations) | any agent with `isolation: worktree` | works on its own checkout and branch; nothing touches `main` |

Rules of thumb that make this cheap and safe:

- **One brief per agent, written for a peer**: goal, what is already ruled out, the files and docs to read, the explicit scope, and what to report back. The agent sees nothing else.
- **Fan out independent work in one message** (several `Agent` calls at once); keep dependent work sequential. Keep the orchestrator out of the file dumps — ask agents for conclusions, not contents.
- **Review before merge, always**: the implementer and the reviewer are different agents (Sonnet writes, Opus reads). The reviewer caught two real bugs in the first script written this way.
- **Rules only load through Read/Edit**: an agent that `cat`s a file via Bash gets no path rules. Implementers should open files with the Read tool.
- **Nobody runs deployments**: `npx convex dev`, `deploy`, `--prod` are for the human. Agents typecheck (`npx tsc -p convex`, `npx tsc -p tsconfig.app.json`) and run `npx vitest run <file>`. `/convex-ops` is the runbook when you do need an operation, `/release` when shipping a version.
- **Measure**: `/context` shows what is loaded; a headless `claude -p "ok" --output-format json` prints the exact token count of the initial context (≈36k today, was ≈103k before this layout).

**Frontend work.** Say what the user should see, in PT-BR, and where (`/app/<route>`). The frontend agent reuses `src/components/ui/` primitives, keeps the URL as the source of truth for deep links, gates UI with `usePermissions`/`PermissionGate`, and puts pure logic in `src/lib/*.ts` with a vitest next to it. `STYLE_GUIDE.md` is the full design system when a token or component detail is missing from the rule.

**Backend work.** Point the agent at the area file in `docs/architecture/` and the single port it must extend (`moveLeadToStageCore`, `createHandoffCore`, `sendTransactionalEmail`, `scheduleWebhookEvent`, `convex/lib/phone.ts`…). Every public function starts with `requireAuth`/`requirePermission`, every change is additive to the schema, every ops function is `internal*` with `dryRun` and a cursor. Tests are convex-test (`convex/*.test.ts`); build-guard tests exist on purpose and must not be deleted.

**Keeping it this way.** A new feature adds one paragraph to `docs/architecture/<area>.md`, at most a few bullets to `.claude/rules/<area>.md`, a PT-BR entry to `CHANGELOG.md`, and zero lines to the root `CLAUDE.md`. The no-loss guard fails CI if documentation goes missing.

## API & Integrations

**REST API** — RESTful endpoints at `/api/v1/` authenticated via `X-API-Key` header. Covers leads, contacts, conversations, handoffs, tasks, calendar, boards, team members, and data export/import. Every route enforces the RBAC permission of the key's member (fail-closed, 403), rate-limited at 300 req/min per key. Route → permission table at `/llms-full.txt`; OpenAPI spec at `/openapi.json`. See `convex/router.ts` for the source of truth.

**MCP Server** — The `mcp-server/` directory contains an MCP server (`hnbcrm-mcp`) with 68 tools and 4 resources for AI agent integration. See [mcp-server/README.md](mcp-server/README.md) for setup.

**Agent Skills** — The `.claude/skills/hnbcrm/` directory contains a portable Agent Skill following the [AgentSkills.io](https://agentskills.io) open standard. Includes workflows, data model reference, API mapping, and platform setup guides. Copy the skill into any compatible agent workspace — [Hermes Agent](https://github.com/NousResearch/hermes-agent) (`~/.hermes/skills/`), Claude Code, Cursor, OpenClaw, and more.

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

Dev and prod are separate Convex deployments. Backend goes to production either automatically (Vercel runs
`npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL` on every push to `main`, with
`CONVEX_DEPLOY_KEY` set only for the Production environment) or manually:

```bash
npm run deploy:prod   # reads the prod deploy key from convex-prod-key.env.local (gitignored)
```

Local `npx convex dev` always targets the dev deployment. See `docs/OPS-SEPARAR-DEV-PROD.md` for the runbook.

See [Convex Hosting & Deployment](https://docs.convex.dev/production/) for details.

## UI Language

The interface is in **Portuguese (PT-BR)**. English localization is planned.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

## Acknowledgments

Built with [Convex](https://convex.dev), [Lucide](https://lucide.dev), [@dnd-kit](https://dndkit.com), and [Sonner](https://sonner.emilkowal.dev).
