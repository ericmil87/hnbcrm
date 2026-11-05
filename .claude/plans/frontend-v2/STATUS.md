# Frontend v2 — STATUS (memória do orquestrador)

> Atualizado pelo orquestrador depois de cada PR integrado em `frontend-v2`. Formato curto. Datas absolutas.

## Integrados em `frontend-v2`

| fv2 | Título | Ramo | Merge | Testes (total) | Achados de revisão relevantes | Decisões fora do plano |
|---|---|---|---|---|---|---|
| 02 | Templates por segmento (`convex/lib/onboardingTemplates.ts`) | `feat/fv2-02-templates-segmento` | `3086e07` (05/11/2026) | 3367 | Sem bloqueio. Melhorias aplicadas: `renderPersonaSeed` remove frase com placeholder vazio; palavras de repasse por intenção ("agendar visita", "fazer matrícula"); "falar com atendente" em todo segmento; JSDoc: consumidor une a `DEFAULT_HANDOFF_KEYWORDS`. | `INDUSTRY_TEMPLATES` do wizard v1 mantido literal (não derivado) para preservar comportamento; `FieldSeed = {key,label,type:"text"|"select",options?}`; `personaForIndustry("financeiro")` segue `geral`. `vite build`/`tsc node` não re-rodados após o commit de ajustes (só texto/dados). |

## Em andamento

| fv2 | Ramo | Agente | Situação | Próximo passo |
|---|---|---|---|---|
| 01 | `feat/fv2-01-testes-componente-roteador` | frontend-specialist | implementado, em revisão (worktree `/home/user/wt/fv2-01`) | integrar |
| 04 | `feat/fv2-04-portas-config` | convex-backend | implementação (worktree `/home/user/wt/fv2-04`) | revisão |

## Parados (não integrar sem decisão do dono)

| fv2 | Motivo (achado "bloqueia" ou falha persistente) | Alternativa mínima sugerida |
|---|---|---|

## Pendências para o dono

- `gh` não está autenticado nesta sessão (token inválido). PRs de feature não são abertos; integração é local por `git merge --no-ff` com push dos ramos. O PR em rascunho `frontend-v2 → main` será tentado pelo GitHub MCP.
- Ambiente: ramo de integração `frontend-v2` criado de `origin/main` em `9d7f8af` (05/11/2026); worktrees em `/home/user/wt/fv2-NN` com `node_modules` linkado.

## Para retomar

- Próximo PR da ordem: **fv2-01** (em revisão), depois fv2-03
- Ramo em andamento: nenhum
