import { describe, expect, test } from "vitest";
import { claimNudge, type ClaimState, detectUnbackedBookingClaim } from "./schedClaimGuard";

const OFFERED = ["quinta-feira, 26/11, às 10:00", "quinta-feira, 26/11, às 14:30", "sexta-feira, 27/11, às 09:00"];
const none: ClaimState = { bookedThisTurn: "none", contactHas: "none", offeredLabels: [] };
const offered: ClaimState = { ...none, offeredLabels: OFFERED };
const pending: ClaimState = { bookedThisTurn: "pending", contactHas: "none", offeredLabels: ["quinta-feira, 26/11, às 10:00"] };
const scheduled: ClaimState = { bookedThisTurn: "scheduled", contactHas: "none", offeredLabels: ["quinta-feira, 26/11, às 10:00"] };

describe("schedClaimGuard — afirmações barradas", () => {
  test.each([
    "Pronto, seu horário está marcado!",
    "Marcado! Quinta, 26/11, às 10h.",
    "Agendei para quinta às 10h, te espero lá.",
    "Seu horário de quinta-feira às 10:00 está confirmado.",
    "Confirmado: 26/11 às 10h.",
    "Marquei você para quinta às 10h.",
    "Reservei quinta às 10h para você.",
    "O horário ficou marcado para quinta, 26/11.",
    "Tudo certo! Agendado para quinta às 10h.",
    "Confirmo o seu horário de quinta às 10h.",
    "Está agendado, 26/11 às 10h.",
    "Ficou para quinta às 10h então.",
  ])("sem reserva nenhuma: %s", (text) => {
    expect(detectUnbackedBookingClaim(text, offered)?.kind).toBe("claim_without_booking");
  });

  test("com pedido registrado (pending), 'confirmado/marcado/agendado' é barrado", () => {
    for (const text of [
      "Seu horário está confirmado para quinta às 10h!",
      "Está marcado: quinta, 26/11, às 10h.",
      "Agendado para quinta às 10:00.",
      "Marquei quinta às 10h.",
    ]) {
      expect(detectUnbackedBookingClaim(text, pending)?.kind, text).toBe("confirmed_but_pending");
    }
  });

  test("pending: 'reservado' sem dizer que aguarda a equipe também é barrado", () => {
    expect(detectUnbackedBookingClaim("Horário reservado para quinta às 10h!", pending)?.kind).toBe("confirmed_but_pending");
  });

  test("contato só com pedido pendente (turno novo) também não pode ouvir 'confirmado'", () => {
    const st: ClaimState = { bookedThisTurn: "none", contactHas: "pending_only", offeredLabels: ["quinta-feira, 26/11, às 10:00"] };
    expect(detectUnbackedBookingClaim("Seu horário de quinta às 10h está confirmado!", st)?.kind).toBe("confirmed_but_pending");
  });

  test("dia e hora citados como disponíveis que o servidor nunca devolveu", () => {
    expect(detectUnbackedBookingClaim("Tenho sexta às 16h livre, quer?", none)?.kind).toBeUndefined(); // pergunta
    expect(detectUnbackedBookingClaim("Tenho sexta, 27/11, às 16h disponível.", offered)?.kind).toBe("time_not_offered");
    expect(detectUnbackedBookingClaim("Temos quinta às 11:00 e também sexta às 09:00.", offered)?.kind).toBe("time_not_offered");
    expect(detectUnbackedBookingClaim("Tenho vaga em 26/11 às 17h.", offered)?.kind).toBe("time_not_offered");
  });

  test("scheduled: horário marcado de fato mas citado com hora diferente da reserva", () => {
    expect(detectUnbackedBookingClaim("Marcado! Quinta, 26/11, às 15h.", scheduled)?.kind).toBe("time_not_offered");
  });

  test("a evidência é um trecho curto, nunca o texto inteiro", () => {
    const long = `Pronto, seu horário está marcado! ${"blá ".repeat(100)}`;
    const v = detectUnbackedBookingClaim(long, offered)!;
    expect(v.evidence.length).toBeLessThanOrEqual(80);
  });
});

describe("schedClaimGuard — o que NÃO é afirmação", () => {
  test.each([
    ["pergunta", "Posso marcar quinta às 14:30?"],
    ["pergunta com 'confirmado'", "Quer que eu deixe confirmado quinta às 10h?"],
    ["oferta de horários vindos do servidor", "Tenho quinta, 26/11, às 10:00 ou às 14:30, e sexta, 27/11, às 09:00. Qual prefere?"],
    ["oferta por extenso sem os minutos", "Tenho quinta às 10h ou quinta às 14:30."],
    ["recebimento de comprovante", "Confirmo o recebimento do comprovante de R$ 150,00."],
    ["comprovante com data", "Recebi o comprovante de 10/11. Confirmo o recebimento, a equipe confere."],
    ["citação do cliente com aspas", 'Você escreveu "está marcado para quinta às 10h", mas ainda preciso confirmar com a equipe.'],
    ["narra o que o cliente disse", "Você pediu quinta às 10h, vou consultar a agenda."],
    ["negação", "Ainda não está marcado: falta você escolher o horário."],
    ["negação simples", "Seu horário não está confirmado."],
    ["promessa futura", "Vou marcar assim que você me confirmar o horário."],
    ["condicional", "Assim que a equipe confirmar o horário, te aviso."],
    ["condicional 'se'", "Se der certo, fica marcado para quinta."],
    ["horário de funcionamento", "Atendemos de segunda a sexta, das 9h às 18h."],
    ["horário indisponível", "Sexta às 16h está ocupado, mas tenho quinta, 26/11, às 10:00."],
    ["sem horário", "Não tenho nada livre na sexta às 9h."],
    ["pedido registrado, aguardando", "Pedido registrado: quinta-feira, 26/11, às 10:00, aguardando confirmação da equipe."],
    ["conversa comum", "Olá! Como posso ajudar? Temos consultas e sessões."],
    ["marcado como (etiqueta)", "Seu cadastro foi marcado como prioritário."],
    ["confirma (equipe)", "A equipe confirma o horário em breve."],
    ["texto vazio", ""],
  ])("%s", (_label, text) => {
    expect(detectUnbackedBookingClaim(text, offered)).toBeNull();
  });

  test("com reserva feita a afirmação correta passa: scheduled", () => {
    expect(detectUnbackedBookingClaim("Pronto, marcado para quinta-feira, 26/11, às 10:00!", scheduled)).toBeNull();
    expect(detectUnbackedBookingClaim("Seu horário está confirmado.", scheduled)).toBeNull();
  });

  test("com pedido registrado, o texto certo passa", () => {
    for (const text of [
      "Pedido registrado para quinta, 26/11, às 10:00! A equipe confirma em breve.",
      "Reservei quinta às 10h e a equipe confirma em seguida.",
      "Anotei seu pedido para quinta às 10h; fica aguardando a confirmação da equipe.",
      "Seu pedido de horário foi registrado e aguarda a confirmação da equipe.",
    ]) {
      expect(detectUnbackedBookingClaim(text, pending), text).toBeNull();
    }
  });

  test("contato com horário marcado de antes pode ouvir o próprio horário, e só ele", () => {
    const st: ClaimState = { bookedThisTurn: "none", contactHas: "scheduled", offeredLabels: ["terça-feira, 17/11, às 15:00"] };
    expect(detectUnbackedBookingClaim("Seu horário continua marcado para terça-feira, 17/11, às 15:00.", st)).toBeNull();
    expect(detectUnbackedBookingClaim("Seu horário está marcado para quarta, 18/11, às 15:00.", st)?.kind).toBe("time_not_offered");
  });
});

describe("claimNudge", () => {
  test("cada violação tem instrução própria e nenhuma cita o texto descartado", () => {
    for (const k of ["claim_without_booking", "confirmed_but_pending", "time_not_offered"] as const) {
      expect(claimNudge(k)).toContain("DESCARTADA");
    }
  });
});
