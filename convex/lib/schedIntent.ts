/**
 * Agenda v2 (D2) — o que o CLIENTE quer, lido do texto dele (puro, só léxico; nunca decide reserva).
 *
 * Duas serventias: (1) a busca de horários recusa quem pediu para remarcar/cancelar um horário que já tem (o modelo mais fraco
 * ofereceu horários novos em vez de repassar); (2) o texto seguro do guard e o motivo do repasse dizem o que o cliente queria.
 */
import { norm } from "./schedTimeText";

export type CustomerIntent = "remarcar" | "cancelar" | "presenca" | "grupo" | "marcar";

const REMARCAR =
  /\b(?:remarc\w*|reagend\w*|trocar\s+(?:de\s+|o\s+|meu\s+|minha\s+|a\s+)?(?:horario|dia|consulta|sessao|agendamento|hora)|mudar\s+(?:de\s+|o\s+|meu\s+|minha\s+|a\s+)?(?:horario|dia|consulta|sessao|agendamento|hora)|adiar|antecipar|outro\s+(?:dia|horario)\s+(?:pra|para)\s+(?:minha|meu|a|o)\s+(?:consulta|sessao|horario|aula|atendimento))\b/;
const CANCELAR_EXPLICIT = /\b(?:cancel\w*|desmarc\w*)\b/;
/** "Não vou poder ir sábado" só é cancelamento quando a mesma mensagem NÃO pede outro período/dia ("…, tem à tarde?"). */
const CANCELAR_IMPLICIT =
  /\b(?:nao\s+(?:vou|consigo|posso|poderei)\s+(?:mais\s+)?(?:poder\s+)?(?:ir|comparecer|aparecer|vir)|nao\s+vai\s+dar\s+(?:pra|para)\s+(?:eu\s+)?(?:ir|comparecer))\b/;
const ASKS_OTHER_SLOT =
  /\b(?:tem|teria|da pra|pode ser|podemos|consegue|outro|outra)\b[^.!?]*\?|\boutro\s+(?:dia|horario|periodo)\b|\b(?:de manha|de tarde|a tarde|a noite|domingo|segunda|terca|quarta|quinta|sexta|sabado)\b[^.!?]*\?/;
const PRESENCA = /\b(?:confirm\w*\s+(?:a\s+|minha\s+|nossa\s+)?presenca|presenca\s+confirmada|estarei\s+(?:ai|presente|la)|vou\s+(?:estar\s+)?(?:ai|la)\s+(?:sim|com certeza))\b/;

/** Parentesco/companhia: sem isto, "eu e a Maria", "meu cabelo também" ou "para mim" não são grupo. */
const KIN = "(?:filho|filha|marido|esposa|esposo|mulher|namorad[oa]|amig[oa]|mae|pai|irma[o]?|prima|primo|neto|neta|sobrinh[oa]|colega|noiv[oa]|genro|nora|vizinh[oa])";
const NUM = "(?:duas|dois|tres|quatro|2|3|4)";
/** Número de pessoas dito às claras ("pra nós três", "somos em 3", "a gente é em 3", "somos um casal"): vale sem outra palavra de intenção. */
const GRUPO_COUNT = new RegExp(
  `\\b(?:(?:para|pra)\\s+${NUM}\\s+pessoas|(?:para|pra)\\s+nos\\s+${NUM}|(?:somos|seremos|vamos em)\\s+(?:em\\s+)?${NUM}\\b|a gente\\s+(?:e|eh|somos|vai ser|vamos ser)\\s+(?:em\\s+)?${NUM}\\b|somos\\s+(?:um|uma)\\s+(?:casal|dupla|trio|familia)|(?:nos|a gente)\\s+(?:dois|duas|tres)\\s+(?:queremos|quer|vamos|gostariamos)|nos\\s+(?:dois|duas|tres)\\s+(?:juntos|juntas))\\b`
);
/** Companhia/parentesco: exige também intenção de marcar (`BOOKING_INTENT`). */
const GRUPO_KIN = new RegExp(
  `\\b(?:(?:eu|nos)\\s+e\\s+(?:minha|meu|uma|um)\\s+${KIN}|(?:eu|nos)\\s+e\\s+(?:a|o)\\s+[a-z]+\\s+(?:queremos|vamos|gostariamos|precisamos|querem|vem|vao)\\b|(?:para|pra|pro)\\s+(?:mim|nos)\\s+e\\s+(?:(?:para|pra|pro)\\s+)?(?:(?:a|o)\\s+|minha\\s+|meu\\s+|uma\\s+|um\\s+)(?:minha\\s+|meu\\s+)?${KIN}|vou\\s+com\\s+(?:minha|meu|uma|um)\\s+${KIN}|(?:minha|meu)\\s+${KIN}\\s+(?:tambem\\s+)?(?:quer|vai|vem)\\s+(?:junto|comigo)|(?:minha|meu)\\s+${KIN}\\s+tambem\\s+(?:quer|vai|vem|gostaria|precisa)\\b)`
);
/** O cliente quer MARCAR (não está contando o passado): sem isto a menção a parentesco não vira grupo. */
const BOOKING_INTENT = /\b(?:marcar|agendar|queria|quero|queremos|gostaria|gostariamos|horario|vaga|consulta|sessao|corte|aula|atendimento|avaliacao|cortar|fazer)\b/;
const PAST = /\b(?:fui|fomos|foi|estive|estivemos|semana passada|mes passado|ontem|antes)\b/;
/** "Só pra mim", "só eu", "a sessão é só minha", "apenas eu": negação explícita vence qualquer menção a outra pessoa. */
const ONLY_ME = /\b(?:so|apenas|somente)\s+(?:pra|para|eu|comigo|mim|minh[ao]|meu|uma\s+pessoa)\b|\bsou so eu\b|\bsou eu mesm[oa]\b|\b(?:1|uma)\s+pessoa\b|^\s*(?:so\s+)?(?:1|uma|eu)\s*[.!]?\s*$/;
/** A companhia só espera/acompanha: não é mais uma pessoa a atender. */
const COMPANION_ONLY = /\b(?:so|apenas|somente)\s+(?:espera\w*|acompanha\w*|assiste|vai junto|vem junto)\b|\bnao\s+(?:vai|vem|quer)\s+(?:fazer|marcar|cortar)\b/;
const MARCAR = /\b(?:marcar|agendar|horario|vaga|consulta|sessao|atendimento|agenda)\b/;

/** O texto fala de MAIS DE UMA pessoa que querem marcar? (número de pessoas, ou parentesco/companhia + intenção de marcar; "só eu" vence.) */
export function mentionsGroup(text: string): boolean {
  const n = norm(text);
  if (ONLY_ME.test(n) || COMPANION_ONLY.test(n) || PAST.test(n)) return false;
  if (GRUPO_COUNT.test(n)) return true;
  return GRUPO_KIN.test(n) && BOOKING_INTENT.test(n);
}

/**
 * O cliente pergunta como ficou o pedido/horário dele ("e aí, confirmou?", "deu certo meu horário?", "que dia é mesmo o meu?", "já está
 * marcado?"). Só serve para escolher o texto seguro montado a partir do ESTADO (nunca decide reserva).
 */
const STATUS_POSSESSIVE = /\b(?:meu|minha)\s+(?:horario|pedido|agendamento|consulta|sessao|vaga|reserva|aula)\b/;
/** A mensagem INTEIRA é só a pergunta da situação ("e aí, confirmou?", "deu certo?", "já está marcado?"): sem posse, mas sem outro assunto. */
const STATUS_ONLY = /^\W*(?:e ai\W+)?(?:ja\s+)?(?:confirm(?:ou|aram)|aprov(?:ou|aram)|deu certo|foi (?:aprovad|confirmad|marcad)\w*|(?:esta|ta) (?:marcad|confirmad|aprovad)\w*)\W*$/;
/** Pergunta de outro assunto que cita "minha consulta" ("quanto custa a minha consulta?"): não é pergunta da situação. */
const NOT_STATUS = /\b(?:quanto|preco|valor|custa|pagar|pagamento|endereco|onde|promocao|desconto|convenio)\b/;
export function asksPedidoStatus(text: string): boolean {
  const n = norm(text);
  if (NOT_STATUS.test(n)) return false;
  // Só posse + estado ("meu horário", "minha consulta", "confirmou o meu"): "e aí, tudo bem?", "que dia vocês atendem?", "qual horário vocês abrem?",
  // "alguma novidade sobre o preço?" e "quando é a promoção?" NÃO são perguntas da situação do pedido.
  return STATUS_POSSESSIVE.test(n) || STATUS_ONLY.test(n) || /\b(?:confirm(?:ou|aram)|aprov(?:ou|aram)|deu certo)\s+(?:o|a)\s+(?:meu|minha)\b/.test(n);
}

/** A primeira intenção de agenda do texto, na ordem de gravidade (remarcar e cancelar antes de marcar). `null` = nenhuma. */
export function detectCustomerIntent(text: string): CustomerIntent | null {
  const n = norm(text);
  if (!n.trim()) return null;
  if (CANCELAR_EXPLICIT.test(n)) return "cancelar";
  if (CANCELAR_IMPLICIT.test(n) && !ASKS_OTHER_SLOT.test(n)) return "cancelar";
  if (REMARCAR.test(n)) return "remarcar";
  if (PRESENCA.test(n)) return "presenca";
  if (mentionsGroup(text)) return "grupo";
  return MARCAR.test(n) ? "marcar" : null;
}

/**
 * Mensagens do cliente DESDE a última oferta da IA (mensagem da IA com horário): é aí que o pedido de grupo vale. Sem oferta no
 * histórico, as últimas `last` mensagens do cliente.
 */
export function customerSinceOffer(history: ReadonlyArray<{ de: string; texto: string }>, last = 6): string {
  const TIME = /\d{1,2}\s*h(?:\d{2})?\b|\d{1,2}:\d{2}/;
  let from = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].de === "ia" && TIME.test(history[i].texto)) {
      from = i + 1;
      break;
    }
  }
  return history
    .slice(from)
    .filter((m) => m.de === "cliente")
    .slice(-last)
    .map((m) => m.texto)
    .join(" ")
    .slice(0, 2000);
}

/** A IA perguntou quantas pessoas são ("quantas pessoas?", "são só você?", "é só para você?"): a recusa `pedido_de_grupo` manda perguntar isso. */
const ASKED_HOW_MANY = /\bquant[oa]s\s+(?:pessoas|vao|sao|vem)\b|\bquantas?\s+(?:sao|vao|serao)\b|\b(?:e|sao)\s+(?:so|apenas)\s+(?:para\s+|pra\s+)?(?:voce|vc|uma pessoa)\b|\bvao\s+(?:no\s+mesmo|juntos|juntas)\b/;

/** A IA já perguntou, na conversa, quantas pessoas são? (última fala da IA/equipe com a pergunta; vale mesmo com cliente depois.) */
export function iaAskedHowMany(history: ReadonlyArray<{ de: string; texto: string }>): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].de === "cliente") continue;
    return ASKED_HOW_MANY.test(norm(history[i].texto));
  }
  return false;
}

/**
 * O texto do cliente em que o pedido de grupo vale: depois de a IA perguntar quantas pessoas são, SÓ o que o cliente respondeu
 * ("sou eu mesma", "1 pessoa", "uma" resolvem; sem isto a recusa não teria saída); senão, desde a última oferta.
 */
export function customerTextForGroup(history: ReadonlyArray<{ de: string; texto: string }>): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].de !== "cliente" && ASKED_HOW_MANY.test(norm(history[i].texto))) {
      return history
        .slice(i + 1)
        .filter((m) => m.de === "cliente")
        .map((m) => m.texto)
        .join(" ")
        .slice(0, 2000);
    }
    if (history[i].de === "ia" && /\d{1,2}\s*h(?:\d{2})?\b|\d{1,2}:\d{2}/.test(history[i].texto)) break;
  }
  return customerSinceOffer(history);
}

/** O cliente citou um serviço que NÃO é o do agendamento que já tem? (tem corte marcado e pede horário de barba: não é remarcar.) */
export function mentionsOtherService(text: string, services: readonly string[], upcomingServices: readonly string[]): boolean {
  const n = norm(text);
  const mine = new Set(upcomingServices.map((x) => norm(x)));
  return services.map((x) => norm(x)).some((sv) => sv.length >= 3 && !mine.has(sv) && n.includes(sv));
}

/** Só remarcar/cancelar: é o que a busca de horários recusa (a equipe cuida; a IA não oferece horário novo). */
export function isChangeIntent(intent: CustomerIntent | null): intent is "remarcar" | "cancelar" {
  return intent === "remarcar" || intent === "cancelar";
}

/** As mensagens do cliente depois da última fala da IA/equipe (o "turno" do cliente), juntas. */
export function customerTail(history: ReadonlyArray<{ de: string; texto: string }>): string {
  const parts: string[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].de !== "cliente") break;
    parts.unshift(history[i].texto);
  }
  return parts.join(" ").slice(0, 800);
}
