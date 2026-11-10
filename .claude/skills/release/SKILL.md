---
name: release
description: Ship a HNBCRM version — bump package version, write the PT-BR CHANGELOG entry, update docs/architecture and rules, update memory, verify CI, and publish to PROD via npm run deploy:prod. Use when asked to release, publish, bump or "fechar a versão".
disable-model-invocation: true
argument-hint: "[version or 'patch|minor'] [one-line summary]"
---

# Release checklist (HNBCRM)

1. **Green first**: `npx tsc -p convex && npx tsc -p tsconfig.app.json && npx tsc -p tsconfig.node.json && npm run test` (≈2.4k tests). CI mirrors this; `npm run lint` additionally pushes DEV — only run it when a schema/function push is intended.
2. **Version**: bump `package.json` (`version`) — the landing (`landing/OpenSourceSection`, `landing/Footer`) reads it through the build id (`versionFromBuild(APP_BUILD)`) and links to `CHANGELOG.md` on GitHub, so never hardcode a version in the UI — and `mcp-server/package.json` if the MCP surface changed. Convention: minor for features, patch for fixes/hotfixes.
3. **CHANGELOG.md** (PT-BR, user language, newest first): `## [x.y.z] - AAAA-MM-DD`, a `###` headline naming the user-visible outcome, bullets that say what changed for the user and why, internal ops named only when an operator must run them. Mirror the tone of existing entries; no code dumps.
4. **Docs with the code**: add the technical paragraph to `docs/architecture/<area>.md` ("Decisões, pegadinhas medidas e histórico", newest last, with version + date); add/adjust bullets in `.claude/rules/<area>.md` ONLY if a gotcha changes how code must be written; update `docs/*-STATUS.md` when the plan tracks phases; the root `CLAUDE.md` does not grow. Run `node scripts/claude/check-no-loss.mjs`.
5. **Commit** on a branch, PR, review (the `reviewer` agent or `/code-review`), merge to `main`. Commit messages in the repo's style (`area: what changed (vX.Y.Z)`), no AI attribution lines.
6. **Publish**: Vercel deploys ONLY the frontend on push to `main` (build = `vite build`); the backend goes to PROD only with `npm run deploy:prod` from this machine, BEFORE the merge when the frontend needs new functions/validators. `main` can hold backend commits not yet in PROD: check before deploying (e.g. `npx convex function-spec` with the PROD key) so you do not ship someone else's unreleased work by accident. Optionally tag `vX.Y.Z` and `gh release create` with the CHANGELOG section. After deploy: `npx convex logs --prod` for a minute; run any backfill the release needs (dry run first — see `/convex-ops`).
7. **Memory**: update the project memory entry (status → PUBLISHED, commit hash, pending validations).
