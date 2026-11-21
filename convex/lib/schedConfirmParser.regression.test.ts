import { describe, expect, it } from "vitest";
import { normalizeConfirmationText, parseConfirmation } from "./schedConfirmParser";

// Tabela de regressão PERMANENTE da revisão adversarial do PR #175 (171 frases escritas pelo revisor,
// não por quem escreveu as regras). Não apague frases para fazer teste passar: corrija o parser.
// Frases adversariais para schedConfirmParser (PR #175). Relógio padrão: sábado 21/11/2026 10:00 America/Sao_Paulo.
// Datas: dom 22, seg 23, ter 24, qua 25, qui 26, sex 27, sáb 28.
// exp "NC" = qualquer coisa exceto "confirmou" (não-confirmação).
// exp objeto = act exato + date/time exatos (undefined = não deve resolver).
export const SAT = Date.parse("2026-11-21T10:00:00-03:00");
export const MON = Date.parse("2026-11-23T09:00:00-03:00");
export const hm = (h: number, m = 0) => h * 60 + m;
export type Exp = "NC" | { act: string; date?: string; time?: number };
export type Case = { t: string; exp: Exp; cat: string; now?: number; tz?: string; proposal?: { localDate?: string; timeMin?: number } };
const C = (act: string, date?: string, time?: number) => ({ act, date, time });
const P = { localDate: "2026-11-26", timeMin: hm(10) }; // proposta aberta: qui 26/11 10:00

export const CASES: Case[] = [
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
  { cat: "d-fuso", t: "confirmado amanhã 9h", exp: C("confirmou", "2027-01-02", hm(9)), now: Date.parse("2027-01-01T00:05:00-03:00") },
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

describe("schedConfirmParser: regressão da revisão adversarial (171 frases)", () => {
  it.each(CASES.map((c) => [`[${c.cat}] ${c.t}${c.proposal ? " (+proposta)" : ""}`, c] as const))("%s", (_n, c) => {
    const r = parseConfirmation(c.t, { now: c.now ?? SAT, tz: c.tz ?? "America/Sao_Paulo", proposal: c.proposal });
    const norm = normalizeConfirmationText(c.t);
    for (const e of [...r.evidence.act, ...r.evidence.date, ...r.evidence.time, ...r.evidence.service, ...r.evidence.blocked]) expect(norm).toContain(e);
    if (c.exp === "NC") expect(r.act, JSON.stringify(r)).not.toBe("confirmou");
    else {
      expect(r.act, JSON.stringify(r)).toBe(c.exp.act);
      expect(r.localDate, JSON.stringify(r)).toBe(c.exp.date);
      expect(r.timeMin, JSON.stringify(r)).toBe(c.exp.time);
    }
  });

  it("nenhuma frase negativa (NC) devolve level completo", () => {
    for (const c of CASES) {
      if (c.exp !== "NC") continue;
      const r = parseConfirmation(c.t, { now: c.now ?? SAT, tz: c.tz ?? "America/Sao_Paulo", proposal: c.proposal });
      expect(r.level, c.t).not.toBe("completo");
    }
  });
});
