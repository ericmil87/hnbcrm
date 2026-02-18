# Contributing to HNBCRM

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- Node.js 18 or higher
- npm

## Development Setup

```bash
git clone https://github.com/ericmil87/hnbcrm.git
cd hnbcrm
npm install
npm run dev
```

This starts both the Vite frontend (port 5173) and the Convex backend in parallel.

## Project Structure

```
src/           React frontend (Vite, TailwindCSS, react-router v7)
convex/        Convex backend (queries, mutations, actions, HTTP API)
mcp-server/    MCP server for AI agent integration
public/        Static assets (logos)
```

## Code Style

- **TypeScript** everywhere — strict mode, always include type annotations for function args/returns
- **TailwindCSS** — dark theme first, mobile-first responsive (`md:`, `lg:` breakpoints)
- **PT-BR** — all user-facing text is in Portuguese (BR)
- **Convex rules** — see `CLAUDE.md` for mandatory backend patterns (validators, indexes, no `.filter()`, etc.)
- **Icons** — use `lucide-react`, never emoji

## Making Changes

1. Fork the repository
2. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
3. Make your changes
4. Run the full check:
   ```bash
   npm run lint
   ```
5. Commit with a descriptive message:
   ```bash
   git commit -m "feat: add widget to dashboard"
   ```
6. Push and open a Pull Request

## Commit Messages

Follow the convention used throughout the project:

| Prefix | Use for |
|--------|---------|
| `feat:` | New features |
| `fix:` | Bug fixes |
| `docs:` | Documentation changes |
| `refactor:` | Code restructuring without behavior change |
| `style:` | Formatting, styling changes |
| `chore:` | Build, tooling, dependency updates |

## Reporting Issues

When opening an issue, include:

- Steps to reproduce the problem
- Expected vs actual behavior
- Browser and OS (for frontend issues)
- Relevant error messages or console output

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `VITE_CONVEX_URL` | `.env.local` | Convex deployment URL (auto-set by `npx convex dev`) |
| `CONVEX_DEPLOYMENT` | `.env.local` | Convex deployment name (auto-set) |

For production deployment on Vercel, only `VITE_CONVEX_URL` needs to be set in the project settings.

## Notes

- No test framework is configured yet — contributions to set one up are welcome
- Seed data is available via `convex/seed.ts` for local development
- The HTTP API is documented in `convex/router.ts`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
