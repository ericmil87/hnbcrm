# AI Agent Config — Plano v4.2 (APROVADO 2026-07-26)

Rodada focada em UX de ativação e em o atendente MANTER o CRM atualizado.
Motivação: (a) ativar o bot exigia passo-a-passo (mestre+LGPD → atendente →
aceite bridge → horário); (b) skips de elegibilidade eram silenciosos e pareciam
bug ("a IA não respondeu e nada avisou"); (c) leads criados pelo pipelineConfig
nascem em board não-default e o usuário não os encontrava; (d) em modo sugestão
as ações propostas eram só texto — a IA nunca "mexia" no CRM de fato.

Invariantes do v3/v4.1 INALTERADAS (opt-in total, TOOL_DENYLIST, escopo por
registro, envelope untrusted, suggest default, gate server-side do autopilot,
commit transacional TOCTOU, registry estático de tools).

## P1 — Ativação em 1 fluxo
- `aiSettings.activateOneFlow` (mutation única, transacional): liga o mestre,
  registra o aceite LGPD, registra o aceite de risco do bridge (opcional, só se
  a org tem canal bridge) e cria o atendente semeado (persona) — MESMOS aceites
  e auditoria do caminho em passos; só a UX muda. Reusa atendente existente.
- **Default novo: atendente nasce SEM horário (24h).** Em modo sugestão nada é
  enviado sozinho — restrição de horário vira decisão de quem liga o autopilot
  (a UI sugere definir horário nesse momento).
- Wizard de UMA tela na seção IA (+ CTA no Painel quando IA desligada):
  bullets do que acontece, persona, bloco de risco do bridge (se aplicável,
  com o texto integral + checkbox), checkbox LGPD, botão único.

## P2 — Fim do skip silencioso + descoberta do lead
- O enqueue agora DEIXA RASTRO: elegibilidade reprovada grava item `skipped`
  com a razão na `aiReplyQueue` (só quando a org tem IA ativa E atendente
  resolvido — org sem IA continua sem writes).
- Query nova `attendant.getConversationAiState(conversationId)` → o inbox
  mostra chip "IA em espera: <motivo>" / "IA preparando resposta…".
- Inbox mostra funil+estágio do lead com link "Ver no funil" (deep-link
  `?board=`); Pipeline lembra o último board por org; card do atendente mostra
  "Leads novos caem em: X → Y".

## P3 — Atendente que preenche o CRM
- Tools novas (registry estático; escopo por registro; executor valida tudo):
  - `updateThisContact` — nome/e-mail do contato do atendimento (e-mail com
    validação de formato; nunca id vindo do modelo).
  - `updateThisLeadInfo` — title/value/temperature + `fields` validado contra a
    whitelist `pipelineConfig.captureFields` (keys de fieldDefinitions de lead)
    E contra o TIPO/OPÇÕES da definição (select fora das opções = recusado).
    O prompt injeta a lista "DADOS A CAPTURAR" com chaves e opções.
- **Ações propostas aprováveis (modo sugestão)**: `proposedActions` agora é
  estruturado `{name, argsJson, label}` (label humano, ex.: 'Mover o lead para
  "X"'). `acceptAiDraft` aceita `actionIndexes` e executa as ações MARCADAS
  pelo MESMO executor gated do autopilot (`executeAttendantToolCore`
  compartilhado — assertAgentCan, escopo, allowMoveStages, whitelist).
  O cliente só envia ÍNDICES — nome/args saem do metadata gravado pelo
  servidor. Subconjunto aprovável fixo (`APPROVABLE_DRAFT_ACTIONS`);
  replyToCustomer/requestHandoff nunca entram. Falha de ação não desfaz o
  envio; resultados ficam em `aiDraft.appliedActions` (exibidos no card).
  Rascunhos legados (ações em string) não são executáveis.

## Segurança (análise)
- Aprovação de rascunho não escala privilégio: o executor roda com o RBAC do
  MEMBRO IA remetente do rascunho (como no autopilot) e o aprovador precisa de
  inbox/reply; ações não-aprováveis e índices inválidos são recusados/ignorados.
- Rastro do skip não vaza dados (razões são slugs; query exige membership).
- `captureFields` é whitelist dupla: chave precisa estar no perfil E existir
  como fieldDefinition de lead; opções validadas por tipo.

## Testes (v4.2): 8 novos (270 total)
updateThisContact (escopo + e-mail inválido), captureFields (whitelist de
chave, opção inválida, sem whitelist), acceptAiDraft com actionIndexes
(seleção parcial, não-aprovável, índice fora do range, legado), activateOneFlow
(fresh org com bridge, LGPD obrigatória, re-ativação reusa atendente, 24h
default), getConversationAiState (razão do skip). Ajustados 2 testes do
contrato antigo de skip (agora com rastro).
