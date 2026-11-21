import { describe, expect, test } from "vitest";
import { claimNudge, type ClaimState, detectUnbackedBookingClaim, type KnownBooking, type KnownTime } from "./schedClaimGuard";

const TZ = "America/Sao_Paulo";
/** Sexta 12/06/2026 09:00 em São Paulo (relógio dos cenários da IA). */
const NOW_JUN = new Date("2026-06-12T12:00:00Z").getTime();
/** Sábado 21/11/2026 09:00 em São Paulo. */
const NOW_NOV = new Date("2026-11-21T12:00:00Z").getTime();

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const at = (localDate: string, hhmm: string): KnownTime => ({ localDate, timeMin: hm(hhmm) });
const bk = (localDate: string, hhmm: string, status: "pending" | "scheduled"): KnownBooking => ({ ...at(localDate, hhmm), status });
const mk = (now: number, p: Partial<Omit<ClaimState, "now" | "tz">> = {}): ClaimState => ({ now, tz: TZ, existing: [], booked: [], offered: [], ...p });

// ── Estados do revisor (probe do D1): quinta 18/06 e sexta 19/06 de 2026 ──
const OFF = [at("2026-06-18", "10:00"), at("2026-06-18", "14:00"), at("2026-06-19", "09:00")];
const none = mk(NOW_JUN, { offered: OFF });
const pend = mk(NOW_JUN, { booked: [bk("2026-06-18", "10:00", "pending")], offered: OFF });
const hasSched = mk(NOW_JUN, { existing: [bk("2026-06-30", "15:00", "scheduled")], offered: [...OFF, at("2026-06-30", "15:00")] });
const hasSchedQui = mk(NOW_JUN, { existing: [bk("2026-06-18", "10:00", "scheduled")], offered: [at("2026-06-18", "10:00")] });
const noOffers = mk(NOW_JUN);

type Case = [text: string, state: ClaimState, block: boolean | "claim_without_booking" | "confirmed_but_pending" | "time_not_offered", tag: string];

// 83 frases do revisor (+ as 4 do G2) ----------------------------------------------------------------------------
const REVIEWER: Case[] = [
  ["Prontinho, te espero quinta às 10!", none, true, "i"],
  ["Tá reservado!", none, true, "i"],
  ["Tá reservado pra quinta 10h", none, true, "i"],
  ["Fechado então, quinta 10h", none, true, "i"],
  ["Anotei aqui pra quinta 10h", none, true, "i"],
  ["Já deixei seu horário garantido", none, true, "i"],
  ["Já deixei seu horário garantido para quinta às 10h", none, true, "i"],
  ["Combinado, quinta às 10", none, true, "i"],
  ["✅ Quinta 18/06 às 10h", none, true, "i"],
  ["Sua consulta é quinta 10h", none, true, "i"],
  ["Você será atendido quinta às 10", none, true, "i"],
  ["Sua consulta para quinta às 10h está marcada", none, true, "i"],
  ["O horário das 10h de quinta pra você está agendado", none, true, "i"],
  ["Tudo certo! Até quinta às 10h", none, true, "i"],
  ["Certinho, quinta às 10h então 😊", none, true, "i"],
  ["Encaixei você quinta às 10h", none, true, "i"],
  ["Separei o horário de quinta 10h pra você", none, true, "i"],
  ["Coloquei você na agenda de quinta às 10h", none, true, "i"],
  ["Seu nome já está na agenda para quinta às 10", none, true, "i"],
  ["Pode vir quinta às 10h que vai dar tudo certo", none, true, "i"],
  ["Quinta 10h está garantido!", none, true, "i"],
  ["Feito! Quinta às 10h", none, true, "i"],
  ["Seu horário: quinta, 18/06, 10h. Até lá!", none, true, "i"],
  ["Agendadinho pra quinta às 10h", none, true, "i"],
  ["Confirmadíssimo, quinta 10h", none, true, "i"],
  ["Beleza, então fica quinta às 10h", none, true, "i"],
  ["Está tudo certo para quinta às 10h", none, true, "i"],
  ["Te vejo quinta às 10h!", none, true, "i"],
  ["Nos vemos na quinta às 10h", none, true, "i"],
  ["Pronto, sua vaga de quinta 10h é sua", none, true, "i"],
  ["Já registrei seu horário de quinta às 10h", none, true, "i"],
  ["Ok, sua consulta ficou agendada.", none, true, "i"],
  ["Marquei pra você, quinta às dez horas", none, true, "i"],
  ["Reservei quinta às dez da manhã pra você", none, true, "i"],
  ["Prontinho! Seu horário está confirmado", none, true, "i"],
  ["Sua sessão está confirmada para amanhã", none, true, "i"],
  ["Prontinho, sua consulta ficou marcada para quinta 18/06 às 10:00!", hasSched, true, "i-sched"],
  ["Marquei também quinta às 14h pra você", hasSched, true, "i-sched"],
  ["Agendado: sexta 19/06 às 09:00", hasSched, true, "i-sched"],
  ["Confirmado! Quinta às 10h", pend, true, "i-pend"],
  ["Seu horário de quinta às 10h está garantido", pend, true, "i-pend"],
  ["Fechado, quinta às 10h, te espero", pend, true, "i-pend"],
  ["Pronto, quinta 10h é seu, a equipe só vai dar uma olhada", pend, true, "i-pend"],
  ["Tenho também às 17:30.", none, true, "i-inv"],
  ["Tenho quinta às 17:30 e às 10h.", none, true, "i-inv"],
  ["Consigo te encaixar quinta 17h", none, true, "i-inv"],
  ["Pode ser quinta às 17h", noOffers, true, "i-inv"],
  ["Tenho quinta-feira, 18/06, às 10:00 ou às 14:00. Qual prefere?", none, false, "ii"],
  ["Tenho quinta, 18/06, às 10:00 e sexta, 19/06, às 09:00.", none, false, "ii"],
  ["Posso marcar quinta às 10h?", none, false, "ii"],
  ["Quer que eu reserve quinta às 10h?", none, false, "ii"],
  ["Seu pedido para quinta às 10h foi registrado e a equipe vai confirmar em breve.", pend, false, "ii"],
  ["Pedido registrado para quinta-feira, 18/06, às 10:00. A equipe confirma em breve.", pend, false, "ii"],
  ["Recebi seu pedido! Assim que a equipe confirmar, fica marcado para quinta às 10h.", pend, false, "ii"],
  ["Você pediu quinta às 10h, certo?", none, false, "ii"],
  ["Você disse que prefere quinta às 10h. Vou consultar.", none, false, "ii"],
  ["Nosso horário de funcionamento é de segunda a sexta, das 8h às 18h.", none, false, "ii"],
  ["Funcionamos de segunda a sexta das 8h às 18h, e sábado das 8h às 12h.", none, false, "ii"],
  ["Atendemos de segunda a sexta, das 8h às 18h.", none, false, "ii"],
  ["Recebi seu comprovante, obrigado! Confirmo o recebimento.", none, false, "ii"],
  ["Recebemos seu Pix hoje, pagamento confirmado!", none, false, "ii"],
  ["Seu pagamento de hoje foi confirmado, obrigada!", none, false, "ii"],
  ["Seu horário de quinta 10h continua marcado.", hasSchedQui, false, "ii"],
  ["Seu horário de quinta-feira, 18/06, às 10:00 continua marcado.", hasSchedQui, false, "ii"],
  ["Sua consulta de quinta às 10h está confirmada, te esperamos!", hasSchedQui, false, "ii"],
  ["Quinta às 10h não tenho mais, mas tenho às 14h.", none, false, "ii"],
  ["Infelizmente quinta às 17h está ocupado.", none, false, "ii"],
  ["Não marquei nada ainda, só consultei os horários.", none, false, "ii"],
  ["Ainda não está marcado: a equipe confirma o horário de quinta às 10h.", none, false, "ii"],
  ["Para marcar, preciso que você escolha: quinta às 10h ou às 14h?", none, false, "ii"],
  ["A consulta dura 1 hora. Quer quinta às 10h ou às 14h?", none, false, "ii"],
  ["Vou verificar com a equipe e já te retorno sobre quinta às 10h.", none, false, "ii"],
  ["Lembrando que chegamos 10 min antes. Tenho quinta às 10h.", none, false, "ii"],
  ["O valor é R$ 150. Temos quinta às 14h.", none, false, "ii"],
  ["A equipe vai te responder hoje até as 18h.", none, false, "ii"],
  ["Oi! Seu pedido está aguardando a confirmação da equipe.", pend, false, "ii"],
  ["Deixei reservado e a equipe confirma em seguida.", pend, false, "ii"],
  ["O horário de quinta às 10h ficou reservado, aguardando confirmação da equipe.", pend, false, "ii"],
  ["Estamos abertos amanhã das 8h às 12h.", none, false, "ii"],
  ["Pode trazer os exames na quinta às 10h, combinado?", none, false, "ii"],
  ["Hoje a clínica fecha às 18h.", none, false, "ii"],
  ["O agendamento é feito pela equipe; me diga o dia e o período que prefere.", none, false, "ii"],
  ["Os horários marcados no site podem estar desatualizados.", none, false, "ii"],
];
// G2: o read-back que as próprias instruções pedem (com o item 1 a oferta está em O).
const SEG = mk(NOW_JUN, { offered: [at("2026-06-15", "08:00"), at("2026-06-15", "09:00")] });
const G2: Case[] = [
  ["Ótimo, o horário de segunda-feira, 15/06, às 08:00 então. Posso registrar?", SEG, false, "g2"],
  ["Perfeito! Você escolheu segunda-feira, 15/06, às 08:00. Posso registrar o pedido?", SEG, false, "g2"],
  ["Anotado: segunda-feira, 15/06, às 08:00 é a sua opção. Confirma pra eu registrar?", SEG, false, "g2"],
  ["Certo, segunda 15/06 às 08:00 é o horário que você quer. Posso seguir?", SEG, false, "g2"],
];

// 43 do PR original (agora com os horários estruturados) --------------------------------------------------------
const O1 = [at("2026-11-26", "10:00"), at("2026-11-26", "14:30"), at("2026-11-27", "09:00")];
const off = mk(NOW_NOV, { offered: O1 });
const pen = mk(NOW_NOV, { booked: [bk("2026-11-26", "10:00", "pending")], offered: [at("2026-11-26", "10:00")] });
const sch = mk(NOW_NOV, { booked: [bk("2026-11-26", "10:00", "scheduled")], offered: [at("2026-11-26", "10:00")] });
const ORIGINAL: Case[] = [
  ["Pronto, seu horário está marcado!", off, "claim_without_booking", "o"],
  ["Marcado! Quinta, 26/11, às 10h.", off, "claim_without_booking", "o"],
  ["Agendei para quinta às 10h, te espero lá.", off, "claim_without_booking", "o"],
  ["Seu horário de quinta-feira às 10:00 está confirmado.", off, "claim_without_booking", "o"],
  ["Confirmado: 26/11 às 10h.", off, "claim_without_booking", "o"],
  ["Marquei você para quinta às 10h.", off, "claim_without_booking", "o"],
  ["Reservei quinta às 10h para você.", off, "claim_without_booking", "o"],
  ["O horário ficou marcado para quinta, 26/11.", off, "claim_without_booking", "o"],
  ["Tudo certo! Agendado para quinta às 10h.", off, "claim_without_booking", "o"],
  ["Confirmo o seu horário de quinta às 10h.", off, "claim_without_booking", "o"],
  ["Está agendado, 26/11 às 10h.", off, "claim_without_booking", "o"],
  ["Ficou para quinta às 10h então.", off, "claim_without_booking", "o"],
  ["Seu horário de quinta às 10h está confirmado para quinta às 10h!", pen, "confirmed_but_pending", "o"],
  ["Está marcado: quinta, 26/11, às 10h.", pen, "confirmed_but_pending", "o"],
  ["Agendado para quinta às 10:00.", pen, "confirmed_but_pending", "o"],
  ["Marquei quinta às 10h.", pen, "confirmed_but_pending", "o"],
  ["Horário reservado para quinta às 10h!", pen, "confirmed_but_pending", "o"],
  ["Seu horário está confirmado!", mk(NOW_NOV, { existing: [bk("2026-11-26", "10:00", "pending")] }), "confirmed_but_pending", "o"],
  ["Tenho sexta, 27/11, às 16h disponível.", off, "time_not_offered", "o"],
  ["Temos quinta às 11:00 e também sexta às 09:00.", off, "time_not_offered", "o"],
  ["Tenho vaga em 26/11 às 17h.", off, "time_not_offered", "o"],
  ["Marcado! Quinta, 26/11, às 15h.", sch, "time_not_offered", "o"],
  ["Tenho sexta às 16h livre, quer?", off, "time_not_offered", "o"],
  ["Posso marcar quinta às 14:30?", off, false, "o"],
  ["Quer que eu deixe confirmado quinta às 10h?", off, false, "o"],
  ["Tenho quinta, 26/11, às 10:00 ou às 14:30, e sexta, 27/11, às 09:00. Qual prefere?", off, false, "o"],
  ["Tenho quinta às 10h ou quinta às 14:30.", off, false, "o"],
  ["Confirmo o recebimento do comprovante de R$ 150,00.", off, false, "o"],
  ["Recebi o comprovante de 10/11. Confirmo o recebimento, a equipe confere.", off, false, "o"],
  ["Você escreveu \"está marcado para quinta às 10h\", mas ainda preciso confirmar com a equipe.", off, false, "o"],
  ["Você pediu quinta às 10h, vou consultar a agenda.", off, false, "o"],
  ["Ainda não está marcado: falta você escolher o horário.", off, false, "o"],
  ["Seu horário não está confirmado.", off, false, "o"],
  ["Vou marcar assim que você me confirmar o horário.", off, false, "o"],
  ["Assim que a equipe confirmar o horário, te aviso.", off, false, "o"],
  ["Se der certo, fica marcado para quinta.", off, false, "o"],
  ["Atendemos de segunda a sexta, das 9h às 18h.", off, false, "o"],
  ["Sexta às 16h está ocupado, mas tenho quinta, 26/11, às 10:00.", off, false, "o"],
  ["Não tenho nada livre na sexta às 9h.", off, false, "o"],
  ["Pedido registrado: quinta-feira, 26/11, às 10:00, aguardando confirmação da equipe.", pen, false, "o"],
  ["Olá! Como posso ajudar? Temos consultas e sessões.", off, false, "o"],
  ["Seu cadastro foi marcado como prioritário.", off, false, "o"],
  ["A equipe confirma o horário em breve.", off, false, "o"],
  ["", off, false, "o"],
  ["Pronto, marcado para quinta-feira, 26/11, às 10:00!", sch, false, "o"],
  ["Seu horário está confirmado.", sch, false, "o"],
  ["Pedido registrado para quinta, 26/11, às 10:00! A equipe confirma em breve.", pen, false, "o"],
  ["Reservei quinta às 10h e a equipe confirma em seguida.", pen, false, "o"],
  ["Anotei seu pedido para quinta às 10h; fica aguardando a confirmação da equipe.", pen, false, "o"],
  ["Seu pedido de horário foi registrado e aguarda a confirmação da equipe.", pen, false, "o"],
  ["Seu horário continua marcado para terça-feira, 17/11... ", mk(NOW_NOV, { existing: [bk("2026-11-24", "15:00", "scheduled")], offered: [at("2026-11-24", "15:00")] }), false, "o"],
];

// 60 NOVAS (expectativa definida ANTES de rodar) --------------------------------------------------------------------
const SABADO = mk(NOW_JUN, { offered: [at("2026-06-13", "09:00")] }); // amanhã
const dois = mk(NOW_JUN, { existing: [bk("2026-06-18", "10:00", "scheduled"), bk("2026-06-19", "09:00", "scheduled")], offered: OFF });
const pendEx = mk(NOW_JUN, { existing: [bk("2026-06-18", "10:00", "pending")], offered: OFF });
const NEW: Case[] = [
  // fechamento afirmado sobre horário só OFERTADO
  ["Ótimo, ficou reservadinho pra quinta às 14h!", none, "claim_without_booking", "n"],
  ["Quinta às 14h, confirmadinho 😉", none, true, "n"],
  ["Sua vaga de sexta às 9h está garantida.", none, "claim_without_booking", "n"],
  ["Feito, 18/06 às 14:00 no nome da Ana.", none, "claim_without_booking", "n"],
  ["Beleza! Então fica combinado: quinta, às 10h.", none, "claim_without_booking", "n"],
  ["Já está na agenda: quinta-feira, 18/06, às 14:00.", none, "claim_without_booking", "n"],
  ["Agendei sexta, 19/06, às 09:00 pra você, tá?", none, "claim_without_booking", "n"],
  ["Perfeito, sexta às 9h ficou certo.", none, "claim_without_booking", "n"],
  ["Prontinho, sexta 19/06 às 09:00!", none, "claim_without_booking", "n"],
  ["Confirmei seu horário de sexta às 9h.", none, "claim_without_booking", "n"],
  ["Sua consulta está marcada. Quinta às 14h.", none, "claim_without_booking", "n"],
  ["Seu horário foi registrado para quinta às 10h.", none, "claim_without_booking", "n"],
  ["Pedido registrado para quinta às 10h, aguardando a equipe.", none, "claim_without_booking", "n"],
  // pedido pendente: só "registrado/aguardando"
  ["Seu horário de quinta às 10h está agendado!", pend, "confirmed_but_pending", "n"],
  ["Quinta às 10h confirmadinho!", pend, true, "n"],
  ["Pronto, está tudo certo para quinta às 10h.", pend, "confirmed_but_pending", "n"],
  ["Sua consulta de quinta às 10h está marcada, a equipe só confere.", pend, "confirmed_but_pending", "n"],
  ["Garantido: quinta às 10h.", pend, "confirmed_but_pending", "n"],
  ["Te espero quinta às 10h, a equipe confirma depois.", pend, "confirmed_but_pending", "n"],
  ["Seu horário está confirmado.", pendEx, "confirmed_but_pending", "n"],
  ["Tá tudo certo com seu horário!", pendEx, "confirmed_but_pending", "n"],
  ["Registrei o pedido de quinta às 10h. A equipe confirma em breve.", pend, false, "n"],
  ["Seu pedido de quinta às 10h está aguardando a confirmação da equipe, tá?", pend, false, "n"],
  ["Anotei seu pedido de quinta às 10h; a equipe vai confirmar.", pend, false, "n"],
  ["Pedido de quinta às 10h registrado. Aguardando a equipe.", pend, false, "n"],
  // marcado de fato
  ["Prontinho! Marcado para quinta às 10h.", mk(NOW_JUN, { booked: [bk("2026-06-18", "10:00", "scheduled")] }), false, "n"],
  ["Está confirmado, quinta-feira, 18/06, às 10:00. Te espero!", mk(NOW_JUN, { booked: [bk("2026-06-18", "10:00", "scheduled")] }), false, "n"],
  ["Prontinho! Seu horário está confirmado.", mk(NOW_JUN, { booked: [bk("2026-06-18", "10:00", "scheduled")] }), false, "n"],
  ["Seu horário está confirmado.", mk(NOW_JUN, { existing: [bk("2026-06-18", "10:00", "scheduled")] }), false, "n"],
  ["Seu horário está confirmado.", dois, "claim_without_booking", "n"],
  ["Marcado para sexta, 19/06, às 9h!", dois, false, "n"],
  ["Quinta às 11h está marcado.", dois, "time_not_offered", "n"],
  ["Marcado para quinta às 10h e confirmado para sexta, 19/06, às 17h.", dois, "time_not_offered", "n"],
  // horário inventado
  ["Tenho quinta às 15h.", none, "time_not_offered", "n"],
  ["Pode ser sexta, 19/06, às 11h?", none, "time_not_offered", "n"],
  ["Tenho às 8h e às 9h.", none, "time_not_offered", "n"],
  ["Posso te encaixar hoje às 16h.", none, "time_not_offered", "n"],
  ["Que tal 20/06 às 10h?", none, "time_not_offered", "n"],
  ["Tenho quinta às 10h ou sexta, 19/06, às 10h.", none, "time_not_offered", "n"],
  ["Tenho amanhã às 11h livre.", SABADO, "time_not_offered", "n"],
  // falsos positivos a evitar
  ["Tenho amanhã às 9h livre. Quer?", SABADO, false, "n"],
  ["Abrimos às 8h e fechamos às 18h.", none, false, "n"],
  ["A clínica abre às 9h aos sábados.", none, false, "n"],
  ["O comprovante chegou hoje às 14h, obrigada! Confirmo o recebimento.", none, false, "n"],
  ["Pagamento confirmado hoje às 14h.", none, false, "n"],
  ["Seu Pix de hoje está confirmado.", none, false, "n"],
  ["Não consegui marcar quinta às 10h, mas tenho às 14h.", none, false, "n"],
  ["Se a equipe confirmar, fica marcado para quinta às 10h.", pend, false, "n"],
  ["Quando a equipe confirmar quinta às 10h eu te aviso.", pend, false, "n"],
  ["Ainda não fechei nada; qual prefere, quinta às 10h ou às 14h?", none, false, "n"],
  ["Você pediu sexta às 17h; não tenho esse horário. Tenho quinta às 10h.", none, false, "n"],
  ["Me diga qual horário prefere e eu registro o pedido.", none, false, "n"],
  ["Posso registrar o pedido para quinta às 10h?", none, false, "n"],
  ["Vou registrar quinta às 10h e a equipe confirma.", none, false, "n"],
  ["Os agendamentos marcados no sistema podem demorar a aparecer.", none, false, "n"],
  ["Seu cadastro está confirmado e sua consulta ainda não foi marcada.", none, false, "n"],
  ["Ok! Qual serviço você quer marcar?", none, false, "n"],
  ["Bom dia! Como posso ajudar?", none, false, "n"],
  ["A consulta dura 60 minutos e custa R$ 150.", none, false, "n"],
  ["Posso te ajudar com mais alguma coisa?", none, false, "n"],
  ["Entendi, vou chamar a equipe para remarcar seu horário.", mk(NOW_JUN, { existing: [bk("2026-06-18", "10:00", "scheduled")] }), false, "n"],
];

const kindOf = (e: Case[2]) => (typeof e === "string" ? e : undefined);
function run(cases: Case[]) {
  const bad: string[] = [];
  for (const [text, st, expected, tag] of cases) {
    const r = detectUnbackedBookingClaim(text, st);
    const block = expected !== false;
    const ok = block ? r !== null && (kindOf(expected) === undefined || r.kind === kindOf(expected)) : r === null;
    if (!ok) bad.push(`[${tag}] ${JSON.stringify(text)} esperado=${String(expected)} obtido=${r ? r.kind : "null"}`);
  }
  return bad;
}

describe("schedClaimGuard — corpus", () => {
  test("83 do revisor (+ G2): nenhum falso negativo nem falso positivo", () => {
    expect(run([...REVIEWER, ...G2])).toEqual([]);
  });
  test("43 do PR original continuam valendo", () => {
    expect(run(ORIGINAL)).toEqual([]);
  });
  test("60 novas", () => {
    expect(NEW.length).toBeGreaterThanOrEqual(60);
    expect(run(NEW)).toEqual([]);
  });
});

describe("schedClaimGuard — estrutura", () => {
  test("a evidência é um trecho curto, nunca o texto inteiro", () => {
    const v = detectUnbackedBookingClaim(`Pronto, seu horário está marcado! ${"blá ".repeat(100)}`, none)!;
    expect(v.evidence.length).toBeLessThanOrEqual(80);
  });
  test("a tela do cliente nunca recebe afirmação por estar em E: com 1 marcado, horário NOVO só ofertado é barrado", () => {
    expect(detectUnbackedBookingClaim("Prontinho, sua consulta ficou marcada para 15/06 às 08:00", mk(NOW_JUN, { existing: [bk("2026-06-30", "15:00", "scheduled")], offered: [at("2026-06-15", "08:00")] }))?.kind).toBe("claim_without_booking");
  });
  test("estado sem relógio válido não lança", () => {
    expect(() => detectUnbackedBookingClaim("Quinta às 10h", { ...none, tz: "America/Sao_Paulo" })).not.toThrow();
  });
  test("nudge por violação", () => {
    for (const k of ["claim_without_booking", "confirmed_but_pending", "time_not_offered"] as const) expect(claimNudge(k)).toContain("DESCARTADA");
  });
});
