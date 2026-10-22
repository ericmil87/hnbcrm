# Plano: o Atendente IA precisa "ouvir" as mensagens de voz

> **Para executar em sessão nova.** Auto-contido: diagnóstico com refs exatas,
> decisões de design fechadas, fases com testes e critérios de aceite.
> Contexto do produto: CLAUDE.md (raiz) + convex/CLAUDE.md.

## 1. Sintoma

Cliente (Rubens) manda áudio no WhatsApp → o Atendente IA responde "não consigo
acessar o áudio por aqui, pode escrever?" — mesmo com o pipeline de transcrição
Whisper **funcionando e configurado** (self-hosted em `aftwhisper.hnbcrm.com`,
envs `WHISPER_SERVICE_URL`/`WHISPER_SERVICE_TOKEN` setadas, transcrição
aparecendo depois no inbox). O bot deveria responder ao CONTEÚDO do áudio.

## 2. Diagnóstico (verificado no código em 2026-07-31)

O snapshot de contexto do atendente **já prefere a transcrição** quando ela
existe — `convex/attendant.ts:643`:

```ts
texto: m.transcriptText && m.contentType === "audio" ? m.transcriptText : m.content,
```

O problema são DUAS causas independentes:

**Causa A — corrida (a principal).** No ingest, transcrição e fila da IA são
agendadas ao mesmo tempo (`convex/conversations.ts:1300-1306`):

```ts
await ctx.scheduler.runAfter(0, internal.transcription.autoTranscribe, { messageId });
await ctx.scheduler.runAfter(0, internal.attendant.internalEnqueueFromInbound, {...});
```

O debounce da fila é `DEBOUNCE_MS = 5_000` (`convex/attendant.ts:51`). A
transcrição (download do áudio → Whisper HTTP → gravação) leva mais que 5s na
maioria dos casos. Resultado: o claim/snapshot roda antes de `transcriptText`
existir e a história entrega só o placeholder `"[áudio]"` (`convex/whatsapp.ts:330`;
conferir o equivalente no ingest do bridge em `lib/bridgeParse.ts`/`bridge.ts`).
O modelo então improvisa o "não consigo acessar o áudio".

**Causa B — gate do toggle.** `autoTranscribe` é no-op se o canal não tem
`autoTranscribeAudio: true` (`convex/transcription.ts:242-258`,
`internalGetAudioMessageIfAutoEnabled`). Ou seja: org com atendente ativo mas
sem o toggle de conveniência do inbox → o bot NUNCA teria transcrição.

**Estado relevante:**
- Status da transcrição vive em `messages.metadata.transcription.status`
  (`pending` | `done` | `failed`) + espelho raso `messages.transcriptText`
  (schema.ts:525-540; mutations `internalSetTranscriptionPending`/`Result` em
  transcription.ts:273+).
- Fila: `aiReplyQueue` com `status/attempts/nextAttemptAt` (schema.ts:1168-1184);
  o coalescing já REQUEUE empurrando `nextAttemptAt` + `ctx.scheduler.runAfter`
  (attendant.ts:458-497) — reusar esse mecanismo, não inventar outro.
- O claim transacional (debounce + pacing + lock OCC + snapshot) está em
  `internalProcessQueueItem`/claim em attendant.ts:504+.

## 3. Decisões de design (fechadas — não rediscutir)

- **D1 — Esperar a transcrição, com prazo.** No claim, se entre as mensagens
  inbound ainda não respondidas houver áudio com transcrição `pending` (ou
  agendável), REQUEUE (+8s) em vez de rodar — até um deadline por item
  (`createdAt do item + 60s`). Estourou o prazo → roda mesmo assim com marcador
  de indisponível (D4). Só espera se o serviço Whisper estiver configurado
  (`WHISPER_SERVICE_URL` presente).
- **D2 — O atendente tem ouvidos próprios.** Alargar o gate da transcrição:
  transcrever quando `autoTranscribeAudio: true` **OU** quando a org tem IA
  ativa (`orgAiActive`) + `attendantEnabled` (renomear/expandir a query interna
  do gate). O ingest já agenda incondicionalmente; só o gate muda. LGPD: sem
  novo operador de dados — o Whisper é self-hosted nosso e o áudio já está no
  storage; a transcrição é derivada do mesmo conteúdo.
- **D3 — Prompt sabe que era áudio.** No mapeamento da história, áudio vira
  `[áudio transcrito]: <texto>` quando há transcrição e
  `[áudio recebido — transcrição indisponível]` quando não há (falha/timeout/
  serviço off). Imagens/arquivos continuam `[imagem]`/`[arquivo]`. Adicionar 1-2
  linhas nas REGRAS do prompt do atendente: com transcrição, responda ao
  conteúdo normalmente e NUNCA diga que "não consegue ouvir áudio"; sem
  transcrição, peça com naturalidade para a pessoa escrever (sem jargão
  técnico). A transcrição é conteúdo do CLIENTE → continua dentro do envelope
  untrusted (`lib/promptEnvelope.ts`) como o resto da história.
- **D4 — Fallback honesto, sem bloquear.** Transcrição failed/timeout NÃO é
  condição de inelegibilidade — o atendente responde pedindo texto. Nada de
  novo skip.
- **D5 — Simulador/evals ficam para o fim** (F4, opcional): permitir entrada de
  áudio simulado no simulador e 1 golden conversation com áudio.

## 4. Fases

### F1 — Espera pela transcrição no claim (causa A)
- `convex/schema.ts`: campo opcional `transcriptWaitUntil: v.optional(v.number())`
  em `aiReplyQueue` (deadline; setado no primeiro requeue-por-transcrição).
- `convex/attendant.ts` (claim): antes do snapshot, buscar as inbound
  não-internas desde o trigger (janela do coalescing) com `contentType === "audio"`;
  se alguma tem `metadata.transcription?.status === "pending"` (ou ainda sem
  metadata de transcrição, com Whisper configurado e gate D2 elegível) e
  `now < (item.transcriptWaitUntil ?? item._creationTime + 60_000)` → patch
  `nextAttemptAt = now + 8_000` (+ `transcriptWaitUntil` se ausente) +
  `ctx.scheduler.runAfter(8_000, internalProcessQueueItem, ...)` e retornar
  `kind: "requeued"` (seguir o padrão de retorno existente do claim).
- Atenção ao contrato existente: attempts/backoff de erro são outra coisa — a
  espera de transcrição não deve consumir `attempts` de falha.

### F2 — Gate de transcrição para o atendente (causa B)
- `convex/transcription.ts`: expandir `internalGetAudioMessageIfAutoEnabled`
  (ou criar `internalGetAudioMessageIfEligible`): retorna a mensagem se
  `config.autoTranscribeAudio === true` OU (aiConfig da org com
  `enabled && lgpdAck` && `attendantEnabled !== false`). Manter o retorno
  null-safe para todo o resto (chamada permanece incondicional no ingest).
- Sem mudança de UI obrigatória; opcional: nota na seção IA ("áudios são
  transcritos automaticamente para o atendente").

### F3 — Prompt e marcadores (D3)
- `convex/attendant.ts:643`: trocar o mapeamento por marcadores
  `[áudio transcrito]: ...` / `[áudio recebido — transcrição indisponível]`
  (e cobrir `contentType` image/file com os placeholders atuais).
- Seção de REGRAS do prompt do atendente (procurar onde `historico`/REGRAS são
  montados, attendant.ts:1563+): instrução sobre áudio com/sem transcrição.

### F4 (opcional) — Simulador + eval
- `attendant.ts:2035+` (simulador): aceitar `{ de, texto, audio?: true }` e
  formatar com o mesmo marcador. 1 golden conversation com áudio em
  `agentEvals`.

## 5. Testes (novo `convex/attendantAudio.test.ts`)

Seguir o padrão de seed/identidade de `convex/attendant.test.ts` (org com
aiConfig ativo + atendente + conversa). Casos:

1. **Requeue por pending:** inbound de áudio com `transcription.status: "pending"`
   → claim retorna requeue, `nextAttemptAt` empurrado, `transcriptWaitUntil`
   setado, `attempts` de falha intacto.
2. **Transcrição pronta → responde ao conteúdo:** com `transcriptText` setado,
   claim roda e `context.history` contém `[áudio transcrito]: <texto>`.
3. **Deadline estourado:** `transcriptWaitUntil` no passado → claim roda com
   `[áudio recebido — transcrição indisponível]`.
4. **Gate D2:** canal com `autoTranscribeAudio: false` mas org com IA ativa +
   atendente → query interna retorna a mensagem; org sem IA ativa e toggle off
   → null (comportamento atual preservado).
5. **Regressão texto:** inbound só texto → nenhum requeue extra, fluxo idêntico.
6. Rodar a suíte inteira (`npm run test`) — 283+ testes verdes.

## 6. Critérios de aceite

- [ ] Áudio com transcrição ok → resposta da IA cita/reage ao conteúdo falado
      (sem "não consigo ouvir áudio").
- [ ] Espera limitada: 1ª resposta a áudio atrasa no máximo ~60s + pacing.
- [ ] Whisper fora do ar / falha → resposta educada pedindo texto (sem travar a
      fila, sem spam de fallback).
- [ ] Org com atendente ativo e toggle de transcrição do inbox DESLIGADO →
      transcrição roda mesmo assim (D2).
- [ ] `npm run lint` + `npm run test` verdes; `npx convex dev --once` ok.

## 7. Validação viva (conta de teste)

1. Login `ericteste@milfont.net` (senha = login), org Acme Corp Test — bridge
   real conectado (GuardTeste2). `/resetme` do número allowlisted zera o contato.
2. Mandar UMA voice note (~10s) para o número → esperar o rascunho/resposta:
   deve referenciar o conteúdo falado. Conferir `messages.transcriptText` e o
   `agentRuns` da conversa.
3. Testar também: áudio + texto na mesma rajada (coalescing), e áudio com
   Whisper derrubado (simular com env inválida em dev) → fallback educado.

## 8. Riscos e notas

- **Latência:** +5–30s na 1ª resposta a áudio (bounded). Aceitável — humano
  também "escuta antes de responder"; o typing humanizado do bridge disfarça.
- **Coalescing:** rajada áudio+texto não pode responder duas vezes — a espera é
  do ITEM da conversa (que já coalesce), não por mensagem.
- **Custo:** zero adicional (Whisper self-hosted).
- **Fora de escopo:** "ver" imagens (visão multimodal) — fica para um plano
  próprio; hoje imagem segue como `[imagem]` no prompt.
- Commits SEM crédito a Claude (preferência do Eric). Branch a partir de main
  (v0.38.0, `ea1b870`).
