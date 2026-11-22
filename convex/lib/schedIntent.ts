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
const CANCELAR =
  /\b(?:cancel\w*|desmarc\w*|nao\s+(?:vou|consigo|posso|poderei)\s+(?:mais\s+)?(?:poder\s+)?(?:ir|comparecer|aparecer|vir)|nao\s+vai\s+dar\s+(?:pra|para)\s+(?:eu\s+)?(?:ir|comparecer))\b/;
const PRESENCA = /\b(?:confirm\w*\s+(?:a\s+|minha\s+|nossa\s+)?presenca|presenca\s+confirmada|estarei\s+(?:ai|presente|la)|vou\s+(?:estar\s+)?(?:ai|la)\s+(?:sim|com certeza))\b/;
const GRUPO =
  /\b(?:(?:eu|mim|nos)\s+e\s+(?:minha|meu|mais|um|uma|a|o)|(?:para|pra)\s+nos\s+(?:dois|duas|tres)|(?:para|pra)\s+(?:duas|dois|tres|quatro|2|3|4)\s+pessoas|(?:somos|seremos)\s+(?:em\s+)?(?:duas|dois|tres|quatro|2|3|4)|(?:minha|meu)\s+\w+\s+(?:tambem|junto)|nos\s+(?:dois|duas|tres)|vou\s+com\s+(?:minha|meu)|(?:eu|a gente)\s+e\s+(?:minha|meu))\b/;
const MARCAR = /\b(?:marcar|agendar|horario|vaga|consulta|sessao|atendimento|agenda)\b/;

/** A primeira intenção de agenda do texto, na ordem de gravidade (remarcar e cancelar antes de marcar). `null` = nenhuma. */
export function detectCustomerIntent(text: string): CustomerIntent | null {
  const n = norm(text);
  if (!n.trim()) return null;
  if (CANCELAR.test(n)) return "cancelar";
  if (REMARCAR.test(n)) return "remarcar";
  if (PRESENCA.test(n)) return "presenca";
  if (GRUPO.test(n)) return "grupo";
  return MARCAR.test(n) ? "marcar" : null;
}

/** O texto fala de mais de uma pessoa ("pra mim e meu filho", "somos em 2", "eu e uma amiga")? */
export function mentionsGroup(text: string): boolean {
  return GRUPO.test(norm(text));
}

/** Tudo o que o cliente escreveu na janela recente do histórico (a menção ao grupo costuma vir na primeira mensagem, não na última). */
export function customerWindow(history: ReadonlyArray<{ de: string; texto: string }>, last = 12): string {
  return history
    .filter((m) => m.de === "cliente")
    .slice(-last)
    .map((m) => m.texto)
    .join(" ")
    .slice(0, 2000);
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
