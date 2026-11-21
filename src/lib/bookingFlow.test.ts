import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  EXPANDED_LIMIT,
  NEVER_FORCEABLE,
  SUGGESTED_COUNT,
  bookingReducer,
  buildBookArgs,
  buildFindSlotsArgs,
  buildRescheduleArgs,
  canAdvance,
  chosenDurationMin,
  classifyViolations,
  dayHeading,
  defaultServiceId,
  groupByDay,
  initialBookingState,
  isAdjacentSlot,
  isProposalFailure,
  isSlotTaken,
  joinNames,
  longRangePhrase,
  longWhenPhrase,
  normalizeOffered,
  parseSchedRulesError,
  parseViolations,
  pickedFromOffered,
  pinnableKinds,
  readAlternatives,
  roundNow,
  searchWindow,
  splitSuggestions,
  violationText,
  type BookingState,
  type OfferedSlot,
  type PickedSlot,
  type ServiceLike,
} from "./bookingFlow";

const TZ = "America/Sao_Paulo";
// 2026-11-26 (quinta) 10:30:45 em São Paulo (UTC-3).
const NOW = Date.UTC(2026, 10, 26, 13, 30, 45, 123);
const at = (h: number, m = 0, day = 26) => Date.UTC(2026, 10, day, h + 3, m);

const sessao: ServiceLike = { _id: "svc1", name: "Sessão", durationMin: 60, requirements: [{ kind: "room" }, { kind: "person" }] };
const corte: ServiceLike = {
  _id: "svc2",
  name: "Corte",
  durationMin: 30,
  variants: [{ key: "longo", name: "Cabelo longo", durationMin: 60 }],
  requirements: [{ kind: "person" }],
};
const inativo: ServiceLike = { _id: "svc3", name: "Antigo", durationMin: 30, active: false };

const base = (over: Partial<Parameters<typeof initialBookingState>[0]> = {}) =>
  initialBookingState({ services: [sessao, corte], idempotencyKey: "k1", ...over });

const picked = (over: Partial<PickedSlot> = {}): PickedSlot => ({
  startTime: at(14),
  endTime: at(15),
  resourceIds: ["room1", "pers1"],
  resourceNames: ["Sala 1", "Ana"],
  reasons: [],
  manual: false,
  warnings: [],
  ...over,
});

describe("roundNow", () => {
  it("arredonda para baixo ao minuto e à hora", () => {
    expect(roundNow(NOW, "minute")).toBe(Date.UTC(2026, 10, 26, 13, 30));
    expect(roundNow(NOW, "hour")).toBe(Date.UTC(2026, 10, 26, 13, 0));
  });
  it("relógio inválido não quebra", () => {
    expect(roundNow(Number.NaN, "minute")).toBe(0);
    expect(roundNow(-5, "hour")).toBe(0);
  });
});

describe("serviço padrão e estado inicial", () => {
  it("um só serviço ativo é pré-selecionado; inativos não contam", () => {
    expect(defaultServiceId([sessao, inativo])).toBe("svc1");
    expect(defaultServiceId([sessao, corte])).toBeNull();
  });
  it("o serviço padrão da org vale se estiver ativo", () => {
    expect(defaultServiceId([sessao, corte], "svc2")).toBe("svc2");
    expect(defaultServiceId([sessao, corte, inativo], "svc3")).toBeNull();
  });
  it("com serviço decidido abre no passo 2 (caminho feliz em 2 toques)", () => {
    const s = initialBookingState({ services: [sessao], idempotencyKey: "k" });
    expect(s.step).toBe("slot");
    expect(s.serviceId).toBe("svc1");
  });
  it("sem padrão abre no passo 1", () => {
    expect(base().step).toBe("service");
  });
  it("padrão com variações ainda pergunta a duração; remarcar não pergunta", () => {
    expect(initialBookingState({ services: [corte], idempotencyKey: "k" }).step).toBe("service");
    expect(initialBookingState({ services: [corte], serviceId: "svc2", idempotencyKey: "k" }).step).toBe("slot");
  });
  it("abre num dia e com recursos fixados quando a Agenda pede", () => {
    const s = base({ date: "2026-12-01", pinned: { room: "room1" } });
    expect(s.dayPreset).toBe("other");
    expect(s.otherDate).toBe("2026-12-01");
    expect(s.pinned).toEqual({ room: "room1" });
  });
  it("a chave de idempotência é a recebida e não muda ao navegar", () => {
    let s = base();
    s = bookingReducer(s, { type: "pickService", serviceId: "svc1", services: [sessao, corte] });
    s = bookingReducer(s, { type: "pickSlot", slot: picked() });
    s = bookingReducer(s, { type: "back" });
    s = bookingReducer(s, { type: "setDay", preset: "tomorrow" });
    expect(s.idempotencyKey).toBe("k1");
  });
});

describe("máquina de passos", () => {
  const services = [sessao, corte];
  it("3 toques: serviço, horário, confirmar", () => {
    let s = base();
    expect(canAdvance(s, true)).toBe(false);
    s = bookingReducer(s, { type: "pickService", serviceId: "svc1", services });
    expect(s.step).toBe("slot");
    s = bookingReducer(s, { type: "pickSlot", slot: picked() });
    expect(s.step).toBe("review");
    expect(canAdvance(s, true)).toBe(true);
    expect(canAdvance(s, false)).toBe(false);
  });
  it("serviço com variações espera a duração antes de ir ao horário", () => {
    let s = bookingReducer(base(), { type: "pickService", serviceId: "svc2", services });
    expect(s.step).toBe("service");
    s = bookingReducer(s, { type: "pickVariant", variantKey: "longo" });
    expect(s.step).toBe("slot");
    expect(s.variantKey).toBe("longo");
  });
  it("trocar serviço descarta horário, variação e recursos fixados", () => {
    let s = base({ pinned: { room: "room1" } });
    s = bookingReducer(s, { type: "pickService", serviceId: "svc1", services });
    s = bookingReducer(s, { type: "pickSlot", slot: picked() });
    s = bookingReducer(s, { type: "pickService", serviceId: "svc2", services });
    expect(s.slot).toBeNull();
    expect(s.pinned).toEqual({});
  });
  it("voltar do passo 3 mantém o horário; mexer na busca descarta", () => {
    let s = bookingReducer(base(), { type: "pickService", serviceId: "svc1", services });
    s = bookingReducer(s, { type: "pickSlot", slot: picked() });
    s = bookingReducer(s, { type: "back" });
    expect(s.step).toBe("slot");
    expect(s.slot).not.toBeNull();
    s = bookingReducer(s, { type: "setPeriod", period: "tarde" });
    expect(s.slot).toBeNull();
  });
  it("fixar e soltar profissional/sala", () => {
    let s = bookingReducer(base(), { type: "pin", kind: "room", resourceId: "room2" });
    expect(s.pinned).toEqual({ room: "room2" });
    s = bookingReducer(s, { type: "pin", kind: "room", resourceId: null });
    expect(s.pinned).toEqual({});
  });
  it("acompanhantes: teto, edição e remoção", () => {
    let s = base();
    for (let i = 0; i < 6; i++) s = bookingReducer(s, { type: "addCompanion" });
    expect(s.companions).toHaveLength(3);
    s = bookingReducer(s, { type: "setCompanion", index: 1, name: "Bia" });
    s = bookingReducer(s, { type: "removeCompanion", index: 0 });
    expect(s.companions).toEqual(["Bia", ""]);
  });
  it("'Ver mais horários' liga a busca ampla e some ao mudar o filtro", () => {
    let s = bookingReducer(base(), { type: "expand" });
    expect(s.expanded).toBe(true);
    s = bookingReducer(s, { type: "setDay", preset: "week" });
    expect(s.expanded).toBe(false);
  });
});

describe("janela e argumentos da busca", () => {
  const today = "2026-11-26";
  it("hoje, amanhã, semana (7 dias) e outro dia (nunca no passado)", () => {
    expect(searchWindow({ dayPreset: "today", otherDate: null }, today)).toEqual({ from: today, to: today });
    expect(searchWindow({ dayPreset: "tomorrow", otherDate: null }, today)).toEqual({ from: "2026-11-27", to: "2026-11-27" });
    expect(searchWindow({ dayPreset: "week", otherDate: null }, today)).toEqual({ from: today, to: "2026-12-02" });
    expect(searchWindow({ dayPreset: "other", otherDate: "2026-12-10" }, today)).toEqual({ from: "2026-12-10", to: "2026-12-10" });
    expect(searchWindow({ dayPreset: "other", otherDate: "2026-11-01" }, today)).toEqual({ from: today, to: today });
    expect(searchWindow({ dayPreset: "other", otherDate: null }, today)).toEqual({ from: today, to: today });
  });
  it("usa o fuso da org para 'hoje' (virada do dia em São Paulo, não em UTC)", () => {
    // 27/11 01:30 UTC ainda é 26/11 22:30 em São Paulo.
    const lateUtc = Date.UTC(2026, 10, 27, 1, 30);
    const args = buildFindSlotsArgs({ organizationId: "org", state: base({ serviceId: "svc1" }), tz: TZ, now: lateUtc });
    expect(args?.fromLocalDate).toBe("2026-11-26");
    const tokyo = buildFindSlotsArgs({ organizationId: "org", state: base({ serviceId: "svc1" }), tz: "Asia/Tokyo", now: lateUtc });
    expect(tokyo?.fromLocalDate).toBe("2026-11-27");
  });
  it("sem serviço não busca", () => {
    expect(buildFindSlotsArgs({ organizationId: "org", state: base(), tz: TZ, now: NOW })).toBeNull();
  });
  it("monta os argumentos com now no minuto, limite de sugestões e só o que foi escolhido", () => {
    const state: BookingState = { ...base({ serviceId: "svc2", variantKey: "longo" }), period: "tarde", pinned: { person: "pers1" } };
    expect(buildFindSlotsArgs({ organizationId: "org", state, tz: TZ, now: NOW })).toEqual({
      organizationId: "org",
      serviceId: "svc2",
      variantKey: "longo",
      fromLocalDate: "2026-11-26",
      toLocalDate: "2026-11-26",
      period: "tarde",
      resourceIds: ["pers1"],
      audience: "staff",
      limit: SUGGESTED_COUNT,
      now: Date.UTC(2026, 10, 26, 13, 30),
    });
  });
  it("período 'qualquer' não vai ao servidor; expandido pede mais; remarcar ignora o próprio horário", () => {
    const state: BookingState = { ...base({ serviceId: "svc1" }), expanded: true };
    const args = buildFindSlotsArgs({ organizationId: "org", state, tz: TZ, now: NOW, rescheduleAppointmentId: "appt1" });
    expect(args).not.toHaveProperty("period");
    expect(args).not.toHaveProperty("resourceIds");
    expect(args?.limit).toBe(EXPANDED_LIMIT);
    expect(args?.rescheduleAppointmentId).toBe("appt1");
  });
});

describe("argumentos de marcar e remarcar", () => {
  const who = { contactId: "c1", leadId: "l1", conversationId: "v1" };
  const state = (over: Partial<BookingState> = {}): BookingState => ({
    ...base({ serviceId: "svc1" }),
    slot: picked(),
    ...over,
  });

  it("sem horário não monta", () => {
    expect(buildBookArgs({ organizationId: "org", state: base({ serviceId: "svc1" }), who })).toBeNull();
    expect(buildRescheduleArgs({ organizationId: "org", appointmentId: "a", state: base() })).toBeNull();
  });
  it("horário da busca leva o plano de recursos e a chave de idempotência", () => {
    expect(buildBookArgs({ organizationId: "org", state: state(), who })).toEqual({
      organizationId: "org",
      serviceId: "svc1",
      startTime: at(14),
      contactId: "c1",
      leadId: "l1",
      conversationId: "v1",
      resourceIds: ["room1", "pers1"],
      idempotencyKey: "k1",
    });
  });
  it("horário digitado não fixa recursos do plano: só o que a pessoa escolheu", () => {
    const manual = state({ slot: picked({ manual: true, resourceIds: ["roomX"] }), pinned: { person: "pers9" } });
    expect(buildBookArgs({ organizationId: "org", state: manual, who })?.resourceIds).toEqual(["pers9"]);
    const none = state({ slot: picked({ manual: true, resourceIds: ["roomX"] }) });
    expect(buildBookArgs({ organizationId: "org", state: none, who })).not.toHaveProperty("resourceIds");
  });
  it("force só com os códigos informados, sem repetir; vazio não envia", () => {
    expect(buildBookArgs({ organizationId: "org", state: state(), who, force: ["OUTSIDE_HOURS", "OUTSIDE_HOURS", "BUFFER_OVERLAP"] })?.force).toEqual([
      "OUTSIDE_HOURS",
      "BUFFER_OVERLAP",
    ]);
    expect(buildBookArgs({ organizationId: "org", state: state(), who, force: [] })).not.toHaveProperty("force");
  });
  it("acompanhantes viram companions (nomes vazios somem); a prévia não leva companions nem chave", () => {
    const s = state({ companions: [" Maria ", "", "  "], notes: "  trazer exame  " });
    const book = buildBookArgs({ organizationId: "org", state: s, who });
    expect(book?.companions).toEqual([{ guestName: "Maria" }]);
    expect(book?.notes).toBe("trazer exame");
    const preview = buildBookArgs({ organizationId: "org", state: s, who, mode: "preview" });
    expect(preview).not.toHaveProperty("companions");
    expect(preview).not.toHaveProperty("idempotencyKey");
  });
  it("só inclui os ids de quem foi informado", () => {
    const args = buildBookArgs({ organizationId: "org", state: state(), who: { conversationId: "v1" } });
    expect(args).not.toHaveProperty("contactId");
    expect(args).not.toHaveProperty("leadId");
  });
  it("remarcar: início, recursos, force e a mesma chave", () => {
    expect(buildRescheduleArgs({ organizationId: "org", appointmentId: "a1", state: state(), force: ["OUTSIDE_HOURS"] })).toEqual({
      organizationId: "org",
      appointmentId: "a1",
      startTime: at(14),
      resourceIds: ["room1", "pers1"],
      force: ["OUTSIDE_HOURS"],
      idempotencyKey: "k1",
    });
  });
});

describe("adaptador de alternativas (dois formatos)", () => {
  const ctx = { tz: TZ, now: NOW, durationMin: 60 };
  const legacy = { startTime: at(15), resourceIds: ["room1", "pers1"] };
  const full = {
    startTime: at(16),
    endTime: at(17),
    localDate: "2026-11-26",
    label: "26/11 às 16:00 (hoje)",
    resourceIds: ["room2"],
    resourceNames: ["Sala 2"],
    score: 12,
    reasons: ["logo após outro atendimento"],
  };

  it("formato antigo: completa data, rótulo e fim a partir do fuso e da duração", () => {
    const [s] = readAlternatives([legacy], ctx);
    expect(s.localDate).toBe("2026-11-26");
    expect(s.label).toBe("qui, 26/11 · 15:00");
    expect(s.endTime).toBe(at(16));
    expect(s.resourceNames).toEqual([]);
    expect(s.reasons).toEqual([]);
  });
  it("formato antigo sem duração conhecida: fim desconhecido", () => {
    expect(normalizeOffered(legacy, { tz: TZ })?.endTime).toBeNull();
  });
  it("formato Slot: mantém o que o servidor mandou", () => {
    const [s] = readAlternatives([full], ctx);
    expect(s).toMatchObject({ endTime: at(17), label: full.label, resourceNames: ["Sala 2"], score: 12, reasons: full.reasons });
  });
  it("mistura os dois, ordena por horário, tira repetidos e passados", () => {
    const past = { startTime: at(9), resourceIds: ["room1"] };
    const out = readAlternatives([full, legacy, legacy, past, null, "x", { startTime: "a" }], ctx);
    expect(out.map((s) => s.startTime)).toEqual([at(15), at(16)]);
  });
  it("mesmo horário com recursos diferentes são alternativas diferentes", () => {
    const a = { startTime: at(15), resourceIds: ["room1"] };
    const b = { startTime: at(15), resourceIds: ["room2"] };
    expect(readAlternatives([a, b], ctx)).toHaveLength(2);
  });
  it("nomes de recurso só valem se forem um por recurso", () => {
    const odd = { ...full, resourceIds: ["a", "b"], resourceNames: ["Só um"] };
    expect(normalizeOffered(odd, ctx)?.resourceNames).toEqual([]);
  });
  it("respeita o limite e aceita entrada que não é lista", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ startTime: at(12, i * 5 + 1 + 30), resourceIds: ["r"] }));
    expect(readAlternatives(many, { ...ctx, limit: 4 })).toHaveLength(4);
    expect(readAlternatives(undefined, ctx)).toEqual([]);
    expect(readAlternatives({}, ctx)).toEqual([]);
  });
  it("a alternativa escolhida vira horário do fluxo com os mesmos recursos", () => {
    const [s] = readAlternatives([legacy], ctx);
    expect(pickedFromOffered(s)).toMatchObject({ startTime: at(15), resourceIds: ["room1", "pers1"], manual: false, warnings: [] });
    expect(pickedFromOffered(s, true).manual).toBe(true);
  });
});

describe("encostado, sugeridos e dias", () => {
  const mk = (h: number, reasons: string[] = [], date = "2026-11-26"): OfferedSlot => ({
    startTime: at(h),
    endTime: at(h + 1),
    localDate: date,
    label: "",
    resourceIds: [],
    resourceNames: [],
    score: 0,
    reasons,
  });
  it("detecta encostado nos motivos do servidor", () => {
    expect(isAdjacentSlot(mk(10, ["logo após outro atendimento"]))).toBe(true);
    expect(isAdjacentSlot(mk(10, ["no início do expediente", "logo antes de outro atendimento"]))).toBe(true);
    expect(isAdjacentSlot(mk(10, ["equilibra a carga entre a equipe"]))).toBe(false);
    expect(isAdjacentSlot(mk(10))).toBe(false);
  });
  it("sugeridos são os primeiros do servidor; o resto vem por horário", () => {
    const list = [mk(15), mk(9), mk(11), mk(17), mk(10)];
    const { suggested, others } = splitSuggestions(list);
    expect(suggested.map((s) => s.startTime)).toEqual([at(15), at(9), at(11)]);
    expect(others.map((s) => s.startTime)).toEqual([at(10), at(17)]);
  });
  it("agrupa por dia local em ordem de data", () => {
    const groups = groupByDay([mk(9, [], "2026-11-27"), mk(10), mk(11, [], "2026-11-27")]);
    expect(groups.map((g) => [g.localDate, g.slots.length])).toEqual([["2026-11-26", 1], ["2026-11-27", 2]]);
  });
  it("títulos de dia", () => {
    expect(dayHeading("2026-11-26", "2026-11-26")).toBe("Hoje · qui, 26/11");
    expect(dayHeading("2026-11-27", "2026-11-26")).toBe("Amanhã · sex, 27/11");
    expect(dayHeading("2026-11-28", "2026-11-26")).toBe("sáb, 28/11");
  });
});

describe("frases por extenso no fuso da org", () => {
  it("dia da semana, dia e mês por extenso e hora", () => {
    expect(longWhenPhrase(at(14, 30), TZ)).toBe("quinta-feira, 26 de novembro às 14:30");
  });
  it("o fuso da org manda, não o do navegador", () => {
    const ms = Date.UTC(2026, 10, 26, 2, 0); // 25/11 23:00 em São Paulo
    expect(longWhenPhrase(ms, TZ)).toBe("quarta-feira, 25 de novembro às 23:00");
    expect(longWhenPhrase(ms, "Asia/Tokyo")).toBe("quinta-feira, 26 de novembro às 11:00");
  });
  it("intervalo, com e sem fim", () => {
    expect(longRangePhrase(at(14), at(15), TZ)).toBe("quinta-feira, 26 de novembro, das 14:00 às 15:00");
    expect(longRangePhrase(at(14), null, TZ)).toBe("quinta-feira, 26 de novembro às 14:00");
  });
  it("junta nomes", () => {
    expect(joinNames([])).toBeNull();
    expect(joinNames(["Sala 1"])).toBe("Sala 1");
    expect(joinNames(["Sala 1", "Ana", " "])).toBe("Sala 1 e Ana");
    expect(joinNames(["Sala 1", "Ana", "Bia"])).toBe("Sala 1, Ana e Bia");
  });
  it("duração da variação e tipos que se podem fixar", () => {
    expect(chosenDurationMin(corte, null)).toBe(30);
    expect(chosenDurationMin(corte, "longo")).toBe(60);
    expect(chosenDurationMin(undefined, null)).toBeUndefined();
    expect(pinnableKinds(sessao)).toEqual(["room", "person"]);
    expect(pinnableKinds(undefined)).toEqual([]);
  });
});

describe("regras: aviso x bloqueio", () => {
  const warn = (code: string, extra = {}) => ({ code, severity: "warn", message: "msg do servidor", ...extra });
  const block = (code: string, extra = {}) => ({ code, severity: "block", message: "msg do servidor", ...extra });

  it("só avisos: forçável, e force lista exatamente os códigos mostrados", () => {
    const out = classifyViolations(parseViolations([warn("OUTSIDE_HOURS"), warn("BUFFER_OVERLAP"), warn("OUTSIDE_HOURS")]));
    expect(out.canForce).toBe(true);
    expect(out.blocks).toEqual([]);
    expect(out.forceCodes).toEqual(["OUTSIDE_HOURS", "BUFFER_OVERLAP"]);
  });
  it("capacidade nunca é forçável, nem se o servidor mandasse 'warn'", () => {
    expect(classifyViolations(parseViolations([block("CAPACITY_EXCEEDED")])).canForce).toBe(false);
    const odd = classifyViolations(parseViolations([warn("CAPACITY_EXCEEDED")]));
    expect(odd.canForce).toBe(false);
    expect(odd.forceCodes).toEqual([]);
    expect(NEVER_FORCEABLE).toContain("CAPACITY_EXCEEDED");
  });
  it("aviso junto com bloqueio: ninguém é forçado", () => {
    const out = classifyViolations(parseViolations([warn("OUTSIDE_HOURS"), block("CAPACITY_EXCEEDED")]));
    expect(out.canForce).toBe(false);
    expect(out.forceCodes).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.blocks).toHaveLength(1);
  });
  it("gravidade desconhecida é tratada como bloqueio", () => {
    const [v] = parseViolations([{ code: "NOVA_REGRA", severity: "info", message: "x" }]);
    expect(v.severity).toBe("block");
    expect(classifyViolations([v]).canForce).toBe(false);
  });
  it("sem violações não há o que forçar", () => {
    expect(classifyViolations([]).canForce).toBe(false);
  });
  it("lixo na lista é descartado", () => {
    expect(parseViolations([null, 3, { severity: "warn" }, warn("OFF_GRID")])).toHaveLength(1);
    expect(parseViolations("x")).toEqual([]);
  });
  it("texto: vocabulário da tela, com o nome do recurso quando se sabe", () => {
    const names = new Map([["room2", "Sala 2"]]);
    const [cap] = parseViolations([block("CAPACITY_EXCEEDED", { detail: { resourceId: "room2" } })]);
    expect(violationText(cap, names)).toBe("Sala 2 não tem mais vaga neste horário.");
    const [hours] = parseViolations([warn("OUTSIDE_HOURS", { detail: { resourceId: "room2" } })]);
    expect(violationText(hours, names)).toBe("Fora do horário de atendimento: Sala 2");
    const [client] = parseViolations([warn("CLIENT_OVERLAP")]);
    expect(violationText(client)).toBe("O cliente já tem outro horário nesta hora");
  });
  it("código desconhecido cai na mensagem do servidor", () => {
    const [v] = parseViolations([{ code: "FUTURA", severity: "warn", message: "Algo novo aconteceu." }]);
    expect(violationText(v)).toBe("Algo novo aconteceu.");
  });
  it("horário tomado = capacidade entre as violações", () => {
    expect(isSlotTaken(parseViolations([block("CAPACITY_EXCEEDED")]))).toBe(true);
    expect(isSlotTaken(parseViolations([warn("OUTSIDE_HOURS")]))).toBe(false);
  });
});

describe("erro sched_rules e proposta vencida", () => {
  it("lê violações e alternativas do ConvexError", () => {
    const err = new ConvexError({
      code: "sched_rules",
      violations: [{ code: "OUTSIDE_HOURS", severity: "warn", message: "x" }],
      alternatives: [{ startTime: 1, resourceIds: [] }],
    });
    const parsed = parseSchedRulesError(err);
    expect(parsed?.violations[0].code).toBe("OUTSIDE_HOURS");
    expect(parsed?.alternatives).toHaveLength(1);
  });
  it("outros erros não são de regra", () => {
    expect(parseSchedRulesError(new Error("boom"))).toBeNull();
    expect(parseSchedRulesError(new ConvexError("texto"))).toBeNull();
    expect(parseSchedRulesError(new ConvexError({ code: "outro" }))).toBeNull();
    expect(parseSchedRulesError(undefined)).toBeNull();
  });
  it("reconhece proposta vencida e proposta que não vale mais", () => {
    expect(isProposalFailure(new ConvexError("Esta proposta venceu: o horário proposto já passou. Recuse a proposta e marque de novo."))).toBe(true);
    expect(isProposalFailure(new ConvexError("Esta proposta não vale mais: o horário original já mudou."))).toBe(true);
    expect(isProposalFailure(new Error("Uncaught Error: Esta proposta venceu"))).toBe(true);
    expect(isProposalFailure(new ConvexError("Agendamento não encontrado"))).toBe(false);
    expect(isProposalFailure(undefined)).toBe(false);
  });
});
