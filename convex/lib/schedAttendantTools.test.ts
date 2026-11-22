import { describe, expect, test } from "vitest";
import { INJECTED_PARAM_NAMES } from "./agentTools";
import {
  bookedResult,
  buildSchedPromptBlock,
  FIND_TOOL,
  BOOK_TOOL,
  formatOfferLine,
  formatSlotText,
  matchService,
  parseBookArgs,
  parseFindArgs,
  SCHED_ATTENDANT_TOOLS,
  upcomingForEnvelope,
} from "./schedAttendantTools";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-11-21T12:00:00Z").getTime(); // sábado
const at = (iso: string) => new Date(iso).getTime();

describe("specs das tools", () => {
  test("nomes em inglês camelCase, sem 'Agenda', nenhum parâmetro de escopo nem id", () => {
    expect(SCHED_ATTENDANT_TOOLS.map((t) => t.name)).toEqual([FIND_TOOL, BOOK_TOOL]);
    for (const tool of SCHED_ATTENDANT_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][A-Za-z]+$/);
      expect(tool.name).not.toMatch(/agenda/i);
      expect(tool.audience).toBe("attendant");
      const props = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
      for (const injected of INJECTED_PARAM_NAMES) expect(props).not.toContain(injected);
      expect(tool.resultFields).toEqual(["status", "resultado", "error", "proximo_passo", "ha_mais"]);
    }
  });

  test("bookOfferedTime só aceita o código da oferta: nunca data nem hora", () => {
    const book = SCHED_ATTENDANT_TOOLS.find((t) => t.name === BOOK_TOOL)!;
    expect(Object.keys((book.parameters as { properties: object }).properties)).toEqual(["offer"]);
    expect((book.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
    expect(book.effect).toBe("write");
    expect(SCHED_ATTENDANT_TOOLS.find((t) => t.name === FIND_TOOL)!.effect).toBe("read");
  });

  test("a lista de ids proibidos como parâmetro inclui os da agenda", () => {
    for (const name of ["appointmentId", "serviceId", "resourceId", "offerId"]) expect(INJECTED_PARAM_NAMES).toContain(name);
  });
});

describe("parseFindArgs", () => {
  test("válido, com padrões", () => {
    expect(parseFindArgs('{"service":" Consulta ","dateRef":"amanha"}')).toEqual({
      ok: true,
      args: { service: "Consulta", dateRef: "amanha", period: undefined, people: 1 },
    });
    expect(parseFindArgs('{"service":"Consulta","dateRef":"2026-11-26","period":"tarde","people":3}')).toMatchObject({
      ok: true,
      args: { period: "tarde", people: 3 },
    });
  });
  test.each([
    ["", "servico_desconhecido"], // sem argumentos = objeto vazio
    ["[]", "argumentos_invalidos"],
    ["não é json", "argumentos_invalidos"],
    ['{"dateRef":"hoje"}', "servico_desconhecido"],
    ['{"service":"x","dateRef":""}', "data_invalida"],
    [`{"service":"x","dateRef":"${"9".repeat(21)}"}`, "data_invalida"],
    [`{"service":"${"a".repeat(81)}","dateRef":"hoje"}`, "servico_desconhecido"],
    ['{"service":"x","dateRef":"hoje","period":"cedo"}', "periodo_invalido"],
    ['{"service":"x","dateRef":"hoje","people":1.5}', "pessoas_invalido"],
    ['{"service":"x","dateRef":"hoje","people":5}', "pessoas_invalido"],
    ['{"service":"x","dateRef":"hoje","people":-1}', "pessoas_invalido"],
  ])("%s → %s", (json, code) => {
    const r = parseFindArgs(json);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(code);
      expect(r.proximo_passo.length).toBeGreaterThan(10);
    }
  });
});

describe("parseBookArgs", () => {
  test.each([["h1", "h1"], [" H12 ", "h12"]])("aceita %s", (raw, code) => {
    expect(parseBookArgs(JSON.stringify({ offer: raw }))).toEqual({ ok: true, offer: code });
  });
  test.each(["h0", "h", "x1", "h01", "h12345", "2026-06-15T10:00", "h1; delete", "10:00"])("recusa %s", (raw) => {
    const r = parseBookArgs(JSON.stringify({ offer: raw }));
    expect(r.ok).toBe(false);
  });
  test("ignora campos extras (data/hora livre nunca chega à reserva)", () => {
    const r = parseBookArgs('{"offer":"h2","startTime":123,"date":"2026-11-26","time":"10:00"}');
    expect(r).toEqual({ ok: true, offer: "h2" });
  });
  test("sem oferta, recusa", () => {
    expect(parseBookArgs("{}").ok).toBe(false);
    expect(parseBookArgs("").ok).toBe(false);
  });
});

describe("matchService", () => {
  const list = [
    { id: "1", name: "Consulta", durationMin: 60 },
    { id: "2", name: "Sessão de massagem", durationMin: 45 },
  ];
  test("nome exato, sem acento nem caixa", () => {
    expect(matchService(list, "sessao de MASSAGEM")?.id).toBe("2");
    expect(matchService(list, "consulta")?.id).toBe("1");
  });
  test("nome parcial só vale com a lista cortada (> 15 serviços)", () => {
    expect(matchService(list, "massagem")).toBeNull();
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `Serviço ${i}X`, durationMin: 30 }));
    many.push({ id: "m", name: "Massagem relaxante", durationMin: 50 });
    expect(matchService(many, "relaxante")?.id).toBe("m");
    expect(matchService(many, "serviço")).toBeNull(); // ambíguo
  });
  test("vazio e nome duplicado não casam", () => {
    expect(matchService(list, "  ")).toBeNull();
    expect(matchService([...list, { id: "3", name: "consulta", durationMin: 30 }], "Consulta")).toBeNull();
  });
});

describe("textos em PT-BR", () => {
  test("linha da oferta: código, dia da semana, data e hora local por extenso", () => {
    // 26/11/2026 é quinta-feira; 13:00Z = 10:00 em São Paulo
    expect(formatOfferLine("h1", at("2026-11-26T13:00:00Z"), NOW, TZ)).toBe("h1 — quinta-feira, 26/11, às 10:00");
    expect(formatSlotText(at("2026-11-26T17:30:00Z"), NOW, TZ)).toBe("quinta-feira, 26/11, às 14:30");
  });
  test("ano só quando difere do atual", () => {
    expect(formatSlotText(at("2027-01-05T13:00:00Z"), NOW, TZ)).toBe("terça-feira, 05/01/2027, às 10:00");
  });
  test("hora no fuso da org, não no do servidor (virada de dia)", () => {
    // 02:00Z de sexta 27 = 23:00 de quinta 26 em São Paulo
    expect(formatSlotText(at("2026-11-27T02:00:00Z"), NOW, TZ)).toBe("quinta-feira, 26/11, às 23:00");
  });
  test("resultado da reserva: pending nunca diz 'marcado'; scheduled diz", () => {
    const pending = bookedResult("pending", "quinta-feira, 26/11, às 10:00", false);
    expect(pending.status).toBe("reservado_aguardando_equipe");
    expect(pending.resultado).toContain("aguardando confirmação da equipe");
    expect(pending.resultado).not.toMatch(/\bMarcado\b/);
    expect(pending.resultado).toBe("Pedido registrado para quinta-feira, 26/11, às 10:00, aguardando confirmação da equipe.");
    const done = bookedResult("scheduled", "quinta-feira, 26/11, às 10:00", false);
    expect(done.status).toBe("marcado");
    expect(done.resultado).toBe("Marcado para quinta-feira, 26/11, às 10:00.");
    expect(done.proximo_passo).toContain(done.resultado!);
    expect(pending.proximo_passo).toContain(pending.resultado!);
  });
});

describe("bloco do prompt", () => {
  const services = [{ name: "Consulta", durationMin: 60, priceLabel: "R$ 150,00" }, { name: "Sessão", durationMin: 45 }];
  test("lista nome, duração e só o preço cadastrado", () => {
    const block = buildSchedPromptBlock({ services, moreServices: false, tools: { find: true, book: true }, book: "propose" });
    expect(block).toContain("- Consulta (1 h, R$ 150,00)");
    expect(block).toContain("- Sessão (45 min)");
    expect(block).not.toMatch(/Sessão \(45 min,/);
    expect(block).toContain("no máximo 3");
    expect(block).toContain("NUNCA mostre o código");
    expect(block).toContain("requestHandoff");
  });
  test("política propose manda dizer 'aguardando a equipe'; auto condiciona ao status", () => {
    const propose = buildSchedPromptBlock({ services, moreServices: false, tools: { find: true, book: true }, book: "propose" });
    expect(propose).toContain("a equipe aprova cada horário");
    const auto = buildSchedPromptBlock({ services, moreServices: false, tools: { find: true, book: true }, book: "auto" });
    expect(auto).toContain('só diga "marcado" quando o status for "marcado"');
  });
  test("sem a tool de reserva o bloco não fala de reservar", () => {
    const block = buildSchedPromptBlock({ services, moreServices: false, tools: { find: true, book: false }, book: "propose" });
    expect(block).not.toContain("bookOfferedTime");
  });
  test("muitos serviços: avisa que há outros", () => {
    expect(buildSchedPromptBlock({ services, moreServices: true, tools: { find: true, book: true }, book: "propose" })).toContain("Há outros serviços");
  });
  test("próximos horários do contato vão com referência curta, sem id", () => {
    const rows = upcomingForEnvelope([{ ref: "a1", label: "quinta-feira, 26/11, às 10:00", startTime: 1, serviceName: "Consulta", status: "pending_approval" }]);
    expect(rows).toEqual([{ ref: "a1", horario: "quinta-feira, 26/11, às 10:00", servico: "Consulta", situacao: "aguardando confirmação da equipe" }]);
  });
});

// ── D2: hora pedida, profissional pedido, contagem, prompt ──
import { findSlotsResult, matchResource, noSlotsResult, parseTimeArg, shortProfessionalName } from "./schedAttendantTools";

describe("D2 — hora e profissional nos argumentos", () => {
  test.each([
    ["14:00", 840], ["14h", 840], ["14h30", 870], ["9", 540], ["9:30", 570], ["às 14h", 840], ["08h", 480], ["0:00", 0], ["23:59", 1439],
  ])("hora %s → %i minutos", (raw, min) => {
    expect(parseTimeArg(raw)).toBe(min);
  });
  test.each(["", "24:00", "14:60", "tarde", "14 horas e meia", "1430", "-1", "14:5"])("hora inválida %j", (raw) => {
    expect(parseTimeArg(raw)).toBeNull();
  });
  test("parseFindArgs: time e professional entram; vazio é omitido; lixo vira erro acionável", () => {
    expect(parseFindArgs('{"service":"Corte","dateRef":"amanha","time":"14h","professional":" o Léo "}')).toMatchObject({ ok: true, args: { timeMin: 840, professional: "o Léo" } });
    expect(parseFindArgs('{"service":"Corte","dateRef":"amanha","time":"","professional":""}')).toMatchObject({ ok: true, args: { timeMin: undefined, professional: undefined } });
    expect(parseFindArgs('{"service":"Corte","dateRef":"amanha","time":"tarde"}')).toMatchObject({ ok: false, error: "hora_invalida" });
    expect(parseFindArgs('{"service":"Corte","dateRef":"amanha","time":1400}')).toMatchObject({ ok: false, error: "hora_invalida" });
    expect(parseFindArgs('{"service":"Corte","dateRef":"amanha","professional":42}')).toMatchObject({ ok: false, error: "profissional_invalido" });
  });
  test("a spec da busca expõe time e professional (nunca id) e a reserva continua só com o código", () => {
    const find = SCHED_ATTENDANT_TOOLS.find((x) => x.name === FIND_TOOL)!;
    const props = Object.keys((find.parameters as { properties: Record<string, unknown> }).properties);
    expect(props).toEqual(["service", "dateRef", "period", "people", "time", "professional"]);
    const book = SCHED_ATTENDANT_TOOLS.find((x) => x.name === BOOK_TOOL)!;
    expect(Object.keys((book.parameters as { properties: Record<string, unknown> }).properties)).toEqual(["offer"]);
  });
});

describe("D2 — matchResource (o servidor resolve o nome para um recurso)", () => {
  const rs = [
    { id: "r1", name: "Dra. Helena" },
    { id: "r2", name: "Léo Silva" },
    { id: "r3", name: "Léo Souza" },
    { id: "r4", name: "Tato" },
    { id: "r5", name: "Sala Rosa" },
  ];
  test.each([
    ["Tato", "r4"], ["o tato", "r4"], ["com o TATO", "r4"], ["Helena", "r1"], ["dra helena", "r1"], ["doutora Helena", "r1"],
    ["Léo Silva", "r2"], ["leo souza", "r3"], ["Souza", "r3"], ["sala rosa", "r5"], ["barbeiro Tato", "r4"],
  ])("%s → %s", (input, id) => {
    expect(matchResource(rs, input)).toEqual({ kind: "found", resource: expect.objectContaining({ id }) });
  });
  test("ambíguo, desconhecido e vazio: sem filtro", () => {
    expect(matchResource(rs, "Léo")).toEqual({ kind: "ambiguous" });
    expect(matchResource(rs, "Zeca")).toEqual({ kind: "none" });
    expect(matchResource(rs, "o")).toEqual({ kind: "none" });
    expect(matchResource(rs, "")).toEqual({ kind: "none" });
    expect(matchResource([], "Tato")).toEqual({ kind: "none" });
  });
  test("nome parcial de palavra não casa ('Hel' não é 'Helena')", () => {
    expect(matchResource(rs, "Hel")).toEqual({ kind: "none" });
  });
});

describe("D2 — textos da busca", () => {
  const base = { echo: "seg, 15/06/2026", period: undefined, people: 1, lines: ["h1 — a", "h2 — b", "h3 — c"], hasMore: true };
  test("contagem em FAIXAS (não expõe a ocupação) e 'todos' sem número", () => {
    expect(findSlotsResult({ ...base, total: 5 }).resultado).toContain("Há alguns outros horários livres neste pedido além destes");
    expect(findSlotsResult({ ...base, total: 11 }).resultado).toContain("Há vários outros horários livres");
    expect(findSlotsResult({ ...base, total: 40 }).resultado).toContain("Há muitos outros horários livres");
    expect(findSlotsResult({ ...base, hasMore: false, total: 3 }).resultado).toContain("Estes são TODOS os horários livres neste pedido;");
    for (const t of [5, 11, 40, 3]) expect(findSlotsResult({ ...base, total: t }).resultado).not.toMatch(new RegExp(`\\b${t} horários`));
  });
  test("hora pedida: disponível × indisponível", () => {
    expect(findSlotsResult({ ...base, total: 5, wanted: { timeMin: 840, available: true } }).resultado).toContain("Horário pedido (14:00) DISPONÍVEL: é o primeiro da lista");
    const no = findSlotsResult({ ...base, total: 5, wanted: { timeMin: 840, available: false } }).resultado!;
    expect(no).toContain("Horário pedido (14:00) INDISPONÍVEL neste pedido");
    expect(no).toContain("alternativas mais próximas");
    expect(noSlotsResult({ echo: "x", period: undefined, people: 1, wanted: { timeMin: 870 } }).resultado).toContain("Horário pedido (14:30) INDISPONÍVEL");
  });
  test("profissional: achou = 'SÃO com X'; todos os motivos de não achar dão a MESMA resposta (não revela quem trabalha nem a ocupação)", () => {
    const r = (professional: Parameters<typeof findSlotsResult>[0]["professional"]) => findSlotsResult({ ...base, total: 3, professional }).resultado!;
    expect(r({ kind: "filtered", name: "Léo" })).toContain("SÃO com Léo");
    const same = r({ kind: "not_found" });
    expect(same).toContain("Não consegui esse profissional nesse período");
    for (const n of [{ kind: "ambiguous" }, { kind: "not_available", name: "Léo" }, { kind: "not_for_service", name: "Léo" }] as const) expect(r(n)).toBe(same);
    expect(same).not.toContain("Léo");
    expect(r({ kind: "ignored_group" })).toContain("grupo não escolhe profissional");
  });
  test("linha da oferta só ganha '(com Nome)' quando o servidor nomeou", () => {
    expect(formatOfferLine("h1", at("2026-11-26T13:00:00Z"), NOW, TZ)).toBe("h1 — quinta-feira, 26/11, às 10:00");
    expect(formatOfferLine("h1", at("2026-11-26T13:00:00Z"), NOW, TZ, "Léo")).toBe("h1 — quinta-feira, 26/11, às 10:00 (com Léo)");
  });
  test("reserva de grupo e de profissional dizem isso na frase (e nunca 'marcado' com pedido pendente)", () => {
    const g = bookedResult("pending", "terça-feira, 24/11, às 10:00", false, { people: 2 });
    expect(g.resultado).toContain("para 2 pessoas, aguardando confirmação da equipe");
    expect(bookedResult("pending", "x", false, { professional: "Léo" }).resultado).toContain("com Léo, aguardando");
    expect(g.proximo_passo).toContain('NUNCA diga "confirmado"');
  });
});

describe("D2 — o prompt traz as regras medidas", () => {
  const block = buildSchedPromptBlock({ services: [{ name: "Corte", durationMin: 30 }], moreServices: false, tools: { find: true, book: true }, book: "propose" });
  test("profissional: não atribuir horário a quem a oferta não trouxe; passar professional; dizer quando não pôde atender", () => {
    expect(block).toContain("NUNCA atribua um horário a um profissional");
    expect(block).toContain("professional");
    expect(block).toContain("ofereça só as alternativas que vieram");
  });
  test("hora pedida, grupo, remarcar e códigos", () => {
    expect(block).toContain("Hora pedida");
    expect(block).toContain("Nunca diga que um horário não existe sem ter consultado com time");
    expect(block).toContain("Grupo: para 2 a 4 pessoas");
    expect(block).toContain("REMARCAR ou CANCELAR");
    expect(block).toContain("NÃO ofereça horários novos");
    expect(block).toContain("nunca escreva códigos de oferta (h1)");
  });
});

describe("D2 — nome de exibição curto (o que o cliente disse)", () => {
  test.each([["o Léo", "Léo"], ["com a Dra. Helena", "Helena"], ["  barbeiro Tato ", "Tato"], ["Terapeuta Carla", "Carla"]])("%j → %s", (i, o) => {
    expect(shortProfessionalName(i)).toBe(o);
  });
});
