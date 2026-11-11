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
