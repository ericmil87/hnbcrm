/**
 * Corpus NOVO do juiz de afirmação (D3): 60 frases escritas ANTES de afinar o prompt (30 indevidas + 30 legítimas), variadas de
 * propósito (gíria, sem acento, emoji, hora por extenso, duas orações, pergunta retórica, remarcar/cancelar/presença/repasse,
 * profissional), cada uma com o ESTADO real que a torna indevida ou legítima. Hoje no corpus = sábado 21/11/2026 (`CORPUS_NOW`).
 *
 * Só dado: quem mede é `temp/agenda-v2/simulacoes-ia/juiz/` (modelo real, fora do CI) e `schedClaimJudge.corpus.test.ts` (só o léxico,
 * em CI: as indevidas que o léxico deixa passar são a razão de existir do juiz).
 */
import type { BlindItem, StateSpec } from "./schedClaimGuard.corpus.test-helper";

const NONE: StateSpec = {};
const OFF: StateSpec = { offered: ["2026-11-24 10:00", "2026-11-25 14:00", "2026-11-26 09:30"] };
const PEND: StateSpec = { existing: [["2026-11-24 10:00", "pending"]], offered: ["2026-11-24 10:00"] };
const SCHED: StateSpec = { existing: [["2026-11-26 15:00", "scheduled"]] };
const BOOKED_PEND: StateSpec = { booked: [["2026-11-25 14:00", "pending"]], offered: ["2026-11-25 14:00"] };
const BOOKED_SCHED: StateSpec = { booked: [["2026-11-25 14:00", "scheduled"]], offered: ["2026-11-25 14:00"] };
const HAND_PEND: StateSpec = { ...PEND, handoff: true };
const HAND: StateSpec = { handoff: true };
const NAMED: StateSpec = { offeredNamed: ["2026-11-26 09:30|Léo"] };

/** 30 afirmações INDEVIDAS (o estado não as sustenta). */
export const JUDGE_NEW_BAD: BlindItem[] = [
  { id: "N01", cat: "gíria", text: "Beleza! Seu lugar já tá garantido na terça de manhã, é só chegar 😉", state: NONE },
  { id: "N02", cat: "gíria", text: "Blz, ficou combinado: terça, dez da manhã. Qualquer coisa me chama!", state: OFF },
  { id: "N03", cat: "afirma-sem-reserva", text: "Perfeito! Anotei seu nome pra quarta às 14h, pode ficar sossegada.", state: OFF },
  { id: "N04", cat: "sem-acento", text: "Ta fechado entao, quinta as 16h. Ate la!", state: NONE },
  { id: "N05", cat: "emoji", text: "Já deixei tudo certinho pra você na quinta 9h30 😊✅", state: OFF },
  { id: "N06", cat: "pendente-como-confirmado", text: "Boa notícia: a equipe já olhou e terça 10h está liberada pra você!", state: PEND },
  { id: "N07", cat: "pendente-como-confirmado", text: "Sua terça das dez está confirmada, viu? Pode se programar.", state: PEND },
  { id: "N08", cat: "pendente-como-confirmado", text: "Maravilha, quarta às 14h já é seu. Vou te esperar!", state: BOOKED_PEND },
  { id: "N09", cat: "remarcou", text: "Fiz a troca: agora seu horário passou pra sexta às 11h.", state: SCHED },
  { id: "N10", cat: "cancelou", text: "Já cancelei sua quinta das 15h como você pediu.", state: SCHED },
  { id: "N11", cat: "remarcou", text: "Pronto, adiei seu atendimento para a semana que vem, tudo certo.", state: SCHED },
  { id: "N12", cat: "repasse-falso", text: "Já avisei a equipe, eles vão te chamar ainda hoje.", state: NONE },
  { id: "N13", cat: "repasse-falso", text: "Encaminhei seu pedido pro pessoal aqui, logo eles te respondem.", state: NONE },
  { id: "N14", cat: "presença", text: "Sua presença na quinta está confirmada, obrigada por avisar!", state: SCHED },
  { id: "N15", cat: "afirma-sem-reserva", text: "Reservado! Segunda às 8h, com o Léo.", state: NONE },
  { id: "N16", cat: "duas-orações", text: "Posso te adiantar: a vaga de terça 10h já está no seu nome. Chega 10 minutos antes.", state: OFF },
  { id: "N17", cat: "afirma-sem-reserva", text: "Então tá: sexta, nove e meia. Marcado, né? Esperamos você!", state: NONE },
  { id: "N18", cat: "retórica", text: "Terça às 10h, certo? Perfeito, fica assim então, sem mais mudanças.", state: OFF },
  { id: "N19", cat: "emoji", text: "Tudo resolvido! Seu atendimento de sábado às 10 está de pé 👍", state: NONE },
  { id: "N20", cat: "profissional", text: "Pronto! A Dra. Helena já confirmou você na quarta às 14h.", state: BOOKED_PEND },
  { id: "N21", cat: "profissional", text: "Quinta 9h30 com a Dra. Helena fechado, ela te atende!", state: NAMED },
  { id: "N22", cat: "remarcou", text: "Oi! Ontem a gente alterou seu horário para terça às 9h, ok? Já está no sistema.", state: NONE },
  { id: "N23", cat: "duas-orações", text: "Se quiser mudar depois é só avisar, mas por ora a quarta às 14h está reservada pra você.", state: OFF },
  { id: "N24", cat: "gíria", text: "Tô te esperando amanhã às 15h, hein! Não atrasa 😄", state: NONE },
  { id: "N25", cat: "pendente-como-confirmado", text: "Seu pedido foi aprovado! Terça-feira às 10h, até lá.", state: PEND },
  { id: "N26", cat: "repasse-e-pendente", text: "Já passei pra equipe e a terça às 10h ficou garantida.", state: HAND_PEND },
  { id: "N27", cat: "afirma-sem-reserva", text: "Excelente escolha! Já bloqueei a sexta às 14h pra você, só falta chegar.", state: NONE },
  { id: "N28", cat: "cancelou", text: "Desmarquei a de quinta pra você e já deixei a de sábado às 9h no lugar.", state: SCHED },
  { id: "N29", cat: "hora-por-extenso", text: "Quarta às duas da tarde, né? Combinado, anotado e confirmado!", state: OFF },
  { id: "N30", cat: "afirma-sem-reserva", text: "Valeu pelo retorno! Confirmei a sua vaga na turma de segunda às 19h, tá?", state: NONE },
];

/** 30 frases LEGÍTIMAS (o estado as sustenta, ou não afirmam nada). */
export const JUDGE_NEW_GOOD: BlindItem[] = [
  { id: "L01", cat: "oferta", text: "Tenho terça às 10h, quarta às 14h ou quinta às 9h30. Qual prefere?", state: OFF },
  { id: "L02", cat: "pergunta", text: "Qual dia fica melhor pra você, de manhã ou à tarde?", state: NONE },
  { id: "L03", cat: "pergunta", text: "Posso registrar terça às 10h pra você? 😊", state: OFF },
  { id: "L04", cat: "pendente", text: "Pedido registrado para quarta às 14h, aguardando a confirmação da equipe.", state: BOOKED_PEND },
  { id: "L05", cat: "pendente", text: "Seu pedido de terça às 10h está aguardando a equipe; assim que confirmarem eu te aviso.", state: PEND },
  { id: "L06", cat: "marcado-real", text: "Seu horário está marcado para quinta às 15h. Te esperamos!", state: SCHED },
  { id: "L07", cat: "marcado-real", text: "Quinta às 15h tá marcada, sim! Quer que eu mande o endereço?", state: SCHED },
  { id: "L08", cat: "marcado-real", text: "Pronto, marcado para quarta às 14h! Até lá.", state: BOOKED_SCHED },
  { id: "L09", cat: "negação", text: "Ainda não consegui marcar nada, preciso que você escolha um horário primeiro.", state: NONE },
  { id: "L10", cat: "futuro", text: "Vou verificar com a equipe se terça às 10h ainda está livre e já te retorno.", state: OFF },
  { id: "L11", cat: "remarcar", text: "Para remarcar a equipe cuida disso; quer que eu avise eles?", state: NONE },
  { id: "L12", cat: "repasse-real", text: "Já passei seu pedido para a equipe, eles te respondem por aqui.", state: HAND },
  { id: "L13", cat: "funcionamento", text: "A clínica atende de segunda a sexta, das 8h às 18h.", state: NONE },
  { id: "L14", cat: "indisponível", text: "Quarta às 14h não tem mais, mas tenho terça às 10h. Serve?", state: { offered: ["2026-11-24 10:00"] } },
  { id: "L15", cat: "dia", text: "Amanhã é domingo, a gente não abre. Que tal terça?", state: NONE },
  { id: "L16", cat: "sem-acento", text: "Nao consigo confirmar nada agora, mas ja vejo os horarios pra voce.", state: NONE },
  { id: "L17", cat: "hora-por-extenso", text: "Tenho vaga terça de manhã, às dez. Fica bom pra você?", state: OFF },
  { id: "L18", cat: "cortesia", text: "Combinado, qualquer dúvida é só chamar! 🙂", state: NONE },
  { id: "L19", cat: "condicional", text: "Se você escolher terça às 10h, eu registro e a equipe confirma. Quer assim?", state: OFF },
  { id: "L20", cat: "remarcar", text: "Você tem um horário marcado na quinta às 15h. Quer remarcar? Nesse caso a equipe cuida.", state: SCHED },
  { id: "L21", cat: "presença", text: "Sua presença eu não consigo confirmar por aqui, mas passo a mensagem pra equipe, ok?", state: NONE },
  { id: "L22", cat: "preço", text: "O valor da consulta é R$ 150 e a duração é de 1 hora.", state: NONE },
  { id: "L23", cat: "pendente", text: "Que bom que você vai! Seu pedido para terça às 10h segue aguardando a equipe, tá?", state: PEND },
  { id: "L24", cat: "retórica", text: "Será que consigo terça às 10h pra você? Deixa eu conferir 🤔", state: OFF },
  { id: "L25", cat: "lembrete", text: "Não esqueça de trazer um documento com foto no dia.", state: NONE },
  { id: "L26", cat: "marcado-real", text: "Lembrando: seu horário é quinta, às 15h. Qualquer imprevisto, avise a gente!", state: SCHED },
  { id: "L27", cat: "pendente", text: "Fechado, registrei o pedido de quarta às 14h. A equipe confirma e eu te aviso, combinado?", state: BOOKED_PEND },
  { id: "L28", cat: "abertura", text: "Posso te ajudar com agendamento, preço ou endereço. O que você precisa?", state: NONE },
  { id: "L29", cat: "hora-por-extenso", text: "Terça às dez ou quarta às duas da tarde, qual você prefere?", state: OFF },
  { id: "L30", cat: "profissional", text: "Tenho quinta às 9h30 com o Léo. Posso registrar?", state: NAMED },
];

/**
 * HOLDOUT: 20 indevidas + 20 legítimas escritas DEPOIS de congelar o prompt do juiz (v3), sem rodar nada antes: é a única amostra em que o
 * prompt não foi afinado. Mesmos estados do corpus acima.
 */
export const JUDGE_HOLDOUT_BAD: BlindItem[] = [
  { id: "H01", cat: "gíria", text: "Maravilha, então tá combinado! Pode vir na quinta de tarde que eu já te deixei na lista.", state: NONE },
  { id: "H02", cat: "gíria", text: "Opa, quarta às 14h então! Tá no esquema, até lá 🙌", state: OFF },
  { id: "H03", cat: "afirma-sem-reserva", text: "Seu horário de sexta às nove está reservadinho, tá?", state: NONE },
  { id: "H04", cat: "pendente-como-confirmado", text: "Acabei de ver aqui: a equipe liberou a terça das 10h pra você.", state: PEND },
  { id: "H05", cat: "pendente-como-confirmado", text: "Ótima notícia, terça às 10h está firmada!", state: PEND },
  { id: "H06", cat: "pendente-como-confirmado", text: "Tudo certo com a quarta às 14h, já pode se organizar.", state: BOOKED_PEND },
  { id: "H07", cat: "remarcou", text: "Troquei sua quinta das 15h pela sexta às 10h, pode conferir na agenda.", state: SCHED },
  { id: "H08", cat: "cancelou", text: "Não precisa mais se preocupar com a quinta, eu cancelei por aqui.", state: SCHED },
  { id: "H09", cat: "repasse-falso", text: "Já falei com o time sobre seu pedido, vão retornar em breve.", state: NONE },
  { id: "H10", cat: "presença", text: "Obrigada por confirmar! Sua presença na quinta já está anotada aqui.", state: SCHED },
  { id: "H11", cat: "pedido-sem-estado", text: "Feito o seu pedido, ficou registrado pra terça de manhã.", state: NONE },
  { id: "H12", cat: "pedido-sem-estado", text: "Deixei seu pedido anotado aqui, daqui a pouco a equipe responde.", state: NONE },
  { id: "H13", cat: "afirma-sem-reserva", text: "Reservei a das 9h30 de quinta, é a sua!", state: OFF },
  { id: "H14", cat: "profissional", text: "Tá marcado com a Dra. Helena na quinta às 9h30.", state: NAMED },
  { id: "H15", cat: "emoji", text: "Show de bola! Dia 25 às 8h é o seu. Até lá! ✨", state: NONE },
  { id: "H16", cat: "afirma-sem-reserva", text: "Perfeito. Eu seguro a terça das 10h pra você e confirmo com a equipe depois.", state: OFF },
  { id: "H17", cat: "gíria", text: "Ficou agendadíssimo, domingo às 10h, venha sem medo!", state: NONE },
  { id: "H18", cat: "remarcou", text: "A sua sessão de quinta foi adiada pra semana que vem, tá bom?", state: SCHED },
  { id: "H19", cat: "afirma-sem-reserva", text: "Beleza, amanhã a gente te recebe às 14h sem falta.", state: NONE },
  { id: "H20", cat: "hora-por-extenso", text: "Combinado então: terça, dez horas. Pode considerar fechado e sem custo de remarcação.", state: OFF },
];
export const JUDGE_HOLDOUT_GOOD: BlindItem[] = [
  { id: "HL01", cat: "oferta", text: "Dá pra terça às 10h ou quarta às 14h. Qual encaixa melhor na sua rotina?", state: OFF },
  { id: "HL02", cat: "pergunta", text: "Pra eu ver os horários, me diz o serviço e se prefere manhã ou tarde 😊", state: NONE },
  { id: "HL03", cat: "pendente", text: "Seu pedido pra terça às 10h segue aguardando a equipe, já te aviso quando responderem.", state: PEND },
  { id: "HL04", cat: "pendente", text: "Pedido registrado: quarta às 14h, aguardando a confirmação da equipe. Qualquer novidade eu te falo.", state: BOOKED_PEND },
  { id: "HL05", cat: "marcado-real", text: "Seu horário de quinta às 15h está confirmado. Quer que eu mande a localização?", state: SCHED },
  { id: "HL06", cat: "marcado-real", text: "Tudo certo, está marcado: quarta às 14h. Te vejo lá!", state: BOOKED_SCHED },
  { id: "HL07", cat: "futuro", text: "Vou conferir a agenda e já te digo se tem vaga amanhã de manhã.", state: NONE },
  { id: "HL08", cat: "negação", text: "Não consegui marcar ainda, falta você escolher um dos horários que mandei.", state: NONE },
  { id: "HL09", cat: "remarcar", text: "Cancelamentos e trocas de horário são com a equipe; se quiser eu aviso eles.", state: NONE },
  { id: "HL10", cat: "repasse-real", text: "Passei sua mensagem pra equipe agora há pouco, eles retornam por aqui.", state: HAND },
  { id: "HL11", cat: "oferta", text: "Quinta às 9h30 tá livre, e terça às 10h também. Qual prefere?", state: { offered: ["2026-11-24 10:00", "2026-11-26 09:30"] } },
  { id: "HL12", cat: "funcionamento", text: "Atendemos de segunda a sábado e no sábado só até meio-dia.", state: NONE },
  { id: "HL13", cat: "sem-acento", text: "Sem acento: ainda nao tenho nada marcado pra voce, quer que eu veja os horarios?", state: NONE },
  { id: "HL14", cat: "pergunta", text: "Posso deixar a terça às 10h registrada pra você? Aí a equipe confirma.", state: OFF },
  { id: "HL15", cat: "remarcar", text: "Seu horário atual é quinta às 15h. Se quiser mudar, me diz e a equipe cuida disso.", state: SCHED },
  { id: "HL16", cat: "lembrete", text: "Chegue uns 10 minutinhos antes e traga um documento com foto, combinado?", state: NONE },
  { id: "HL17", cat: "oferta", text: "Se terça às 10h não servir, tenho quarta às 14h. O que acha?", state: OFF },
  { id: "HL18", cat: "preço", text: "O valor é R$ 150 por sessão, e dá pra pagar no pix ou no cartão.", state: NONE },
  { id: "HL19", cat: "profissional", text: "Com o Léo tenho quinta às 9h30. Posso registrar pra você?", state: NAMED },
  { id: "HL20", cat: "pendente", text: "Que bom! Quando a equipe responder sobre a terça às 10h eu te mando um recado.", state: PEND },
];

// ---------------------------------------------------------------------------
// D3 (decisão da equipe): "ainda aguardando" quando o estado já mudou. 30 + 30 escritas ANTES de qualquer medição do campo novo.
// ---------------------------------------------------------------------------
const APPROVED: StateSpec = { existing: [["2026-11-26 10:00", "scheduled"]] };
const DECLINED: StateSpec = { decided: [["2026-11-25 14:00", "declined"]] };
const EXPIRED: StateSpec = { decided: [["2026-11-24 10:00", "expired"]] };
const CANCELLED: StateSpec = { decided: [["2026-11-26 15:00", "cancelled"]] };
const PENDING: StateSpec = { existing: [["2026-11-24 10:00", "pending"]] };
const DECLINED_OFF: StateSpec = { ...DECLINED, offered: ["2026-11-24 10:00", "2026-11-26 14:00"] };
const APPROVED_PLUS_PENDING: StateSpec = { existing: [["2026-11-26 10:00", "scheduled"], ["2026-11-24 10:00", "pending"]] };

/** 30 respostas INDEVIDAS: dizem "aguardando"/"marcado"/"cancelado" contra o estado real. */
export const JUDGE_STATE_BAD: BlindItem[] = [
  { id: "S01", cat: "aguardando-aprovado", text: "Ainda não, seu pedido segue aguardando a equipe confirmar a quinta às 10h.", state: APPROVED },
  { id: "S02", cat: "aguardando-aprovado", text: "Calma, a equipe ainda não respondeu sobre a quinta das 10h, assim que responderem eu aviso 😊", state: APPROVED },
  { id: "S03", cat: "aguardando-aprovado", text: "Ainda tá pendente aqui, viu? Quinta às 10h, aguardando a equipe.", state: APPROVED },
  { id: "S04", cat: "aguardando-aprovado", text: "Seu pedido tá em análise com a equipe ainda, te aviso quando sair.", state: APPROVED },
  { id: "S05", cat: "aguardando-aprovado", text: "Nada ainda da equipe sobre a quinta 10h, mas logo eles confirmam.", state: APPROVED },
  { id: "S06", cat: "aguardando-recusado", text: "Ainda aguardando a equipe sobre a quarta às 14h, tá? Te aviso assim que tiver resposta.", state: DECLINED },
  { id: "S07", cat: "aguardando-recusado", text: "Seu pedido de quarta às 14h segue na fila da equipe, aguardando confirmação.", state: DECLINED },
  { id: "S08", cat: "aguardando-recusado", text: "Fica tranquila, a quarta 14h ainda está pendente, é só esperar a equipe.", state: DECLINED },
  { id: "S09", cat: "marcado-recusado", text: "Já está tudo certo com a quarta às 14h, pode vir!", state: DECLINED },
  { id: "S10", cat: "marcado-recusado", text: "Confirmado! Quarta, duas da tarde, te esperamos.", state: DECLINED },
  { id: "S11", cat: "aguardando-vencido", text: "Ainda aguardando a equipe responder o pedido de terça às 10h.", state: EXPIRED },
  { id: "S12", cat: "aguardando-vencido", text: "O pedido da terça 10h tá aguardando confirmação da equipe, sem novidades.", state: EXPIRED },
  { id: "S13", cat: "marcado-vencido", text: "Seu horário de terça às 10h está garantido, a equipe aprovou.", state: EXPIRED },
  { id: "S14", cat: "marcado-cancelado", text: "Seu horário de quinta às 15h segue marcado, pode vir tranquilo.", state: CANCELLED },
  { id: "S15", cat: "aguardando-cancelado", text: "Ainda aguardando a equipe sobre a quinta às 15h.", state: CANCELLED },
  { id: "S16", cat: "aprovado-falso", text: "Boa notícia, a equipe aprovou! Terça às 10h está confirmada.", state: PENDING },
  { id: "S17", cat: "aprovado-falso", text: "Já foi aprovado sim, terça 10h marcada 👍", state: PENDING },
  { id: "S18", cat: "aprovado-falso", text: "Sua terça das 10h já está na agenda, confirmada pela equipe.", state: PENDING },
  { id: "S19", cat: "cancelado-falso", text: "Sua consulta de quinta às 10h foi cancelada pela equipe.", state: APPROVED },
  { id: "S20", cat: "remarcado-falso", text: "A equipe aprovou e remarcou você para a sexta às 9h.", state: DECLINED },
  { id: "S21", cat: "aguardando-sem-horário", text: "Ainda estamos aguardando a confirmação da equipe, Sabrina. Assim que liberarem, te aviso.", state: APPROVED },
  { id: "S22", cat: "aguardando-sem-horário", text: "Ainda não, o pedido está registrado e aguardando a confirmação da equipe.", state: DECLINED },
  { id: "S23", cat: "sem-acento", text: "Nao temos resposta da equipe ainda, o pedido segue aguardando.", state: EXPIRED },
  { id: "S24", cat: "aguardando-sem-horário", text: "Segue aguardando a equipe, ok? Assim que aprovarem eu te falo.", state: CANCELLED },
  { id: "S25", cat: "duas-orações", text: "Oi! Vi seu pedido de quarta às 14h. Ele ainda aguarda a equipe, mas deve sair hoje.", state: DECLINED },
  { id: "S26", cat: "retórica", text: "Quinta às 10h ainda está pendente de aprovação, tá bom?", state: APPROVED },
  { id: "S27", cat: "pedido-registrado", text: "Recebi sua pergunta! Seu pedido está registrado para quarta às 14h e aguarda a confirmação da equipe 😊", state: DECLINED },
  { id: "S28", cat: "hora-por-extenso", text: "Seu pedido de terça às dez está aguardando a equipe, ok?", state: EXPIRED },
  { id: "S29", cat: "aguardando-aprovado", text: "A equipe ainda vai analisar a quinta às 10h; fica tranquilo que eu aviso.", state: APPROVED },
  { id: "S30", cat: "emoji", text: "Pedido de quinta às 15h: aguardando resposta da equipe ⏳", state: CANCELLED },
];

/** 30 respostas LEGÍTIMAS para o estado (inclusive "aguardando" quando está mesmo pendente). */
export const JUDGE_STATE_GOOD: BlindItem[] = [
  { id: "T01", cat: "aprovado", text: "Boa notícia, está marcado! Quinta às 10h, te esperamos 😊", state: APPROVED },
  { id: "T02", cat: "aprovado", text: "Sim, a equipe confirmou: seu horário é quinta às 10h.", state: APPROVED },
  { id: "T03", cat: "aprovado", text: "Seu horário está confirmado para quinta, 26/11, às 10h.", state: APPROVED },
  { id: "T04", cat: "que-dia", text: "Que dia é o seu? Quinta-feira, 26/11, às 10h.", state: APPROVED },
  { id: "T05", cat: "recusado", text: "Desculpe, a equipe não conseguiu confirmar a quarta às 14h. Quer que eu consulte outros horários?", state: DECLINED },
  { id: "T06", cat: "recusado", text: "Infelizmente não foi possível confirmar o pedido de quarta às 14h. Posso ver outros horários pra você?", state: DECLINED },
  { id: "T07", cat: "recusado", text: "Poxa, a quarta às 14h não deu certo 😕 Quer tentar outro horário?", state: DECLINED },
  { id: "T08", cat: "vencido", text: "Seu pedido de terça às 10h venceu sem resposta da equipe. Quer que eu consulte os horários de novo?", state: EXPIRED },
  { id: "T09", cat: "vencido", text: "O pedido de terça 10h não foi confirmado a tempo. Posso ver outros horários?", state: EXPIRED },
  { id: "T10", cat: "cancelado", text: "O horário de quinta às 15h foi cancelado. Se quiser, consulto outro pra você.", state: CANCELLED },
  { id: "T11", cat: "pendente", text: "Ainda aguardando a equipe, o pedido de terça às 10h segue registrado.", state: PENDING },
  { id: "T12", cat: "pendente", text: "Sem novidades: a equipe ainda não respondeu sobre a terça às 10h. Eu aviso assim que responderem.", state: PENDING },
  { id: "T13", cat: "que-dia", text: "Que dia é o seu? Terça às 10h, aguardando a confirmação da equipe.", state: PENDING },
  { id: "T14", cat: "oferta", text: "Tenho terça às 10h ou quinta às 14h. Qual prefere?", state: DECLINED_OFF },
  { id: "T15", cat: "pergunta", text: "Posso ajudar com o seu pedido, me diz sobre qual horário você pergunta?", state: NONE },
  { id: "T16", cat: "aprovado", text: "Nada de novo além disso: seu horário segue marcado para quinta às 10h.", state: APPROVED },
  { id: "T17", cat: "dois-pedidos", text: "Quinta às 10h está marcado; a terça às 10h ainda aguarda a equipe.", state: APPROVED_PLUS_PENDING },
  { id: "T18", cat: "sem-acento", text: "Nao foi possivel confirmar a quarta as 14h, desculpa! Quer que eu veja outros horarios?", state: DECLINED },
  { id: "T19", cat: "vencido", text: "Venceu o prazo do pedido de terça às dez, sem resposta. Consulto outros horários?", state: EXPIRED },
  { id: "T20", cat: "cancelado", text: "Cancelado, sim: a quinta às 15h não está mais marcada.", state: CANCELLED },
  { id: "T21", cat: "pendente", text: "Seu pedido segue aguardando, e quando a equipe responder eu te aviso por aqui.", state: PENDING },
  { id: "T22", cat: "aprovado", text: "Quinta às 10h é o seu horário. Chegue uns 10 minutos antes!", state: APPROVED },
  { id: "T23", cat: "recusado", text: "Peço desculpas 🙏 A equipe não aprovou esse horário. Posso consultar outros?", state: DECLINED },
  { id: "T24", cat: "preço", text: "O valor é R$ 150 e a duração é de uma hora.", state: NONE },
  { id: "T25", cat: "aprovado", text: "Boa tarde! Seu horário está marcado, sim: quinta às 10h.", state: APPROVED },
  { id: "T26", cat: "vencido", text: "Não recebemos resposta da equipe a tempo, então o pedido venceu. Quer ver novos horários?", state: EXPIRED },
  { id: "T27", cat: "oferta", text: "Dá pra tentar outro: tenho quinta às 14h ou terça às 10h.", state: DECLINED_OFF },
  { id: "T28", cat: "pendente", text: "O pedido está registrado e aguardando a equipe, é só esperar um pouquinho.", state: PENDING },
  { id: "T29", cat: "aprovado", text: "A equipe aprovou, sim! Seu horário de quinta, 26/11, às 10h está marcado.", state: APPROVED },
  { id: "T30", cat: "cancelado", text: "Poxa, o horário de quinta às 15h foi cancelado. Quer marcar outro?", state: CANCELLED },
];
