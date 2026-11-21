import { describe, expect, it } from "vitest";
import { CONFIRM_MAX_CHARS, normalizeConfirmationText, parseConfirmation, prefilterConfirmation } from "./schedConfirmParser";

// 100 frases adversariais de classes que a tabela do revisor NÃO cobre: chat de equipe colado, áudio
// transcrito, encaminhada, citação, dois clientes, terceiros/entrega/visita técnica, remarcação com data
// antiga e nova, valor + horário, listas de opções, assinatura automática, mensagem de ausência, saudação
// com número. O esperado foi definido ANTES de rodar (ver "primeira execução" no PR).
const SAT = Date.parse("2026-11-21T10:00:00-03:00"); // sábado 21/11/2026 10:00 em São Paulo
const hm = (h: number, m = 0) => h * 60 + m;
type Exp = "NC" | { act: string; date?: string; time?: number };
const C = (act: string, date?: string, time?: number): Exp => ({ act, date, time });
const Q26 = "2026-11-26";
const Q = (time: number): Exp => C("confirmou", Q26, time);
type Row = { t: string; exp: Exp; lvl?: "completo" };
const R = (t: string, exp: Exp, lvl?: "completo"): Row => ({ t, exp, lvl });

const ROWS: Row[] = [
  // chat de equipe colado
  R("Gente, a cliente da quinta 10h confirmou?", "NC"),
  R("Ana, confirma com a Joana o horário de quinta 10h", "NC"),
  R("Pessoal: quinta 10h confirmado com a Dra., sexta 14h livre", "NC"),
  R("Lembrete interno: reunião de equipe quinta 10h", "NC"),
  R("Marquei a reunião com o fornecedor quinta 10h", "NC"),
  R("Agendei o técnico pra quinta 10h", "NC"),
  R("Reservei a sala pra reunião quinta 10h", "NC"),
  R("Anotei aqui: quinta 10h dentista", "NC"),
  R("Fechei com o fornecedor pra quinta 10h", "NC"),
  R("Confirmei com a Dra., pode ser quinta 10h", "NC"),
  // áudio transcrito sem pontuação
  R("oi tudo bem então ficou combinado quinta as dez horas pode vir", Q(hm(10))),
  R("bom dia entao tá marcado amanhã às nove e meia combinado", C("confirmou", "2026-11-22", hm(9, 30))),
  R("então tá fechado quinta de manhã às dez horas", Q(hm(10))),
  // AJUSTE (decidido no PR): é uma confirmação verdadeira de sexta 10h; o precedente do revisor ("Hoje não, amanhã 10h confirmado") manda resolver o trecho depois do "mas".
  R("olha eu não consigo na quinta mas na sexta às dez tá confirmado", C("confirmou", "2026-11-27", hm(10))),
  R("tá bom então combinado sexta as dez", C("confirmou", "2026-11-27", hm(10))),
  R("oi a doutora disse que pode vir quinta às dez", "NC"),
  R("pode vir sim quinta as dez horas", Q(hm(10))),
  R("eh entao amanha as oito horas ta combinado", C("confirmou", "2026-11-22", hm(8))),
  // encaminhada
  R("Encaminhada: Confirmado quinta 10h", "NC"),
  R("[Mensagem encaminhada] Fechado quinta 10h", "NC"),
  R("Fwd: confirmado quinta 10h", "NC"),
  R("Reenviando a mensagem da cliente: confirmado quinta 10h", "NC"),
  // resposta a mensagem citada / transcrição
  R("> Confirmado quinta 10h\nok", "NC"),
  R("Maria: confirmado quinta 10h", "NC"),
  R("[10:32, 21/11/2026] Cliente: confirmado quinta 10h", "NC"),
  R("Em resposta a: 'confirmado quinta 10h' — sim", "NC"),
  // dois clientes na mesma frase
  R("Confirmado a Ana quinta 10h e o Pedro sexta 14h", C("confirmou")),
  R("Ana confirmou quinta 10h e Pedro sexta 14h", "NC"),
  R("Confirmado quinta 10h pra você e sua amiga", Q(hm(10))),
  R("Confirmado quinta 10h para Ana e 11h para Pedro", C("confirmou", Q26)),
  // entrega, visita técnica, consulta de terceiro
  R("O técnico passa aí amanhã às 10h", "NC"),
  R("A visita técnica está agendada para quinta 10h", Q(hm(10))),
  R("A entrega está agendada para quinta 10h", "NC"),
  R("A consulta do seu pai está marcada para quinta 10h", "NC"),
  R("Sua mãe confirmou presença quinta 10h", "NC"),
  R("A consulta da Maria é quinta 10h", "NC"),
  R("A Maria já está confirmada quinta 10h", "NC"),
  R("O pedido de vocês chega quinta 10h", "NC"),
  R("O orçamento fica pronto quinta 10h", "NC"),
  // remarcação com data antiga e nova
  R("Remarcado de quinta 10h para sexta 14h", C("remarcou", "2026-11-27", hm(14))),
  R("Mudei do dia 26 pro dia 27 às 10h", C("remarcou", "2026-11-27", hm(10))),
  R("Seu horário de quinta 10h foi remarcado para sexta 10h", C("remarcou", "2026-11-27", hm(10))),
  R("Remarquei de ontem 10h pra amanhã 10h", C("remarcou", "2026-11-22", hm(10))),
  R("Desmarcado quinta 10h", C("cancelou", Q26, hm(10))),
  R("Cancelei o de quinta e o de sexta", C("cancelou")),
  // valor + horário
  R("Confirmado quinta 10h, total R$ 120,00", Q(hm(10))),
  R("Confirmado quinta 10h. Valor 150 reais", Q(hm(10))),
  R("Sua consulta de R$ 200 está marcada pra quinta 10h", Q(hm(10))),
  R("Pix de R$ 50 recebido, te espero quinta 10h", Q(hm(10))),
  R("Quinta 10h: R$ 80. Sexta 14h: R$ 100", "NC"),
  // listas de opções
  R("1) quinta 10h 2) sexta 14h", "NC"),
  R("Opções: quinta 10h / sexta 14h / sábado 9h", "NC"),
  R("Qual prefere: quinta 10h ou sexta 14h?", "NC"),
  R("Pode ser qualquer um: quinta 10h, sexta 10h ou sábado 10h", "NC"),
  // assinatura automática, ausência, bot
  R("Confirmado quinta 10h.\n\n--\nClínica Exemplo\nRua das Flores 123\nSeg a Sex 8h às 18h\nwww.exemplo.com.br", Q(hm(10))),
  R("Olá! Aqui é a atendente virtual da Clínica Exemplo. Seu horário: quinta 10h. Responda SIM para confirmar.", "NC"),
  R("Atenção: este é um atendimento automático. Horário de funcionamento: seg a sex, 9h às 18h. Retornaremos em breve.", "NC"),
  R("Estamos ausentes no momento. Retornamos quinta 10h", "NC"),
  R("Mensagem automática: estamos fechados hoje, voltamos amanhã às 9h", "NC"),
  R("Olá, no momento estamos em atendimento. Em breve respondemos. Funcionamos de seg a sex das 8h às 18h", "NC"),
  // saudação com número
  R("Bom dia às 10 pessoas do grupo", "NC"),
  R("Boa tarde pras 8 pessoas que vêm quinta", "NC"),
  R("Bom dia! Confirmado quinta 10h", Q(hm(10)), "completo"),
  R("Boa noite, tudo bem? Confirmado quinta 10h", Q(hm(10))),
  R("Oi! Confirmado amanhã às 14h, até lá! 😊", C("confirmou", "2026-11-22", hm(14)), "completo"),
  // formas mistas
  R("Confirmado quinta 10h com a Dra. Ana, 2º andar", Q(hm(10))),
  R("Quinta 10h confirmado, né", "NC"),
  R("Fechado então! Quinta 10h", Q(hm(10))),
  R("Pode vir quinta às 10h, a recepção fica no térreo", Q(hm(10))),
  R("Te espero quinta 10h 🙂", Q(hm(10)), "completo"),
  R("Combinado! Quinta, 10h. Abraço!", Q(hm(10)), "completo"),
  R("Confirmado sexta 14h, obrigado!", C("confirmou", "2026-11-27", hm(14)), "completo"),
  R("ok, combinado, sexta 14h", C("confirmou", "2026-11-27", hm(14)), "completo"),
  R("Confirmado quinta 10h e já te mando o endereço", Q(hm(10))),
  R("Marcado! Quinta 10h. Chegue 15 min antes", Q(hm(10))),
  // negação em outros lugares
  R("Quinta 10h não está confirmado", "NC"),
  R("Não está confirmado quinta 10h", "NC"),
  R("Ainda não marcamos quinta 10h", "NC"),
  R("Nunca confirmamos quinta 10h sem sinal", "NC"),
  R("Quinta 10h? Já foi confirmado ontem", "NC"),
  // formas de hora
  R("Confirmado quinta às 8h45", Q(hm(8, 45)), "completo"),
  R("Confirmado quinta 18:15", Q(hm(18, 15)), "completo"),
  R("Confirmado quinta 6 da tarde", Q(hm(18)), "completo"),
  R("Confirmado quinta 12 da manhã", C("confirmou", Q26)),
  R("Confirmado quinta às 24h", C("confirmou", Q26)),
  R("Confirmado quinta 1h", C("confirmou", Q26)),
  R("Confirmado quinta pelas 9", Q(hm(9))),
  R("Confirmado quinta de 10h até 11h", Q(hm(10))),
  R("Confirmado quinta 10h às 12h", Q(hm(10))),
  // datas
  R("Confirmado dia 26/11 às 10h", Q(hm(10)), "completo"),
  R("Confirmado para o dia 1º de dezembro às 9h", C("confirmou", "2026-12-01", hm(9))),
  R("Confirmado dia 1 às 9h", C("confirmou", "2026-12-01", hm(9))),
  R("Confirmado 26/11/26 às 10h", Q(hm(10))),
  R("Confirmado quinta (26) às 10h", Q(hm(10))),
  R("Confirmado quinta, 26 de nov, às 10h", Q(hm(10))),
  // ruído
  R("Confirmado quinta 10h kkkkk", Q(hm(10))),
  R("CONFIRMADO!!! QUINTA!!! 10H!!!", Q(hm(10)), "completo"),
  R("confirmadoquinta10h", "NC"),
  R("Confirmado quinta 10h. Confirmado quinta 10h. Confirmado quinta 10h", Q(hm(10))),
  R("Confirmado quinta 10h; confirmado sexta 10h", C("confirmou", undefined, hm(10))),
];

const run = (t: string) => parseConfirmation(t, { now: SAT, tz: "America/Sao_Paulo" });

describe("schedConfirmParser: 100 frases adversariais próprias", () => {
  it("são 100", () => expect(ROWS.length).toBe(100));

  it.each(ROWS.map((r) => [r.t.replace(/\n/g, "⏎"), r] as const))("%s", (_n, row) => {
    const r = run(row.t);
    if (row.exp === "NC") {
      expect(r.act, JSON.stringify(r)).not.toBe("confirmou");
      expect(r.level, JSON.stringify(r)).not.toBe("completo");
    } else {
      expect(r.act, JSON.stringify(r)).toBe(row.exp.act);
      expect(r.localDate, JSON.stringify(r)).toBe(row.exp.date);
      expect(r.timeMin, JSON.stringify(r)).toBe(row.exp.time);
    }
    if (row.lvl) expect(r.level, JSON.stringify(r)).toBe("completo");
    const norm = normalizeConfirmationText(row.t);
    for (const e of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.service, ...r.evidence.blocked]) expect(norm).toContain(e);
  });

  it("zero falso positivo; 'completo' só em confirmação com dia e hora resolvidos", () => {
    let completos = 0;
    for (const row of ROWS) {
      const r = run(row.t);
      if (row.exp === "NC") expect(r.act, row.t).not.toBe("confirmou");
      if (r.level === "completo") {
        completos++;
        expect(r.act, row.t).toBe("confirmou");
        expect(r.resolved.date && r.resolved.time, row.t).toBe(true);
      }
    }
    expect(completos).toBeGreaterThanOrEqual(12);
  });
});

describe("schedConfirmParser: robustez", () => {
  const ctx = { now: SAT, tz: "America/Sao_Paulo" };
  it("5.000 caracteres repetitivos em menos de 5 ms (média de 20 chamadas)", () => {
    for (const unit of ["a ", "1 a ", "as 1 ", "das 1 e ", "seg a ", "dia ", "10h", "confirmado quinta 10h ", "👍", "11/", "vou x ", "depois de "]) {
      const text = unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
      parseConfirmation(text, ctx);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        parseConfirmation(text, ctx);
        prefilterConfirmation(text);
      }
      expect((performance.now() - t0) / 20, unit).toBeLessThan(5);
    }
  });

  it("599 caracteres adversariais não explodem (backtracking)", () => {
    for (const unit of ["as 1 ", "das 1 e ", "seg a ", "1h1 ", "a ", "dia 1 de ", "depois de ", "vou x ", "1/1/1 "]) {
      const text = unit.repeat(Math.ceil(CONFIRM_MAX_CHARS / unit.length)).slice(0, CONFIRM_MAX_CHARS - 1);
      const t0 = performance.now();
      parseConfirmation(text, ctx);
      prefilterConfirmation(text);
      expect(performance.now() - t0, unit).toBeLessThan(50);
    }
  });

  it("entradas estranhas não lançam e a evidência é substring do texto normalizado (NFC)", () => {
    const entradas = ["", "   \n\t ", "👍🏽🙏✅", "👨‍👩‍👧 confirmado amanhã 10h", "Confirmado amanhã às 10h".normalize("NFD"), "Confirmado quinta 10h", "Confir​mado quinta 10h", "CONFİRMADO quinta 10h", "\ud83d confirmado amanhã 10h", "‮confirmado amanhã 10h"];
    for (const e of entradas) {
      const r = run(e);
      const norm = normalizeConfirmationText(e);
      for (const ev of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.blocked]) expect(norm).toContain(ev);
      prefilterConfirmation(e);
    }
    expect(() => parseConfirmation(null as unknown as string, ctx)).not.toThrow();
    expect(() => parseConfirmation(42 as unknown as string, ctx)).not.toThrow();
  });
});
