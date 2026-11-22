import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { computeDayAvailability } from "../../convex/lib/schedAvailability";
import { scoreCandidate, DEFAULT_WEIGHTS } from "../../convex/lib/schedScore";
import { atLocalMinutes } from "../../convex/lib/schedTime";
import { slotTouchesAnother } from "./agendaSlots";
import {
  EXPANDED_LIMIT,
  NEVER_FORCEABLE,
  SUGGESTED_COUNT,
  bookingReducer,
  buildBookArgs,
  nearestSlotStart,
  supportsGroup,
  timeInputValue,
  buildFindSlotsArgs,
  buildRescheduleArgs,
  clientLabel,
  interpretPreview,
  pinsForService,
  previewManualSlot,
  reviewSubmitLabel,
  mergeRefreshedSlots,
  submitBooking,
  undoFreshBooking,
  undoRefusedText,
  canAdvance,
  chosenDurationMin,
  classifyViolations,
  defaultServiceId,
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
  it("escolher o serviço mantém a sala clicada na Agenda; trocar para um que não usa sala descarta horário, variação e a sala", () => {
    let s = base({ pinned: { room: "room1" } });
    s = bookingReducer(s, { type: "pickService", serviceId: "svc1", services });
    expect(s.pinned).toEqual({ room: "room1" }); // a coluna clicada continua fixada (antes era apagada aqui)
    expect(buildFindSlotsArgs({ organizationId: "org", state: s, tz: "America/Sao_Paulo", now: NOW })?.resourceIds).toEqual(["room1"]);
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
      allowResourceFallback: false,
      idempotencyKey: "k1",
    });
  });
  it("horário digitado: a prévia vai com o que a pessoa fixou; depois dela, o envio leva o plano que a revisão mostrou", () => {
    // Antes da prévia o horário digitado não tem plano: só o que a pessoa escolheu, sem deixar trocar.
    const beforePreview = state({ slot: picked({ manual: true, resourceIds: [], resourceNames: [] }), pinned: { room: "roomD" } });
    const preview = buildBookArgs({ organizationId: "org", state: beforePreview, who, mode: "preview" });
    expect(preview?.resourceIds).toEqual(["roomD"]);
    expect(preview?.allowResourceFallback).toBe(false);
    // Depois da prévia: o plano real (a sala fixada + o profissional que o servidor achou).
    const afterPreview = state({ slot: picked({ manual: true, resourceIds: ["roomD", "pers2"] }), pinned: { room: "roomD" } });
    const book = buildBookArgs({ organizationId: "org", state: afterPreview, who });
    expect(book?.resourceIds).toEqual(["roomD", "pers2"]);
    expect(book?.allowResourceFallback).toBe(false);
    // Nada fixado e sem plano: o servidor escolhe (sem `resourceIds` não há o que manter).
    const none = state({ slot: picked({ manual: true, resourceIds: [] }) });
    const free = buildBookArgs({ organizationId: "org", state: none, who });
    expect(free).not.toHaveProperty("resourceIds");
    expect(free).not.toHaveProperty("allowResourceFallback");
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
  it("prévia de remarcação leva rescheduleAppointmentId; marcar de verdade nunca leva", () => {
    const manual = state({ slot: picked({ manual: true, resourceIds: [] }) });
    const preview = buildBookArgs({ organizationId: "org", state: manual, who: {}, mode: "preview", rescheduleAppointmentId: "appt1" });
    expect(preview?.rescheduleAppointmentId).toBe("appt1");
    expect(buildBookArgs({ organizationId: "org", state: manual, who: {}, mode: "preview" })).not.toHaveProperty("rescheduleAppointmentId");
    expect(buildBookArgs({ organizationId: "org", state: manual, who: {}, rescheduleAppointmentId: "appt1" })).not.toHaveProperty("rescheduleAppointmentId");
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
      allowResourceFallback: false,
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
    reasonCodes: [],
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

describe("encostado: códigos estruturados primeiro, texto do servidor depois", () => {
  const slot = (reasons: string[], reasonCodes?: string[]) => ({ reasons, reasonCodes });
  it("reasonCodes manda quando existe", () => {
    expect(isAdjacentSlot(slot([], ["ADJACENT"]))).toBe(true);
    expect(isAdjacentSlot(slot(["logo após outro atendimento"], ["OUTRO_CODIGO"]))).toBe(false);
  });
  it("sem códigos, cai no texto", () => {
    expect(isAdjacentSlot(slot(["logo antes de outro atendimento"], []))).toBe(true);
    expect(isAdjacentSlot(slot(["logo antes de outro atendimento"]))).toBe(true);
  });
  it("PROTEÇÃO: o texto REAL do servidor (scoreCandidate) continua sendo reconhecido como encostado", () => {
    const tz = "America/Sao_Paulo";
    const MON = "2026-11-23";
    const at = (hh: number) => atLocalMinutes(MON, hh * 60, tz);
    const room = { _id: "A", kind: "room" as const, name: "Sala A", capacity: 1, weekly: [{ weekday: 1, startMin: 480, endMin: 1080 }], sortOrder: 0, active: true };
    const busy = { appointmentId: "x", resourceId: "A", blockStart: at(9), blockEnd: at(10), coreStart: at(9), coreEnd: at(10), units: 1 };
    const day = computeDayAvailability({ date: MON, tz, resources: [room], exceptions: [], allocations: [busy], internalEvents: [] });
    const cand = (h: number) => ({ startTime: at(h), endTime: at(h + 1), blockStart: at(h), blockEnd: at(h + 1), plan: [{ role: "Sala", resourceId: "A", units: 1 }] });
    const opts = { minUsefulGapMin: 30 };
    const weights = { ...DEFAULT_WEIGHTS, balance: 0 };
    const touching = scoreCandidate(cand(10), day, weights, opts); // logo após o das 9h
    const touchingBefore = scoreCandidate(cand(8), day, weights, opts); // logo antes do das 9h
    const apart = scoreCandidate(cand(14), day, weights, opts);
    expect(isAdjacentSlot({ reasons: touching.reasons })).toBe(true);
    expect(isAdjacentSlot({ reasons: touchingBefore.reasons })).toBe(true);
    expect(isAdjacentSlot({ reasons: apart.reasons })).toBe(false);
    // O código estruturado do servidor decide igual ao texto.
    expect(isAdjacentSlot(touching)).toBe(true);
    expect(isAdjacentSlot(touchingBefore)).toBe(true);
    expect(isAdjacentSlot(apart)).toBe(false);
    expect(touching.reasonCodes).toContain("ADJACENT");
  });
  it("isAdjacentSlot delega à regra única de agendaSlots", () => {
    for (const s of [slot([], ["ADJACENT"]), slot(["logo após outro atendimento"], ["NEW_RESOURCE"]), slot(["logo antes de outro atendimento"]), slot(["no início do expediente"], ["EDGE_OF_DAY"])]) {
      expect(isAdjacentSlot(s)).toBe(slotTouchesAnother(s));
    }
  });
});

describe("force do envio inclui os avisos já vistos na prévia", () => {
  const warn = (code: string) => ({ code, severity: "warn" as const, message: "" });
  const state = (warnings: ReturnType<typeof warn>[]): BookingState => ({
    ...base({ serviceId: "svc1" }),
    slot: picked({ manual: true, warnings: [...warnings, { code: "CAPACITY_EXCEEDED", severity: "block", message: "" }] }),
  });
  it("só os forçáveis, sem repetir, e soma ao que foi aceito agora", () => {
    const args = buildBookArgs({ organizationId: "org", state: state([warn("OUTSIDE_HOURS")]), who: { contactId: "c1" }, force: ["BUFFER_OVERLAP", "OUTSIDE_HOURS"] });
    expect(args?.force?.sort()).toEqual(["BUFFER_OVERLAP", "OUTSIDE_HOURS"]);
    expect(args?.force).not.toContain("CAPACITY_EXCEEDED");
    expect(buildRescheduleArgs({ organizationId: "org", appointmentId: "a", state: state([warn("OUTSIDE_HOURS")]) })?.force).toEqual(["OUTSIDE_HOURS"]);
  });
  it("sem aviso visto nem aceito, nada vai", () => {
    expect(buildBookArgs({ organizationId: "org", state: { ...base({ serviceId: "svc1" }), slot: picked() }, who: { contactId: "c1" } })).not.toHaveProperty("force");
  });
});

describe("rebusca silenciosa da lista", () => {
  const mk = (h: number, res = "r"): OfferedSlot => ({ startTime: at(h), endTime: at(h + 1), localDate: "2026-11-26", label: "", resourceIds: [res], resourceNames: [], score: 0, reasons: [], reasonCodes: [] });
  it("mantém a ordem exibida, tira só o que passou e acrescenta o novo no fim", () => {
    const prev = [mk(15), mk(11), mk(17)];
    const next = [mk(11), mk(15), mk(12), mk(17)];
    const out = mergeRefreshedSlots(prev, next, at(11) + 1);
    expect(out.map((s) => s.startTime)).toEqual([at(15), at(17), at(12)]);
  });
  it("horário que sumiu do servidor continua até passar (o envio trata o tomado)", () => {
    const out = mergeRefreshedSlots([mk(15), mk(16)], [mk(16)], at(10));
    expect(out.map((s) => s.startTime)).toEqual([at(15), at(16)]);
  });
});

describe("cliente na revisão", () => {
  it("nome, senão telefone, senão texto genérico; nunca vazio", () => {
    expect(clientLabel(" Maria ", "+55 11 99999-1234")).toBe("Maria");
    expect(clientLabel("", "+55 11 99999-1234")).toBe("+55 11 99999-1234");
    expect(clientLabel(undefined, undefined)).toBe("Cliente desta conversa");
    expect(clientLabel("  ", " ")).toBe("Cliente desta conversa");
  });
});

describe("submitBooking", () => {
  const state: BookingState = { ...base({ serviceId: "svc1" }), slot: picked() };
  const input = { organizationId: "org", state, who: { contactId: "c1" }, tz: TZ, now: NOW };
  const rulesErr = (violations: unknown[], alternatives: unknown[] = []) => new ConvexError({ code: "sched_rules", violations, alternatives } as never);
  const deps = (over: Partial<Parameters<typeof submitBooking>[0]> = {}) => ({
    book: async () => ({ appointmentIds: ["a1"], duplicate: false }),
    reschedule: async () => null,
    ...over,
  });

  it("marcou", async () => {
    expect(await submitBooking(deps(), input)).toEqual({ kind: "booked", appointmentIds: ["a1"] });
  });
  it("sem horário: inválido", async () => {
    expect(await submitBooking(deps(), { ...input, state: base({ serviceId: "svc1" }) })).toEqual({ kind: "invalid" });
  });
  it("duplicado: devolve o existente e NÃO conta como marcação nova", async () => {
    const out = await submitBooking(deps({ book: async () => ({ appointmentIds: ["velho"], duplicate: true }) }), input);
    expect(out).toEqual({ kind: "duplicate", appointmentId: "velho" });
  });
  it("remarcar usa a porta de remarcar", async () => {
    const calls: unknown[] = [];
    const out = await submitBooking(deps({ reschedule: async (a) => void calls.push(a) }), { ...input, rescheduleAppointmentId: "a9" });
    expect(out).toEqual({ kind: "rescheduled", appointmentId: "a9" });
    expect(calls[0]).toMatchObject({ appointmentId: "a9", startTime: at(14) });
  });
  it("só avisos: regras sem bloqueio (forçável)", async () => {
    const out = await submitBooking(deps({ book: async () => { throw rulesErr([{ code: "OUTSIDE_HOURS", severity: "warn", message: "x" }]); } }), input);
    expect(out).toMatchObject({ kind: "rules", blocked: false });
  });
  it("capacidade: bloqueado, com alternativas dos dois formatos", async () => {
    const alt = at(16);
    const out = await submitBooking(
      deps({ book: async () => { throw rulesErr([{ code: "CAPACITY_EXCEEDED", severity: "block", message: "x" }], [{ startTime: alt, resourceIds: ["r"] }]); } }),
      input
    );
    expect(out).toMatchObject({ kind: "rules", blocked: true });
    expect(out.kind === "rules" && out.alternatives.map((a) => a.startTime)).toEqual([alt]);
  });
  it("outro erro é devolvido como está", async () => {
    const boom = new Error("boom");
    expect(await submitBooking(deps({ book: async () => { throw boom; } }), input)).toEqual({ kind: "error", error: boom });
  });
});

describe("desfazer a marcação recém-feita", () => {
  it("chama undoBooking uma vez com todos os ids (grupo inteiro) e devolve ok", async () => {
    const calls: unknown[] = [];
    const out = await undoFreshBooking((async (a: unknown) => { calls.push(a); return { undoneIds: [], restoredIds: [] }; }) as never, { organizationId: "org", appointmentIds: ["a", "b", "c"] });
    expect(out).toEqual({ kind: "ok" });
    expect(calls).toEqual([{ organizationId: "org", appointmentIds: ["a", "b", "c"] }]);
  });
  it("recusa do servidor vira 'refused' com a mensagem; outro erro é devolvido", async () => {
    const refused = await undoFreshBooking((async () => { throw new ConvexError("O horário já mudou de situação."); }) as never, { organizationId: "o", appointmentIds: ["a"] });
    expect(refused).toEqual({ kind: "refused", message: "O horário já mudou de situação." });
    const boom = new Error("rede");
    expect(await undoFreshBooking((async () => { throw boom; }) as never, { organizationId: "o", appointmentIds: ["a"] })).toEqual({ kind: "error", error: boom });
    const objectData = new ConvexError({ code: "x" } as never);
    expect((await undoFreshBooking((async () => { throw objectData; }) as never, { organizationId: "o", appointmentIds: ["a"] })).kind).toBe("error");
  });
  it("texto da recusa: 'Já não dá para desfazer: ...' com a inicial minúscula", () => {
    expect(undoRefusedText("O horário anterior foi ocupado por outro agendamento.")).toBe("Já não dá para desfazer: o horário anterior foi ocupado por outro agendamento.");
    expect(undoRefusedText("A marcação foi feita há mais de 10 minutos")).toBe("Já não dá para desfazer: a marcação foi feita há mais de 10 minutos.");
  });
  it("remarcar devolve o id do agendamento novo, que é o que o Desfazer desfaz", async () => {
    const out = await submitBooking({ book: async () => ({ appointmentIds: [], duplicate: false }), reschedule: async () => ({ appointmentId: "novo" }) }, {
      organizationId: "org", state: { ...base({ serviceId: "svc1" }), slot: picked() }, who: {}, rescheduleAppointmentId: "velho", tz: TZ, now: NOW,
    });
    expect(out).toEqual({ kind: "rescheduled", appointmentId: "velho", newAppointmentId: "novo" });
  });
});

describe("prévia de 'Outro horário'", () => {
  const ctx = { tz: TZ, now: NOW };
  const res = (over = {}) => ({ ok: true, warnings: [], violations: [], alternatives: [], plan: [{ resourceName: "Sala 1" }], ...over });
  it("já existe: duplicado, não segue", () => {
    expect(interpretPreview(res({ duplicateOf: "velho" }), ctx)).toEqual({ kind: "duplicate", appointmentId: "velho" });
  });
  it("livre, com avisos e bloqueado", () => {
    expect(interpretPreview(res(), ctx)).toMatchObject({ kind: "ok", resourceNames: ["Sala 1"] });
    expect(interpretPreview(res({ ok: false, violations: [{ code: "OUTSIDE_HOURS", severity: "warn", message: "" }] }), ctx).kind).toBe("warn");
    const blocked = interpretPreview(res({ ok: false, violations: [{ code: "CAPACITY_EXCEEDED", severity: "block", message: "" }], alternatives: [{ startTime: at(16), resourceIds: [] }] }), ctx);
    expect(blocked.kind).toBe("blocked");
  });
});

describe("recursos fixados e o serviço", () => {
  const restrito: ServiceLike = { _id: "svc9", name: "Casal", durationMin: 60, requirements: [{ kind: "room", resourceIds: ["roomD"] }, { kind: "person" }] };
  it("mantém o que o serviço pede; tira o tipo que ele não usa e a sala fora da lista do requisito", () => {
    expect(pinsForService({ room: "room1", person: "pers1" }, sessao)).toEqual({ room: "room1", person: "pers1" });
    expect(pinsForService({ room: "room1", person: "pers1" }, corte)).toEqual({ person: "pers1" });
    expect(pinsForService({ room: "room1" }, restrito)).toEqual({});
    expect(pinsForService({ room: "roomD" }, restrito)).toEqual({ room: "roomD" });
    expect(pinsForService({ room: "room1" }, undefined)).toEqual({});
  });
  it("abrindo já com o serviço decidido, a sala clicada vem fixada (e some se o serviço não usa sala)", () => {
    expect(initialBookingState({ services: [sessao], idempotencyKey: "k", pinned: { room: "room1" } }).pinned).toEqual({ room: "room1" });
    expect(initialBookingState({ services: [sessao, corte], serviceId: "svc2", variantKey: "longo", idempotencyKey: "k", pinned: { room: "room1" } }).pinned).toEqual({});
  });
});

describe("prévia de 'Outro horário' com o plano real", () => {
  const ctx = { tz: "America/Sao_Paulo", now: NOW };
  const okRes = { ok: true, warnings: [], violations: [], alternatives: [], plan: [{ resourceId: "room1", resourceName: "Sala 1" }, { resourceId: "pers1", resourceName: "Ana" }] };
  const warn = { code: "OUTSIDE_HOURS", severity: "warn", message: "" };
  it("livre: uma chamada, com o plano (ids e nomes)", async () => {
    const calls: Array<string[] | undefined> = [];
    const v = await previewManualSlot(async (force) => (calls.push(force), okRes), ctx);
    expect(calls).toEqual([undefined]);
    expect(v).toEqual({ kind: "ok", warnings: [], resourceIds: ["room1", "pers1"], resourceNames: ["Sala 1", "Ana"] });
  });
  it("só avisos: repete aceitando os avisos para saber o lugar; a revisão recebe avisos E plano", async () => {
    const calls: Array<string[] | undefined> = [];
    const v = await previewManualSlot(async (force) => {
      calls.push(force);
      return force ? { ...okRes, warnings: [warn] } : { ...okRes, ok: false, plan: [], violations: [warn, warn] };
    }, ctx);
    expect(calls).toEqual([undefined, ["OUTSIDE_HOURS"]]);
    expect(v).toMatchObject({ kind: "ok", resourceIds: ["room1", "pers1"], resourceNames: ["Sala 1", "Ana"] });
    expect(v.kind === "ok" && v.warnings.map((w) => w.code)).toEqual(["OUTSIDE_HOURS"]);
  });
  it("bloqueio (sala escolhida cheia) não repete e devolve as alternativas", async () => {
    let n = 0;
    const v = await previewManualSlot(async () => (n++, { ...okRes, ok: false, plan: [], violations: [{ code: "CAPACITY_EXCEEDED", severity: "block", message: "" }], alternatives: [{ startTime: at(16), resourceIds: ["room1"] }] }), ctx);
    expect(n).toBe(1);
    expect(v.kind).toBe("blocked");
    expect(v.kind === "blocked" && v.alternatives).toHaveLength(1);
  });
  it("aceitar os avisos revelou bloqueio: vale o bloqueio", async () => {
    const v = await previewManualSlot(async (force) => (force ? { ...okRes, ok: false, plan: [], violations: [{ code: "CAPACITY_EXCEEDED", severity: "block", message: "" }] } : { ...okRes, ok: false, plan: [], violations: [warn] }), ctx);
    expect(v.kind).toBe("blocked");
  });
});

describe("botão de confirmar da revisão", () => {
  const w = { code: "OUTSIDE_HOURS", severity: "warn" as const, message: "" };
  it("sem aviso: Marcar horário / Remarcar", () => {
    expect(reviewSubmitLabel(picked(), false)).toBe("Marcar horário");
    expect(reviewSubmitLabel(picked(), true)).toBe("Remarcar");
    expect(reviewSubmitLabel(null, false)).toBe("Marcar horário");
  });
  it("com aviso visível: Marcar mesmo assim / Remarcar mesmo assim", () => {
    expect(reviewSubmitLabel(picked({ warnings: [w] }), false)).toBe("Marcar mesmo assim");
    expect(reviewSubmitLabel(picked({ warnings: [w] }), true)).toBe("Remarcar mesmo assim");
  });
});

describe("busca com acompanhantes (partySize)", () => {
  const argsFor = (companions: string[]) => buildFindSlotsArgs({ organizationId: "org", state: { ...base({ serviceId: "svc1" }), companions }, tz: "America/Sao_Paulo", now: Date.UTC(2026, 10, 26, 15) });
  it("sem acompanhante não manda partySize; cada linha de acompanhante conta (nome ou não), no máximo 4", () => {
    expect(argsFor([])).not.toHaveProperty("partySize");
    expect(argsFor([""])?.partySize).toBe(2);
    expect(argsFor(["Maria", "", "Bia"])?.partySize).toBe(4);
    expect(argsFor(["a", "b", "c", "d", "e"])?.partySize).toBe(4);
  });
  it("'Quantas pessoas?' antes do horário: ajusta os acompanhantes, mantém nomes e descarta o horário escolhido", () => {
    const s0 = { ...base({ serviceId: "svc1" }), companions: ["Maria", "Bia"], slot: picked() };
    const s1 = bookingReducer(s0, { type: "setPartySize", size: 2 });
    expect(s1.companions).toEqual(["Maria"]);
    expect(s1.slot).toBeNull();
    expect(bookingReducer(s1, { type: "setPartySize", size: 4 }).companions).toEqual(["Maria", "", ""]);
    expect(bookingReducer(s1, { type: "setPartySize", size: 1 }).companions).toEqual([]);
    expect(bookingReducer(s1, { type: "setPartySize", size: 9 }).companions).toHaveLength(3);
    expect(bookingReducer(s1, { type: "setPartySize", size: 0 }).companions).toHaveLength(0);
  });
  it("só mostra grupo quando o serviço usa sala/equipamento com capacidade acima de 1 (da lista do requisito)", () => {
    const dual = { _id: "dual", name: "Dupla", kind: "room", capacity: 2 };
    const simples = { _id: "s1", name: "Sala", kind: "room", capacity: 1 };
    const pro = { _id: "p", name: "Ana", kind: "person", capacity: 3 };
    const svc = (reqs: ServiceLike["requirements"]): ServiceLike => ({ _id: "x", name: "S", durationMin: 60, requirements: reqs });
    expect(supportsGroup(svc([{ kind: "room" }]), [dual, simples])).toBe(true);
    expect(supportsGroup(svc([{ kind: "room" }]), [simples])).toBe(false);
    expect(supportsGroup(svc([{ kind: "person" }]), [pro])).toBe(false);
    expect(supportsGroup(svc([{ kind: "room", resourceIds: ["s1"] }]), [dual, simples])).toBe(false);
    expect(supportsGroup(svc([{ kind: "room", resourceIds: ["dual"] }]), [dual, simples])).toBe(true);
    expect(supportsGroup(svc([{ kind: "room" }]), [{ ...dual, active: false }])).toBe(false);
    expect(supportsGroup(undefined, [dual])).toBe(false);
  });
});

describe("hora pedida pela Agenda", () => {
  const tz = "America/Sao_Paulo";
  const at = (date: string, h: number, m = 0) => atLocalMinutes(date, h * 60 + m, tz);
  const slot = (date: string, h: number, m = 0) => ({ startTime: at(date, h, m), localDate: date });
  it("escolhe a sugestão mais próxima; empate vai para a mais cedo", () => {
    const list = [slot("2026-11-26", 9), slot("2026-11-26", 10), slot("2026-11-26", 12)];
    expect(nearestSlotStart(list, { timeMin: 11 * 60 + 40, tz })).toBe(at("2026-11-26", 12));
    expect(nearestSlotStart(list, { timeMin: 11 * 60, tz })).toBe(at("2026-11-26", 10)); // 10:00 e 12:00 a 60 min? 10:00 vence por ser a mais cedo
    expect(nearestSlotStart(list, { timeMin: 0, tz })).toBe(at("2026-11-26", 9));
  });
  it("só considera o dia pedido e devolve null sem sugestão", () => {
    const list = [slot("2026-11-25", 11), slot("2026-11-26", 15)];
    expect(nearestSlotStart(list, { timeMin: 11 * 60, tz, date: "2026-11-26" })).toBe(at("2026-11-26", 15));
    expect(nearestSlotStart(list, { timeMin: 11 * 60, tz, date: "2026-11-27" })).toBeNull();
    expect(nearestSlotStart([], { timeMin: 600, tz })).toBeNull();
  });
  it("campo de hora: HH:mm ou vazio quando fora do dia", () => {
    expect(timeInputValue(9 * 60 + 5)).toBe("09:05");
    expect(timeInputValue(undefined)).toBe("");
    expect(timeInputValue(1440)).toBe("");
    expect(timeInputValue(-1)).toBe("");
  });
});
