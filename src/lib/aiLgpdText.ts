/**
 * Texto do aceite de IA/LGPD: fonte única da tela de IA (`ActivationCard`,
 * `ActivationWizardCard`) e do chat de onboarding (`CartaoAceiteBlock`). É o texto
 * jurídico da tela de IA; qualquer mudança é feita aqui.
 */
export type AiLgpdPart = string | { strong: string };

export const AI_LGPD_PARAGRAPHS: readonly (readonly AiLgpdPart[])[] = [
  [
    "Ao ativar, dados de clientes (mensagens, nomes, contexto do CRM) são processados por provedores de IA nos EUA em modo ",
    { strong: "zero-retention" },
    " (não são retidos nem usados para treino no caminho padrão da plataforma).",
  ],
  [
    "Sua organização é a controladora dos dados. Confirme que sua política de privacidade divulga o uso de IA no atendimento e a transferência internacional de dados (LGPD, art. 33).",
  ],
];

export const AI_LGPD_ACK_LABEL =
  "Confirmo que minha política de privacidade divulga o uso de IA e a transferência internacional de dados";

/** Texto corrido de um parágrafo (sem marcação). */
export function aiLgpdPlainText(paragraph: readonly AiLgpdPart[]): string {
  return paragraph.map((p) => (typeof p === "string" ? p : p.strong)).join("");
}
