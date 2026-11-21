import { describe, expect, it } from "vitest";
import { MAIN, SAT, hm, type MainRow } from "../../src/test/schedConfirmParserTables";
import { normalizeConfirmationText, parseConfirmation, prefilterConfirmation, type ConfirmProposal } from "./schedConfirmParser";

const SP = "America/Sao_Paulo";
const { POSITIVAS, PARCIAIS, NEGATIVAS, CALENDARIO } = MAIN;
type Row = MainRow;

function run(row: Row) {
  return parseConfirmation(row.t, { now: row.now ?? SAT, tz: row.tz ?? SP });
}

describe("parseConfirmation: tabela de frases", () => {
  const todas: Array<[string, Row]> = [
    ...POSITIVAS.map((r): [string, Row] => ["positiva", r]),
    ...PARCIAIS.map((r): [string, Row] => ["parcial", r]),
    ...NEGATIVAS.map((r): [string, Row] => ["negativa", r]),
    ...CALENDARIO.map((r): [string, Row] => ["calendário", r]),
  ];

  it("tem pelo menos 80 frases", () => {
    expect(todas.length).toBeGreaterThanOrEqual(80);
  });

  it.each(todas.map(([k, r]) => [`${k}: ${r.t || "(vazio)"}`, r] as const))("%s", (_nome, row) => {
    const r = run(row);
    expect(r.act, JSON.stringify(r)).toBe(row.act);
    expect(r.localDate, JSON.stringify(r)).toBe(row.date);
    expect(r.timeMin, JSON.stringify(r)).toBe(row.time);
    expect(r.resolved.date).toBe(row.date !== undefined);
    expect(r.resolved.time).toBe(row.time !== undefined);
  });

  it("zero falso positivo: nenhuma frase negativa devolve 'confirmou'", () => {
    const falsos = NEGATIVAS.filter((r) => run(r).act === "confirmou").map((r) => r.t);
    expect(falsos).toEqual([]);
  });

  it("'completo' só em confirmação com dia e hora; nunca nas parciais/negativas; evidência é substring normalizada", () => {
    let completoNasPositivas = 0;
    for (const r of [...PARCIAIS, ...NEGATIVAS]) expect(run(r).level, r.t).not.toBe("completo");
    for (const r of [...POSITIVAS, ...CALENDARIO]) {
      const p = run(r);
      if (p.level === "completo") {
        expect(p.act).toBe("confirmou");
        expect(p.resolved.date && p.resolved.time).toBe(true);
      }
      if (r.act === "confirmou" && POSITIVAS.includes(r) && p.level === "completo") completoNasPositivas++;
    }
    // custo da lista de permissão em toques do humano: pelo menos 30% das positivas ficam na forma fechada
    expect(completoNasPositivas / POSITIVAS.length).toBeGreaterThanOrEqual(0.3);
    for (const r of [...POSITIVAS, ...PARCIAIS, ...NEGATIVAS, ...CALENDARIO]) {
      const p = run(r);
      const norm = normalizeConfirmationText(r.t);
      for (const e of [...p.evidence.act, ...p.evidence.date, ...p.evidence.time, ...p.evidence.service, ...p.evidence.blocked]) expect(norm, r.t).toContain(e);
    }
  });
});

describe("parseConfirmation: formato de retorno e evidência", () => {
  it("devolve trechos literais do original (com acento e caixa)", () => {
    const r = parseConfirmation("Ok CONFIRMADO Amanhã às 14h30 😉", { now: SAT, tz: SP });
    expect(r.act).toBe("confirmou");
    expect(r.evidence.act).toEqual(["CONFIRMADO"]);
    expect(r.evidence.date).toEqual(["Amanhã"]);
    expect(r.evidence.time).toEqual(["14h30"]);
    expect(r.level).toBe("completo");
    expect(r.resolved).toEqual({ act: true, date: true, time: true });
    expect(r.signals).toEqual(["ato:confirmou", "dia", "hora"]);
  });

  it("evidência do que derrubou a leitura", () => {
    const r = parseConfirmation("ontem às 10h você não veio", { now: SAT, tz: SP });
    expect(r.act).toBe("nenhum");
    expect(r.negatives).toEqual(expect.arrayContaining(["passado", "negacao"]));
    expect(r.evidence.blocked.join(" ")).toMatch(/ontem/);
  });

  it("texto em NFD (acento decomposto) dá o mesmo resultado", () => {
    const nfd = "fechado amanhã às 14h30".normalize("NFD");
    const r = parseConfirmation(nfd, { now: SAT, tz: SP });
    expect(r.act).toBe("confirmou");
    expect(r.localDate).toBe("2026-11-22");
    expect(r.timeMin).toBe(hm(14, 30));
  });

  it("texto longo demais não é confirmação", () => {
    const r = parseConfirmation(`fechado amanhã 10h ${"a ".repeat(400)}`, { now: SAT, tz: SP });
    expect(r.act).toBe("nenhum");
    expect(r.negatives).toContain("texto_longo");
  });

  it("fuso inválido lança", () => {
    expect(() => parseConfirmation("fechado amanhã 10h", { now: SAT, tz: "Marte/Base" })).toThrow();
  });

  it("é pura: mesmo texto, mesmo instante e mesmo fuso, mesmo resultado", () => {
    const a = parseConfirmation("fechado quinta 10h", { now: SAT, tz: SP });
    const b = parseConfirmation("fechado quinta 10h", { now: SAT, tz: SP });
    expect(a).toEqual(b);
  });
});

describe("parseConfirmation: serviço e proposta aberta", () => {
  const services = [
    { _id: "svc_corte", name: "Corte de cabelo" },
    { _id: "svc_barba", name: "Barba" },
  ];

  it("serviço citado sem acento/caixa vira serviceId", () => {
    const r = parseConfirmation("Confirmado CORTE DE CABELO quinta 10h", { now: SAT, tz: SP, services });
    expect(r.serviceId).toBe("svc_corte");
    expect(r.evidence.service).toEqual(["CORTE DE CABELO"]);
  });

  it("dois serviços citados = ambíguo, sem serviceId", () => {
    const r = parseConfirmation("confirmado barba e corte de cabelo amanhã 10h", { now: SAT, tz: SP, services });
    expect(r.serviceId).toBeUndefined();
    expect(r.negatives).toContain("servico_ambiguo");
  });

  it("sem serviço citado, sem serviceId", () => {
    const r = parseConfirmation("confirmado amanhã 10h", { now: SAT, tz: SP, services });
    expect(r.serviceId).toBeUndefined();
  });

  const proposal: ConfirmProposal = { localDate: "2026-11-26", timeMin: hm(10), by: "cliente", at: SAT - 3_600_000 };

  it("'ok, pode ser' com proposta aberta confirma o horário da proposta", () => {
    const r = parseConfirmation("ok, pode ser", { now: SAT, tz: SP, proposal });
    expect(r.act).toBe("confirmou");
    expect(r.localDate).toBe("2026-11-26");
    expect(r.timeMin).toBe(hm(10));
    expect(r.fromProposal).toEqual({ date: true, time: true });
  });

  it("'fechado' sem dia nem hora completa pela proposta", () => {
    const r = parseConfirmation("Fechado 👍", { now: SAT, tz: SP, proposal });
    expect(r.act).toBe("confirmou");
    expect(r.level).toBe("completo");
  });

  it("'ok quinta 10h' igual à proposta confirma; dia diferente não", () => {
    expect(parseConfirmation("ok quinta 10h", { now: SAT, tz: SP, proposal }).act).toBe("confirmou");
    expect(parseConfirmation("ok sexta 14h", { now: SAT, tz: SP, proposal }).act).toBe("nenhum");
  });

  it("sem proposta, 'ok' e 'pode ser' não confirmam nada", () => {
    expect(parseConfirmation("ok, pode ser", { now: SAT, tz: SP }).act).toBe("nenhum");
  });

  it("proposta no passado não resolve", () => {
    const r = parseConfirmation("fechado", { now: SAT, tz: SP, proposal: { localDate: "2026-11-10", timeMin: hm(10), by: "cliente", at: SAT - 3_600_000 } });
    expect(r.act).toBe("confirmou");
    expect(r.resolved.date).toBe(false);
  });
});

describe("prefilterConfirmation", () => {
  it("passa com marca de tempo ou verbo de compromisso", () => {
    for (const r of [...POSITIVAS, ...PARCIAIS.filter((p) => p.act === "confirmou")]) {
      expect(prefilterConfirmation(r.t).pass, r.t).toBe(true);
    }
    expect(prefilterConfirmation("quinta 10h").pass).toBe(true);
    expect(prefilterConfirmation("Confirmado!").pass).toBe(true);
  });

  it("cai com faixa de funcionamento, pergunta, negação, condicional e passado", () => {
    for (const t of [
      "atendemos de segunda a sexta das 8h às 18h",
      "das 9 às 12",
      "pode ser quinta 10h?",
      "quinta não consigo",
      "se der eu confirmo",
      "ontem às 10h você não veio",
      "vou ter que ver",
      "sex",
      "ter",
      "bom dia, tudo bem?",
      "",
    ]) {
      expect(prefilterConfirmation(t).pass, t).toBe(false);
    }
  });

  it("devolve sinais e motivos", () => {
    const ok = prefilterConfirmation("fechado quinta 10h");
    expect(ok.signals).toEqual(expect.arrayContaining(["ato:confirmou", "dia", "hora"]));
    const no = prefilterConfirmation("atendemos das 8h às 18h");
    expect(no.negatives).toContain("funcionamento");
  });

  it("não depende de relógio nem de fuso: só texto", () => {
    expect(prefilterConfirmation.length).toBe(1);
  });
});
