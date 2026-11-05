# Prompt — Claude Code local · Frontend v2: verificar o que a nuvem fez e concluir (fv2-23 a fv2-33)

> Cole TUDO abaixo da linha numa sessão nova do Claude Code **neste repositório, nesta máquina**, modelo Fable. Diferente da nuvem, aqui o Eric está presente e existe deployment DEV do Convex. Mesmo assim o modelo da sessão só orquestra; quem escreve código são os subagentes `frontend-specialist` e `convex-backend` (Sonnet) e quem revisa é o `reviewer` (Opus).

---

Você é o **orquestrador** da conclusão do programa "Frontend v2" do HNBCRM. Uma sessão autônoma na nuvem executou e integrou os PRs **fv2-01 a fv2-22** no ramo `frontend-v2` (05/11/2026, 128 commits, suíte em 4.251 testes, CI verde, PR em rascunho #40 `frontend-v2 → main`). Seu trabalho tem duas partes, nesta ordem: **(A) verificar** o que foi feito; **(B) continuar** pelos PRs **fv2-23 a fv2-33** até concluir, e deixar `frontend-v2` pronto para o Eric mesclar em `main`.

Você NÃO escreve código nem edita arquivos de produto; delega pela ferramenta Agent, lê resumos, decide, briefa, cobra critérios e registra. Pergunte ao Eric só nos pontos marcados **[Eric]** abaixo; o resto decide pelo plano.

## 0. Leitura inicial (você mesmo, uma vez)

1. `.claude/plans/frontend-v2/STATUS.md` **no ramo `frontend-v2`** — memória da sessão da nuvem: tabela de integrados, seção "Para retomar" (tem notas "antes de começar" para o fv2-23), "Pendências para o dono".
2. `.claude/plans/frontend-v2/00-PLANO-MESTRE.md` — seções 3 (princípios), 4 (glossário), 5 (decisões de integração), 6 (ordem; agora interessam fv2-23 a fv2-33), 7 (critérios), 9 (pendências do Eric).
3. `.claude/plans/frontend-v2/PROMPT-CLOUD.md` seções 2 a 6 — o loop por PR, os gates, as regras de produto e de orçamento valem aqui **sem mudança**, exceto o que a seção 3 deste prompt altera.
4. Os blocos dos PRs nos arquivos de seção só na hora de executar cada um (`02-onboarding-ia.md` para fv2-23/24; `03-reorganizacao-vocabulario.md` para fv2-25 a 29; `01-temas.md` para fv2-30/32).

## 1. Preparar o ambiente

```bash
git fetch origin --prune
git checkout frontend-v2 && git pull --ff-only
npm ci                      # package.json mudou (jsdom, Testing Library, fonte)
```

Confirme com o Eric **[Eric]** que o `npx convex dev` dele está rodando apontado para DEV (`tacit-chicken-195`) ou peça autorização para rodar `npx convex dev --once` quando um PR tocar `convex/`. Nunca `--prod`, nunca `deploy`.

## 2. Parte A — Verificação do trabalho da nuvem

Faça tudo abaixo antes de qualquer PR novo. Delegue cada item a um agente e leia o resumo; registre o resultado em `STATUS.md` numa seção nova `## Verificação local (data)`.

1. **Gates completos no `frontend-v2`** (implementador `frontend-specialist`, só roda e reporta): os 5 comandos da seção 4 do `PROMPT-CLOUD.md`. Qualquer falha é a primeira coisa a corrigir.
2. **Codegen de verdade** (`convex-backend`): a nuvem editou `convex/_generated/api.d.ts` à mão porque `npx convex codegen` não roda sem deployment. Aqui roda. Executar `npx convex codegen` com o DEV disponível e conferir `git diff convex/_generated/`: diferença só de ordem/formatação é aceitável e vira um commit `fv2: codegen regenerado`; qualquer módulo faltando ou sobrando é bug a corrigir.
3. **Push de schema e funções no DEV** (`npx convex dev --once`, com autorização do item 1): valida `teamMembers.uiTheme`, `onboardingMeta` aditivo, as 9 tools, `startBridgePairing`/`pollBridgePairing`, `generateAttendantDraft`. Erro de validador aqui não aparece em `tsc` nem em `convex-test`.
4. **Revisão de conjunto** (`reviewer`, Opus): `git diff main...frontend-v2` por área, em três passadas separadas para caber no contexto: (a) `convex/` inteiro, com foco em multi-tenant, `requireAccountWithEmail` nas 4 mutations que ganharam o gate (impacto em membros sem e-mail que hoje editam o atendente), two-phase das tools do Copiloto e exclusão no modo automático do Telegram, cota compartilhada do código de conexão, `webhookUrl` só do servidor (`CONVEX_SITE_URL`); (b) `src/components/settings/**` + `src/lib/nav.ts` + `vocab.ts` + registro de painéis, com foco em deep links `?secao=` legados, permissões por painel e salvamento parcial (`toPatch` não pode gravar `persona`/`knowledge` vazios); (c) tema: `index.css`, `tailwind.config.js`, `theme-init.js`, `useUiTheme`, isolamento das páginas públicas, Toaster. Cada "bloqueia" vira um PR de correção `fv2-22b-<slug>` antes de seguir.
5. **Smoke test visual com o Eric [Eric]**: com `npm run dev` rodando, usando as ferramentas do Chrome (`claude-in-chrome`) na conta de teste do DEV (`CLAUDE.local.md`), nas larguras 375, 768 e 1024: menu novo e barra inferior; troca de tema Escuro → Claro → Estilo WhatsApp (conversa com papel de parede e bolhas verdes; páginas públicas continuam escuras); Configurações em dois níveis, busca "transcrição"; painéis do Atendente IA salvando um campo sem apagar outro; Conectar número por código (até a tela do código, sem parear); pedir ao Copiloto "mude o horário para seg a sex 9–18" e ver a prévia Antes → Depois. Anote cada achado como bug (PR `fv2-22b-…`) ou como "aceito".
6. **Pendências anotadas pela nuvem** que cabem em PR pequeno agora (um `convex-backend`, ramo `fv2-22c-ajustes-backend`): links de e-mail/Telegram `?secao=ai` → `ai-usage` e `?secao=channels` (Meta) → `instagram` (`convex/emailTemplates.ts`, `convex/lib/telegramNotifications.ts`); erros técnicos traduzidos em `pairingResultFromStep`; `rename` exposto em `updateAgentProfile`; tabela 3.5 de `01-temas.md` corrigida (`bubble-out` Claro). O resto (Modal sem gestão de foco, ~60 toasts "Falha ao…", `BridgeQrModal` com `useAction` direto) entra no fv2-29.

Só depois de A.1 a A.4 verdes (A.5 pode acontecer em paralelo com os primeiros PRs se o Eric não estiver disponível) comece a Parte B.

## 3. Parte B — Concluir fv2-23 a fv2-33

Mesmo loop do `PROMPT-CLOUD.md` seção 3 (briefing → implementador → `reviewer` → gates → docs → merge `--no-ff` em `frontend-v2` → push → `STATUS.md`), com estas diferenças locais:

- **Worktree por PR**: `git worktree add .claude/worktrees/fv2-NN feat/fv2-NN-<slug>` a partir de `frontend-v2`, com `node_modules` linkado; remover ao integrar. Nunca trabalhar no checkout principal (o Eric usa).
- **`gh` funciona aqui**: abra o PR de `feat/fv2-NN-…` para `frontend-v2` antes de integrar e feche com `gh pr merge --merge`; atualize o corpo do #40 com a tabela de integrados a cada merge.
- **Backend no DEV**: PR que toca `convex/` roda `npx convex dev --once` (autorizado no item 1) antes da revisão, além dos gates. Depois rode `npx convex codegen` e commite `_generated` no mesmo ramo.
- **Validação viva pelo Eric [Eric]**, obrigatória antes de marcar como integrado: **fv2-24** (wizard completo numa org nova em DEV: Seu negócio com o checkbox LGPD, funil, Conectar WhatsApp até o código, Atendente IA com "Escrever com IA", Teste no simulador, Extras, Pronto; e o checklist "Primeiros passos" no Painel) e **fv2-26** (Conversas: enviar, responder, assumir e devolver à IA numa conversa real do bridge de teste; abrir a mesma conversa pelo painel do lead). Para os demais, o smoke pelo Chrome feito por você basta.
- **Ordem e dependências**: 23 → 24 (wizard; usa `ChannelConnectCard variant="wizard"`, `PairingPanel`, `FunnelEditor`, `AttendantPersonaForm`/`AttendantHoursForm` já existentes; ver as notas "antes de começar" do `STATUS.md`: `SimulatorModal` → `AttendantSimulator variant="modal"`, `setupThreadId` em `wizardData`); depois 25 → 26 → 27 e 28 em paralelo (um implementador cada, pastas diferentes) → 29; opcionais 30, 31 (absorve o que sobrou de A.6), 32, 33 só se o Eric disser que quer **[Eric]** (pergunte uma vez, ao terminar o 29).
- **Parado continua sendo parado**: duas rodadas de revisão com "bloqueia", ou duas tentativas iguais falhando, registram e seguem. O fv2-24 não pode ficar parado em silêncio: se travar, avise o Eric na hora, porque ele substitui o onboarding real.

## 4. Gates, regras e orçamento

Exatamente `PROMPT-CLOUD.md` seções 4, 5 e 6, mais: `npx convex dev --once` para PRs de `convex/`; sem limite de orçamento imposto, mas a mesma disciplina (um implementador por PR, no máximo dois PRs paralelos, nunca repetir a mesma tentativa mais de duas vezes). Commits sem atribuição a IA. `CHANGELOG.md` sob `## [Não lançado — Frontend v2]`, versão do `package.json` intocada.

## 5. Encerramento (quando o fv2-29 ou o último opcional pedido estiver integrado)

1. `reviewer` numa passada final `main...frontend-v2` (invariantes + deep links + guards).
2. Gates completos + `npx convex dev --once` no `frontend-v2` final; `npx convex codegen` sem diff.
3. `STATUS.md` com a seção **"Pronto para main"**: lista das funções novas do backend que precisam estar em PROD antes do merge (a nuvem já começou essa lista em "Para retomar"), envs a confirmar em PROD (`CONVEX_SITE_URL`, bridge, Whisper, LLM), validações vivas feitas e as que faltam, textos que o Eric quer revisar (templates de segmento, checkbox LGPD, `VOCAB.lead`).
4. Corpo do PR #40 atualizado e marcado como pronto para revisão (`gh pr ready 40`). **Não mesclar em `main`**: a ordem é do Eric, que primeiro publica o backend em PROD com `npm run deploy:prod` e depois mescla, porque a Vercel publica o frontend no push.
5. Mensagem final de até 10 linhas: o que foi integrado, o que ficou parado, o que o Eric faz em seguida.

Comece pela seção 0.
