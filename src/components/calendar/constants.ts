export const EVENT_TYPE_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  call: { bg: "bg-blue-500/20", border: "border-blue-500", text: "text-blue-400" },
  meeting: { bg: "bg-purple-500/20", border: "border-purple-500", text: "text-purple-400" },
  follow_up: { bg: "bg-amber-500/20", border: "border-amber-500", text: "text-amber-400" },
  demo: { bg: "bg-emerald-500/20", border: "border-emerald-500", text: "text-emerald-400" },
  task: { bg: "bg-brand-500/20", border: "border-brand-500", text: "text-brand-400" },
  reminder: { bg: "bg-rose-500/20", border: "border-rose-500", text: "text-rose-400" },
  other: { bg: "bg-zinc-500/20", border: "border-zinc-500", text: "text-zinc-400" },
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  call: "Ligação",
  meeting: "Reunião",
  follow_up: "Follow-up",
  demo: "Demo",
  task: "Tarefa",
  reminder: "Lembrete",
  other: "Outro",
};

export const EVENT_STATUS_LABELS: Record<string, string> = {
  scheduled: "Agendado",
  completed: "Concluído",
  cancelled: "Cancelado",
};

export const RECURRENCE_OPTIONS = [
  { value: "none", label: "Nenhuma" },
  { value: "daily", label: "Diária" },
  { value: "weekly", label: "Semanal" },
  { value: "biweekly", label: "Quinzenal" },
  { value: "monthly", label: "Mensal" },
];

export const WEEKDAYS_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sab"];
export const WEEKDAYS_LONG = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export const MONTHS_LONG = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

export const TIME_SLOTS = Array.from({ length: 17 }, (_, i) => 6 + i); // 6:00 to 22:00
