---
name: release
description: Ship a HNBCRM version — bump package version, write the PT-BR CHANGELOG entry, update docs/architecture and rules, update memory, verify CI, and publish to PROD via npm run deploy:prod. Use when asked to release, publish, bump or "fechar a versão".
disable-model-invocation: true
argument-hint: "[version or 'patch|minor'] [one-line summary]"
---

# Release checklist (HNBCRM)

1. **Green first**: `npx tsc -p convex && npx tsc -p tsconfig.app.json && npx tsc -p tsconfig.node.json && npm run test` (≈2.4k tests). CI mirrors this; `npm run lint` additionally pushes DEV — only run it when a schema/function push is intended.
2. **Version**: bump `package.json` (`version`) and `mcp-server/package.json` if the MCP surface changed. Convention: minor for features, patch for fixes/hotfixes.
3. **CHANGELOG.md** (PT-BR, user language, newest first): `## [x.y.z] - AAAA-MM-DD`, a `###` headline naming the user-visible outcome, bullets that say what changed for the user and why, internal ops named only when an operator must run them. Mirror the tone of existing entries; no code dumps.
4. **Docs with the code**: add the technical paragraph to `docs/architecture/<area>.md` ("Decisões, pegadinhas medidas e histórico", newest last, with version + date); add/adjust bullets in `.claude/rules/<area>.md` ONLY if a gotcha changes how code must be written; update `docs/*-STATUS.md` when the plan tracks phases; the root `CLAUDE.md` does not grow. Run `node scripts/claude/check-no-loss.mjs`.
5. **Commit** on a branch, PR, review (the `reviewer` agent or `/code-review`), merge to `main`. Commit messages in the repo's style (`area: what changed (vX.Y.Z)`), no AI attribution lines.
6. **Publish**: Vercel deploys front + backend on push to `main` (build command with `CONVEX_DEPLOY_KEY`), or `npm run deploy:prod` from this machine. After deploy: `npx convex logs --prod` for a minute; run any backfill the release needs (dry run first — see `/convex-ops`).
7. **Memory**: update the project memory entry (status → PUBLISHED, commit hash, pending validations).
