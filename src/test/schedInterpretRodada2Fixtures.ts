/**
 * Fixtures da interpretação da confirmação do humano pelo WhatsApp (C1), correções da rodada 2.
 *
 * REAL_CASES: as frases REAIS da rodada 2 de simulação com modelo (`temp/agenda-v2/simulacoes-ia/rodada-2/harness/c1.py`:
 * 11 casos do conjunto 1 e 9 do conjunto 2; cada um rodou em 3 negócios x 2 modos = 120 mensagens). `{who}` é o profissional
 * de cada negócio ("a Ana", "o Rui", "a Dra. Helena"). Dias da semana valem para o relógio de cada teste.
 *
 * BLIND_SET: 30 positivos + 30 negativos escritos ANTES de mexer no código (conjunto cego; relógio: sexta 12/06/2026 09:00,
 * São Paulo; seg 15, ter 16, qua 17, qui 18, sex 19). Positivo = a equipe confirma ao cliente o horário que ELE pediu para si:
 * tem de virar sugestão de 1 toque com aquele dia e hora. Negativo = nada pode ser sugerido nem criado (exceto o N30, em que a
 * correção pode sugerir o horário corrigido, nunca o primeiro).
 */

export type Turn = { from: "c" | "h"; text: string };
/** Assunto REAL da mensagem do cliente (o que o classificador LLM deve devolver em `assunto`). */
export type Subject = "agendamento_proprio" | "funcionamento" | "terceiro" | "entrega_pagamento" | "outro";

export type RealCase = {
  id: string;
  /** `create` = a equipe confirma o que o cliente pediu para si; `none` = nada pode ser sugerido nem criado. */
  expected: "create" | "none";
  turns: Turn[];
  subject: Subject;
  /** Dia da semana (0 = domingo) e hora do horário esperado; `tomorrow` = amanhã. */
  when?: { wd?: number; tomorrow?: boolean; hour: number };
  /** Correção logo depois (o segundo recado da equipe corrige o primeiro): o esperado é nenhum agendamento ativo. */
  correction?: { wd: number; hour: number };
};

const c = (text: string): Turn => ({ from: "c", text });
const h = (text: string): Turn => ({ from: "h", text });

export const REAL_CASES: RealCase[] = [
  // Conjunto 1: frases naturais do cliente
  { id: "P1", expected: "create", turns: [c("dá pra ser terça às 10h?"), h("Confirmado terça 10h")], subject: "agendamento_proprio", when: { wd: 2, hour: 10 } },
  { id: "P2", expected: "create", turns: [c("amanhã às 15h dá?"), h("Pode vir amanhã às 15h")], subject: "agendamento_proprio", when: { tomorrow: true, hour: 15 } },
  { id: "P3", expected: "create", turns: [c("quarta às 9h com {who}?"), h("Fechado, quarta 9h com {who}")], subject: "agendamento_proprio", when: { wd: 3, hour: 9 } },
  { id: "P4", expected: "create", turns: [c("posso ir segunda às 14h?"), h("ok")], subject: "agendamento_proprio", when: { wd: 1, hour: 14 } },
  { id: "P5", expected: "none", turns: [h("Confirmado quarta 11h")], subject: "outro" },
  { id: "N1", expected: "none", turns: [c("Vocês abrem segunda às 10h?"), h("Confirmado segunda 10h")], subject: "funcionamento" },
  { id: "N2", expected: "none", turns: [c("pode ser terça às 10h pro meu marido?"), h("Confirmado terça 10h")], subject: "terceiro" },
  { id: "N3", expected: "none", turns: [c("a entrega chega amanhã às 10h?"), h("Confirmado amanhã 10h")], subject: "entrega_pagamento" },
  { id: "N4", expected: "none", turns: [c("fiz o pix agora às 10h"), h("confirmado o pix")], subject: "entrega_pagamento" },
  { id: "N5", expected: "none", turns: [c("quinta às 10h pode?"), h("quinta 10h não dá")], subject: "agendamento_proprio" },
  { id: "N6", expected: "none", turns: [c("terça às 10h?"), h("Confirmado terça 10h"), h("ops, terça 11h")], subject: "agendamento_proprio", correction: { wd: 2, hour: 11 } },
  // Conjunto 2: o cliente com intenção explícita
  { id: "P1i", expected: "create", turns: [c("quero marcar terça às 10h"), h("Confirmado terça 10h")], subject: "agendamento_proprio", when: { wd: 2, hour: 10 } },
  { id: "P2i", expected: "create", turns: [c("queria agendar amanhã às 15h"), h("Pode vir amanhã às 15h")], subject: "agendamento_proprio", when: { tomorrow: true, hour: 15 } },
  { id: "P3i", expected: "create", turns: [c("quero horário quarta às 9h com {who}"), h("Fechado, quarta 9h com {who}")], subject: "agendamento_proprio", when: { wd: 3, hour: 9 } },
  { id: "P4i", expected: "create", turns: [c("quero ir segunda às 14h, pode?"), h("ok")], subject: "agendamento_proprio", when: { wd: 1, hour: 14 } },
  { id: "N1i", expected: "none", turns: [c("quero saber se vocês abrem segunda às 10h"), h("Confirmado segunda 10h")], subject: "funcionamento" },
  { id: "N2i", expected: "none", turns: [c("quero marcar terça às 10h pro meu marido"), h("Confirmado terça 10h")], subject: "terceiro" },
  { id: "N3i", expected: "none", turns: [c("quero que a entrega seja amanhã às 10h"), h("Confirmado amanhã 10h")], subject: "entrega_pagamento" },
  { id: "N5i", expected: "none", turns: [c("quero marcar quinta às 10h"), h("quinta 10h não dá")], subject: "agendamento_proprio" },
  { id: "N6i", expected: "none", turns: [c("quero marcar terça às 11h"), h("Confirmado terça 11h"), h("ops, terça 14h")], subject: "agendamento_proprio", correction: { wd: 2, hour: 14 } },
];

export type BlindCase = { id: string; kind: "pos" | "neg"; turns: Turn[]; subject: Subject; when?: { date: string; hour: number; min?: number }; correctionTo?: { date: string; hour: number } };

const P = (id: string, turns: Turn[], date: string, hour: number, min = 0): BlindCase => ({ id, kind: "pos", turns, subject: "agendamento_proprio", when: { date, hour, min } });
const N = (id: string, turns: Turn[], subject: Subject): BlindCase => ({ id, kind: "neg", turns, subject });

export const BLIND_SET: BlindCase[] = [
  // ---- 30 positivos ----
  P("B01", [c("Consegue me encaixar na terça às 14h?"), h("Confirmado, terça às 14h")], "2026-06-16", 14),
  P("B02", [c("Queria marcar uma consulta quinta 9h"), h("Fechado! Quinta 9h então")], "2026-06-18", 9),
  P("B03", [c("Tem vaga sexta às 16h?"), h("Tenho sim, sexta 16h tá confirmado")], "2026-06-19", 16),
  P("B04", [c("posso ir quarta às 10:30?"), h("Pode vir quarta 10:30")], "2026-06-17", 10, 30),
  P("B05", [c("Bom dia! Gostaria de agendar segunda às 8h"), h("Bom dia! Agendado segunda 8h")], "2026-06-15", 8),
  P("B06", [c("quero um horário na terça de tarde, 15h pode ser?"), h("Combinado, terça 15h")], "2026-06-16", 15),
  P("B07", [c("dá pra quinta às 11h?"), h("Dá sim, confirmado quinta 11h")], "2026-06-18", 11),
  P("B08", [c("Preciso marcar para sexta às 9h"), h("Marcado sexta 9h")], "2026-06-19", 9),
  P("B09", [c("pode ser dia 17/06 às 13h?"), h("Confirmado dia 17/06 às 13h")], "2026-06-17", 13),
  P("B10", [c("queria marcar amanhã às 9h"), h("Confirmado amanhã 9h")], "2026-06-13", 9),
  P("B11", [c("Boa tarde, tem horário na quarta às 16h?"), h("Tem sim. Confirmado quarta 16h")], "2026-06-17", 16),
  P("B12", [c("Me encaixa terça às 9h por favor"), h("Encaixei você terça 9h, combinado")], "2026-06-16", 9),
  P("B13", [c("Podem me atender quinta às 15h?"), h("Podemos sim, quinta 15h confirmado")], "2026-06-18", 15),
  P("B14", [c("Prefiro sexta às 14h"), h("Perfeito, sexta 14h fechado")], "2026-06-19", 14),
  P("B15", [c("segunda às 17h?"), h("Pode vir segunda 17h")], "2026-06-15", 17),
  P("B16", [c("quero marcar segunda 11h, pode?"), h("Ok, segunda 11h confirmado")], "2026-06-15", 11),
  P("B17", [c("Tem como ser quarta às 8h30?"), h("Tem sim! Quarta 8h30 confirmado")], "2026-06-17", 8, 30),
  P("B18", [c("Vou querer agendar na quinta às 10h"), h("Agendado para quinta às 10h")], "2026-06-18", 10),
  P("B19", [c("Gostaria de marcar terça-feira às 16h"), h("Confirmado terça-feira 16h")], "2026-06-16", 16),
  P("B20", [c("Seria possível sexta às 10h?"), h("Seria sim. Sexta 10h, confirmado")], "2026-06-19", 10),
  P("B21", [h("Tenho segunda 10h ou terça 14h"), c("terça"), h("Confirmado terça 14h")], "2026-06-16", 14),
  P("B22", [c("Oi, quero marcar um horário"), h("Claro, que dia?"), c("quinta às 9h"), h("Confirmado quinta 9h")], "2026-06-18", 9),
  P("B23", [c("boa noite, tem quarta às 18h?"), h("Tem sim, quarta 18h confirmado")], "2026-06-17", 18),
  P("B24", [c("sexta às 9h pode ser?"), h("Pode ser, sexta 9h confirmado ✅")], "2026-06-19", 9),
  P("B25", [c("posso passar na segunda às 14h?"), h("Pode passar segunda 14h, te espero")], "2026-06-15", 14),
  P("B26", [c("quero ir na terça às 9h"), h("Fechado, terça 9h")], "2026-06-16", 9),
  P("B27", [c("Tem vaga pra quinta às 16h?"), h("Tem sim, quinta 16h reservado")], "2026-06-18", 16),
  P("B28", [c("Pode ser quarta às 14h? Obrigada"), h("Confirmado quarta 14h, até lá!")], "2026-06-17", 14),
  P("B29", [c("Bom dia, consigo um horário sexta às 11h?"), h("Consegue sim, sexta 11h confirmado")], "2026-06-19", 11),
  P("B30", [c("posso ir quinta às 13h?"), h("ok")], "2026-06-18", 13),
  // ---- 30 negativos ----
  // funcionamento (6)
  N("B31", [c("Vocês abrem sábado às 9h?"), h("Abrimos sim! Confirmado sábado 9h")], "funcionamento"),
  N("B32", [c("Abre segunda às 8h?"), h("Abre sim, segunda 8h confirmado")], "funcionamento"),
  N("B33", [c("Tem expediente sábado às 10h?"), h("Temos, sábado 10h")], "funcionamento"),
  N("B34", [c("vocês fecham às 18h na sexta?"), h("Fechamos sim, sexta 18h")], "funcionamento"),
  N("B35", [c("Estão funcionando segunda às 9h?"), h("Sim, confirmado segunda 9h")], "funcionamento"),
  N("B36", [c("o consultório funciona sexta às 17h?"), h("Funciona sim, sexta 17h confirmado")], "funcionamento"),
  // terceiro (6)
  N("B37", [c("minha mãe pode ir quinta às 10h?"), h("Pode sim, confirmado quinta 10h")], "terceiro"),
  N("B38", [c("É para o meu filho: terça às 15h"), h("Confirmado terça 15h")], "terceiro"),
  N("B39", [c("queria marcar pra minha esposa sexta 9h"), h("Fechado sexta 9h")], "terceiro"),
  N("B40", [c("meu pai precisa de um horário quarta às 14h"), h("Confirmado quarta 14h")], "terceiro"),
  N("B41", [c("pode ser segunda às 16h pro meu cachorro?"), h("Confirmado segunda 16h")], "terceiro"),
  N("B42", [c("Marca para a Júlia, minha irmã, quinta 11h"), h("Marcado quinta 11h")], "terceiro"),
  // entrega, pagamento, evento (5)
  N("B43", [c("o motoboy passa quinta às 14h?"), h("Passa sim, confirmado quinta 14h")], "entrega_pagamento"),
  N("B44", [c("a encomenda chega sexta às 10h?"), h("Chega sim, sexta 10h confirmado")], "entrega_pagamento"),
  N("B45", [c("faço o pix segunda às 9h"), h("Confirmado, segunda 9h, obrigado")], "entrega_pagamento"),
  N("B46", [c("o evento começa quinta às 19h?"), h("Confirmado quinta 19h")], "outro"),
  N("B47", [c("Posso pagar a parcela quarta às 10h?"), h("Pode sim, quarta 10h confirmado")], "entrega_pagamento"),
  // a equipe nega, informa ou não há pedido (5)
  N("B48", [c("terça às 10h pode?"), h("terça 10h não dá, tenho quarta 10h")], "agendamento_proprio"),
  N("B49", [c("posso ir quinta às 9h?"), h("Infelizmente quinta 9h está ocupado")], "agendamento_proprio"),
  N("B50", [c("sexta às 14h?"), h("Não consigo sexta 14h")], "agendamento_proprio"),
  N("B51", [h("Confirmado quarta 11h")], "outro"),
  N("B52", [h("Atendemos de segunda a sexta das 8h às 18h")], "outro"),
  // a equipe confirma OUTRO horário que o do pedido (3)
  N("B53", [c("terça às 10h?"), h("Confirmado terça 11h")], "agendamento_proprio"),
  N("B54", [c("quarta às 9h?"), h("Confirmado quinta 9h")], "agendamento_proprio"),
  N("B55", [c("pode ser segunda às 14h?"), h("Fechado segunda 15h")], "agendamento_proprio"),
  // outros (5)
  N("B56", [c("bom dia"), h("Bom dia! Confirmado quinta 10h")], "outro"),
  N("B57", [c("terça às 10h?"), h("Confirmado ontem 10h")], "agendamento_proprio"),
  N("B58", [c("é o João da obra, passo aí sexta 9h pegar o material"), h("Confirmado sexta 9h")], "outro"),
  N("B59", [c("tem horário quinta às 10h?"), h("quinta 10h tá lotado")], "agendamento_proprio"),
  { id: "B60", kind: "neg", turns: [c("terça às 10h?"), h("Confirmado terça 10h"), h("ops, terça 14h")], subject: "agendamento_proprio", correctionTo: { date: "2026-06-16", hour: 14 } },
];
