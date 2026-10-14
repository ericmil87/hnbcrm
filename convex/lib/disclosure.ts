/**
 * Divulgação do atendente IA ("você fala com um assistente") — núcleo PURO.
 *
 * Dois modos em `agentProfile.disclosureMode`:
 * - `"first_reply"` (default; ausente = este): comportamento histórico — o
 *   prompt manda começar a 1ª resposta com o texto exato e o commit PREPENDE o
 *   texto se o modelo não o incluiu.
 * - `"on_demand"`: nada é prependido nem exigido na abertura. O prompt ganha
 *   uma regra de identificação: quando a pessoa perguntar se fala com robô/IA/
 *   pessoa, ou quando a IA abrir um repasse, ela responde com o texto da
 *   divulgação. Caso real (Aos Filhos da Terra, 13/10/2026): o cliente quer uma
 *   abertura humana da casa, sem "sou um assistente" logo de cara, mas sem que
 *   a IA jamais finja ser humana.
 */

export type DisclosureMode = "first_reply" | "on_demand";

export const DISCLOSURE_MODES: readonly DisclosureMode[] = ["first_reply", "on_demand"];

export function resolveDisclosureMode(
  profile: { disclosureMode?: string | null } | null | undefined
): DisclosureMode {
  return profile?.disclosureMode === "on_demand" ? "on_demand" : "first_reply";
}

/**
 * O que o turno precisa fazer com a divulgação.
 * `needsDisclosure` = prompt exige + commit prepende (só `first_reply`, e só
 * enquanto a IA ainda não falou nesta conversa). `onDemand` = regra de
 * identificação sob demanda no prompt (todo turno).
 */
export function resolveDisclosurePolicy(
  profile: { disclosureMode?: string | null } | null | undefined,
  hasPriorAiOutbound: boolean
): { needsDisclosure: boolean; onDemand: boolean } {
  const onDemand = resolveDisclosureMode(profile) === "on_demand";
  return { needsDisclosure: !onDemand && !hasPriorAiOutbound, onDemand };
}

/** Linha do system prompt sobre a divulgação ("" quando não há nada a dizer). */
export function buildDisclosurePromptLine(context: {
  needsDisclosure: boolean;
  disclosure: string;
  disclosureOnDemand?: boolean;
}): string {
  if (context.needsDisclosure) {
    return `Esta é a primeira resposta da IA neste atendimento: comece a resposta com exatamente: "${context.disclosure}"`;
  }
  const text = context.disclosure.trim();
  if (context.disclosureOnDemand && text) {
    return [
      "IDENTIFICAÇÃO SOB DEMANDA: não se apresente como assistente, IA ou robô na abertura da conversa.",
      `Quando a pessoa perguntar se está falando com um robô, uma IA ou uma pessoa (ou com alguém da equipe pelo nome), e quando você abrir um repasse para humano, diga com estas palavras: "${text}"`,
      "Nunca negue ser um assistente digital e nunca finja ser uma pessoa da equipe.",
    ].join("\n");
  }
  return "";
}
