import type { AiStateReasonCode } from "../../convex/lib/aiStateReasons";

// Motivo (aiReplyQueue.error) → texto PT-BR amigável para o chip "IA em espera".
export const AI_STATE_REASON_LABELS: Record<AiStateReasonCode, string> = {
  conversa_de_grupo: "conversa de grupo (tratada pelo agente de grupo)",
  ia_desativada: "IA desativada",
  atendente_desativado: "atendente desativado",
  sem_atendente: "sem atendente configurado",
  ia_pausada: "IA pausada nesta conversa",
  handoff_pendente: "aguardando atendimento humano (repasse)",
  suspeita_de_bot: "suspeita de robô/mensagem automática — aguardando verificação",
  lead_de_humano: "lead atribuído a um humano",
  opt_out: "contato optou por não falar com IA",
  fora_do_horario: "fora do horário de atendimento",
  teto_conversa: "limite de respostas da conversa atingido",
  teto_hora: "limite de respostas por hora atingido",
  bridge_sem_aceite: "canal não-oficial sem aceite de risco",
  janela_24h: "janela de 24h fechada",
  conversa_removida: "conversa removida",
  budget_mensal: "limite mensal de conversas atingido",
  rascunho_ja_revisado: "o rascunho já foi revisado por uma pessoa",
  humano_respondeu: "uma pessoa da equipe respondeu primeiro",
  cliente_falou: "o cliente escreveu enquanto a IA preparava a resposta",
  lock_perdido: "outra resposta da IA estava em andamento nesta conversa",
  agente_de_grupo_desativado: "agente de grupo desativado",
  canal_sem_grupos: "este canal não suporta grupos",
  canal_inativo: "canal inativo",
  grupos_desligados_no_numero: "grupos desligados neste número",
  grupos_sem_aceite: "grupos sem o aceite de risco no número",
  grupo_nao_monitorado: "grupo não está sendo acompanhado",
  fora_do_grupo: "o número saiu do grupo",
  ia_do_grupo_desligada: "IA desligada neste grupo",
  teto_dia: "limite diário de respostas do grupo atingido",
  sem_resposta: "a IA decidiu não responder",
  escopo_divergente: "a configuração da sala mudou durante a resposta",
  conversa_nao_e_grupo: "conversa não é um grupo",
  grupo_removido: "grupo removido",
  org_removida: "organização removida",
  canal_removido: "canal removido",
};

export function aiStateReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "motivo desconhecido";
  return (AI_STATE_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}
