/**
 * "Um dia com o HNBCRM" (S7b): cenas de exemplo, assumidas como tal na seção
 * (uma linha discreta no fim), sem selo por item. Não são depoimento nem
 * métrica: nenhuma pessoa, marca ou número de cliente aparece aqui. A regra de
 * produção de depoimentos e logos continua em `socialProof.ts`.
 *
 * Princípio do produto: IA e pessoas no mesmo time. A IA nunca confirma
 * pagamento sozinha; quem decide é a equipe.
 */
export type MomentActor = "ia" | "equipe" | "ia-equipe";

export type MomentIcon = "sun" | "message" | "receipt" | "copilot" | "moon";

export interface DayMoment {
  id: string;
  /** Horário de exemplo, `HH:MM`. */
  time: string;
  icon: MomentIcon;
  title: string;
  text: string;
  actor: MomentActor;
}

export const ACTOR_LABEL: Record<MomentActor, string> = {
  ia: "IA",
  equipe: "Equipe",
  "ia-equipe": "IA + equipe",
};

export const DAY_IN_THE_LIFE: readonly DayMoment[] = [
  {
    id: "mensagem-do-dia",
    time: "07:30",
    icon: "sun",
    title: "A mensagem do dia sai no grupo",
    text: "A IA escreve, a equipe aprova no celular e ela é publicada na hora certa.",
    actor: "ia-equipe",
  },
  {
    id: "pergunta-sabado",
    time: "10:12",
    icon: "message",
    title: "Cliente pergunta se abre no sábado",
    text: "O Atendente sugere a resposta com o horário certo. A recepção aprova com um toque.",
    actor: "ia-equipe",
  },
  {
    id: "comprovante-pix",
    time: "13:40",
    icon: "receipt",
    title: "Chega um comprovante de Pix por foto",
    text: "A IA lê o valor e chama a equipe. Quem confirma o pagamento é uma pessoa, nunca a IA.",
    actor: "ia-equipe",
  },
  {
    id: "resumo-do-dia",
    time: "18:05",
    icon: "copilot",
    title: "O Copiloto resume o dia",
    text: "Ele lista as conversas e cria a tarefa de ligar para quem pediu preço.",
    actor: "ia",
  },
  {
    id: "audio-noite",
    time: "23:14",
    icon: "moon",
    title: "Cliente manda áudio fora do horário",
    text: "A IA responde e deixa o agendamento anotado. De manhã, a equipe confirma.",
    actor: "ia-equipe",
  },
];
