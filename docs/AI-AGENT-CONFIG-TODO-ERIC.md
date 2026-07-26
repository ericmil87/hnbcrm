# AI Agent Config — O que só VOCÊ pode fazer (Eric)

Lista viva do que depende exclusivamente de você. Tudo o mais está implementado
(ver `AI-AGENT-CONFIG-STATUS.md`).

## 1. Chaves e infraestrutura

- [ ] **`OPENROUTER_API_KEY`** — ficou MAIS urgente após o E2E: o OpenCode Go
  tem instabilidade real ("Upstream request failed" em continuação de tool; já
  mitiguei com retry + recuperação, mas o fallback é a solução completa) e,
  quando o tier de 5h esgota, a IA fica indisponível até resetar:
  ```bash
  npx convex env set OPENROUTER_API_KEY <sua-key>
  ```
  O fallback já está implementado e liga sozinho quando a key existir (com a
  trava dupla ZDR do OpenRouter aplicada por request). Lembrete: **sempre
  `npx convex env set`**, nunca `.env.local` nem prefixo `VITE_`.
  Na conta do OpenRouter, ativar **"ZDR Endpoints only"** nas configurações de
  privacidade (a trava por-request já vai no código, mas a de conta é sua).
- [ ] **Escolher o tier/assinatura do OpenCode Go** quando o uso real der sinal
  (o limite de 5h esgotou uma vez só com dev). Acompanhe pelo medidor em
  Configurações → IA e pelo workspace do OpenCode.
- [ ] **Deploy em produção** (quando decidir): `npx convex deploy` + setar no
  deployment de PROD: `OPENCODE_GO_API`, `CHANNEL_ENCRYPTION_KEY` (se ainda não
  existir lá), e opcionalmente `OPENROUTER_API_KEY` / `ALLOWED_ORIGIN`.

## 2. LGPD / Jurídico (necessário ANTES de atendente com clientes reais)

- [ ] **Aprovar/publicar a cláusula de IA na política de privacidade**
  (`/privacidade` no app). Precisa cobrir: (a) uso de assistente de IA no
  atendimento; (b) transferência internacional de dados a operadores nos EUA
  em regime zero-retention (OpenCode Go; OpenRouter ZDR como contingência);
  (c) direito de opt-out ("digite 'humano'" / pedido ao atendente humano).
  → Posso REDIGIR a minuta e inserir na página quando você pedir — a
  **aprovação do texto é sua** (idealmente com revisão jurídica).
- [ ] (Se um dia usar BYO com DeepSeek/Moonshot diretos) citar residência
  China/Singapura na política — o app já avisa e pede aceite na UI.

## 3. Testes que exigem o SEU telefone (canal bridge real)

Desde o v4.1, o atendente IA pode responder via bridge **somente com o aceite
de risco org-level** (Configurações → IA → "Canais não-oficiais"). Vale
verificar ao vivo no GuardTeste2 (org Acme Corp Test):

- [ ] **Gate SEM aceite**: com o aceite desligado, mande "oi" de um celular
  real para o número do GuardTeste2 → mensagem chega no inbox e **nenhuma
  resposta/rascunho de IA** aparece.
- [ ] **Gate COM aceite (modo sugestão)**: ligue o aceite de risco, mande outra
  mensagem → deve aparecer um **rascunho** de IA no inbox (nada enviado ao
  cliente sem sua aprovação). Aceite o rascunho e confira no celular que a
  resposta chegou com "digitando…" antes.
- [ ] **Revogação**: desligue o aceite → próxima mensagem não gera rascunho.
- [ ] **Atendente com cliente real em Meta**: exige um número na WhatsApp Cloud
  API oficial. Quando quiser o piloto: conectar um número Meta em Configurações
  → Canais e apontar o atendente para ele.

## 4. Hardening do gateway wuzapi (VPS — fora do código do CRM)

Da pesquisa v4.1 (fingerprinting de sessão foi o vetor da onda de detecção de
mai/2025 que atingiu whatsmeow e Baileys):

- [ ] Avaliar **atrasar a presença "available" 45–120s** após reconectar a
  sessão wuzapi (hoje o whatsmeow sinaliza presença imediatamente ao conectar).
- [ ] Avaliar **variar o client name** da sessão (o "Chrome" fixo e idêntico em
  milhares de bots é ele próprio um fingerprint).
- [ ] Se a sessão cair com aviso de "versão não-oficial detectada", tratar como
  ALTO risco: não reconectar automaticamente em loop.

## 5. Decisões de produto

- [ ] **Commit/PR**: o trabalho está na branch `ericmil87/check-next-task`, sem
  commit — me diga quando quiser commitar (e se quer squash/mensagem específica).
- [ ] **Autopilot**: destravado automaticamente após 10+ sugestões revisadas com
  60%+ de aceitação — a decisão de ligar é sua (botão em Configurações → IA).
  No bridge, o risco de banimento é seu — considere manter suggest por mais tempo.
- [ ] **Warm-up/cap diário no bridge**: continua FORA do produto (decisão
  v4/v4.1). A métrica `channelPacing.dailyCount` já registra envios/dia por
  canal; se um dia quiser o cap, a rampa de referência está no addendum do
  `AI-WHATSAPP-LIMITS.md` (20→680 em 7 dias).

---
*Resolvidos:* `OPENCODE_GO_API` ✅ · IDs de modelo confirmados ✅ · ZDR =
aviso-não-bloqueio ✅ · matriz de modelos extras **cancelada** (ficamos com
kimi-k2.7-code / deepseek-v4-flash / deepseek-v4-pro) ✅ · tier liberado
2026-07-24 ✅
