/**
 * Códigos de motivo que o backend grava em `aiReplyQueue.error` quando um item
 * termina `skipped` e que `attendant.getConversationAiState` devolve ao chip
 * "IA em espera" do inbox. Fonte única: o front mapeia cada código para uma
 * frase PT-BR (`src/lib/aiStateReasons.ts`) e um teste de build quebra se
 * algum ficar sem rótulo. Ao criar um motivo novo de skip, ACRESCENTE aqui.
 *
 * Não inclui `failed` (texto livre do erro) nem motivos de follow-up
 * (`origin:"follow_up"` fica fora do chip).
 */
export const AI_STATE_REASON_CODES = [
  // elegibilidade do atendente 1 a 1 (evaluateEligibility)
  "conversa_de_grupo",
  "ia_desativada",
  "atendente_desativado",
  "sem_atendente",
  "ia_pausada",
  "handoff_pendente",
  "suspeita_de_bot",
  "lead_de_humano",
  "opt_out",
  "fora_do_horario",
  "teto_conversa",
  "teto_hora",
  "bridge_sem_aceite",
  "janela_24h",
  // claim / commit do turno
  "conversa_removida",
  "budget_mensal",
  "rascunho_ja_revisado",
  "humano_respondeu",
  "cliente_falou",
  "lock_perdido",
  // agente de grupo (groupAgentCore + loadGroupTurnContext)
  "agente_de_grupo_desativado",
  "canal_sem_grupos",
  "canal_inativo",
  "grupos_desligados_no_numero",
  "grupos_sem_aceite",
  "grupo_nao_monitorado",
  "fora_do_grupo",
  "ia_do_grupo_desligada",
  "teto_dia",
  "sem_resposta",
  "escopo_divergente",
  "conversa_nao_e_grupo",
  "grupo_removido",
  "org_removida",
  "canal_removido",
] as const;

export type AiStateReasonCode = (typeof AI_STATE_REASON_CODES)[number];
