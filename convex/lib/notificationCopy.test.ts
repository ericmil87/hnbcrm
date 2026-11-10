import { describe, expect, test } from "vitest";
import {
  BODY_MAX,
  COPY_TYPES,
  CONTACT_MAX,
  messagePreview,
  notificationCopy,
  safeName,
  scrubPii,
  splitGraphemes,
  truncateGraphemes,
  hasIntlSegmenter,
  type CopyInput,
} from "./notificationCopy";

// 07/11/2026 15:00 UTC = 12:00 em São Paulo.
const NOW = Date.UTC(2026, 10, 7, 15, 0);
const SP = { timeZone: "America/Sao_Paulo", now: NOW };

const golden: Array<[CopyInput, { title: string; body?: string }]> = [
  [
    { type: "task_assigned", taskTitle: "Ligar para a Ana", actorName: "Bruno", dueAt: Date.UTC(2026, 10, 7, 17, 30) },
    { title: "Bruno atribuiu uma tarefa a você", body: "Ligar para a Ana · vence às 14:30" },
  ],
  [
    { type: "task_comment_mention", taskTitle: "Proposta", actorName: "Bruno", excerpt: "@Ana pode revisar?" },
    { title: "Bruno mencionou você em Proposta", body: "@Ana pode revisar?" },
  ],
  [
    { type: "task_due_soon", taskTitle: "Ligar para a Ana", dueAt: Date.UTC(2026, 10, 7, 17, 30) },
    { title: "Ligar para a Ana vence às 14:30", body: "Lembrete da tarefa" },
  ],
  [
    { type: "task_overdue", taskTitle: "Enviar contrato", dueAt: Date.UTC(2026, 10, 6, 13, 0) },
    { title: "Tarefa atrasada: Enviar contrato", body: "Venceu ontem às 10:00" },
  ],
  [
    { type: "handoff_requested", contactName: "Ana Souza", reason: "Cliente quer desconto" },
    { title: "A IA pediu ajuda: Ana Souza", body: "Cliente quer desconto" },
  ],
  [
    { type: "handoff_requested", contactName: "Ana Souza", reason: "Assume?", fromHumanName: "Bruno" },
    { title: "Bruno pediu ajuda: Ana Souza", body: "Assume?" },
  ],
  [
    { type: "handoff_resolved", contactName: "Ana Souza", actorName: "Bruno", outcome: "accepted" },
    { title: "Bruno assumiu a conversa com Ana Souza" },
  ],
  [
    { type: "handoff_resolved", contactName: "Ana Souza", actorName: "Bruno", outcome: "rejected" },
    { title: "Bruno devolveu à IA a conversa com Ana Souza" },
  ],
  [
    { type: "ai_draft_pending", contactName: "Ana Souza" },
    { title: "A IA sugeriu uma resposta para Ana Souza", body: "Resposta sugerida aguardando sua revisão" },
  ],
  [
    { type: "ai_draft_pending", groupName: "Sementes", count: 2 },
    { title: "A IA sugeriu 2 respostas para o grupo Sementes", body: "Resposta sugerida aguardando sua revisão" },
  ],
  [
    { type: "campaign_completed", campaignName: "Black Friday", sent: 10, failed: 1, replied: 3 },
    { title: "Campanha Black Friday concluída", body: "10 enviadas · 1 falha · 3 respostas" },
  ],
  [
    { type: "campaign_paused", campaignName: "Black Friday", reason: "Muitas falhas seguidas" },
    { title: "Campanha Black Friday pausada por segurança", body: "Muitas falhas seguidas" },
  ],
  [
    { type: "group_joined", groupName: "Sementes" },
    { title: "Entrou no grupo Sementes", body: "Marque Acompanhar para as mensagens deste grupo aparecerem em Conversas." },
  ],
  [
    { type: "group_mention", groupName: "Sementes", senderName: "Carla", preview: "alguém aí?" },
    { title: "Mencionaram você no grupo Sementes", body: "Carla: alguém aí?" },
  ],
  [
    { type: "group_mention", groupName: "Sementes", senderName: "Carla", preview: "e aí?", count: 3 },
    { title: "3 menções a você no grupo Sementes", body: "Carla: e aí?" },
  ],
  [
    { type: "group_mention", groupName: "Sementes", senderName: "Carla", preview: "qual o preço?", keyword: "preço" },
    { title: "preço no grupo Sementes", body: "Carla: qual o preço?" },
  ],
  [
    { type: "group_post_pending", postName: "Bom dia", preview: "Bom dia, pessoal!" },
    { title: "Aprovar publicação Bom dia", body: "Bom dia, pessoal!" },
  ],
  [
    { type: "group_post_failed", postName: "Bom dia", reason: "Canal desconectado", kind: "paused" },
    { title: "Publicação Bom dia foi pausada", body: "Canal desconectado" },
  ],
  [
    { type: "group_post_failed", postName: "Bom dia", reason: "Nenhum grupo recebeu a mensagem", kind: "not_sent" },
    { title: "Publicação Bom dia não foi enviada", body: "Nenhum grupo recebeu a mensagem" },
  ],
  [
    { type: "group_post_failed", postName: "Bom dia", reason: "A IA não respondeu", kind: "ai_failed" },
    { title: "A IA não conseguiu escrever a publicação Bom dia", body: "A IA não respondeu" },
  ],
  [
    { type: "group_opportunity", groupName: "Sementes", label: "Intenção de compra", memberName: "Carla", summary: "quer 2 ingressos" },
    { title: "Intenção de compra no grupo Sementes", body: "Carla: quer 2 ingressos" },
  ],
  [
    { type: "group_digest", groupName: "Sementes", summary: "Pouco movimento hoje." },
    { title: "Resumo do dia: Sementes", body: "Pouco movimento hoje." },
  ],
  [
    { type: "ai_followup_needs_human", taskTitle: "Retomar contato", reason: "o cliente pediu um humano" },
    { title: "A IA não conseguiu fazer o follow-up", body: "Retomar contato · o cliente pediu um humano" },
  ],
  [
    { type: "conversation_transferred", kind: "assign", actorName: "Bruno", contactName: "Ana Souza" },
    { title: "Bruno atribuiu a conversa com Ana Souza a você" },
  ],
  [
    { type: "conversation_transferred", kind: "transfer", actorName: "Bruno", contactName: "Ana Souza", note: "Ela quer boleto" },
    { title: "Bruno transferiu a conversa com Ana Souza para você", body: "Ela quer boleto" },
  ],
  [
    { type: "conversation_transferred", kind: "transfer", actorName: "Bruno", contactName: "Ana Souza", departmentName: "Financeiro" },
    { title: "Bruno transferiu a conversa com Ana Souza para Financeiro" },
  ],
  [
    { type: "channel_session_lost", provider: "whatsapp", channelName: "Principal", detail: "Sessão encerrada no celular" },
    { title: "WhatsApp Principal perdeu a conexão", body: "Sessão encerrada no celular" },
  ],
  [
    { type: "channel_session_lost", provider: "meta", channelName: "Loja / @loja", state: "reauth_required", detail: "Token expirado" },
    { title: "Página Loja / @loja precisa ser reconectada", body: "Token expirado" },
  ],
  [
    { type: "channel_session_lost", provider: "meta", channelName: "Página", state: "revoked" },
    { title: "A autorização da Página foi removida" },
  ],
  [
    { type: "channel_session_lost", provider: "meta", channelName: "Loja", state: "data_access_expiring" },
    { title: "Reconecte Loja para manter o acesso", body: "Reconecte a conta para manter o acesso às mensagens." },
  ],
  [
    { type: "ai_spend_warning", pct: 80, costBrl: "R$ 80", capBrl: "R$ 100", month: "2026-11" },
    { title: "Gasto de IA em 80% do teto do mês", body: "Gasto aproximado R$ 80 de R$ 100 em 2026-11." },
  ],
  [
    { type: "ai_spend_reached", costBrl: "R$ 100", capBrl: "R$ 100", blockMode: true },
    {
      title: "Teto de gastos de IA atingido: IA só sugere respostas",
      body: "Gasto aproximado R$ 100 de R$ 100. Os outros recursos de IA ficam suspensos até o próximo mês.",
    },
  ],
  [
    { type: "ai_spend_reached", costBrl: "R$ 100", capBrl: "R$ 100", blockMode: false },
    { title: "Teto de gastos de IA atingido", body: "Gasto aproximado R$ 100 de R$ 100. A IA continua funcionando." },
  ],
  [
    { type: "plan_usage_warning", meter: "ai", pct: 80, month: "2026-11" },
    {
      title: "Atendimentos IA em 80% da franquia do mês",
      body: "Em 2026-11 você já usou 80% da franquia do plano. Nada muda por enquanto.",
    },
  ],
  [
    { type: "plan_usage_reached", meter: "ai", overageEnabled: false },
    {
      title: "Franquia de atendimentos IA do mês atingida",
      body: "Os próximos contatos novos recebem rascunho para a equipe enviar. Ligue o excedente em Configurações → Uso e fatura.",
    },
  ],
  [
    { type: "plan_overage_cap_reached", capBrl: "R$ 100,00" },
    {
      title: "Teto do excedente atingido",
      body: "O teto de R$ 100,00 em excedente do mês acabou: contatos novos recebem rascunho para a equipe enviar.",
    },
  ],
  [
    { type: "trial_ending", daysLeft: 3, endsAt: "20/12/2026" },
    {
      title: "Seu teste termina em 3 dias",
      body: "O teste grátis acaba em 20/12/2026. Depois disso a conta fica em modo só leitura até você contratar um plano.",
    },
  ],
  [
    { type: "plan_read_only" },
    {
      title: "Conta em modo só leitura",
      body: "A IA e os envios estão pausados. Você continua vendo seus dados e pode exportá-los. Contrate um plano para voltar.",
    },
  ],
  [
    { type: "plan_payment_overdue", dueDate: "05/12/2026" },
    {
      title: "Pagamento em atraso",
      body: "A fatura com vencimento em 05/12/2026 não foi paga. A conta segue funcionando por alguns dias; regularize pelo link da fatura em Configurações › Uso e fatura.",
    },
  ],
  [
    { type: "plan_payment_received", planLabel: "Profissional", amountBrl: "R$ 497,00" },
    {
      title: "Pagamento confirmado",
      body: "Recebemos R$ 497,00 do plano Profissional. O recibo e a nota fiscal ficam na fatura, em Configurações › Uso e fatura.",
    },
  ],
  [
    { type: "plan_changed", planLabel: "Escala" },
    { title: "Plano alterado", body: "Sua conta agora está no plano Escala." },
  ],
  [
    { type: "plan_change_scheduled", planLabel: "Essencial", effectiveAt: "10/12/2026" },
    {
      title: "Troca de plano agendada",
      body: "Seu plano muda para Essencial em 10/12/2026, no fim do ciclo atual. Até lá, tudo segue como está.",
    },
  ],
  [
    { type: "plan_cancel_scheduled", endsAt: "10/12/2026" },
    {
      title: "Cancelamento agendado",
      body: "Sua assinatura termina em 10/12/2026. Até lá você usa tudo normalmente; depois a conta fica em modo só leitura, com exportação liberada. Dá para reativar antes disso.",
    },
  ],
  [
    { type: "plan_canceled" },
    {
      title: "Assinatura cancelada",
      body: "A conta está em modo só leitura: você continua vendo e exportando seus dados. Para voltar, assine um plano em Configurações › Uso e fatura.",
    },
  ],
  [
    { type: "plan_refunded", amountBrl: "R$ 497,00" },
    {
      title: "Reembolso solicitado",
      body: "Devolvemos R$ 497,00; ele volta pelo mesmo meio de pagamento em alguns dias. A conta ficou em modo só leitura e você ainda pode exportar seus dados.",
    },
  ],
  [
    { type: "plan_payment_overdue" },
    {
      title: "Pagamento em atraso",
      body: "Há uma fatura vencida. A conta segue funcionando por alguns dias; regularize pelo link da fatura em Configurações › Uso e fatura.",
    },
  ],
  [
    { type: "new_message", contactName: "Ana", count: 1, preview: "Oi!" },
    { title: "Mensagem nova de Ana", body: "Oi!" },
  ],
  [
    { type: "new_message", contactName: "Ana", count: 5, preview: "Pix? · Me manda a chave" },
    { title: "5 mensagens novas de Ana", body: "Pix? · Me manda a chave" },
  ],
  [
    { type: "lead_assigned", leadTitle: "Ana Souza", actorName: "Bruno" },
    { title: "Bruno atribuiu o lead Ana Souza a você" },
  ],
];

describe("notificationCopy — golden por tipo (PT-BR)", () => {
  for (const [input, expected] of golden) {
    test(`${input.type}: ${expected.title}`, () => {
      const out = notificationCopy(input, SP);
      expect(out.title).toBe(expected.title);
      expect(out.body).toBe(expected.body);
    });
  }

  test("todo tipo do formatador tem golden", () => {
    const covered = new Set(golden.map(([i]) => i.type));
    expect(COPY_TYPES.filter((t) => !covered.has(t))).toEqual([]);
  });
});

describe("sem PII (telefone/e-mail) no texto", () => {
  const PHONE = "+55 11 98765-4321";
  const EMAIL = "ana.souza@example.com";
  test("nome que é telefone ou e-mail vira 'Contato'", () => {
    expect(notificationCopy({ type: "new_message", contactName: PHONE, count: 1 }).title).toBe("Mensagem nova de Contato");
    expect(notificationCopy({ type: "handoff_requested", contactName: EMAIL }).title).toBe("A IA pediu ajuda: Contato");
    expect(notificationCopy({ type: "lead_assigned", leadTitle: "5511987654321" }).title).toBe("Lead Contato atribuído a você");
  });
  test("trechos livres têm telefone e e-mail removidos", () => {
    for (const [input] of golden) {
      const withPii = { ...input } as Record<string, unknown>;
      for (const k of ["preview", "reason", "excerpt", "summary", "note", "detail"]) {
        if (k in withPii) withPii[k] = `me liga ${PHONE} ou ${EMAIL}`;
      }
      const out = notificationCopy(withPii as CopyInput, SP);
      const text = `${out.title} ${out.body ?? ""}`;
      expect(text).not.toMatch(/98765|4321|example\.com/);
    }
  });
  test("scrubPii não come dinheiro, data nem hora", () => {
    expect(scrubPii("R$ 1.500,00 em 06/11 às 14:30")).toBe("R$ 1.500,00 em 06/11 às 14:30");
    expect(scrubPii("CPF 123.456.789-00")).toBe("CPF [telefone]");
  });
});

describe("corte por grafema (Intl.Segmenter e fallback)", () => {
  const FAMILY = "👨‍👩‍👧‍👦";
  const FLAG = "🇧🇷";
  const THUMB = "👍🏽";
  for (const useSegmenter of [true, false]) {
    if (useSegmenter && !hasIntlSegmenter()) continue;
    const opts = { useSegmenter };
    test(`segmenter=${useSegmenter}: família, bandeira e tom de pele contam como 1`, () => {
      expect(splitGraphemes(`${FAMILY}${FLAG}${THUMB}é`, opts)).toEqual([FAMILY, FLAG, THUMB, "é"]);
    });
    test(`segmenter=${useSegmenter}: cortar nunca parte o emoji`, () => {
      const name = `Ana ${FAMILY}`.padEnd(4, "x") + FAMILY.repeat(30);
      const cut = truncateGraphemes(name, CONTACT_MAX, opts);
      const parts = splitGraphemes(cut, opts);
      expect(parts.length).toBeLessThanOrEqual(CONTACT_MAX);
      expect(parts.at(-1)).toBe("…");
      for (const p of parts.slice(4, -1)) expect(p).toBe(FAMILY);
    });
    test(`segmenter=${useSegmenter}: RTL (árabe com diacríticos) corta sem órfãos`, () => {
      const arabic = "مُحَمَّد عَبْدُ الله ".repeat(10);
      const cut = truncateGraphemes(arabic, 10, opts);
      expect(splitGraphemes(cut, opts).length).toBeLessThanOrEqual(10);
      expect(cut.endsWith("…")).toBe(true);
      // nenhum grafema começa por marca combinante
      for (const p of splitGraphemes(cut, opts)) expect(/^\p{M}/u.test(p)).toBe(false);
    });
  }
  test("corpo ≤ 140 grafemas e nome do contato ≤ 24", () => {
    const out = notificationCopy({ type: "new_message", contactName: "Maria ".repeat(10), count: 1, preview: "a".repeat(500) });
    expect(splitGraphemes(out.body!).length).toBe(BODY_MAX);
    expect(out.title).toBe(`Mensagem nova de ${truncateGraphemes("Maria ".repeat(10), CONTACT_MAX)}`);
    expect(splitGraphemes(safeName("Maria ".repeat(10), CONTACT_MAX, "Contato")).length).toBe(CONTACT_MAX);
  });
});

describe("fuso da org", () => {
  const due = Date.UTC(2026, 10, 7, 17, 30);
  test("America/Sao_Paulo × UTC", () => {
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: due }, SP).title).toBe("X vence às 14:30");
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: due }, { timeZone: "UTC", now: NOW }).title).toBe(
      "X vence às 17:30"
    );
  });
  test("fuso inválido/ausente cai em São Paulo", () => {
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: due }, { timeZone: "Marte/Olimpo", now: NOW }).title).toBe(
      "X vence às 14:30"
    );
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: due }, { now: NOW }).title).toBe("X vence às 14:30");
  });
  test("amanhã e outra data", () => {
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: due + 86_400_000 }, SP).title).toBe(
      "X vence amanhã às 14:30"
    );
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: due + 3 * 86_400_000 }, SP).title).toBe(
      "X vence em 10/11 às 14:30"
    );
  });
  test("virada do dia: 23:30 em SP é o dia seguinte em UTC", () => {
    const late = Date.UTC(2026, 10, 8, 2, 30); // 07/11 23:30 em SP
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: late }, SP).title).toBe("X vence às 23:30");
    expect(notificationCopy({ type: "task_due_soon", taskTitle: "X", dueAt: late }, { timeZone: "UTC", now: NOW }).title).toBe(
      "X vence amanhã às 02:30"
    );
  });
});

describe("prévia multilíngue", () => {
  test("tradução pronta usa o texto traduzido com o idioma de origem", () => {
    expect(
      messagePreview({
        content: "How much is it?",
        contentType: "text",
        translatedText: "Quanto custa?",
        metadata: { translation: { status: "done", role: "inbound", sourceLang: "en", at: 1 } },
      })
    ).toBe("Quanto custa? (traduzido do inglês)");
  });
  test("tradução pendente/falha mostra o original", () => {
    for (const status of ["pending", "failed", "skipped"]) {
      expect(
        messagePreview({
          content: "¿Cuánto cuesta?",
          contentType: "text",
          translatedText: "Quanto custa?",
          metadata: { translation: { status, role: "inbound", sourceLang: "es", at: 1 } },
        })
      ).toBe("¿Cuánto cuesta?");
    }
  });
  test("mídia vira rótulo curto", () => {
    expect(messagePreview({ content: "[imagem]", contentType: "image" })).toBe("Foto");
    expect(messagePreview({ content: "", contentType: "audio", transcriptText: "oi" })).toBe("Áudio: oi");
  });
});
