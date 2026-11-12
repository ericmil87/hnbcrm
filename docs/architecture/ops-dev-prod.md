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
                         # o arquivo pode ser a chave CRUA (`prod:…|…`) ou `CONVEX_DEPLOY_KEY=…`; chave que não começa com `prod:` é recusada (v0.72.1)
```

Tests: `npm run test` (vitest + convex-test; `*.test.ts` em `convex/`). Seed data is available via `convex/seed.ts`.

**CI (GitHub Actions, `.github/workflows/ci.yml`, v0.69):** roda em push/PR para `main` e em push de `ci/**`: `npm ci` → 3× `tsc` (convex, app, node) → `npm run test` (inclui `secretScan.test.ts`) → `npx vite build`, ~1,5 min, Node do `.nvmrc` (22). Atualização 11/2026 (P2.2): o `.nvmrc` passou de 22 para 24 e hoje vale 24, igual ao runtime das actions Node fixado em `convex.json` (ver "Versão do Node" abaixo); o 22 desta frase é o valor histórico da v0.69. **Sem** `convex dev --once` de propósito — não há deployment nem chave no CI, por isso `npm run lint` NÃO serve de CI. A suíte não depende de `.env.local` (o build lê `VITE_CONVEX_URL` com fallback vazio). Único teste sensível a carga com `{ retry: 2 }` pontual: `groupMediaPolicy.test.ts` ("fetch do sob demanda tem timeout menor que a trava") — não mudar o tempo. O `visualizer` do `vite.config.ts` só abre o `stats.html` fora do CI (`open: !process.env.CI`).

## Deployments: dev × prod (separados desde 02/10/2026)

| | **Prod** | **Dev** |
|---|---|---|
| Deployment | `careful-anaconda-127` (`https://careful-anaconda-127.convex.cloud` / `.convex.site`) | `tacit-chicken-195` |
| Quem usa | **hnbcrm.com** (Vercel) e os clientes reais | desenvolvimento, testes e demos (org e conta de demo: ver `CLAUDE.local.md`, fora do git) |
| Como publicar | `npm run deploy:prod` daqui, ou automaticamente pelo Vercel a cada push na `main`. Build Command do Vercel (condicional, verificado em 02/10/2026): `if [ -n "$CONVEX_DEPLOY_KEY" ]; then npx convex deploy --cmd 'npm run build' --cmd-url-env-var-name VITE_CONVEX_URL; else npm run build; fi` — com a chave (só em Production) publica backend+front; sem ela (Preview) só faz o build do front apontando para o `VITE_CONVEX_URL` do ambiente (Preview = dev). Preview de branch = `hnbcrm-repo-git-<branch>-elevatepro.vercel.app` | `npx convex dev` / `npx convex dev --once` (o `.env.local` tem `CONVEX_DEPLOYMENT=dev:tacit-chicken-195`) |
| Chave | `convex-prod-key.env.local` (gitignored, nunca commitar) | admin key local em `CONVEX_DEV_ADMIN_KEY` no `.env.local` (usada pelo simulador da demo). **Nunca** a chame de `CONVEX_DEPLOY_KEY`: com esse nome presente, `npx convex deploy` cairia no dev |
| Estado | dados reais, envs reais, webhooks (bridge/Resend) apontam para cá | **neutralizado**: `RESEND_TEST_MODE=true`, canais desarmados sem credenciais, cópia congelada dos dados reais de 02/10 (purga pendente) |

**Regras:** (1) `convex dev`/`convex run` sem flag = DEV; para o prod use `--prod` (`npx convex run --prod …`, `npx convex env … --prod`, `npx convex data … --prod`, `npx convex logs --prod`). **Pegadinha medida (CLI 1.31.2): `convex data` e `convex logs` IGNORAM `CONVEX_DEPLOY_KEY`** e leem o dev; só `--prod` muda o alvo (`env`, `deploy`, `import`, `export` e `run` honram a chave). (2) Schema só aditivo entre dev e prod — os dois precisam aceitar os mesmos documentos. (3) Op em prod sempre com `dryRun` antes. (4) Runbook da separação, ops de migração (`convex/opsMigration.ts`: re-apontar webhooks do bridge, reaplicar HMAC, desarmar canais, cancelar/re-armar agendadas, reenviar saídas travadas) e registro do que foi feito em `docs/OPS-SEPARAR-DEV-PROD.md`. (5) Restore de backup do Convex NÃO traz funções agendadas nem envs: após qualquer restore, rodar `internalRearmScheduledMessages`, `internalRearmGroupPosts` e `internalRedispatchStuckOutbound`. (6) Envs da tradução automática, por deployment: `LIBRETRANSLATE_URL` (`https://lt.hnbcrm.com`) e `LIBRETRANSLATE_API_KEY`, setadas em DEV e PROD em 06/11/2026 (`npx convex env set …`; PROD com `--prod`); ver `translation.md`.

## Notas vindas de convex/CLAUDE.md (22/10/2026)

Trechos movidos literalmente do `convex/CLAUDE.md` ao enxugá-lo (identificadores que não existiam em nenhum outro lugar).

> **Dois deployments desde 02/10/2026:** PROD `careful-anaconda-127` (hnbcrm.com, clientes reais) e DEV `tacit-chicken-195`
> (desenvolvimento/demos, neutralizado). `npx convex dev|run|data|logs` sem flag = DEV; prod = `npm run deploy:prod` /
> `--prod`. `convex data`/`convex logs` ignoram a deploy key — use `--prod`. Detalhes na seção "Deployments" do CLAUDE.md
> da raiz e em `docs/OPS-SEPARAR-DEV-PROD.md`.
- `opsMigration.ts` — Ops internas de separação dev/prod e pós-restore (re-apontar webhooks do bridge — `webhookurl`! —, reaplicar HMAC nas instâncias, desarmar canais do deployment-cópia, cancelar/re-armar agendadas, re-armar publicações de grupo, reenviar saídas travadas); todas com `dryRun` default true

## Versão do Node (11/2026, P2.2)

- `convex.json` fixa `node.nodeVersion: "24"` para as actions Node (o `unpdf@2.1.0` do extrator de PDF declara `engines >=24`) e `.nvmrc` está em 24, então CI e máquina local rodam a mesma versão das actions. A suíte inteira passou em Node 24.22.2 e em 22.15.0.
- Node 25 está BLOQUEADO por enquanto: o `web-push@3.6.7` (`pushNode.ts`) depende de `jws` → `jwa` → `buffer-equal-constant-time@1.0.1`, que usa `SlowBuffer` (removido no Node 25). Subir para 25 exige trocar/atualizar o `web-push` antes.
- `convex.json` também declara `node.externalPackages: ["unpdf"]` (o worker do pdf.js importa o pacote pelo caminho absoluto; ver `security.md`). Validação no primeiro push: `npx convex dev --once` deve aceitar a versão e instalar o pacote; se o servidor recusar 24, voltar para `"22"` (o spike rodou igual em 22).

## Envs novas da entrega "landing + onboarding v2" (11/2026)

Convex (`npx convex env set NOME valor [--prod]`; PROD só com `--prod`). Nenhuma é obrigatória para o app subir: o comportamento sem a env está na última coluna. Detalhes em `onboarding.md` (custo, modelos, leads) e `ai-attendant.md` (voz).

| Env | Onde | Para quê | Se ausente (ou inválida) |
|---|---|---|---|
| `HNBCRM_INTERNAL_ORG_ID` | Convex | org interna do HNBCRM: recebe o lead do cadastro, o lead de contato/consultoria e o audit do alerta global de custo | nada acontece: nenhum lead interno é criado e `POST /api/v1/public/contact` responde 503 `unavailable` (o front cai para o `mailto`); id inválido, org inexistente ou sem admin humano ativo = igual a ausente |
| `HNBCRM_INTERNAL_BOARD_ID` | Convex | funil da org interna para esses leads | usa o funil padrão da org interna |
| `ONBOARDING_SESSION_BUDGET_USD_MICROS` | Convex | teto de gasto de IA de uma sessão do onboarding (micro-US$) | 500000 (US$ 0,50); vazia, não inteira, <= 0 ou acima de US$ 1.000 cai no padrão |
| `ONBOARDING_TRIAL_ORG_BUDGET_USD_MICROS` | Convex | teto mensal de onboarding por org (trial, sem billing, legacy criada em/depois de 11/11/2026) | 2000000 (US$ 2,00), mesma regra de validação |
| `ONBOARDING_GLOBAL_DAILY_USD_MICROS` | Convex | corte global do dia UTC (soma de todas as orgs) | 20000000 (US$ 20,00), mesma regra de validação |
| `ONBOARDING_MODEL_INTERVIEWER`, `ONBOARDING_MODEL_READER`, `ONBOARDING_MODEL_VISION` | Convex | modelo do entrevistador, do leitor em quarentena e da visão do onboarding | padrões do `registry.ts` (copiloto, atendente e visão); valor com formato inválido ou fora do registry (na visão, fora da cadeia de visão) cai no padrão |
| `ONBOARDING_TTS_MODEL`, `ONBOARDING_TTS_VOICE` | Convex | modelo e voz da resposta falada do Copiloto do onboarding | `google/gemini-3.8-flash-tts` e voz `Kore`; valor fora da lista de modelos/vozes de catálogo cai no padrão |
| `ATTENDANT_TTS_MODEL`, `ATTENDANT_TTS_VOICE` | Convex | modelo e voz padrão da resposta em áudio do atendente (a voz escolhida pela org vence a env) | mesmos padrões; a voz só toca quando a org liga "Responder em áudio" |
| `EMAIL_CODE_PEPPER` | Convex | segredo opcional extra do código de e-mail de 6 dígitos; a chave do HMAC já é derivada de `JWT_PRIVATE_KEY` | opcional: sem ela vale só `JWT_PRIVATE_KEY` (que o Convex Auth exige); sem as duas o pedido de código é recusado. Trocar invalida os códigos pendentes (expiram em 10 min) |
| `VITE_COMMUNITY_URL` | Vercel (build do frontend) | link https do grupo da comunidade (landing, QR code, menu Ajuda, próximos passos do onboarding) | a comunidade não aparece em lugar nenhum; valor que não é https é ignorado |

Também: `convex.json` fixa `node.nodeVersion: "24"` e `node.externalPackages: ["unpdf"]` (extrator de PDF do onboarding; ver "Versão do Node"), e o deploy do backend deve ir ANTES do frontend nesta entrega (a entrada por e-mail e o `/comecar` chamam funções novas). A voz exige `OPENROUTER_API_KEY` e o conversor `WHISPER_SERVICE_URL`/`TOKEN`, que já existiam.
