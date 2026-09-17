/**
 * Helpers de apresentação de grupo de WhatsApp (F2).
 *
 * Tudo aqui é puro: o inbox, o painel de membros, a tela de Canais e
 * `/app/grupos` mostram os mesmos nomes, as mesmas cores e o mesmo telefone
 * mascarado, e nenhum deles precisa saber como isso é calculado.
 */

/**
 * Paleta das bolhas de grupo. Oito tons que sobrevivem ao tema escuro e se
 * distinguem entre si — o objetivo é "quem falou?" batido de relance, não
 * identidade visual do membro.
 */
export const GROUP_SENDER_COLORS = [
  "#f97316", // laranja
  "#22c55e", // verde
  "#38bdf8", // azul claro
  "#e879f9", // rosa
  "#facc15", // amarelo
  "#2dd4bf", // turquesa
  "#a78bfa", // roxo
  "#fb7185", // coral
] as const;

/**
 * Cor ESTÁVEL por remetente. A chave é o LID (ou o telefone, quando o grupo
 * está em modo `pn`) — nunca o nome, que muda quando a pessoa troca o PushName
 * e faria a conversa inteira mudar de cor no meio.
 */
export function groupSenderColor(key: string | null | undefined): string {
  if (!key) return GROUP_SENDER_COLORS[GROUP_SENDER_COLORS.length - 1];
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return GROUP_SENDER_COLORS[Math.abs(hash) % GROUP_SENDER_COLORS.length];
}

/**
 * Telefone mascarado: os quatro últimos dígitos bastam para alguém reconhecer
 * o próprio número numa lista sem que a tela vire uma lista de contatos de
 * terceiros exportável de relance (D3/LGPD). Quem tem `inbox:view_all` vê o
 * número inteiro — a máscara é discrição, não controle de acesso.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return `••${digits}`;
  return `••••${digits.slice(-4)}`;
}

/** "+55 81 9298-5729" quando dá, senão o que veio. */
export function formatGroupPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 13 || digits.length === 12) {
    const cc = digits.slice(0, 2);
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const head = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
    const tail = rest.length === 9 ? rest.slice(5) : rest.slice(4);
    return `+${cc} ${ddd} ${head}-${tail}`;
  }
  return `+${digits}`;
}

/** Nome exibível de um participante: PushName > telefone mascarado > "Membro". */
export function participantDisplayName(
  p: { name?: string | null; phone?: string | null },
  full = false
): string {
  if (p.name && p.name.trim()) return p.name.trim();
  if (p.phone) return full ? formatGroupPhone(p.phone) : maskPhone(p.phone);
  return "Membro";
}

/** Chave estável do participante — espelha `participantKey` do backend. */
export function participantKeyOf(p: { lid?: string | null; phone?: string | null }): string {
  return p.lid ?? p.phone ?? "";
}

/** Iniciais para o avatar da bolha (uma ou duas letras). */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "há 5 min" / "há 3h" / "12/09/2026" — mesma escala do painel de contato. */
/**
 * "ativo há 5 min" / "sem atividade" — o rótulo PRONTO.
 *
 * `relativeTime` devolve "sem atividade" para um grupo que nunca falou, e a
 * tela prefixava "ativo " nela: "12 membros · ativo sem atividade" (achado
 * menor do review de correção). Quem monta a frase agora é o helper.
 */
export function activityLabel(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return "sem atividade";
  return `ativo ${relativeTime(timestamp, now)}`;
}

export function relativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return "sem atividade";
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `há ${days} dia${days > 1 ? "s" : ""}`;
  return new Date(timestamp).toLocaleDateString("pt-BR");
}
