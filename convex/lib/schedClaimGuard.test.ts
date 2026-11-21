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


// 60 da RODADA 2 do revisor ---------------------------------------------------------------------------------
const R2: Case[] = [
  // ===== 60 NOVAS (round 2) — O = qui 18/06 10:00 e 14:00, sex 19/06 09:00 =====
  // indevidas (devem barrar)
  ["Tenho quinta às 17h, se preferir.", none, true, "n-inv-cond"],
  ["Caso queira, tenho quinta às 16h também.", none, true, "n-inv-cond"],
  ["Tenho quinta às dez e às quatro da tarde.", none, true, "n-inv-extenso"],
  ["Tenho quinta ao meio-dia e meia.", none, true, "n-inv-extenso"],
  ["Tenho amanhã às 8.", none, true, "n-inv-rel"],
  ["Depois de amanhã tenho às 11h.", none, true, "n-inv-rel"],
  ["Tenho quinta. Às 17h está livre.", none, true, "n-inv-split"],
  ["Tenho quinta às 10h e às 17h.", none, true, "n-inv-dois"],
  ["Tenho sexta às 9h e sábado às 9h.", none, true, "n-inv-dois"],
  ["Seu horário de terça 30/06 às 15h segue, e também deixei quinta às 10h pra você.", hasSched, true, "n-E+O"],
  ["Além do dia 30, já te encaixei quinta às 14h.", hasSched, true, "n-E+O"],
  ["Ficou certinho pra quinta 10h, viu?", none, true, "n-claim"],
  ["Quinta às 10h é sua, pode contar!", none, true, "n-claim"],
  ["Segurei quinta às 10h pra você.", none, true, "n-claim"],
  ["Bloqueei quinta 10h no seu nome.", none, true, "n-claim"],
  ["Seu nome está na lista de quinta às 10h.", none, true, "n-claim"],
  ["Deixei quinta 10h no seu nome.", none, true, "n-claim"],
  ["Tá feito, quinta às 10h.", none, true, "n-claim"],
  ["Já era, quinta 10h tá contigo!", none, true, "n-claim"],
  ["Pode deixar que quinta às 10h a Dra. te atende.", none, true, "n-claim"],
  ["Sua presença está confirmada.", none, true, "n-claim-semhora"],
  ["Tudo pronto pra sua consulta!", none, true, "n-claim-semhora"],
  ["Qualquer coisa me avisa, quinta 10h te esperamos.", none, true, "n-claim"],
  ["Pronto, a equipe já confirmou sua consulta de quinta às 10h.", pend, true, "n-pend"],
  ["Seu horário de quinta às 10h foi aprovado.", pend, true, "n-pend"],
  ["Quinta às 10h então, a equipe só formaliza depois, mas pode vir.", pend, true, "n-pend"],
  ["Quinta às 10h então! Te mando a localização.", none, true, "n-claim"],
  ["Beleza, nos falamos quinta às 10h na clínica.", none, true, "n-claim"],
  ["A sessão das 17h de quinta é sua.", none, true, "n-inv"],
  ["Confirmado pras 10 da manhã de quinta.", none, true, "n-claim"],
  // legítimas (NÃO podem barrar)
  ["A consulta dura 50 minutos.", none, false, "n-ok-dur"],
  ["Chegue uns 10 minutos antes, por favor. Tenho quinta às 10h ou às 14h.", none, false, "n-ok-dur"],
  ["Em 10 minutos a equipe te responde.", none, false, "n-ok-dur"],
  ["O valor é R$ 150, e tenho quinta às 10h.", none, false, "n-ok-preco"],
  ["Ficamos na Rua 7 de Setembro, 1500, sala 12.", none, false, "n-ok-end"],
  ["Nosso telefone é (11) 3456-7890.", none, false, "n-ok-tel"],
  ["Atendemos das 8 às 18h, de segunda a sexta.", none, false, "n-ok-faixa"],
  ["A clínica abre às 8h no sábado.", none, false, "n-ok-func"],
  ["A equipe costuma responder até as 18h.", none, false, "n-ok-limite"],
  ["Tenho quinta às dez ou às duas da tarde.", none, false, "n-ok-extenso"],
  ["Tenho quinta-feira 18/06 às 10:00. Também tenho sexta às 9h.", none, false, "n-ok"],
  ["Tenho quinta. Às 10h ou às 14h, qual prefere?", none, false, "n-ok-split"],
  ["Seu horário de terça 30/06 às 15h continua de pé.", hasSched, false, "n-ok-E"],
  ["Seu horário de terça 30/06 às 15h continua marcado. Para outro, tenho quinta às 10h.", hasSched, false, "n-ok-E+O"],
  ["Seu pedido de quinta às 10h está com a equipe, aguardando confirmação.", pend, false, "n-ok-pend"],
  ["Registrei seu pedido para quinta às 10h; a equipe confirma em breve.", pend, false, "n-ok-pend"],
  ["Seu Pix de R$ 150 foi confirmado hoje às 9h.", none, false, "n-ok-pag"],
  ["Recebi o comprovante enviado hoje às 8h40, obrigado!", none, false, "n-ok-pag"],
  ["Você comentou que só pode depois das 18h; tenho quinta às 14h, serve?", none, false, "n-ok"],
  ["Não tenho quinta às 17h, só às 10h ou 14h.", none, false, "n-ok-neg"],
  ["Prefere manhã ou tarde?", none, false, "n-ok"],
  ["Posso consultar a agenda pra você, qual dia prefere?", none, false, "n-ok"],
  ["O Dr. atende às terças e quintas.", none, false, "n-ok-semhora"],
  ["Lembre de trazer os exames na consulta.", none, false, "n-ok"],
  ["Hoje é sexta, 12/06.", none, false, "n-ok-data"],
  ["O retorno costuma ser em 30 dias.", none, false, "n-ok-dur"],
  ["Tenho quinta às 10h e às 14h. Qual fica melhor pra você?", none, false, "n-ok"],
  ["Ah, entendi! Quinta às 14h então é a sua preferência? Posso registrar?", none, false, "n-ok-readback"],
  ["Desculpe a demora! Tenho sexta às 9h.", none, false, "n-ok"],
  ["Nosso estacionamento fecha às 22h.", none, false, "n-ok-func"],
];

// Sem as tools / frases fora do assunto agenda (o guard roda em todo turno de org com o módulo ligado) -------------
const VAZIO = mk(NOW_JUN);
const FORA: Case[] = [
  ["O evento é sábado às 19h.", VAZIO, false, "f"],
  ["Posso te ligar amanhã às 10h?", VAZIO, false, "f"],
  ["Posso te ligar amanhã às 10h para explicar?", VAZIO, false, "f"],
  ["O curso começa dia 20 às 19h.", VAZIO, false, "f"],
  ["Sua entrega chega amanhã às 14h.", VAZIO, false, "f"],
  ["A live é hoje às 20h!", VAZIO, false, "f"],
  ["A reunião com o consultor ficou para quinta às 15h.", VAZIO, false, "f"],
  ["A promoção vai até domingo às 23h59.", VAZIO, false, "f"],
  ["Seu pedido sai amanhã às 9h.", VAZIO, false, "f"],
  ["Seu horário de quinta às 10h está confirmado.", VAZIO, "time_not_offered", "f"],
];

// 40 NOVAS da rodada 3 (expectativa definida ANTES de rodar) --------------------------------------------------------
const R3: Case[] = [
  ["Tenho quinta às 18h, se quiser.", none, "time_not_offered", "r3"],
  ["Se preferir à noite, tenho quinta às 19h.", none, "time_not_offered", "r3"],
  ["Caso não possa, consigo sexta, 19/06, às 16h.", none, "time_not_offered", "r3"],
  ["Quinta às 10h ficou no seu nome.", none, "claim_without_booking", "r3"],
  ["Pode contar com quinta às 14h, já está reservado.", none, "claim_without_booking", "r3"],
  ["A vaga de quinta às 14h é sua.", none, "claim_without_booking", "r3"],
  ["Quinta às 10h, está garantido!", none, "claim_without_booking", "r3"],
  ["Anotado! Quinta às 10h.", none, "claim_without_booking", "r3"],
  ["Pronto, sexta 19/06 às 9h.", none, "claim_without_booking", "r3"],
  ["Beleza, sexta às 9h, te aguardo!", none, "claim_without_booking", "r3"],
  ["Seu horário de quinta às 10h foi confirmado pela equipe.", pend, "confirmed_but_pending", "r3"],
  ["A equipe já aprovou quinta às 10h.", pend, "confirmed_but_pending", "r3"],
  ["Quinta às 10h está garantido, pode vir.", pend, "confirmed_but_pending", "r3"],
  ["Tudo certo com quinta às 10h!", pend, "confirmed_but_pending", "r3"],
  ["Sua consulta de quinta às 17h está marcada.", none, "time_not_offered", "r3"],
  ["Já te encaixei quinta às 14h.", hasSched, "claim_without_booking", "r3"],
  ["Confirmei sua sessão de sexta, 19/06, às 9h.", none, "claim_without_booking", "r3"],
  ["Prontinho! Sua consulta está confirmada.", none, "claim_without_booking", "r3"],
  ["Seu agendamento está feito!", none, "claim_without_booking", "r3"],
  ["Reservado!", none, "claim_without_booking", "r3"],
  ["Tenho quinta às 10h. Já deixei reservado pra você.", none, "claim_without_booking", "r3"],
  ["Quinta às 10h então, combinado!", none, "claim_without_booking", "r3"],
  ["Sua consulta ficou marcada pra quinta.", none, "claim_without_booking", "r3"],
  ["Agendei você para sexta, 19/06, às 17h.", none, true, "r3"],
  ["Tenho quinta às 10h, se preferir.", none, false, "r3"],
  ["Se quiser, tenho sexta, 19/06, às 9h.", none, false, "r3"],
  ["Caso prefira à tarde, tenho quinta às 14h.", none, false, "r3"],
  ["Quinta às 10h ou sexta às 9h, qual você prefere?", none, false, "r3"],
  ["Qual horário fica melhor: quinta às 10h ou às 14h?", none, false, "r3"],
  ["Quinta, 18/06:\n- 10:00\n- 14:00", none, false, "r3"],
  ["Posso reservar quinta às 14h pra você?", none, false, "r3"],
  ["Vou registrar quinta às 10h, tudo bem?", none, false, "r3"],
  ["Pedido registrado para quinta-feira, 18/06, às 10:00, aguardando confirmação da equipe.", pend, false, "r3"],
  ["Anotei seu pedido; a equipe confirma quinta às 10h.", pend, false, "r3"],
  ["Seu pedido de quinta às 10h está com a equipe.", pend, false, "r3"],
  ["O treino começa às 7h, a gente se vê lá.", none, false, "r3"],
  ["Estarei fora amanhã às 16h, mas já te respondo.", none, false, "r3"],
  ["O prazo de resposta é até as 18h de hoje.", none, false, "r3"],
  ["A consulta de hoje às 9h já passou, tenho quinta às 10h.", none, false, "r3"],
  ["Seu horário de terça 30/06 às 15h está confirmado.", hasSched, false, "r3"],
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
  test("60 da rodada 2 do revisor (zero afirmação indevida passando, zero falso positivo nas legítimas)", () => {
    expect(R2.length).toBeGreaterThanOrEqual(58);
    expect(run(R2)).toEqual([]);
  });
  test("10 frases fora do assunto agenda (módulo ligado, sem tools) passam; só o horário de agenda inventado barra", () => {
    expect(run(FORA)).toEqual([]);
  });
  test("40 novas da rodada 3", () => {
    expect(R3.length).toBe(40);
    expect(run(R3)).toEqual([]);
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
