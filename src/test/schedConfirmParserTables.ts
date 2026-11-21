// Tabelas de frases do parser de confirmação (schedConfirmParser), compartilhadas pelos testes.
// Fica em src/test/ (fora de convex/) de propósito: o Convex empacota todo .ts de convex/, e um arquivo
// *.test.ts que só exporta dados faria o vitest reclamar de "no test suite". Só dados, sem lógica.
// Relógio padrão das tabelas: sábado 21/11/2026 10:00 em America/Sao_Paulo.

export type PropLite = { localDate?: string; timeMin?: number; by: "cliente" | "ia" | "humano"; at: number };

const SAT = Date.parse("2026-11-21T10:00:00-03:00");
const hm = (h: number, m = 0) => h * 60 + m;

/** Tabela do PR original (203 frases): positivas, parciais, negativas, calendário/fuso. */
export const MAIN = (() => {
type Row = {
  t: string;
  act: "confirmou" | "propos" | "remarcou" | "cancelou" | "informativo" | "nenhum";
  date?: string;
  time?: number;
  now?: number;
  tz?: string;
};

// ───────── positivas: confirmou com dia e hora resolvidos ─────────
const POSITIVAS: Row[] = [
  { t: "Ok confirmado qui 10h", act: "confirmou", date: "2026-11-26", time: hm(10) },
  { t: "Fechado 5ª às 10h", act: "confirmou", date: "2026-11-26", time: hm(10) }, // "Nª" colado a uma hora é dia da semana
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
  { t: "Combinado, te espero amanhã 8h", act: "confirmou", date: "2026-11-22", time: hm(8) },
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
  { t: "Combinado, te espero amanhã 7h", act: "confirmou", date: "2026-11-22" }, // 1h–7h sem período é ambíguo
  { t: "Até quinta, te espero", act: "confirmou", date: "2026-11-26" },
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
  { t: "Fechado quinta 10h. Que tal sexta 14h?", act: "propos", date: "2026-11-27", time: hm(14) },
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
  // "amanhã" entre 00h e 05h locais (00:30 em Kolkata) não resolve o dia
  { t: "confirmado amanhã 10h", act: "confirmou", time: hm(10), now: Date.parse("2026-11-21T19:00:00Z"), tz: "Asia/Kolkata" },
  { t: "confirmado hoje 15h", act: "confirmou", date: "2026-07-01", time: hm(15), now: Date.parse("2026-06-30T23:30:00Z"), tz: "Europe/Lisbon" },
  { t: "confirmado hoje 22h", act: "confirmou", date: "2026-06-30", time: hm(22), now: Date.parse("2026-06-30T23:30:00Z"), tz: "America/Sao_Paulo" },
];


  return { POSITIVAS, PARCIAIS, NEGATIVAS, CALENDARIO };
})();
export type MainRow = (typeof MAIN.POSITIVAS)[number];

/** 171 frases da revisão adversarial rodada 1 (escritas pelo revisor). */
export const ROUND1 = (() => {
  const MON = Date.parse("2026-11-23T09:00:00-03:00");
type Exp = "NC" | { act: string; date?: string; time?: number };
type Case = { t: string; exp: Exp; cat: string; now?: number; tz?: string; proposal?: PropLite };
const C = (act: string, date?: string, time?: number) => ({ act, date, time });
const P: PropLite = { localDate: "2026-11-26", timeMin: hm(10), by: "cliente", at: SAT - 3_600_000 }; // proposta aberta: qui 26/11 10:00

const CASES: Case[] = [
  // ── (a) não-confirmações que citam dia e hora
  { cat: "a-funcionamento", t: "Nosso horário: seg a sex 9h às 18h, sábado até 13h", exp: "NC" },
  { cat: "a-funcionamento", t: "Quinta às 10h estaremos fechados para manutenção", exp: "NC" },
  { cat: "a-funcionamento", t: "Estaremos fechados quinta, reabrimos sexta 10h", exp: "NC" },
  { cat: "a-funcionamento", t: "Quinta 10h fechou com outra cliente", exp: "NC" },
  { cat: "a-funcionamento", t: "Fechado quinta às 10h para balanço", exp: "NC" },
  { cat: "a-promo", t: "Promoção confirmada! Quinta 10h começa a Black Friday", exp: "NC" },
  { cat: "a-promo", t: "Live confirmada quinta 10h no nosso Instagram", exp: "NC" },
  { cat: "a-promo", t: "Desconto garantido quinta 10h, só pros primeiros", exp: "NC" },
  { cat: "a-promo", t: "Black Friday: quinta 10h tem 30% off em tudo", exp: "NC" },
  { cat: "a-pix", t: "Lembrando que o Pix vence quinta 10h", exp: "NC" },
  { cat: "a-pix", t: "Confirmado o pagamento, quinta 10h te aviso do horário", exp: "NC" },
  { cat: "a-pix", t: "Quinta 10h está pré-agendado, só confirmo depois do sinal", exp: "NC" },
  { cat: "a-pix", t: "Pré-reservado quinta 10h, aguardo o sinal pra confirmar", exp: "NC" },
  { cat: "a-pix", t: "Só confirmo quinta 10h com o sinal de 50%", exp: "NC" },
  { cat: "a-entrega", t: "Sua encomenda está confirmada pra quinta 10h", exp: "NC" },
  { cat: "a-entrega", t: "Pode vir buscar o carro quinta 10h", exp: "NC" },
  { cat: "a-entrega", t: "Pode passar pra retirar quinta 10h", exp: "NC" },
  { cat: "a-entrega", t: "O motoboy chega quinta 10h", exp: "NC" },
  { cat: "a-terceiro", t: "O doutor chega quinta 10h", exp: "NC" },
  { cat: "a-terceiro", t: "Minha reunião é quinta 10h", exp: "NC" },
  { cat: "a-terceiro", t: "Minha reunião foi marcada pra quinta 10h, então não consigo", exp: "NC" },
  { cat: "a-terceiro", t: "Tenho dentista marcado quinta 10h, então quinta não atendo", exp: "NC" },
  { cat: "a-terceiro", t: "Quinta 10h já tenho cliente marcado", exp: "NC" },
  { cat: "a-terceiro", t: "Quinta 10h já está agendado com outra cliente", exp: "NC" },
  { cat: "a-terceiro", t: "Esse horário de quinta 10h já foi reservado por outra pessoa", exp: "NC" },
  { cat: "a-terceiro", t: "Quinta 10h já tá reservado", exp: "NC" },
  { cat: "a-terceiro", t: "Seu irmão confirmou quinta 10h", exp: "NC" },
  { cat: "a-terceiro", t: "O Dr. João confirmou que chega quinta 10h", exp: "NC" },
  { cat: "a-terceiro", t: "O técnico confirmou que vem quinta 10h", exp: "NC" },
  { cat: "a-terceiro", t: "A Maria marcou quinta 10h, você quer sexta?", exp: "NC" },
  { cat: "a-terceiro", t: "Meu marido agendou o carro dele quinta 10h", exp: "NC" },
  { cat: "a-citacao", t: "vc escreveu \"confirmado quinta 10h\" mas eu tinha anotado sexta", exp: "NC" },
  { cat: "a-citacao", t: "Você disse confirmado quinta 10h né", exp: "NC" },
  { cat: "a-citacao", t: "A cliente mandou: confirmado quinta 10h", exp: "NC" },
  { cat: "a-lista", t: "tenho quinta 10h ou sexta 14h", exp: "NC" },
  { cat: "a-lista", t: "Horários livres: quinta 10h, sexta 14h", exp: "NC" },
  { cat: "a-lista", t: "Agenda da semana: quinta 10h confirmado, sexta 14h livre", exp: "NC" },
  { cat: "a-lista", t: "Quinta 10h ocupado, sexta 14h ocupado, sábado 9h aberto", exp: "NC" },
  { cat: "a-cancel", t: "Cancelado o de quinta, remarcado pra sexta 14h", exp: C("remarcou", "2026-11-27", hm(14)) },
  { cat: "a-cancel", t: "Desmarquei quinta 10h. Me avisa outro dia", exp: C("cancelou", "2026-11-26", hm(10)) },
  { cat: "a-ironia", t: "Confirmado quinta 10h, só que não", exp: "NC" },
  { cat: "a-ironia", t: "Confirmado quinta 10h sqn", exp: "NC" },
  { cat: "a-negdist", t: "confirmado não está, quinta 10h ainda preciso ver", exp: "NC" },
  { cat: "a-negdist", t: "Quinta 10h? Confirmado ainda não", exp: "NC" },
  { cat: "a-negdist", t: "Confirmado quinta 10h nada, a Dra. viajou", exp: "NC" },
  { cat: "a-futuro", t: "Te confirmo amanhã às 10h", exp: "NC" },
  { cat: "a-futuro", t: "Amanhã te confirmo quinta 10h", exp: "NC" },
  { cat: "a-futuro", t: "Anotei quinta 10h, já já te confirmo", exp: "NC" },
  { cat: "a-futuro", t: "Anotado quinta 10h, vou confirmar com a Dra.", exp: "NC" },
  { cat: "a-futuro", t: "Anotado, quinta 10h. Te confirmo em breve", exp: "NC" },
  { cat: "a-futuro", t: "Eu confirmo quinta 10h depois que você mandar o comprovante", exp: "NC" },
  { cat: "a-longa", t: "Oi! Então, quinta 10h eu tenho a Ana, sexta 14h o Pedro e sábado 9h tá livre. Me fala qual prefere", exp: "NC" },
  { cat: "a-semana", t: "Confirmado sexta 10h. Semana que vem a gente vê o resto", exp: C("confirmou", "2026-11-27", hm(10)) },
  { cat: "a-semana", t: "Fechado quinta 10h, próxima semana tem promoção", exp: C("confirmou", "2026-11-26", hm(10)) },

  // ── proposta aberta (qui 26/11 10h) + resposta curta que NÃO é confirmação
  { cat: "a-proposta", t: "Ok, mas quinta não dá", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Ok, não vai dar", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Certo, vou verificar a agenda e te retorno", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Ok, só um minuto que vou olhar a agenda", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Show, deixa eu ver aqui", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Beleza, já te respondo", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Sim, infelizmente esse horário tá ocupado", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Ok. Isso não vai rolar", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Já te confirmo", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Te confirmo daqui a pouco", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "tá bom, deixa pra próxima", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Certo, a Dra. está de férias", exp: "NC", proposal: P },

  // ── (b) confirmações verdadeiras em formas difíceis
  { cat: "b-forma", t: "CONFIRMADO QUINTA AS 10H", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "confirmado quinta as 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "✅ Confirmado! Quinta 🕙 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Fechou! Quinta 10h então", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "tá marcado quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Pode vir quinta às 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Te aguardo quinta 10h 😘", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Combinadíssimo, quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmadíssimo quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado dia vinte e seis às 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "b-forma", t: "Confirmado 26 de novembro às 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado amanhã cedo", exp: C("confirmou", "2026-11-22") },
  { cat: "b-forma", t: "Confirmado amanhã de manhã", exp: C("confirmou", "2026-11-22") },
  { cat: "b-forma", t: "confirmado hj as 15h", exp: C("confirmou", "2026-11-21", hm(15)) },
  { cat: "b-forma", t: "fechado amanha as 9", exp: C("confirmou", "2026-11-22", hm(9)) },
  { cat: "b-forma", t: "Confirmado amanhã meio dia e meia", exp: C("confirmou", "2026-11-22", hm(12, 30)) },
  { cat: "b-forma", t: "Confirmado amanhã às 9 e meia", exp: C("confirmou", "2026-11-22", hm(9, 30)) },
  { cat: "b-forma", t: "Confirmado amanhã 9 e meia", exp: C("confirmou", "2026-11-22", hm(9, 30)) },
  { cat: "b-forma", t: "Confirmado amanhã às 15", exp: C("confirmou", "2026-11-22", hm(15)) },
  { cat: "b-forma", t: "Confirmado amanhã 3 da tarde", exp: C("confirmou", "2026-11-22", hm(15)) },
  { cat: "b-forma", t: "Confirmado amanhã 19h", exp: C("confirmou", "2026-11-22", hm(19)) },
  { cat: "b-forma", t: "Confirmado amanhã 7 da noite", exp: C("confirmou", "2026-11-22", hm(19)) },
  { cat: "b-forma", t: "Ok, confirmado. Até quinta às 10h!", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta, 10 horas", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta das 10h às 11h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta 10h-11h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta 10h. Cancelamentos só com 24h de antecedência", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta 10h sem atraso hein", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta 10h, não precisa jejum", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Agendadinho quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado com o Domingos amanhã 10h", exp: C("confirmou", "2026-11-22", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta-feira (26/11) às 10:00", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "Confirmado sexta, não quinta, às 10h", exp: C("confirmou", "2026-11-27", hm(10)) },
  { cat: "b-forma", t: "Hoje não, amanhã 10h confirmado", exp: C("confirmou", "2026-11-22", hm(10)) },
  { cat: "b-forma", t: "Confirmado quinta às dez e meia", exp: C("confirmou", "2026-11-26", hm(10, 30)) },
  { cat: "b-forma", t: "Te vejo quinta às 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "b-forma", t: "👍", exp: C("confirmou", "2026-11-26", hm(10)), proposal: P },
  { cat: "b-forma", t: "Combinado", exp: C("confirmou", "2026-11-26", hm(10)), proposal: P },
  { cat: "b-virada", t: "confirmado dia 2 às 10h", exp: C("confirmou", "2026-12-02", hm(10)), now: Date.parse("2026-11-30T09:00:00-03:00") },
  { cat: "b-virada", t: "confirmado 2/1 às 10h", exp: C("confirmou", "2027-01-02", hm(10)), now: Date.parse("2026-12-30T09:00:00-03:00") },
  { cat: "b-virada", t: "fechado sábado 10h", exp: C("confirmou", "2027-01-02", hm(10)), now: Date.parse("2026-12-30T09:00:00-03:00") },
  { cat: "b-virada", t: "confirmado 01/01/2027 às 10h", exp: C("confirmou", "2027-01-01", hm(10)), now: Date.parse("2026-12-30T09:00:00-03:00") },

  // ── (c) horas e datas traiçoeiras
  { cat: "c-num", t: "Confirmado quinta, valor R$ 150", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta, sala 3", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta pra 2 pessoas", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta, chegue 10 minutos antes", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta, 30% de desconto", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta, qualquer coisa liga 11 98765-4321", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta, CEP 01310-100", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Confirmado quinta 10h, pode parcelar em 10x sem juros", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-num", t: "Confirmado quinta, desmarcar só com 24h antes", exp: C("confirmou", "2026-11-26") },
  // AJUSTE (decidido no PR): hoje (sáb 21/11) já é sábado; "sábado" sem "que vem" é ambíguo (hoje ou +7), igual ao c-hoje abaixo, que o revisor esperava sem data.
  { cat: "c-num", t: "Confirmado sábado pras 8 madrinhas", exp: C("confirmou") },
  { cat: "c-num", t: "Confirmado quinta pras 10 convidadas", exp: C("confirmou", "2026-11-26") },
  { cat: "c-num", t: "Te espero quinta com as 2 crianças", exp: C("confirmou", "2026-11-26") },
  { cat: "c-faixa", t: "Confirmado quinta, chega até as 10h", exp: C("confirmou", "2026-11-26") },
  { cat: "c-faixa", t: "Confirmado quinta depois das 14", exp: C("confirmou", "2026-11-26") },
  { cat: "c-faixa", t: "Confirmado quinta 10h, depois das 14 não consigo", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-2datas", t: "Confirmado quinta 10h e sexta 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-2datas", t: "Confirmado 26/11, retorno 10/12, às 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-hoje", t: "Confirmado sábado 15h", exp: C("confirmou", undefined, hm(15)) },
  { cat: "c-invalida", t: "Confirmado 31/02 às 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-invalida", t: "Confirmado 30/11/2026 às 25h", exp: C("confirmou", "2026-11-30") },
  { cat: "c-passado", t: "Confirmado hoje às 9h", exp: C("confirmou", "2026-11-21") },
  { cat: "c-ordinal", t: "Confirmada a segunda dose às 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-ordinal", t: "Confirmado sua segunda aplicação de botox às 15h", exp: C("confirmou", undefined, hm(15)) },
  { cat: "c-ordinal", t: "Confirmada sua 2ª sessão às 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-ordinal", t: "Confirmada 2ª dose às 14h", exp: C("confirmou", undefined, hm(14)) },
  { cat: "c-ordinal", t: "Te espero às 15h no 4º andar", exp: C("confirmou", undefined, hm(15)) },
  { cat: "c-ordinal", t: "Te espero às 10h, 2º andar sala 21", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-ordinal", t: "Segunda sessão confirmada quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-ordinal", t: "Confirmada sua sexta sessão às 10h", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-ordinal", t: "Confirmado quinta 10h, sexta-feira santa não abrimos", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-ordinal", t: "Confirmado quinta 10h, é a quarta parcela", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-ordinal", t: "Confirmado sabado 28/11 10h", exp: C("confirmou", "2026-11-28", hm(10)) },
  { cat: "c-endereco", t: "Te espero às 15h na Rua 13 de Maio, 500", exp: C("confirmou", undefined, hm(15)) },
  { cat: "c-endereco", t: "Confirmado às 10h, loja da 25 de Março", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-endereco", t: "Confirmado às 10h, Av. 9 de Julho 1200", exp: C("confirmou", undefined, hm(10)) },
  { cat: "c-endereco", t: "Confirmado amanhã 10h na Rua 7 de Setembro", exp: C("confirmou", "2026-11-22", hm(10)) },
  { cat: "c-nome", t: "Confirmado quinta 10h com a Dra. Quintana", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-nome", t: "Confirmado com a Dona Domingas quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-nome", t: "Confirmado quinta 10h com o Sabatini", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-ambig", t: "Te espero às 7", exp: C("confirmou") },
  { cat: "c-ambig", t: "Mesa confirmada pra hoje às 8", exp: C("confirmou", "2026-11-21") },
  { cat: "c-ambig", t: "Confirmado quinta 12h", exp: C("confirmou", "2026-11-26", hm(12)) },
  { cat: "c-ambig", t: "Confirmado quinta meia-noite", exp: C("confirmou", "2026-11-26") },
  { cat: "c-ambig", t: "Confirmado 26.11 às 10h", exp: C("confirmou", "2026-11-26", hm(10)) },
  { cat: "c-ambig", t: "Confirmado quinta 10.30", exp: C("confirmou", "2026-11-26", hm(10, 30)) },

  // ── (d) fuso
  { cat: "d-fuso", t: "pode vir amanhã às 10h", exp: C("confirmou", "2026-11-22", hm(10)), now: Date.parse("2026-11-21T23:50:00-03:00") },
  { cat: "d-fuso", t: "pode vir hoje às 23h55", exp: C("confirmou", "2026-11-21", hm(23, 55)), now: Date.parse("2026-11-21T23:50:00-03:00") },
  { cat: "d-fuso", t: "pode vir amanhã às 10h", exp: C("confirmou", "2026-11-22", hm(10)), now: Date.parse("2026-11-21T23:30:00-04:00"), tz: "America/Manaus" },
  { cat: "d-fuso", t: "confirmado hoje 15h", exp: C("confirmou", "2026-11-22", hm(15)), now: Date.parse("2026-11-22T01:30:00-02:00"), tz: "America/Noronha" },
  { cat: "d-fuso", t: "confirmado amanhã 9h", exp: C("confirmou", "2027-01-01", hm(9)), now: Date.parse("2026-12-31T23:55:00-03:00") },
  // AJUSTE (decisão da rodada 2, item 3): "amanhã" enviado entre 00h e 05h locais não resolve o dia.
  { cat: "d-fuso", t: "confirmado amanhã 9h", exp: C("confirmou", undefined, hm(9)), now: Date.parse("2027-01-01T00:05:00-03:00") },
  { cat: "d-fuso", t: "confirmado hoje 22h", exp: C("confirmou", "2026-12-31", hm(22)), now: Date.parse("2027-01-01T00:30:00Z") },
  { cat: "d-fuso", t: "confirmado quinta 10h", exp: C("confirmou", "2026-11-26", hm(10)), now: Date.parse("2026-11-21T10:00:00Z"), tz: "Asia/Tokyo" },
  { cat: "d-fuso", t: "confirmado amanhã 10h", exp: C("confirmou", "2026-11-02", hm(10)), now: Date.parse("2026-11-01T12:00:00-05:00"), tz: "America/New_York" },
  { cat: "d-fuso", t: "confirmado amanhã 10h", exp: C("confirmou", "2026-11-22", hm(10)), tz: "UTC" },
  // ── "semana que vem" de OUTRO trecho contamina o dia da semana (relógio: segunda 23/11 09:00)
  { cat: "a-semana", t: "Confirmado sexta 10h. Semana que vem a gente vê o resto", exp: C("confirmou", "2026-11-27", hm(10)), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { cat: "a-semana", t: "Fechado quinta 10h, próxima semana tem promoção", exp: C("confirmou", "2026-11-26", hm(10)), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { cat: "a-semana", t: "Te espero quarta 15h. Semana que vem eu tô de férias", exp: C("confirmou", "2026-11-25", hm(15)), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { cat: "a-semana", t: "Confirmado quinta 10h, a avaliação fica pra semana que vem", exp: C("confirmou", "2026-11-26", hm(10)), now: Date.parse("2026-11-23T09:00:00-03:00") },
  { cat: "a-proposta", t: "Ok, obrigado pelo aviso", exp: "NC", proposal: P },
  { cat: "a-proposta", t: "Beleza, a Dra. vai te ligar", exp: "NC", proposal: P },
  { cat: "a-funcionamento", t: "Agenda de quinta 10h fechada", exp: "NC" },
  { cat: "a-terceiro", t: "O horário da sua mãe tá confirmado quinta 10h", exp: "NC" },
];


  void MON;
  return CASES;
})();

/** 100 frases próprias (classes não cobertas pela rodada 1). */
export const OWN100 = (() => {
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


  return ROWS;
})();

/** 184 frases da rodada 2 (cls "txt": o texto denuncia; cls "ctx": só o contexto mostra que não é confirmação). */
export const ROUND2 = (() => {
const CLK = {
  SAT: Date.parse("2026-11-21T10:00:00-03:00"), // sáb 21/11
  FRI: Date.parse("2026-11-27T22:30:00-03:00"), // sex 27/11 à noite
  SUN: Date.parse("2026-11-29T15:00:00-03:00"), // dom 29/11
  WED: Date.parse("2026-12-30T09:00:00-03:00"), // qua 30/12
  MON: Date.parse("2026-11-23T08:00:00-03:00"), // seg 23/11
  FEB: Date.parse("2028-02-28T18:00:00-03:00"), // seg 28/02/2028 (bissexto)
};

type Exp = "NOCOMP" | { act: string; date?: string; time?: number };
type Case = { t: string; exp: Exp; cat: string; cls?: "txt" | "ctx"; ctx?: string; now?: number; tz?: string; proposal?: PropLite };
const C = (act: string, date?: string, time?: number) => ({ act, date, time });
const K = (date?: string, time?: number) => C("confirmou", date, time);
const P: PropLite = { localDate: "2026-11-26", timeMin: hm(10), by: "cliente", at: CLK.SAT - 3_600_000 };
const N = (t: string, cls: "txt" | "ctx", ctx?: string, extra: Partial<Case> = {}): Case => ({ t, exp: "NOCOMP", cat: "a", cls, ctx, ...extra });

const CASES: Case[] = [
  // ───── (a) não-confirmações que tentam caber na forma fechada (relógio SAT)
  N("Confirmado quinta 10h 👎", "txt"),
  N("Agendado quinta 10h ❌", "txt"),
  N("Confirmado quinta 10h 🚫", "txt"),
  N("Confirmado quinta 10h 🙅‍♀️", "txt"),
  N("Confirmado quinta 10h ❓", "txt"),
  N("Confirmado quinta 10h ❔", "txt"),
  N("Confirmado quinta 10h ⁉️", "txt"),
  N("Confirmado quinta 10h 🤔", "txt"),
  N("Confirmado quinta 10h 🤷‍♀️", "txt"),
  N("Confirmado quinta 10h 🤡", "txt"),
  N("Confirmado quinta 10h 🙄", "txt"),
  N("Confirmado quinta 10h 🙃", "txt"),
  N("Agendado quinta 10h ✖️", "txt"),
  N("Confirmado quinta 10h ⛔", "txt"),
  N("Confirmado quinta 10h por favor", "txt"),
  N("Agendado pra quinta 10h por favor", "txt"),
  N("Reservado quinta 10h por favor", "txt"),
  N("Confirmado quinta 10h nã", "txt"),
  N("Te espero até quinta 10h", "txt"),
  N("Te aguardo até amanhã 10h", "txt"),
  N("Confirmado quinta 10h, tá", "txt"),
  N("Confirmado quinta 10h, certo", "txt"),
  N("Confirmado quinta 10h... tô brincando", "txt"),
  N("Confirmado quinta 10h kkkkk", "txt"),
  N("Agendado quinta 10h, só que nunca", "txt"),
  N("Reembolso agendado quinta 10h", "txt"),
  N("Estorno agendado pra quinta 10h", "txt"),
  N("Recibo confirmado quinta 10h", "txt"),
  N("Frete agendado quinta 10h", "txt"),
  N("Coleta agendada quinta 10h", "txt"),
  N("Mudança confirmada quinta 10h", "txt"),
  N("Confirma quinta 10h", "txt"),
  N("Confirme quinta 10h por gentileza", "txt"),
  N("Confirmar quinta 10h", "txt"),
  N("Marca quinta 10h pra mim", "txt"),
  N("Agenda quinta 10h", "txt"),
  N("Lembrando: quinta 10h", "txt"),
  N("Lembrete: agendado quinta 10h", "txt"),
  N("Ausente até quinta 10h", "txt"),
  N("Estou fora, retorno quinta 10h", "txt"),
  N("Confirmado quinta 10h cancelado", "txt"),
  N("Confirmado. Quinta 10h não", "txt"),
  N("Confirmado quinta 10h ou sexta 14h", "txt"),
  N("Confirmado quinta 10h nn", "txt"),
  N("Confirmado quinta 10h #sqn", "txt"),
  N("Confirmado quinta 10h???", "txt"),
  N("Pode vir quinta 10h pegar", "txt"),
  N("Te vejo quinta 10h na reunião do condomínio", "txt"),
  N("Confirmado quinta 10h e sexta 10h", "txt"),
  N("Confirmado amanhã e depois 10h", "txt"),
  // contexto: o texto sozinho é uma confirmação perfeita
  N("Agendado pra quinta 10h", "ctx", "resposta a 'quando chega meu pedido?'"),
  N("Confirmada quinta 10h", "ctx", "a entrega dos móveis"),
  N("Marcado pra quinta 10h", "ctx", "dono para o contador dele"),
  N("Combinado amanhã 20h", "ctx", "jantar com amigo no número comercial"),
  N("Te vejo sábado 20h", "ctx", "amigo"),
  N("Te espero amanhã 8h", "ctx", "dono para funcionária: turno"),
  N("Pode vir amanhã 8h", "ctx", "pedreiro/diarista"),
  N("Reservado sábado 20h", "ctx", "dono reservando mesa num restaurante"),
  N("Garantido sábado 15h", "ctx", "fornecedor da festa"),
  N("Confirmado quinta 10h", "ctx", "pergunta sem '?': dono pedindo que o cliente confirme"),
  N("Tá confirmado quinta 10h", "ctx", "pergunta sem '?'"),
  N("Ficou marcado quinta 10h", "ctx", "pergunta sem '?'"),
  N("Oi, confirmado quinta 10h", "ctx", "pergunta sem '?'"),
  N("Confirmado quinta 10h", "ctx", "colada da conversa de OUTRO cliente"),
  N("Marcado quinta 10h", "ctx", "encaminhada sem marca visível"),
  N("Anotado quinta 10h", "ctx", "anotou o pedido; vai ver com a profissional"),
  N("Fechado amanhã 10h", "ctx", "aviso curto: loja fechada amanhã"),
  N("Agendado quinta 10h", "ctx", "resposta a 'quando vem o técnico da operadora?'"),
  N("Combinado sábado 9h", "ctx", "vistoria do proprietário do imóvel"),
  N("Confirmado amanhã 14h", "ctx", "fornecedor entregando mercadoria"),
  N("Ok, marcado amanhã 9h", "ctx", "retirada do carro na oficina"),
  N("Marcada quinta 10h", "ctx", "reunião de pais da escola do filho do dono"),
  N("Confirmado sexta 19h", "ctx", "dono confirmando presença em evento de outra pessoa"),
  N("Te espero quinta 10h", "ctx", "convite para inauguração, não atendimento"),
  N("Agendado quinta 10h", "ctx", "dono informando a escala ao funcionário"),
  N("Reservado quinta 10h", "ctx", "resposta a 'tem quinta 10h?': já reservado por outra pessoa"),
  N("Marcado amanhã 11h", "ctx", "lembrete em massa de agendamento que já existe"),
  N("Confirmado quinta 10h", "ctx", "confirmando o CANCELAMENTO pedido pelo cliente"),
  N("Agendado sexta 14h", "ctx", "resposta automática de chatbot de terceiro"),
  N("Combinado quinta 10h", "ctx", "ligação/call comercial, não atendimento"),
  N("Te espero quinta 10h", "ctx", "para a fisioterapeuta parceira"),
  N("Pode passar quinta 10h", "ctx", "retirada de encomenda"),
  N("Pode vir sexta 9h", "ctx", "entregador"),
  N("Agendado amanhã 9h", "ctx", "consulta do próprio dono, respondendo à secretária dele"),
  N("Fechado quinta 10h", "ctx", "orçamento fechado, entrega quinta 10h"),
  N("Confirmado amanhã 10h", "ctx", "contato é fornecedor"),
  N("Ok, obrigado", "ctx", "proposta qui 10h aberta, mas o cliente RECUSOU antes", { proposal: P }),
  N("Ok", "ctx", "proposta aberta; cliente pediu outro horário", { proposal: P }),
  N("Beleza 👍", "ctx", "proposta aberta; cliente disse que vai ver e avisa", { proposal: P }),
  N("Ok, tchau", "ctx", "proposta aberta; conversa encerrada sem aceite", { proposal: P }),
  N("Sim", "ctx", "proposta aberta; respondendo 'vocês abrem sábado?'", { proposal: P }),

  // ───── (b) confirmações verdadeiras curtas
  { cat: "b", t: "Confirmadinho pra quinta às 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "b", t: "Agendado ✅ terça 16h", exp: K("2026-11-24", hm(16)) },
  { cat: "b", t: "Tá agendado, segunda às 9h30", exp: K("2026-11-23", hm(9, 30)) },
  { cat: "b", t: "Marcadíssimo amanhã 11h", exp: K("2026-11-22", hm(11)) },
  { cat: "b", t: "Reservado pra você domingo 10h", exp: K("2026-11-22", hm(10)) },
  { cat: "b", t: "Combinado! Sábado que vem 9h", exp: K("2026-11-28", hm(9)) },
  { cat: "b", t: "Bom dia! Confirmado sexta às 14h. Obrigada", exp: K("2026-11-27", hm(14)) },
  { cat: "b", t: "Fechado, quarta às 19h", exp: K("2026-11-25", hm(19)) },
  { cat: "b", t: "Te espero terça 10h30 😊", exp: K("2026-11-24", hm(10, 30)) },
  { cat: "b", t: "Pode vir amanhã às onze", exp: K("2026-11-22", hm(11)) },
  { cat: "b", t: "Confirmado dia 30 às 15h", exp: K("2026-11-30", hm(15)) },
  { cat: "b", t: "Agendada sua avaliação quinta 9h", exp: K("2026-11-26", hm(9)) },
  { cat: "b", t: "ok, marcado 4ª 8h30", exp: K("2026-11-25", hm(8, 30)) },
  { cat: "b", t: "Confirmado: quinta (26) às 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "b", t: "Combinado pra amanhã meio-dia", exp: K("2026-11-22", hm(12)) },
  { cat: "b", t: "Tudo certo, agendado segunda 14h", exp: K("2026-11-23", hm(14)) },
  { cat: "b", t: "Ok, fechado", exp: K("2026-11-26", hm(10)), proposal: P },
  { cat: "b", t: "Confirmado amanhã 9h", exp: K("2026-11-28", hm(9)), now: CLK.FRI },
  { cat: "b", t: "Te espero segunda às 8h", exp: K("2026-11-30", hm(8)), now: CLK.FRI },
  { cat: "b", t: "Agendado terça dia 1º às 10h", exp: K("2026-12-01", hm(10)), now: CLK.FRI },
  { cat: "b", t: "Marcado quinta 3/12 às 15h", exp: K("2026-12-03", hm(15)), now: CLK.FRI },
  { cat: "b", t: "Pode vir domingo 10h", exp: K("2026-11-29", hm(10)), now: CLK.FRI },
  { cat: "b", t: "Fechado sexta 10h", exp: K(undefined, hm(10)), now: CLK.FRI },
  { cat: "b", t: "Confirmado sexta que vem 10h", exp: K("2026-12-04", hm(10)), now: CLK.FRI },
  { cat: "b", t: "Confirmado hoje 23h", exp: K("2026-11-27", hm(23)), now: CLK.FRI },
  { cat: "b", t: "Confirmado hoje 22h", exp: K("2026-11-27"), now: CLK.FRI },
  { cat: "b", t: "Confirmado amanhã 8h", exp: K("2026-11-30", hm(8)), now: CLK.SUN },
  { cat: "b", t: "Agendado terça 1/12 às 9h", exp: K("2026-12-01", hm(9)), now: CLK.SUN },
  { cat: "b", t: "Te aguardo quarta às 17h", exp: K("2026-12-02", hm(17)), now: CLK.SUN },
  { cat: "b", t: "Combinado domingo 10h", exp: K(undefined, hm(10)), now: CLK.SUN },
  { cat: "b", t: "Confirmado hoje às 18h", exp: K("2026-11-29", hm(18)), now: CLK.SUN },
  { cat: "b", t: "Marcado dia 2 às 14h", exp: K("2026-12-02", hm(14)), now: CLK.SUN },
  { cat: "b", t: "Confirmado próxima sexta 16h", exp: K("2026-12-04", hm(16)), now: CLK.SUN },
  { cat: "b", t: "Confirmado sexta da semana que vem 16h", exp: K("2026-12-04", hm(16)), now: CLK.SUN },
  { cat: "b", t: "Confirmado sexta 10h", exp: K("2027-01-01", hm(10)), now: CLK.WED },
  { cat: "b", t: "Agendado dia 4 às 9h", exp: K("2027-01-04", hm(9)), now: CLK.WED },
  { cat: "b", t: "Te espero 05/01 às 14h", exp: K("2027-01-05", hm(14)), now: CLK.WED },
  { cat: "b", t: "Combinado amanhã 16h", exp: K("2026-12-31", hm(16)), now: CLK.WED },
  { cat: "b", t: "Confirmado segunda 4/1 às 10h", exp: K("2027-01-04", hm(10)), now: CLK.WED },
  { cat: "b", t: "Fechado dia 2 de janeiro às 11h", exp: K("2027-01-02", hm(11)), now: CLK.WED },
  { cat: "b", t: "Confirmado hoje 9h", exp: K("2026-12-30"), now: CLK.WED },
  { cat: "b", t: "Confirmado hoje 8h30", exp: K("2026-11-23", hm(8, 30)), now: CLK.MON },
  { cat: "b", t: "Agendado amanhã às 10 da manhã", exp: K("2026-11-24", hm(10)), now: CLK.MON },
  { cat: "b", t: "Combinado quinta 7 da noite", exp: K("2026-11-26", hm(19)), now: CLK.MON },
  { cat: "b", t: "Confirmado sábado 9 e meia", exp: K("2026-11-28", hm(9, 30)), now: CLK.MON },
  { cat: "b", t: "Te espero domingo às 11", exp: K("2026-11-29", hm(11)), now: CLK.MON },
  { cat: "b", t: "Confirmado amanhã 10h", exp: K("2028-02-29", hm(10)), now: CLK.FEB },
  { cat: "b", t: "Agendado 01/03 às 9h", exp: K("2028-03-01", hm(9)), now: CLK.FEB },

  // ───── (c) bordas de data/hora dentro da forma fechada (SAT salvo indicação)
  { cat: "c", t: "Confirmado quinta 10:60", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado quinta 25h", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado 31/11 às 10h", exp: K(undefined, hm(10)) },
  { cat: "c", t: "Confirmado 29/02 às 10h", exp: K(undefined, hm(10)) },
  { cat: "c", t: "Confirmado 20/11 às 10h", exp: K(undefined, hm(10)) },
  { cat: "c", t: "Confirmado quinta 27/11 10h", exp: K(undefined, hm(10)) },
  { cat: "c", t: "Confirmado dia 26 quinta às 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado quinta às 7", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado quinta 00h", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado quinta 12h", exp: K("2026-11-26", hm(12)) },
  { cat: "c", t: "Confirmado quinta meia noite", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado quinta 12 da noite", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado quinta 10 da noite", exp: K("2026-11-26", hm(22)) },
  { cat: "c", t: "Confirmado quinta 6 da tarde", exp: K("2026-11-26", hm(18)) },
  { cat: "c", t: "Confirmado quinta 1 da tarde", exp: K("2026-11-26", hm(13)) },
  { cat: "c", t: "Confirmado quinta 13h", exp: K("2026-11-26", hm(13)) },
  { cat: "c", t: "Confirmado quinta 8 horas", exp: K("2026-11-26", hm(8)) },
  { cat: "c", t: "Confirmado quinta 10h15", exp: K("2026-11-26", hm(10, 15)) },
  { cat: "c", t: "Confirmado quinta 10h e 10h30", exp: K("2026-11-26") },
  { cat: "c", t: "Confirmado hoje 10h", exp: K("2026-11-21") },
  { cat: "c", t: "Confirmado hoje 10h01", exp: K("2026-11-21", hm(10, 1)) },
  { cat: "c", t: "Confirmado sábado 28/11 10h", exp: K("2026-11-28", hm(10)) },
  { cat: "c", t: "Confirmado sábado 10h", exp: K(undefined, hm(10)) },
  { cat: "c", t: "Confirmado 26/11/2026 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado 26/11/26 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado 26-11 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado quinta 10hs", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado quinta às 10 h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "CONFIRMADO QUINTA 10H", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado 26 de nov às 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado 26 nov 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado qui 26/11 10h", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado quinta 10h da manhã", exp: K("2026-11-26", hm(10)) },
  { cat: "c", t: "Confirmado quinta 10 e meia", exp: K("2026-11-26", hm(10, 30)) },
  { cat: "c", t: "Confirmado quinta às 22", exp: K("2026-11-26", hm(22)) },
  { cat: "c", t: "Confirmado amanhã cedinho 8h", exp: K("2026-11-22", hm(8)) },
  { cat: "c", t: "Confirmado depois de amanhã 9h", exp: K("2026-11-23", hm(9)) },
  { cat: "c", t: "Confirmado 2ª feira 9h", exp: K("2026-11-23", hm(9)) },
  { cat: "c", t: "Confirmado 15/09 às 10h", exp: K(undefined, hm(10)) },
  // AJUSTE (decisão da rodada 2, item 3): "dia 20" no dia 21 resolve para o mês seguinte, com aviso, e nunca é completo.
  { cat: "c", t: "Confirmado dia 20 às 10h", exp: K("2026-12-20", hm(10)) },
  { cat: "c", t: "Confirmado amanhã 10h", exp: K("2026-11-22", hm(10)), now: Date.parse("2026-11-21T13:00:00Z"), tz: "Asia/Tokyo" },
  { cat: "c", t: "Confirmado amanhã 10h", exp: K("2026-11-23", hm(10)), now: Date.parse("2026-11-22T02:30:00Z"), tz: "Asia/Tokyo" },
  { cat: "c", t: "Confirmado amanhã 10h", exp: K("2026-11-22", hm(10)), now: Date.parse("2026-11-22T02:30:00Z"), tz: "America/Los_Angeles" },
  // AJUSTE (decisão da rodada 2, item 3): "amanhã" entre 00h e 05h locais não resolve o dia.
  { cat: "c", t: "Confirmado amanhã 10h", exp: K(undefined, hm(10)), now: Date.parse("2026-11-22T00:20:00-03:00") },
  { cat: "c", t: "Confirmado sábado que vem 10h", exp: K(undefined, hm(10)), now: CLK.FRI },
];

  return { CASES, CLK };
})();

export { SAT, hm };
