/**
 * Núcleo puro do agente de grupo (F4).
 *
 * O que estes testes protegem, em ordem de gravidade:
 *  1. **O gatilho.** Uma mensagem comum de membro NÃO pode acordar a IA. Se
 *     isso quebrar, o CRM vira um bot que fala por cima de todo mundo numa sala
 *     com clientes — o modo de falha mais caro do recurso.
 *  2. **A elegibilidade.** `groupAgentEnabled` ausente é DESLIGADO, e cada
 *     aceite (grupos no número, IA no bridge) é um portão de verdade.
 *  3. **As menções.** O modelo só consegue mencionar quem está na sala.
 *  4. **O parser do radar**, que recebe JSON de um LLM e não pode explodir.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_GROUP_MAX_PER_DAY,
  DEFAULT_GROUP_MAX_PER_HOUR,
  buildGroupSystemPrompt,
  digestDueNow,
  evaluateGroupEligibility,
  groupSpeakerLabel,
  jidIsUs,
  matchesKeyword,
  parseDigestTime,
  parseRadarVerdicts,
  resolveMentionJids,
  sanitizeGroupReply,
  shouldTriggerGroupAgent,
  suggestedDmFor,
} from "./groupAgentCore";

const OUR_LID = "92965187932215@lid";
const OUR_PHONE = "558192985729";

describe("gatilho (§9.1)", () => {
  const base = { mode: "mention" as const, ourLid: OUR_LID, ourPhone: OUR_PHONE };

  test("menção formal ao nosso LID dispara", () => {
    expect(
      shouldTriggerGroupAgent({ ...base, content: "@Cláudio qual o horário?", mentions: [OUR_LID] })
    ).toEqual({ trigger: true, reason: "mention" });
  });

  test("menção pelo telefone (o mesmo número em outro formato) dispara", () => {
    expect(
      shouldTriggerGroupAgent({
        ...base,
        content: "alguém sabe?",
        mentions: [`${OUR_PHONE}@s.whatsapp.net`],
      })
    ).toEqual({ trigger: true, reason: "mention" });
  });

  test("responder a uma mensagem NOSSA dispara", () => {
    expect(
      shouldTriggerGroupAgent({ ...base, content: "e para sábado?", quotedParticipantJid: OUR_LID })
    ).toEqual({ trigger: true, reason: "quote" });
  });

  test("nosso número digitado à mão dispara (o WhatsApp não monta mentionedJid)", () => {
    expect(
      shouldTriggerGroupAgent({ ...base, content: `@${OUR_PHONE} você atende domingo?` })
    ).toEqual({ trigger: true, reason: "number" });
  });

  test("mensagem comum de membro NÃO dispara — é a regra mais importante", () => {
    expect(shouldTriggerGroupAgent({ ...base, content: "bom dia pessoal" })).toEqual({
      trigger: false,
      reason: "sem_mencao",
    });
  });

  test("menção a OUTRO membro não dispara", () => {
    expect(
      shouldTriggerGroupAgent({
        ...base,
        content: "@Maria consegue?",
        mentions: ["5511999998888@s.whatsapp.net"],
      })
    ).toEqual({ trigger: false, reason: "sem_mencao" });
  });

  test("palavra-chave configurada dispara; sem configurar, não", () => {
    expect(
      shouldTriggerGroupAgent({ ...base, content: "qual o PREÇO do curso?", keywords: ["preço"] })
    ).toEqual({ trigger: true, reason: "keyword" });
    expect(shouldTriggerGroupAgent({ ...base, content: "qual o preço do curso?" })).toEqual({
      trigger: false,
      reason: "sem_mencao",
    });
  });

  test("palavra-chave casa sem acento e sem caixa", () => {
    expect(matchesKeyword("Qual o ORCAMENTO?", ["orçamento"])).toBe("orçamento");
  });

  test("modo off nunca dispara, nem com menção", () => {
    expect(
      shouldTriggerGroupAgent({ ...base, mode: "off", content: "@nós", mentions: [OUR_LID] })
    ).toEqual({ trigger: false, reason: "ia_do_grupo_desligada" });
    expect(
      shouldTriggerGroupAgent({ ...base, mode: undefined, content: "oi", mentions: [OUR_LID] })
    ).toEqual({ trigger: false, reason: "ia_do_grupo_desligada" });
  });

  test("jidIsUs tolera sufixo de device e domínio", () => {
    expect(jidIsUs(`${OUR_PHONE}@s.whatsapp.net`, undefined, OUR_PHONE)).toBe(true);
    expect(jidIsUs("92965187932215:12@lid", OUR_LID, undefined)).toBe(true);
    expect(jidIsUs("5511999998888@s.whatsapp.net", OUR_LID, OUR_PHONE)).toBe(false);
  });
});

describe("elegibilidade", () => {
  const ok = {
    orgAiActive: true,
    groupAgentEnabled: true,
    bridgeAiAck: true,
    bridgeGroupsAck: true,
    bridgeGroupsEnabled: true,
    channelProvider: "bridge" as const,
    channelActive: true,
    attendantActive: true,
    withinSchedule: true,
    groupMode: "mention" as const,
    groupMonitored: true,
    groupGone: false,
    hasPendingHandoff: false,
    repliesLastHour: 0,
    repliesLastDay: 0,
    now: 1_000_000,
  };

  test("tudo em ordem passa", () => {
    expect(evaluateGroupEligibility(ok)).toEqual({ ok: true });
  });

  test.each([
    ["ia_desativada", { orgAiActive: false }],
    ["agente_de_grupo_desativado", { groupAgentEnabled: false }],
    ["canal_sem_grupos", { channelProvider: "meta" as const }],
    ["canal_inativo", { channelActive: false }],
    ["grupos_desligados_no_numero", { bridgeGroupsEnabled: false }],
    ["grupos_sem_aceite", { bridgeGroupsAck: false }],
    ["bridge_sem_aceite", { bridgeAiAck: false }],
    ["sem_atendente", { attendantActive: false }],
    ["grupo_nao_monitorado", { groupMonitored: false }],
    ["fora_do_grupo", { groupGone: true }],
    ["ia_do_grupo_desligada", { groupMode: "off" as const }],
    ["handoff_pendente", { hasPendingHandoff: true }],
    ["fora_do_horario", { withinSchedule: false }],
  ])("bloqueia com motivo %s", (reason, patch) => {
    expect(evaluateGroupEligibility({ ...ok, ...patch })).toEqual({ ok: false, reason });
  });

  test("IA pausada na conversa bloqueia (e pausa vencida não)", () => {
    expect(
      evaluateGroupEligibility({ ...ok, conversationPausedUntil: ok.now + 1000 })
    ).toEqual({ ok: false, reason: "ia_pausada" });
    expect(
      evaluateGroupEligibility({ ...ok, conversationPausedUntil: ok.now - 1000 })
    ).toEqual({ ok: true });
  });

  test("tetos default do GRUPO são 10/h e 30/dia", () => {
    expect(
      evaluateGroupEligibility({ ...ok, repliesLastHour: DEFAULT_GROUP_MAX_PER_HOUR })
    ).toEqual({ ok: false, reason: "teto_hora" });
    expect(
      evaluateGroupEligibility({ ...ok, repliesLastDay: DEFAULT_GROUP_MAX_PER_DAY })
    ).toEqual({ ok: false, reason: "teto_dia" });
  });

  test("teto 0 significa SEM teto (mesma ressignificação do atendente)", () => {
    expect(
      evaluateGroupEligibility({ ...ok, maxPerHour: 0, maxPerDay: 0, repliesLastHour: 99, repliesLastDay: 99 })
    ).toEqual({ ok: true });
  });
});

describe("histórico e menções", () => {
  test("rótulo diz QUEM falou — é o que permite responder só a quem perguntou", () => {
    expect(groupSpeakerLabel({ direction: "inbound", senderName: "Eric" })).toBe("membro:Eric");
    expect(groupSpeakerLabel({ direction: "inbound", senderPhone: "5581999" })).toBe(
      "membro:5581999"
    );
    expect(groupSpeakerLabel({ direction: "outbound", senderType: "ai" })).toBe("ia");
    expect(groupSpeakerLabel({ direction: "outbound", senderType: "human" })).toBe("equipe");
  });

  test("menção só resolve para quem ESTÁ na sala", () => {
    const participants = [
      { lid: "111@lid", phone: "5581111" },
      { phone: "5582222" },
      { lid: "333@lid", phone: "5583333", leftAt: 1 },
    ];
    expect(
      resolveMentionJids(participants, ["111@lid", "5582222", "333@lid", "5589999", 42])
    ).toEqual(["111@lid", "5582222@s.whatsapp.net"]);
  });

  test("sem chaves, nenhuma menção", () => {
    expect(resolveMentionJids([{ lid: "111@lid" }], undefined)).toEqual([]);
    expect(resolveMentionJids([{ lid: "111@lid" }], "111@lid")).toEqual([]);
  });

  test("resposta vazia vira null; resposta gigante é cortada", () => {
    expect(sanitizeGroupReply("   ")).toBeNull();
    expect(sanitizeGroupReply(null)).toBeNull();
    expect(sanitizeGroupReply("x".repeat(5000))!.length).toBe(1200);
  });

  test("markdown do modelo é convertido antes de ir para a sala", () => {
    expect(sanitizeGroupReply("Aula de **sábado** cancelada")).toBe(
      "Aula de *sábado* cancelada"
    );
  });
});

describe("prompt do grupo (§9.1)", () => {
  const ctx = {
    agentName: "Guardião",
    orgName: "Aos Filhos da Terra",
    language: "pt-BR",
    persona: "Você é o Guardião, atendente da loja.",
    knowledge: "Entregamos às terças.",
    groupSubject: "Clientes VIP",
    participantsCount: 42,
    extraInstructions: null,
    teamNotes: [],
  };

  test("carrega as regras da SALA, não as do atendimento 1:1", () => {
    const prompt = buildGroupSystemPrompt(ctx);
    expect(prompt).toContain("VOCÊ ESTÁ NUM GRUPO");
    expect(prompt).toContain("42 pessoas");
    expect(prompt).toContain("replyToGroup");
    expect(prompt).toContain("NUNCA revele dados de outro cliente");
    expect(prompt).toContain("NUNCA confirme pagamento");
    expect(prompt).toContain("privado");
    // A persona da org continua valendo.
    expect(prompt).toContain("Você é o Guardião");
    expect(prompt).toContain("Entregamos às terças");
    // E NADA do 1:1 vaza: nem a tool, nem a obrigação de qualificar lead.
    expect(prompt).not.toContain("replyToCustomer");
    expect(prompt).not.toContain("updateThisLeadInfo");
  });

  test("flagOpportunity só aparece com o radar ligado", () => {
    expect(buildGroupSystemPrompt(ctx)).not.toContain("flagOpportunity");
    expect(buildGroupSystemPrompt({ ...ctx, opportunityRadar: true })).toContain("flagOpportunity");
  });

  test("o carimbo de data/hora, quando vem, fica no FIM (cache de prefixo)", () => {
    const bloco = "DATA E HORA ATUAIS: sexta-feira, 18/09/2026, 14:32 (fuso America/Sao_Paulo).";
    const prompt = buildGroupSystemPrompt({ ...ctx, dateTimeBlock: bloco });
    expect(prompt).toContain(bloco);
    expect(prompt.trimEnd().endsWith(bloco)).toBe(true);
    // Sem o bloco (perfil do atendente com o carimbo desligado) nada sobra.
    expect(buildGroupSystemPrompt(ctx)).not.toContain("DATA E HORA ATUAIS");
  });

  test("instruções da sala e notas da equipe entram como conteúdo confiável", () => {
    const prompt = buildGroupSystemPrompt({
      ...ctx,
      extraInstructions: "Só fale de horários de aula.",
      teamNotes: [{ text: "A aula de sábado foi cancelada.", at: 1 }],
    });
    expect(prompt).toContain("Só fale de horários de aula.");
    expect(prompt).toContain("A aula de sábado foi cancelada.");
    expect(prompt).toContain("FONTE OFICIAL CONFIRMADA");
  });

  test("sala com mensagens temporárias avisa o modelo", () => {
    expect(buildGroupSystemPrompt({ ...ctx, isEphemeral: true })).toContain("temporárias");
  });
});

describe("radar (§9.3)", () => {
  test("parseia JSON limpo", () => {
    const out = parseRadarVerdicts(
      '{"itens":[{"id":"m1","oportunidade":true,"tipo":"orcamento","resumo":"quer preço do plano"}]}'
    );
    expect(out).toEqual([
      { id: "m1", oportunidade: true, tipo: "orcamento", resumo: "quer preço do plano" },
    ]);
  });

  test("tolera cerca ```json e <think> (as duas pegadinhas medidas na visão)", () => {
    const raw = '<think>hmm</think>\n```json\n{"itens":[{"id":"m2","oportunidade":false}]}\n```';
    expect(parseRadarVerdicts(raw)).toEqual([
      { id: "m2", oportunidade: false, tipo: "nenhum", resumo: "" },
    ]);
  });

  test("lixo vira lista vazia em vez de explodir", () => {
    expect(parseRadarVerdicts("desculpe, não consigo")).toEqual([]);
    expect(parseRadarVerdicts(null)).toEqual([]);
    expect(parseRadarVerdicts('{"itens":"nao é lista"}')).toEqual([]);
  });

  test("o rascunho de DM é sugestão para um HUMANO mandar", () => {
    const dm = suggestedDmFor({
      agentName: "Guardião",
      orgName: "Loja",
      memberName: "Maria",
      groupSubject: "Clientes VIP",
      summary: "quer orçamento de 3 cestas",
    });
    expect(dm).toContain("Maria");
    expect(dm).toContain("Clientes VIP");
    expect(dm).toContain("orçamento de 3 cestas");
  });
});

describe("digest diário (§9.2)", () => {
  test('aceita só "HH:MM"', () => {
    expect(parseDigestTime("18:30")).toEqual({ hour: 18, minute: 30 });
    expect(parseDigestTime("7:30")).toBeNull();
    expect(parseDigestTime("24:00")).toBeNull();
    expect(parseDigestTime(undefined)).toBeNull();
  });

  test("dispara na HORA local do fuso da org", () => {
    // 2026-09-16T21:00:00Z = 18:00 em São Paulo (UTC-3).
    const now = Date.parse("2026-09-16T21:00:00Z");
    expect(digestDueNow("18:00", "America/Sao_Paulo", now)).toBe(true);
    expect(digestDueNow("18:45", "America/Sao_Paulo", now)).toBe(true); // o minuto é da UI
    expect(digestDueNow("19:00", "America/Sao_Paulo", now)).toBe(false);
    expect(digestDueNow("18:00", "UTC", now)).toBe(false);
    expect(digestDueNow(undefined, "America/Sao_Paulo", now)).toBe(false);
  });
});
