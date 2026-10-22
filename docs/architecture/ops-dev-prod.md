# Operação: comandos, CI e deployments dev × prod

> Texto movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (commit 1f51a2f). A versão condensada em inglês vive na raiz; este é o registro completo. Runbook: `docs/OPS-SEPARAR-DEV-PROD.md`.

## Comandos e testes

```bash
npm run dev              # Start frontend (Vite) + backend (Convex) in parallel
npm run dev:frontend     # Start only Vite dev server
npm run dev:backend      # Start only Convex dev server
npm run build            # Build frontend (vite build)
npm run convert-images   # Convert PNG images to WebP format
npm run lint             # Full check: tsc (convex + app) → convex dev --once (DEV) → vite build
npx convex dev --once    # Push schema/functions para o deployment DEV, sem watch
npm run deploy:prod      # Publica backend no PROD (lê a chave de convex-prod-key.env.local) — só com testes verdes
```

Tests: `npm run test` (vitest + convex-test; `*.test.ts` em `convex/`). Seed data is available via `convex/seed.ts`.

**CI (GitHub Actions, `.github/workflows/ci.yml`, v0.69):** roda em push/PR para `main` e em push de `ci/**`: `npm ci` → 3× `tsc` (convex, app, node) → `npm run test` (inclui `secretScan.test.ts`) → `npx vite build`, ~1,5 min, Node do `.nvmrc` (22). **Sem** `convex dev --once` de propósito — não há deployment nem chave no CI, por isso `npm run lint` NÃO serve de CI. A suíte não depende de `.env.local` (o build lê `VITE_CONVEX_URL` com fallback vazio). Único teste sensível a carga com `{ retry: 2 }` pontual: `groupMediaPolicy.test.ts` ("fetch do sob demanda tem timeout menor que a trava") — não mudar o tempo. O `visualizer` do `vite.config.ts` só abre o `stats.html` fora do CI (`open: !process.env.CI`).

## Deployments: dev × prod (separados desde 02/10/2026)

| | **Prod** | **Dev** |
|---|---|---|
| Deployment | `careful-anaconda-127` (`https://careful-anaconda-127.convex.cloud` / `.convex.site`) | `tacit-chicken-195` |
| Quem usa | **hnbcrm.com** (Vercel) e os clientes reais | desenvolvimento, testes e demos (org e conta de demo: ver `CLAUDE.local.md`, fora do git) |
| Como publicar | `npm run deploy:prod` daqui, ou automaticamente pelo Vercel a cada push na `main`. Build Command do Vercel (condicional, verificado em 02/10/2026): `if [ -n "$CONVEX_DEPLOY_KEY" ]; then npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL; else npm run build; fi` — com a chave (só em Production) publica backend+front; sem ela (Preview) só faz o build do front apontando para o `VITE_CONVEX_URL` do ambiente (Preview = dev). Preview de branch = `hnbcrm-repo-git-<branch>-elevatepro.vercel.app` | `npx convex dev` / `npx convex dev --once` (o `.env.local` tem `CONVEX_DEPLOYMENT=dev:tacit-chicken-195`) |
| Chave | `convex-prod-key.env.local` (gitignored, nunca commitar) | admin key local em `CONVEX_DEV_ADMIN_KEY` no `.env.local` (usada pelo simulador da demo). **Nunca** a chame de `CONVEX_DEPLOY_KEY`: com esse nome presente, `npx convex deploy` cairia no dev |
| Estado | dados reais, envs reais, webhooks (bridge/Resend) apontam para cá | **neutralizado**: `RESEND_TEST_MODE=true`, canais desarmados sem credenciais, cópia congelada dos dados reais de 02/10 (purga pendente) |

**Regras:** (1) `convex dev`/`convex run` sem flag = DEV; para o prod use `--prod` (`npx convex run --prod …`, `npx convex env … --prod`, `npx convex data … --prod`, `npx convex logs --prod`). **Pegadinha medida (CLI 1.31.2): `convex data` e `convex logs` IGNORAM `CONVEX_DEPLOY_KEY`** e leem o dev; só `--prod` muda o alvo (`env`, `deploy`, `import`, `export` e `run` honram a chave). (2) Schema só aditivo entre dev e prod — os dois precisam aceitar os mesmos documentos. (3) Op em prod sempre com `dryRun` antes. (4) Runbook da separação, ops de migração (`convex/opsMigration.ts`: re-apontar webhooks do bridge, reaplicar HMAC, desarmar canais, cancelar/re-armar agendadas, reenviar saídas travadas) e registro do que foi feito em `docs/OPS-SEPARAR-DEV-PROD.md`. (5) Restore de backup do Convex NÃO traz funções agendadas nem envs: após qualquer restore, rodar `internalRearmScheduledMessages`, `internalRearmGroupPosts` e `internalRedispatchStuckOutbound`.

## Notas vindas de convex/CLAUDE.md (22/10/2026)

Trechos movidos literalmente do `convex/CLAUDE.md` ao enxugá-lo (identificadores que não existiam em nenhum outro lugar).

> **Dois deployments desde 02/10/2026:** PROD `careful-anaconda-127` (hnbcrm.com, clientes reais) e DEV `tacit-chicken-195`
> (desenvolvimento/demos, neutralizado). `npx convex dev|run|data|logs` sem flag = DEV; prod = `npm run deploy:prod` /
> `--prod`. `convex data`/`convex logs` ignoram a deploy key — use `--prod`. Detalhes na seção "Deployments" do CLAUDE.md
> da raiz e em `docs/OPS-SEPARAR-DEV-PROD.md`.
- `opsMigration.ts` — Ops internas de separação dev/prod e pós-restore (re-apontar webhooks do bridge — `webhookurl`! —, reaplicar HMAC nas instâncias, desarmar canais do deployment-cópia, cancelar/re-armar agendadas, re-armar publicações de grupo, reenviar saídas travadas); todas com `dryRun` default true
