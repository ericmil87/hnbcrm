import { describe, expect, it } from "vitest";
import { parseConfirmation, prefilterConfirmation, type ConfirmAct } from "./schedConfirmParser";

const SP = "America/Sao_Paulo";
// Sábado, 21/11/2026 10:00 em São Paulo (UTC-3, sem horário de verão).
const SAT = Date.parse("2026-11-21T10:00:00-03:00");
const hm = (h: number, m = 0) => h * 60 + m;

type Row = {
  t: string;
  act: ConfirmAct;
  date?: string;
  time?: number;
  now?: number;
  tz?: string;
};

// ───────── positivas: confirmou com dia e hora resolvidos ─────────
const POSITIVAS: Row[] = [
  { t: "Ok confirmado qui 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "fechado amanhã às 14h30", act: "confirmou", date: "2026-11-22", time: hm(14, 30) },
  { t: "te espero sexta 9hrs", act: "confirmou", date: "2026-11-27", time: hm(9) },
  { t: "pode vir dia 27 às 10", act: "confirmou", date: "2026-11-27", time: hm(10) },
  { t: "Confirmado! Quinta às 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "combinado então, terça 15h30", act: "confirmou", date: "2026-11-24", time: hm(15, 30) },
  { t: "FECHADO SEGUNDA 8H", act: "confirmou", date: "2026-11-23", time: hm(8) },
  { t: "Agendado pra quarta 10:30 😉", act: "confirmou", date: "2026-11-25", time: hm(10, 30) },
  { t: "tá marcado domingo as 9 da manha", act: "confirmou", date: "2026-11-22", time: hm(9) },
  { t: "Confirmado 27/11 às 14h", act: "confirmou", date: "2026-11-27", time: hm(14) },
  { t: "marcado pra 27/11 14h", act: "confirmou", date: "2026-11-27", time: hm(14) },
  { t: "pode vir hoje às 15h", act: "confirmou", date: "2026-11-21", time: hm(15) },
  { t: "Te aguardo hoje 14hs", act: "confirmou", date: "2026-11-21", time: hm(14) },
  { t: "te espero depois de amanhã às 11h", act: "confirmou", date: "2026-11-23", time: hm(11) },
  { t: "fechado dps de amanha 9h", act: "confirmou", date: "2026-11-23", time: hm(9) },
  { t: "combinado, meio-dia amanhã", act: "confirmou", date: "2026-11-22", time: hm(12) },
  { t: "ok confirmado amanha meio dia e meia", act: "confirmou", date: "2026-11-22", time: hm(12, 30) },
  { t: "confirmadooo sexta 16h", act: "confirmou", date: "2026-11-27", time: hm(16) },
  { t: "Confirmado quinta que vem às 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "pode vir quinta da semana que vem 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "Fechado 5ª às 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "confirmado 5a feira 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "Confirmado quinta-feira às 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "confirmado terça 3 da tarde", act: "confirmou", date: "2026-11-24", time: hm(15) },
  { t: "Fechado quarta às 9 da manhã", act: "confirmou", date: "2026-11-25", time: hm(9) },
  { t: "agendado 28/11 as 10h", act: "confirmou", date: "2026-11-28", time: hm(10) },
  { t: "Te espero dia 5 de dezembro às 9h", act: "confirmou", date: "2026-12-05", time: hm(9) },
  { t: "marcamos dia 30 as 10h", act: "confirmou", date: "2026-11-30", time: hm(10) },
  { t: "Ok, confirmado 🙂👍 sexta 10h", act: "confirmou", date: "2026-11-27", time: hm(10) },
  { t: "Confirmado!!! sexta às 10h30", act: "confirmou", date: "2026-11-27", time: hm(10, 30) },
  { t: "fechadoo amanha 14h", act: "confirmou", date: "2026-11-22", time: hm(14) },
  { t: "te espero seg 9h", act: "confirmou", date: "2026-11-23", time: hm(9) },
  { t: "confirmado sex às 10", act: "confirmou", date: "2026-11-27", time: hm(10) },
  { t: "confirmado ter 14h", act: "confirmou", date: "2026-11-24", time: hm(14) },
  { t: "pode vir dom 10h", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "fechado qua 15h30", act: "confirmou", date: "2026-11-25", time: hm(15, 30) },
  { t: "Tá confirmado amanhã às 14:30", act: "confirmou", date: "2026-11-22", time: hm(14, 30) },
  { t: "Combinado, te espero amanhã 7h", act: "confirmou", date: "2026-11-22", time: hm(7) },
  { t: "Confirmado terça, dia 24, às 10h", act: "confirmou", date: "2026-11-24", time: hm(10) },
  { t: "reservado pra você amanhã às 10h", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "vou te atender amanhã às 16h", act: "confirmou", date: "2026-11-22", time: hm(16) },
  { t: "anotado! sexta 11h", act: "confirmou", date: "2026-11-27", time: hm(11) },
  { t: "Confirmado amanhã às 10 horas", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "Confirmado amanhã às dez", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "fechado pra amanhã 2 da tarde", act: "confirmou", date: "2026-11-22", time: hm(14) },
  { t: "fechado quinta 9h45", act: "confirmou", date: "2026-11-26", time: hm(9, 45) },
  { t: "Confirmado 01/12 às 10h", act: "confirmou", date: "2026-12-01", time: hm(10) },
  { t: "combinado amanhã às 9h30min", act: "confirmou", date: "2026-11-22", time: hm(9, 30) },
  { t: "Sem problema, te espero quinta 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "Confirmado 4ª feira 9h", act: "confirmou", date: "2026-11-25", time: hm(9) },
  { t: "confirmado 25 de dezembro 10h", act: "confirmou", date: "2026-12-25", time: hm(10) },
  { t: "Combinado amanhã 10h - te espero", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "pagamento confirmado, te espero quinta 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "Confirmado quinta 10h. Alguma dúvida?", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "Fechado 👍 amanhã 🕙 10h", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "Confirmado, quinta, às 10h, não precisa trazer nada", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "pode vir sexta 10hs", act: "confirmou", date: "2026-11-27", time: hm(10) },
  { t: "Fechado sexta 10 h", act: "confirmou", date: "2026-11-27", time: hm(10) },
  { t: "te espero sexta as 9", act: "confirmou", date: "2026-11-27", time: hm(9) },
  { t: "Confirmado amnha 10h", act: "confirmou", date: "2026-11-22", time: hm(10) },
  { t: "CONFIRMADO TERÇA ÀS 11H", act: "confirmou", date: "2026-11-24", time: hm(11) },
  { t: "Combinado terca 15h", act: "confirmou", date: "2026-11-24", time: hm(15) },
  { t: "ficou combinado sábado dia 28 às 10h", act: "confirmou", date: "2026-11-28", time: hm(10) },
  { t: "Confirmado 5ª-feira 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "te espero amanhã por volta das 10h", act: "confirmou", date: "2026-11-22", time: hm(10) },
];

// ───────── parciais: ato de confirmação sem dia e/ou hora resolvidos ─────────
const PARCIAIS: Row[] = [
  { t: "Confirmado!", act: "confirmou" },
  { t: "Fechado, te espero", act: "confirmou" },
  { t: "confirmado amanhã", act: "confirmou", date: "2026-11-22" },
  { t: "te espero às 10h", act: "confirmou", time: hm(10) },
  { t: "fechado quinta de manhã", act: "confirmou", date: "2026-11-26" },
  { t: "combinado, sexta à tarde", act: "confirmou", date: "2026-11-27" },
  { t: "confirmado sabado 10h", act: "confirmou", time: hm(10) }, // hoje é sábado: "sábado" é ambíguo
  { t: "confirmado quinta 3h", act: "confirmou", date: "2026-11-26" }, // 03:00 ou 15:00
  { t: "te espero hoje às 8h", act: "confirmou", date: "2026-11-21" }, // 10:00 agora: passou
  { t: "confirmado quinta dia 27 10h", act: "confirmou", time: hm(10) }, // dia 27 é sexta
  { t: "confirmado 31/02 10h", act: "confirmou", time: hm(10) },
  { t: "confirmado 05/11 10h", act: "confirmou", time: hm(10) }, // já passou
  { t: "confirmado semana que vem 10h", act: "confirmou", time: hm(10) },
  { t: "confirmado dia 31 10h", act: "confirmou", time: hm(10) }, // novembro tem 30
  { t: "Confirmado, a consulta dura 1h", act: "confirmou" },
  { t: "Confirmado, qualquer coisa me avisa", act: "confirmou" },
  { t: "confirmado quinta ou sexta 10h", act: "propos", time: hm(10) },
];

// ───────── negativas: nunca "confirmou" ─────────
const NEGATIVAS: Row[] = [
  // obrigatórias do plano §6.1
  { t: "atendemos de segunda a sexta das 8h às 18h", act: "informativo" },
  { t: "vou ter que ver", act: "nenhum" },
  { t: "quinta não consigo", act: "nenhum" },
  { t: "ontem às 10h você não veio", act: "nenhum" },
  { t: "pode ser quinta 10h?", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "se der eu confirmo", act: "nenhum" },
  { t: "sex", act: "nenhum" },
  { t: "ter", act: "nenhum" },
  { t: "das 9 às 12", act: "informativo" },
  // abreviações como palavra comum
  { t: "dom", act: "nenhum" },
  { t: "seg", act: "nenhum" },
  { t: "ter que ver isso", act: "nenhum" },
  { t: "vou ter 10h livres", act: "nenhum" },
  { t: "pra ter as 9 sessões feitas", act: "nenhum" },
  { t: "sex 🔥", act: "nenhum" },
  // horário de funcionamento / faixa / recorrência
  { t: "Funcionamos de seg a sex das 9h as 18h", act: "informativo" },
  { t: "nosso horário de atendimento é das 8h às 18h", act: "informativo" },
  { t: "fechamos às 18h", act: "informativo" },
  { t: "abrimos amanhã às 8h", act: "informativo" },
  { t: "Funcionamos aos sábados", act: "informativo" },
  { t: "toda quinta às 10h tem aula", act: "informativo" },
  { t: "quinta e sexta às 10h", act: "informativo" },
  { t: "sábados e domingos", act: "informativo" },
  { t: "Dia 27 temos feriado", act: "informativo" },
  { t: "27/11 é feriado", act: "informativo" },
  // limites ("até", "depois das")
  { t: "ate amanha!", act: "nenhum" },
  { t: "Até quinta, te espero", act: "nenhum" },
  { t: "Fechado até as 18h", act: "nenhum" },
  { t: "depois das 14h pode vir", act: "nenhum" },
  { t: "a partir das 10h pode vir", act: "nenhum" },
  { t: "pode vir antes das 10h", act: "nenhum" },
  // duração e relativo
  { t: "dura 2h a consulta", act: "nenhum" },
  { t: "volto em 2 horas", act: "nenhum" },
  // negação
  { t: "não, quinta 10h não dá", act: "nenhum" },
  { t: "infelizmente não temos vaga quinta 10h", act: "nenhum" },
  { t: "quinta 10h está lotado", act: "nenhum" },
  { t: "nao confirmado", act: "nenhum" },
  { t: "Não vou cancelar", act: "nenhum" },
  { t: "n posso quinta 10h", act: "nenhum" },
  { t: "Quinta, não rola 😕", act: "nenhum" },
  // condicional e intenção futura
  { t: "se puder, te espero quinta 10h", act: "nenhum" },
  { t: "Confirmado quinta 10h se não chover", act: "nenhum" },
  { t: "talvez quinta 10h", act: "nenhum" },
  { t: "vou confirmar e te aviso", act: "nenhum" },
  { t: "vou ver se consigo quinta 10h", act: "nenhum" },
  { t: "preciso ver a agenda pra quinta 10h", act: "nenhum" },
  { t: "vou confirmar com a equipe e te aviso amanhã", act: "nenhum" },
  { t: "Posso confirmar quinta 10h?", act: "nenhum" },
  { t: "consigo te encaixar quinta 10h", act: "nenhum" },
  // passado
  { t: "Você faltou na quinta passada", act: "nenhum" },
  { t: "ontem foi bom te ver, até quinta", act: "nenhum" },
  { t: "O cliente confirmou presença ontem às 10h", act: "nenhum" },
  { t: "Na terça passada você esteve aqui", act: "nenhum" },
  { t: "tinha marcado quinta 10h", act: "nenhum" },
  // proposta ainda em aberto
  { t: "pode ser quinta 10h", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "que tal sexta 14h?", act: "propos", date: "2026-11-27", time: hm(14) },
  { t: "tenho vaga quinta 10h ou sexta 14h", act: "propos" },
  { t: "quinta ou sexta?", act: "propos" },
  { t: "Confirma pra mim quinta 10h?", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "tem horario quinta 10h", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "Será que dá pra quinta 10h?", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "Vc confirma quinta 10h", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "Combinado amanhã 10h. Pode ser?", act: "propos", date: "2026-11-22", time: hm(10) },
  { t: "Fechado quinta 10h, né?", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "Fechado quinta 10h. Que tal sexta 14h?", act: "nenhum" },
  { t: "Fechado! Mas só consigo quinta 10h", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "Se você quiser, quinta 10h", act: "nenhum" },
  { t: "quinta-feira eu não atendo", act: "nenhum" },
  { t: "Confirmado, mas quinta não", act: "nenhum" },
  { t: "qual dia fica melhor pra você?", act: "nenhum" },
  { t: "que horas você pode?", act: "nenhum" },
  // marca de tempo sem ato
  { t: "quinta 10h", act: "nenhum" },
  { t: "amanhã", act: "nenhum" },
  { t: "às 10h", act: "nenhum" },
  { t: "só tenho segunda 9h", act: "nenhum" },
  { t: "segunda opção: sexta 10h", act: "propos", date: "2026-11-27", time: hm(10) },
  // assunto financeiro e palavras parecidas
  { t: "Confirmo o recebimento do comprovante", act: "nenhum" },
  { t: "pix confirmado", act: "nenhum" },
  { t: "pedido confirmado e enviado", act: "nenhum" },
  { t: "Segunda via do boleto sai amanhã", act: "nenhum" },
  { t: "a segunda parcela vence dia 27", act: "nenhum" },
  { t: "dia dos namorados está chegando", act: "nenhum" },
  // conversa solta
  { t: "bom dia, tudo bem?", act: "nenhum" },
  { t: "ok", act: "nenhum" },
  { t: "beleza 👍", act: "nenhum" },
  { t: "obrigado!", act: "nenhum" },
  { t: "", act: "nenhum" },
  // remarcação e cancelamento (classifica o ato; quem decide é outra camada)
  { t: "Remarcado para sexta 14h", act: "remarcou", date: "2026-11-27", time: hm(14) },
  { t: "Remarcamos pra quinta às 10h", act: "remarcou", date: "2026-11-26", time: hm(10) },
  { t: "reagendei para amanhã 9h", act: "remarcou", date: "2026-11-22", time: hm(9) },
  { t: "vamos remarcar pra quinta 10h?", act: "propos", date: "2026-11-26", time: hm(10) },
  { t: "Cancelado. Qualquer coisa chama", act: "cancelou" },
  { t: "desmarquei seu horário de quinta", act: "cancelou", date: "2026-11-26" },
  { t: "cancelei a consulta de amanhã 10h", act: "cancelou", date: "2026-11-22", time: hm(10) },
];

// ───────── virada de mês/ano, semana e fuso ─────────
const CALENDARIO: Row[] = [
  // quarta 30/12/2026, 09:00
  { t: "fechado sexta 10h", act: "confirmou", date: "2027-01-01", time: hm(10), now: Date.parse("2026-12-30T09:00:00-03:00") },
  { t: "confirmado dia 5 às 14h", act: "confirmou", date: "2027-01-05", time: hm(14), now: Date.parse("2026-12-30T09:00:00-03:00") },
  { t: "Confirmado 03/01 às 9h", act: "confirmou", date: "2027-01-03", time: hm(9), now: Date.parse("2026-12-30T09:00:00-03:00") },
  { t: "fechado amanhã 10h", act: "confirmou", date: "2027-01-01", time: hm(10), now: Date.parse("2026-12-31T09:00:00-03:00") },
  { t: "te espero depois de amanhã 9h", act: "confirmou", date: "2027-01-02", time: hm(9), now: Date.parse("2026-12-31T09:00:00-03:00") },
  // segunda 30/11/2026
  { t: "confirmado dia 2 às 10", act: "confirmou", date: "2026-12-02", time: hm(10), now: Date.parse("2026-11-30T09:00:00-03:00") },
  { t: "confirmado amanhã às 10", act: "confirmou", date: "2026-12-01", time: hm(10), now: Date.parse("2026-11-30T09:00:00-03:00") },
  { t: "confirmado dia 31 10h", act: "confirmou", time: hm(10), now: Date.parse("2026-11-30T09:00:00-03:00") },
  // fevereiro e ano bissexto
  { t: "fechado amanhã 10h", act: "confirmou", date: "2027-02-28", time: hm(10), now: Date.parse("2027-02-27T09:00:00-03:00") },
  { t: "fechado amanhã 10h", act: "confirmou", date: "2028-02-29", time: hm(10), now: Date.parse("2028-02-28T09:00:00-03:00") },
  { t: "fechado depois de amanhã 10h", act: "confirmou", date: "2028-03-01", time: hm(10), now: Date.parse("2028-02-28T09:00:00-03:00") },
  { t: "confirmado dia 30 às 10h", act: "confirmou", time: hm(10), now: Date.parse("2027-01-31T09:00:00-03:00") }, // fevereiro não tem 30
  // segunda 23/11/2026: semana, "que vem" e dia da semana igual ao de hoje
  { t: "pode vir quinta da semana que vem 10h", act: "confirmou", date: "2026-12-03", time: hm(10), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { t: "Confirmado quinta que vem 10h", act: "confirmou", date: "2026-11-26", time: hm(10), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { t: "confirmado segunda que vem 10h", act: "confirmou", date: "2026-11-30", time: hm(10), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { t: "confirmado segunda 10h", act: "confirmou", time: hm(10), now: Date.parse("2026-11-23T09:00:00-03:00") },
  // sexta 20/11/2026
  { t: "te espero sexta que vem 9h", act: "confirmou", date: "2026-11-27", time: hm(9), now: Date.parse("2026-11-20T09:00:00-03:00") },
  // 23h30 em São Paulo (sexta 20/11) já é sábado 21/11 em UTC
  { t: "pode vir amanhã às 10h", act: "confirmou", date: "2026-11-21", time: hm(10), now: Date.parse("2026-11-20T23:30:00-03:00") },
  { t: "pode vir hoje às 23h45", act: "confirmou", date: "2026-11-20", time: hm(23, 45), now: Date.parse("2026-11-20T23:30:00-03:00") },
  { t: "pode vir hoje às 22h", act: "confirmou", date: "2026-11-20", now: Date.parse("2026-11-20T23:30:00-03:00") },
  { t: "fechado depois de amanhã 10h", act: "confirmou", date: "2026-11-22", time: hm(10), now: Date.parse("2026-11-20T23:30:00-03:00") },
  // mesmo instante, fusos diferentes
  { t: "confirmado amanhã 9h", act: "confirmou", date: "2026-11-21", time: hm(9), now: Date.parse("2026-11-21T02:30:00Z"), tz: "America/New_York" },
  { t: "confirmado hoje 14h", act: "confirmou", date: "2026-11-21", time: hm(14), now: Date.parse("2026-11-21T02:30:00Z"), tz: "Asia/Tokyo" },
  { t: "confirmado amanhã 14h", act: "confirmou", date: "2026-11-22", time: hm(14), now: Date.parse("2026-11-21T02:30:00Z"), tz: "Asia/Tokyo" },
  { t: "confirmado amanhã 10h", act: "confirmou", date: "2026-11-23", time: hm(10), now: Date.parse("2026-11-21T19:00:00Z"), tz: "Asia/Kolkata" },
  { t: "confirmado hoje 15h", act: "confirmou", date: "2026-07-01", time: hm(15), now: Date.parse("2026-06-30T23:30:00Z"), tz: "Europe/Lisbon" },
  { t: "confirmado hoje 22h", act: "confirmou", date: "2026-06-30", time: hm(22), now: Date.parse("2026-06-30T23:30:00Z"), tz: "America/Sao_Paulo" },
];

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

  it("confirmação completa só nas positivas e no calendário (nunca nas parciais/negativas)", () => {
    for (const r of [...PARCIAIS, ...NEGATIVAS]) if (run(r).act === "confirmou") expect(run(r).level, r.t).not.toBe("completo");
    for (const r of POSITIVAS) expect(run(r).level, r.t).toBe("completo");
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

  const proposal = { localDate: "2026-11-26", timeMin: hm(10) };

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
    const r = parseConfirmation("fechado", { now: SAT, tz: SP, proposal: { localDate: "2026-11-10", timeMin: hm(10) } });
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
