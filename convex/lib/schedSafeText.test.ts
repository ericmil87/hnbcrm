import { describe, expect, test } from "vitest";
import { SCHED_SAFE_TEXT } from "./schedClaimGuard";
import { buildClaimState, knowledgeTimesOf } from "./schedClaimState";
import { customerTail, detectCustomerIntent, isChangeIntent } from "./schedIntent";
import { schedSafeReply } from "./schedSafeText";

describe("detectCustomerIntent (léxico do cliente)", () => {
  test.each<[string, string | null]>([
    ["Preciso remarcar minha consulta", "remarcar"],
    ["queria trocar o horário de amanhã", "remarcar"],
    ["dá pra mudar o dia da minha sessão?", "remarcar"],
    ["Quero reagendar", "remarcar"],
    ["preciso adiar", "remarcar"],
    ["Quero cancelar", "cancelar"],
    ["não vou poder ir amanhã", "cancelar"],
    ["não consigo mais comparecer", "cancelar"],
    ["desmarca por favor", "cancelar"],
    ["Confirmo minha presença na segunda", "presenca"],
    ["vou estar lá com certeza", "presenca"],
    ["quero marcar para mim e minha amiga", "grupo"],
    ["somos duas pessoas, queremos marcar", "grupo"],
    ["queria marcar para eu e meu filho amanhã", "grupo"],
    ["queria marcar para 2 pessoas na sexta", "grupo"],
    ["queria um horário na quinta", "marcar"],
    ["tem vaga amanhã?", "marcar"],
    ["bom dia", null],
    ["qual o endereço?", null],
    ["", null],
  ])("%j → %s", (text, intent) => {
    expect(detectCustomerIntent(text)).toBe(intent);
  });
  test("remarcar/cancelar vêm antes de marcar ('cancelar e marcar outro')", () => {
    expect(detectCustomerIntent("quero cancelar essa e marcar outro horário")).toBe("cancelar");
    expect(isChangeIntent(detectCustomerIntent("quero cancelar"))).toBe(true);
    expect(isChangeIntent(detectCustomerIntent("quero marcar"))).toBe(false);
    expect(isChangeIntent(null)).toBe(false);
  });
  test("customerTail junta só as mensagens do cliente depois da última fala da IA", () => {
    expect(
      customerTail([
        { de: "cliente", texto: "oi" },
        { de: "ia", texto: "olá" },
        { de: "cliente", texto: "preciso remarcar" },
        { de: "cliente", texto: "a de segunda" },
      ])
    ).toBe("preciso remarcar a de segunda");
    expect(customerTail([{ de: "ia", texto: "oi" }])).toBe("");
    expect(customerTail([])).toBe("");
  });
});

describe("schedSafeReply: texto conforme a intenção, motivo com o rótulo (nunca o texto do cliente)", () => {
  const reply = (customerText: string, over: Partial<Parameters<typeof schedSafeReply>[0]> = {}) =>
    schedSafeReply({ kind: "claim_without_booking", customerText, pendingRequest: false, hasUpcoming: true, ...over });
  test("cada intenção tem texto próprio e verdadeiro (o repasse é criado logo depois)", () => {
    expect(reply("preciso remarcar").text).toMatch(/^Remarcar fica com a nossa equipe/);
    expect(reply("quero cancelar").text).toMatch(/^O cancelamento fica com a nossa equipe/);
    expect(reply("confirmo minha presença").text).toMatch(/^Recebi a sua mensagem e já avisei a equipe/);
    expect(reply("queria marcar eu e minha amiga amanhã").text).toMatch(/^Para mais de uma pessoa a equipe confirma/);
    expect(reply("quero marcar", { kind: "resource_not_offered" }).text).toMatch(/^Quem atende a equipe confirma/);
    expect(reply("tá marcado?", { pendingRequest: true }).text).toMatch(/^Seu pedido já está registrado e aguarda a confirmação da equipe/);
    expect(reply("quero um horário").text).toBe(SCHED_SAFE_TEXT);
    expect(reply("").text).toBe(SCHED_SAFE_TEXT);
  });
  test("a intenção do cliente vale mais que o pedido pendente (quem quer cancelar não ouve 'seu pedido está registrado')", () => {
    expect(reply("quero cancelar", { pendingRequest: true }).text).toMatch(/^O cancelamento/);
    expect(reply("quero remarcar", { pendingRequest: true }).situation).toBe("remarcar");
  });
  test("motivo e resumo dizem o que o cliente queria, sem copiar o texto dele", () => {
    const cliente = "Quero cancelar a consulta da Maria, meu CPF é 123.456.789-00";
    const r = reply(cliente);
    expect(r.reason).toBe("Cliente quer cancelar um horário (resposta da IA barrada pelo guard)");
    expect(r.reason.length).toBeLessThanOrEqual(200);
    expect(r.summary.length).toBeLessThanOrEqual(1000);
    for (const field of [r.reason, r.summary, r.text]) {
      expect(field).not.toContain("123.456");
      expect(field).not.toContain("Maria");
    }
  });
  test("'pedido registrado' nunca sai sem pedido pendente conhecido", () => {
    for (const text of ["quero um horário", "tá confirmado?", "oi"]) expect(reply(text).text).not.toMatch(/já está registrado/);
  });
});

describe("buildClaimState e horas do conhecimento", () => {
  test("knowledgeTimesOf: turmas fixas entram; faixas de funcionamento não", () => {
    const k = "Turmas de segunda a sexta às 7h, 9h, 18h e 19h. Funcionamos das 6h às 21h.";
    expect(knowledgeTimesOf(k).sort((a, b) => a - b)).toEqual([420, 540, 1080, 1140]);
    expect(knowledgeTimesOf(null)).toEqual([]);
    expect(knowledgeTimesOf("")).toEqual([]);
  });
  test("o nome do recurso só liga aos horários que o servidor nomeou (oferta vigente, oferta do turno, reserva e agendamento existente)", () => {
    const T = new Date("2026-11-24T13:00:00Z").getTime(); // terça 10:00 em SP
    const T2 = new Date("2026-11-24T17:00:00Z").getTime(); // terça 14:00
    const st = buildClaimState({
      now: new Date("2026-11-21T12:00:00Z").getTime(),
      tz: "America/Sao_Paulo",
      upcoming: [{ ref: "a1", label: "x", startTime: T2, serviceName: "Corte", status: "pending_approval", resourceNames: ["Dra. Helena", "Sala Rosa"] }],
      offers: [{ code: "h1", label: "x", startTime: T, professional: "Léo" }],
      turn: { booked: [{ startTime: T, status: "pending" }], offered: [T2], named: [{ startTime: T2, professional: "Tato" }] },
      serviceNames: ["Corte"],
      guardNames: ["Léo", "Tato"],
      knowledgeTimes: [],
      handoff: true,
    });
    expect(st.existing[0].resources).toEqual(["dra helena", "sala rosa"]);
    expect(st.booked[0].resources).toEqual(["leo"]);
    expect(st.offered.find((o) => o.timeMin === 600)!.resources).toEqual(["leo"]);
    expect(st.offered.find((o) => o.timeMin === 840)!.resources).toEqual(["tato"]);
    expect(st.handoff).toBe(true);
    expect(st.knowledgeTimes).toBeUndefined();
  });
});

import { customerSinceOffer, mentionsGroup, mentionsOtherService } from "./schedIntent";
describe("mentionsGroup (parentesco/companhia ou número de pessoas + intenção de marcar; 'só eu' vence)", () => {
  test.each([
    ["queria um corte quinta pra mim e meu filho, um depois do outro", true],
    ["somos em 2, queremos marcar uma consulta", true],
    ["quero marcar para mim e minha amiga", true],
    ["queria marcar uma aula, vou com minha esposa", true],
    ["queria um corte quinta de tarde", false],
    ["minha amiga indicou vocês, queria marcar", false],
    ["só eu mesmo, quero marcar", false],
    // falsos positivos da revisão
    ["Para mim é a melhor opção, quinta", false],
    ["Meu cabelo também tá grande, queria marcar um corte", false],
    ["Fui eu e minha mãe semana passada", false],
    ["Meu marido também faz aqui, mas quero marcar só pra mim", false],
    ["Eu e a Maria combinamos de nos ver, quero marcar um corte", false],
    // 2ª revisão: falsos negativos (7 de 10) e os falsos positivos que têm de continuar fora
    ["Pra nós três, tem horário sábado?", true],
    ["Eu e a Ana queremos marcar juntas", true],
    ["Meu marido também quer cortar, pode ser no mesmo horário que o meu?", true],
    ["Queria marcar pra mim e pro meu marido", true],
    ["pra mim e pra minha filha no mesmo horário", true],
    ["A gente é em 3", true],
    ["Somos um casal", true],
    ["Minha filha vai comigo mas ela só espera", false],
    ["Vou com meu marido até aí mas a sessão é só minha", false],
    ["Meu filho vai marcar depois", false],
    ["minha mãe indicou vocês", false],
    ["duas vezes por semana", false],
    ["2 sessões", false],
  ])("%j → %s", (text, expected) => {
    expect(mentionsGroup(text)).toBe(expected);
  });
  test("só valem as mensagens do cliente desde a última oferta da IA", () => {
    const h = [
      { de: "cliente", texto: "oi, queria marcar pra mim e meu filho" },
      { de: "ia", texto: "Tenho quinta às 14h ou às 15h" },
      { de: "cliente", texto: "pode ser as 14h" },
    ];
    expect(mentionsGroup(customerSinceOffer(h))).toBe(false);
    expect(mentionsGroup(customerSinceOffer(h.slice(0, 1)))).toBe(true);
    expect(customerSinceOffer([])).toBe("");
  });
  test("outro serviço que não é o do agendamento que o cliente já tem", () => {
    expect(mentionsOtherService("queria marcar uma barba também", ["Corte", "Barba"], ["Corte"])).toBe(true);
    expect(mentionsOtherService("preciso remarcar meu corte", ["Corte", "Barba"], ["Corte"])).toBe(false);
  });
});

describe("intenção sem falso cancelamento e sem agendamento", () => {
  test.each(["Não consigo ir de manhã, tem à tarde?", "Não vou poder ir sábado, tem domingo?"])("%j não é cancelar", (t) => {
    expect(detectCustomerIntent(t)).not.toBe("cancelar");
  });
  test("cancelamento explícito e 'não vou poder ir' sem pedir outro dia continuam", () => {
    expect(detectCustomerIntent("Não vou poder ir amanhã")).toBe("cancelar");
    expect(detectCustomerIntent("Quero cancelar, não tem mais jeito")).toBe("cancelar");
  });
  test("sem agendamento ativo o texto seguro e o repasse nunca falam de cancelar/remarcar/presença", () => {
    for (const t of ["quero cancelar", "preciso remarcar", "confirmo minha presença", "Não vou poder ir sábado"]) {
      const r = schedSafeReply({ kind: "claim_without_booking", customerText: t, pendingRequest: false, hasUpcoming: false });
      expect(r.text).not.toMatch(/cancelamento|Remarcar|presença|Recebi a sua mensagem/);
      expect(r.reason).not.toMatch(/cancelar|remarcar|presença/);
    }
  });
});

import { statusReplyText } from "./schedSafeText";
import { asksPedidoStatus } from "./schedIntent";
describe("texto seguro de SITUAÇÃO (D3): montado pelo servidor a partir do estado, nunca esconde o que o cliente perguntou", () => {
  const none = { scheduled: [], pending: [], declined: [], expired: [], cancelled: [] };
  const L = "segunda-feira, 15/06, às 08:00";
  test.each([
    ["e aí, confirmou?", true],
    ["deu certo meu horário?", true],
    ["que dia é mesmo o meu horário?", true],
    ["já está marcado?", true],
    ["quando é a minha consulta?", true],
    ["confirmou o meu pedido?", true],
    // 2ª revisão do #203: perguntas comuns que NÃO são da situação do pedido
    ["E aí, tudo bem? Queria marcar um corte pra mim e meu filho", false],
    ["Qual horário vocês abrem amanhã?", false],
    ["Que dia vocês atendem?", false],
    ["Alguma novidade sobre o preço?", false],
    ["quando é a promoção?", false],
    ["alguma novidade?", false],
    ["Quanto custa a minha consulta?", false],
    ["quanto custa?", false],
    ["onde fica a clínica?", false],
  ])("%j pergunta da situação? %s", (text, expected) => expect(asksPedidoStatus(text)).toBe(expected));

  test("aprovado diz o horário; pendente diz que aguarda; recusado/vencido/cancelado dizem que não foi possível e oferecem outros", () => {
    expect(statusReplyText({ ...none, scheduled: [L] })).toBe(`Seu horário está marcado para ${L}.`);
    expect(statusReplyText({ ...none, pending: [L] })).toBe(`Seu pedido para ${L} está registrado e aguarda a confirmação da equipe.`);
    expect(statusReplyText({ ...none, declined: [L] })).toMatch(/^Não foi possível confirmar o horário de .*não conseguiu aprovar esse pedido\. Posso consultar outros horários para você\.$/);
    expect(statusReplyText({ ...none, expired: [L] })).toMatch(/venceu sem resposta da equipe e não foi marcado\. Posso consultar outros horários/);
    expect(statusReplyText({ ...none, cancelled: [L] })).toMatch(/foi cancelado\. Se quiser, posso consultar outros horários/);
    expect(statusReplyText(none)).toBeNull();
  });
  test("marcado + pendente: diz os dois; marcado vence recusado antigo", () => {
    expect(statusReplyText({ ...none, scheduled: [L], pending: ["terça-feira, 16/06, às 10:00"] })).toBe(`Seu horário está marcado para ${L}. Seu pedido para terça-feira, 16/06, às 10:00 está registrado e aguarda a confirmação da equipe.`);
    expect(statusReplyText({ ...none, scheduled: [L], declined: ["x"] })).toBe(`Seu horário está marcado para ${L}.`);
  });
  const base = { kind: "claim_without_booking", pendingRequest: false, hasUpcoming: true };
  test("schedSafeReply: pergunta de situação usa o texto de situação e NÃO abre repasse; sem fatos, o texto de antes", () => {
    const r = schedSafeReply({ ...base, customerText: "e aí, confirmou?", facts: { ...none, declined: [L] } });
    expect(r.situation).toBe("situacao");
    expect(r.handoff).toBe(false);
    expect(r.text).toMatch(/^Não foi possível confirmar/);
    expect(schedSafeReply({ ...base, customerText: "e aí, confirmou?" }).situation).not.toBe("situacao");
    expect(schedSafeReply({ ...base, customerText: "e aí, confirmou?", facts: none }).situation).not.toBe("situacao");
  });
  test("kind stale_pending sem a pergunta da situação: o texto é o da situação, MAS com repasse (só a pergunta de fato dispensa o repasse)", () => {
    const r = schedSafeReply({ ...base, kind: "stale_pending", customerText: "ok, obrigada", facts: { ...none, scheduled: [L] } });
    expect(r.situation).toBe("situacao");
    expect(r.text).toBe(`Seu horário está marcado para ${L}.`);
    expect(r.handoff).toBeUndefined();
  });
  test("pergunta que não é da situação (preço, grupo, profissional) não ganha o texto de situação: texto seguro normal + repasse", () => {
    const facts = { ...none, scheduled: [L] };
    for (const t of ["Qual horário vocês abrem amanhã?", "Alguma novidade sobre o preço?"]) {
      const r = schedSafeReply({ ...base, customerText: t, facts });
      expect(r.situation).not.toBe("situacao");
      expect(r.handoff).toBeUndefined();
    }
    const group = schedSafeReply({ ...base, customerText: "E aí? Queria marcar um corte pra mim e meu filho", facts });
    expect(group.situation).toBe("grupo");
    expect(group.handoff).toBeUndefined();
    expect(schedSafeReply({ ...base, kind: "resource_not_offered", customerText: "deu certo meu horário com o Léo?", facts }).situation).toBe("profissional");
  });
  test("remarcar/cancelar/presença continuam antes da situação (a equipe cuida)", () => {
    expect(schedSafeReply({ ...base, customerText: "quero cancelar, confirmou?", facts: { ...none, scheduled: [L] } }).situation).toBe("cancelar");
  });
});
