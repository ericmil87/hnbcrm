/**
 * Prompt da "mensagem do dia" — publicação programada gerada por IA (F3, D8).
 *
 * PURO: recebe persona, conhecimento e contexto, devolve as duas mensagens
 * (system + user). Nenhuma tool, nenhum acesso a CRM — o produto aqui é um
 * TEXTO que uma pessoa vai aprovar (ou que vai ser publicado direto, se a org
 * assumiu esse risco com `campaigns:full`).
 *
 * Por que não reusar `buildAttendantSystemPrompt`: aquele prompt é de um
 * ATENDIMENTO 1:1 — fala em "cliente", obriga `replyToCustomer`, tem regras de
 * repasse, de funil e de captura de dados. Aproveitamos dele o que de fato é
 * reaproveitável, que é a PERSONA e o CONHECIMENTO do atendente da org.
 *
 * Dois cuidados de segurança:
 *  - nome de grupo e nome de membro vêm do WhatsApp (terceiros) — vão dentro
 *    do envelope de dado não-confiável, igual ao resto do produto;
 *  - a saída é um texto que será publicado: o prompt proíbe inventar preço,
 *    prazo e promoção que não estejam no conhecimento.
 */

import { ENVELOPE_SYSTEM_NOTICE, wrapUntrustedJson } from "./promptEnvelope";
import { toWhatsAppText } from "./whatsappText";

export interface GroupPostPromptContext {
  /** Nome do agente/assinatura (o atendente IA da org, ou o nome da empresa). */
  agentName: string;
  orgName: string;
  language: string; // "pt-BR"
  /** Persona: a do atendente, uma escrita à mão, ou nenhuma (default do produto). */
  persona: string | null;
  knowledge: string | null;
  /** O que a publicação deve dizer (escrito pelo humano ao criar a rotina). */
  instruction: string;
  maxChars: number;
  /** Nomes dos grupos de destino — dado de terceiro. */
  groupNames: string[];
  /** Textos das últimas publicações desta rotina, para não repetir o assunto. */
  recentPosts: string[];
  /** Data/dia por extenso no fuso da publicação. */
  dateText: string;
  weekdayText: string;
  /**
   * Carimbo completo de data/hora (`lib/promptDateTime.ts`), quando o perfil do
   * atendente o mantém ligado. Presente, ele SUBSTITUI o "Hoje é …" do user —
   * traz a mesma data com hora e a régua dos próximos dias.
   */
  dateTimeBlock?: string | null;
}

export interface GroupPostPromptMessages {
  system: string;
  user: string;
}

export function buildGroupPostPrompt(ctx: GroupPostPromptContext): GroupPostPromptMessages {
  const persona =
    ctx.persona?.trim() ||
    `Você é ${ctx.agentName}, a voz da empresa "${ctx.orgName}" no WhatsApp.`;

  const system = [
    persona,
    `Responda sempre em ${ctx.language}.`,
    "TAREFA: escrever UMA mensagem para ser PUBLICADA num grupo de WhatsApp da empresa. Não é uma conversa: ninguém te perguntou nada, e não há um cliente específico do outro lado.",
    "REGRAS OBRIGATÓRIAS:",
    `1. Devolva SOMENTE o texto da mensagem, pronto para publicar. Sem aspas em volta, sem "aqui está", sem título, sem assinatura e sem explicação.`,
    `2. No máximo ${ctx.maxChars} caracteres. Mensagem de grupo curta é lida; longa é ignorada.`,
    "3. Escreva para o grupo inteiro, nunca para uma pessoa. Nada de \"oi, tudo bem?\" nem de perguntar algo que exija resposta individual.",
    "4. NUNCA invente preço, prazo, promoção, endereço, horário ou política que não esteja no conhecimento abaixo. Sem a informação, escreva sem ela.",
    "5. Não prometa nada em nome da empresa, não confirme pagamento de ninguém e não peça dado pessoal no grupo.",
    "6. Use a formatação do WhatsApp com moderação (*negrito*, _itálico_), no máximo 2 emojis, e nunca markdown de título ou tabela.",
    ENVELOPE_SYSTEM_NOTICE,
    ctx.knowledge
      ? `CONHECIMENTO DO NEGÓCIO (use como fonte da verdade):\n${ctx.knowledge}`
      : "",
    // Último: parte volátil do prompt, fora do prefixo que o provider cacheia.
    ctx.dateTimeBlock ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const user = [
    `O QUE PUBLICAR HOJE (instrução da equipe):\n${ctx.instruction}`,
    // O carimbo completo já diz o dia (com hora e próximos dias): repetir só a
    // data aqui seria ruído.
    ctx.dateTimeBlock ? "" : `Hoje é ${ctx.weekdayText}, ${ctx.dateText}.`,
    wrapUntrustedJson("contexto_da_publicacao", {
      grupos: ctx.groupNames.slice(0, 20),
      publicacoes_recentes: ctx.recentPosts.slice(0, 5),
    }),
    ctx.recentPosts.length > 0
      ? "As publicações recentes acima já foram ao ar: NÃO repita o mesmo assunto nem a mesma abertura."
      : "",
    "Escreva agora a mensagem.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

/**
 * Limpa a saída do modelo: tira cerca de markdown, aspas envolventes,
 * raciocínio vazado (`<think>`) e prefixos do tipo "Mensagem:", converte o
 * markdown restante para a formatação do WhatsApp e corta no teto de caracteres
 * SEM cortar palavra pela metade.
 */
export function cleanGeneratedPost(raw: string | unknown[] | null | undefined, maxChars: number): string {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  const fence = text.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
  if (fence) text = fence[1].trim();

  text = text.replace(/^(?:mensagem|publica[çc][ãa]o|texto|post)\s*:\s*/i, "").trim();

  // Aspas envolventes só quando abraçam o texto INTEIRO (uma citação interna
  // legítima não deve ser comida).
  if (text.length > 1) {
    const first = text[0];
    const last = text[text.length - 1];
    const pairs: Record<string, string> = { '"': '"', "'": "'", "“": "”", "«": "»" };
    if (pairs[first] === last && !text.slice(1, -1).includes(first)) {
      text = text.slice(1, -1).trim();
    }
  }

  // Markdown → WhatsApp antes do corte: é o texto convertido que vai ao ar, e
  // é o tamanho dele que precisa caber no teto.
  text = toWhatsAppText(text);

  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}
