import { describe, expect, it } from "vitest";
import { type ConfirmProposal, PROPOSAL_TTL_MS, extractDateTimeMentions, matchesProposal, parseConfirmation } from "./schedConfirmParser";

const TZ = "America/Sao_Paulo";
const SAT = Date.parse("2026-11-21T10:00:00-03:00"); // sábado 21/11/2026
const hm = (h: number, m = 0) => h * 60 + m;
const prop = (by: ConfirmProposal["by"], over: Partial<ConfirmProposal> = {}): ConfirmProposal => ({
  localDate: "2026-11-26",
  timeMin: hm(10),
  by,
  at: SAT - 3_600_000,
  ...over,
});
const parse = (t: string, proposal?: ConfirmProposal, now = SAT) => parseConfirmation(t, { now, tz: TZ, proposal });

describe("matchesProposal (terceira condição do plano §8.1)", () => {
  it("coincide: mesmo dia e mesma hora, proposta de qualquer origem (forma explícita)", () => {
    for (const by of ["cliente", "ia", "humano"] as const) {
      const p = parse("Confirmado quinta 10h");
      expect(p.form).toBe("explicito");
      expect(matchesProposal(p, prop(by), SAT)).toEqual({ ok: true, reason: "ok" });
    }
  });

  it("dia diferente", () => {
    expect(matchesProposal(parse("Confirmado sexta 10h"), prop("cliente"), SAT)).toEqual({ ok: false, reason: "dia_diferente" });
  });

  it("hora diferente", () => {
    expect(matchesProposal(parse("Confirmado quinta 11h"), prop("cliente"), SAT)).toEqual({ ok: false, reason: "hora_diferente" });
  });

  it("proposta velha (48 h ou mais)", () => {
    const p = parse("Confirmado quinta 10h");
    expect(matchesProposal(p, prop("cliente", { at: SAT - PROPOSAL_TTL_MS }), SAT).reason).toBe("proposta_velha");
    expect(matchesProposal(p, prop("cliente", { at: SAT - PROPOSAL_TTL_MS + 60_000 }), SAT).ok).toBe(true);
  });

  it("sem proposta, proposta incompleta, ou mensagem que não confirma", () => {
    const p = parse("Confirmado quinta 10h");
    expect(matchesProposal(p, undefined, SAT)).toEqual({ ok: false, reason: "sem_proposta" });
    expect(matchesProposal(p, prop("cliente", { timeMin: undefined }), SAT).reason).toBe("proposta_incompleta");
    expect(matchesProposal(parse("pode ser quinta 10h?"), prop("cliente"), SAT).reason).toBe("nao_confirmou");
  });

  it("falta dia ou hora na mensagem explícita", () => {
    expect(matchesProposal(parse("Confirmado quinta"), prop("cliente"), SAT).reason).toBe("sem_dia_ou_hora");
  });

  it("resposta curta com proposta do humano ou da IA: false", () => {
    for (const by of ["humano", "ia"] as const) {
      const proposal = prop(by);
      const p = parse("Combinado", proposal);
      expect(p.act).toBe("confirmou");
      expect(p.form).toBe("resposta_curta");
      expect(p.fromProposal).toEqual({ date: false, time: false }); // proposta que não é do cliente não preenche nada
      expect(matchesProposal(p, proposal, SAT)).toEqual({ ok: false, reason: "resposta_curta_exige_cliente" });
    }
  });

  it("resposta curta com proposta do cliente: true, e o parser preenche pela proposta", () => {
    const proposal = prop("cliente");
    for (const t of ["Combinado", "Fechado 👍", "ok", "sim", "👍", "Ok, pode ser"]) {
      const p = parse(t, proposal);
      expect(p.act, t).toBe("confirmou");
      expect(p.form, t).toBe("resposta_curta");
      expect(p.level, t).toBe("completo");
      expect(p.fromProposal, t).toEqual({ date: true, time: true });
      expect(p.fromMessage, t).toEqual({});
      expect(matchesProposal(p, proposal, SAT), t).toEqual({ ok: true, reason: "ok" });
    }
  });

  it("'ok' do dono para proposta da IA/humano não confirma nada (nem o parser)", () => {
    expect(parse("ok", prop("ia")).act).toBe("nenhum");
    expect(parse("sim", prop("humano")).act).toBe("nenhum");
  });

  it("proposta velha não preenche resposta curta", () => {
    const p = parse("Combinado", prop("cliente", { at: SAT - PROPOSAL_TTL_MS - 1 }));
    expect(p.fromProposal).toEqual({ date: false, time: false });
    expect(p.negatives).toContain("proposta_velha");
    expect(p.level).toBe("parcial");
  });

  it("separa o que veio da mensagem do que veio da proposta", () => {
    const proposal = prop("cliente");
    const p = parse("Fechado quinta", proposal);
    expect(p.fromMessage).toEqual({ localDate: "2026-11-26", timeMin: undefined });
    expect(p.fromProposal).toEqual({ date: false, time: true });
    expect(p.timeMin).toBe(hm(10));
    expect(p.form).toBe("resposta_curta");
    // dia da mensagem diferente da proposta: não completa a hora
    const q = parse("Fechado sexta", proposal);
    expect(q.fromProposal.time).toBe(false);
    expect(q.timeMin).toBeUndefined();
  });

  it("explícita não é preenchida pela proposta", () => {
    const p = parse("Confirmado quinta 10h", prop("cliente"));
    expect(p.form).toBe("explicito");
    expect(p.fromProposal).toEqual({ date: false, time: false });
    expect(p.fromMessage).toEqual({ localDate: "2026-11-26", timeMin: hm(10) });
  });
});

describe("avisos e ambiguidades de data", () => {
  it("data_distante quando a data fica a mais de 30 dias", () => {
    expect(parse("Confirmado 30/12 às 10h").negatives).toContain("data_distante");
    expect(parse("Confirmado 15/12 às 10h").negatives).not.toContain("data_distante");
  });

  it("'sábado que vem' / 'próximo sábado' quando cai amanhã não resolve o dia", () => {
    const FRI = Date.parse("2026-11-27T10:00:00-03:00");
    for (const t of ["Confirmado sábado que vem 10h", "Confirmado próximo sábado 10h"]) {
      const p = parse(t, undefined, FRI);
      expect(p.localDate, t).toBeUndefined();
      expect(p.level, t).toBe("parcial");
    }
    expect(parse("Confirmado domingo que vem 10h", undefined, FRI).localDate).toBe("2026-11-29");
  });

  it("'amanhã' enviado entre 00h e 05h locais não resolve o dia", () => {
    expect(parse("Confirmado amanhã 10h", undefined, Date.parse("2026-11-22T00:20:00-03:00")).localDate).toBeUndefined();
    expect(parse("Confirmado amanhã 10h", undefined, Date.parse("2026-11-22T05:00:00-03:00")).localDate).toBe("2026-11-23");
  });

  it("'dia 20' no dia 21 resolve para o mês seguinte, com aviso, e nunca completo", () => {
    const p = parse("Confirmado dia 20 às 10h");
    expect(p.localDate).toBe("2026-12-20");
    expect(p.negatives).toContain("dia_ja_passou_neste_mes");
    expect(p.level).toBe("parcial");
    expect(parse("Confirmado dia 10 às 10h").localDate).toBe("2026-12-10");
  });

  it("'quinta (26)' precisa bater com o dia da semana", () => {
    expect(parse("Confirmado: quinta (26) às 10h").localDate).toBe("2026-11-26");
    expect(parse("Confirmado: quinta (27) às 10h").localDate).toBeUndefined();
  });

  it("modificador de semana só vale colado ao dia", () => {
    const MON = Date.parse("2026-11-23T09:00:00-03:00");
    expect(parse("Confirmado quinta 10h, a avaliação fica pra semana que vem", undefined, MON).localDate).toBe("2026-11-26");
    expect(parse("Confirmado sexta da semana que vem 16h", undefined, MON).localDate).toBe("2026-12-04");
  });

  it("emoji: só os da lista de permissão mantêm 'completo'; os negativos derrubam o ato", () => {
    for (const e of ["✅", "👍", "👌", "🙏", "😊", "🙂", "😉", "🤝", "❤️", "😘", "🥰", "👍🏽"]) expect(parse(`Confirmado quinta 10h ${e}`).level, e).toBe("completo");
    for (const e of ["👎", "❌", "🚫", "🙅‍♀️", "❓", "🤔", "🤷‍♀️", "🤡", "🙄", "🙃", "⛔", "✖️"]) {
      const p = parse(`Confirmado quinta 10h ${e}`);
      expect(p.act, e).not.toBe("confirmou");
    }
    for (const e of ["🕙", "🔥", "😅", "🎉"]) expect(parse(`Confirmado quinta 10h ${e}`).level, e).toBe("parcial");
  });

  it("'por favor' e mensagem truncada em conector não são forma fechada", () => {
    expect(parse("Confirmado quinta 10h por favor").level).toBe("parcial");
    for (const t of ["Confirmado quinta 10h nã", "Confirmado quinta 10h mas", "Confirmado quinta 10h e", "Confirmado quinta 10h que"]) {
      expect(parse(t).level, t).toBe("parcial");
    }
  });
});

describe("extractDateTimeMentions (mensagens do cliente, sem marcador de confirmação)", () => {
  const ex = (t: string, now = SAT) => extractDateTimeMentions(t, { now, tz: TZ }).map((m) => [m.localDate, m.timeMin] as const);

  const TABELA: Array<[string, Array<readonly [string | undefined, number | undefined]>]> = [
    ["pode ser quinta às 10?", [["2026-11-26", hm(10)]]],
    ["tem horário amanhã de manhã?", [["2026-11-22", undefined]]],
    ["quinta 10h ou sexta 14h", [["2026-11-26", hm(10)], ["2026-11-27", hm(14)]]],
    ["depois das 18h", []],
    ["amanhã às 14h pode?", [["2026-11-22", hm(14)]]],
    ["queria quinta 10h", []],
    ["quinta não posso", []],
    ["sexta às 9", [["2026-11-27", hm(9)]]],
    ["dia 30 às 15h", [["2026-11-30", hm(15)]]],
    ["27/11 às 10h", [["2026-11-27", hm(10)]]],
    ["segunda 8h", [["2026-11-23", hm(8)]]],
    ["hoje às 15h", [["2026-11-21", hm(15)]]],
    ["hoje às 8h", []],
    ["sábado 10h", []],
    ["vocês atendem sábado?", []],
    ["tem vaga domingo?", [["2026-11-22", undefined]]],
    ["posso ir às 3?", []],
    ["terça ou quarta às 10h", [["2026-11-24", undefined], ["2026-11-25", hm(10)]]],
    ["às 10h", [[undefined, hm(10)]]],
    ["pode ser 10h30?", [[undefined, hm(10, 30)]]],
    ["se der quinta 10h", []],
    ["você disse quinta 10h", []],
    ["quinta (26) às 10h", [["2026-11-26", hm(10)]]],
    ["quinta 27/11 10h", []],
    ["semana que vem", []],
    ["próxima sexta às 16h", [["2026-11-27", hm(16)]]],
    ["meio-dia", [[undefined, hm(12)]]],
    ["das 9 às 12", []],
    ["funcionamos de segunda a sexta", []],
    ["dia 5 de dezembro às 9h", [["2026-12-05", hm(9)]]],
    ["pode ser amanhã à tarde?", [["2026-11-22", undefined]]],
    ["bom dia, tem horário na quinta?", [["2026-11-26", undefined]]],
    ["Quarta-feira 14h", [["2026-11-25", hm(14)]]],
    ["3 da tarde amanhã", [["2026-11-22", hm(15)]]],
    ["Não consigo quinta, mas sexta 10h", [["2026-11-27", hm(10)]]],
    ["ontem às 10h", []],
    ["quero marcar", []],
    ["o valor é R$ 10.30", []],
    ["quinta 10h 👎", []],
    ["Quinta 10h está bom pra mim", [["2026-11-26", hm(10)]]],
  ];
  it(`tabela de ${TABELA.length} frases`, () => {
    expect(TABELA.length).toBeGreaterThanOrEqual(30);
    for (const [t, expected] of TABELA) expect(ex(t), t).toEqual(expected);
  });

  it("evidência é substring do texto normalizado e a lista vem sem duplicata", () => {
    const t = "Pode ser quinta às 10? Quinta 10h mesmo";
    const out = extractDateTimeMentions(t, { now: SAT, tz: TZ });
    expect(out).toHaveLength(1);
    for (const m of out) for (const e of m.evidence) expect(t.normalize("NFC")).toContain(e);
  });

  it("'amanhã' de madrugada e fuso: mesma regra do parser", () => {
    expect(ex("tem horário amanhã?", Date.parse("2026-11-22T00:20:00-03:00"))).toEqual([]);
    expect(extractDateTimeMentions("hoje 14h", { now: Date.parse("2026-11-21T02:30:00Z"), tz: "Asia/Tokyo" })).toEqual([
      { localDate: "2026-11-21", timeMin: hm(14), evidence: ["hoje", "14h"] },
    ]);
    expect(() => extractDateTimeMentions("hoje 14h", { now: SAT, tz: "Marte/Base" })).toThrow();
  });

  it("entradas vazias, longas ou não-string devolvem vazio", () => {
    expect(ex("")).toEqual([]);
    expect(ex(`quinta 10h ${"a ".repeat(400)}`)).toEqual([]);
    expect(extractDateTimeMentions(null as unknown as string, { now: SAT, tz: TZ })).toEqual([]);
  });
});
