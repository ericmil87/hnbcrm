/**
 * Textos e passos da cena S2 (A máquina funcionando), literais da copy aprovada.
 * O preço da cena é o do serviço fictício do cliente fictício, não do HNBCRM.
 */
import type { SceneStep } from "../kit";

export const MACHINE_EYEBROW = "Veja acontecendo";
export const MACHINE_TITLE = "A máquina funcionando, às 23h14";
export const MACHINE_SUBTITLE =
  "Um cliente manda áudio. A IA entende, responde e move o lead no Funil. Você só entra quando importa.";
export const MACHINE_CAPTION =
  "Cena ilustrativa, com o Atendente no modo automático. Ele começa em modo sugestão, e você libera o automático quando quiser.";
export const MACHINE_SWIPE_HINT = "Deslize para ver os três painéis";
export const MACHINE_LABEL = "Cena ilustrativa: a máquina funcionando";
export const MACHINE_DESCRIPTION =
  "Cena ilustrativa: às 23h14 uma cliente manda áudio perguntando horário e preço. A IA transcreve, responde, e o lead passa de Novo para Agendado no Funil. A dona recebe um aviso no celular, assume a conversa e manda o Pix. O Copiloto resume os leads quentes do dia.";

export const MACHINE_PANELS = [
  { id: "conversa", title: "Conversa", badge: "WhatsApp" },
  { id: "funil", title: "Funil", badge: "Atualiza sozinho" },
  { id: "voce", title: "Você", badge: "No celular" },
] as const;

export const MACHINE_FUNNEL_COLUMNS = [
  { id: "novo", title: "Novo" },
  { id: "interessado", title: "Interessado" },
  { id: "agendado", title: "Agendado" },
] as const;

/** ~20 s no total. */
export const MACHINE_STEPS: readonly SceneStep[] = [
  { id: "inicio", duration: 800 },
  { id: "audio", duration: 1600 },
  { id: "transcricao", duration: 1800 },
  { id: "digitando", duration: 1400 },
  { id: "resposta", duration: 2200 },
  { id: "cliente-ok", duration: 1800 },
  { id: "ia-ok", duration: 1800 },
  { id: "aviso", duration: 2400 },
  { id: "equipe", duration: 2600 },
  { id: "resumo", duration: 3800 },
];

export const MACHINE_TRANSCRIPT = "Oi, vocês têm horário no sábado? Queria saber o valor da limpeza de pele.";

/** Falas e rótulos da cena (nomes fictícios; o preço é do serviço fictício da cliente). */
export const MACHINE_TEXT = {
  customerName: "Marina",
  dateSeparator: "Hoje",
  audioDuration: "0:14",
  aiLabel: "Atendente IA",
  aiPrice:
    "Oi, Marina! Sábado temos às 9h e às 10h30. A limpeza de pele sai por R$ 180. Qual horário você prefere?",
  customerOk: "Fechado, 10h30!",
  aiOk: "Anotei 10h30. A equipe confirma com você amanhã cedo.",
  funnelCardTitle: "Marina",
  funnelCardSubtitle: "limpeza de pele",
  notificationTitle: "Marina quer fechar. Assumir?",
  notificationLater: "Depois",
  notificationTake: "Assumir",
  takeoverLine: "Você assumiu a conversa. A IA pausou.",
  teamLabel: "Ana",
  teamMessage: "Oi, Marina! Aqui é a Ana. Vou te passar o Pix do sinal.",
  copilotTitle: "Copiloto",
  copilotSubtitle: "resumo de hoje",
  copilotLabel: "Copiloto · resumo de hoje",
  copilotHeadline: "3 leads quentes hoje",
  copilotLeads: ["Marina · pronta para fechar", "Paulo · pediu valor do pacote", "Ingrid · voltou a falar hoje"],
} as const;

export const MACHINE_DOT_LABELS: Record<"conversa" | "funil" | "voce", string> = {
  conversa: "Ver painel Conversa",
  funil: "Ver painel Funil",
  voce: "Ver painel Você",
};
