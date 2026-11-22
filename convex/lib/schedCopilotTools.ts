/**
 * Agenda v2 (E1) — tools do COPILOTO para operar a agenda. PURO (sem `ctx`): specs, referências curtas, datas
 * relativas, argumentos e textos. A execução mora em `lib/schedCopilotOps.ts`.
 *
 * O Copiloto ajuda a EQUIPE (painel e Telegram) e age COMO o membro que conversa com ele: ator humano, origem
 * `staff`, `via:"copilot"` (ou `"telegram"`) na auditoria, permissão `agenda` DO MEMBRO conferida a cada chamada.
 *
 * Regras de desenho:
 *  - LEITURA roda direto (`agenda: view_own`+; quem só tem `view_own` recebe só os próprios agendamentos).
 *  - ESCRITA é sempre em duas fases: a tool monta a prévia (portas em `mode:"preview"`), grava uma `pendingActions`
 *    e devolve `confirmacao_necessaria`; quem executa é a confirmação do membro (botão no painel, botão no
 *    Telegram), nunca um argumento do modelo. Nenhuma tool daqui entra em `autoWriteTools`.
 *  - O modelo nunca inventa data, hora nem id: a data relativa é resolvida aqui no fuso da org; o horário vem de
 *    uma OFERTA (referência curta devolvida por `findFreeTimes` NESTA conversa) ou de `startLocal` validado pela
 *    prévia; o agendamento vem de uma REFERÊNCIA devolvida pelas tools de leitura NESTA conversa.
 *  - Texto de terceiros (nome de contato) é sanitizado (`safeText`) e só chega ao modelo dentro do envelope
 *    de resultado de tool (`wrapUntrustedJson`, em `copilotTurn`).
 */
import type { AgentToolSpec } from "./agentTools";
import { type DateRef, resolveDateRef } from "./schedRelativeDates";
import {
  addLocalDays,
  assertValidTimezone,
  atLocalMinutes,
  formatLocalDateLabel,
  isValidLocalDate,
  type LocalDate,
  localDateOf,
  minutesOfDay,
  weekdayOf,
} from "./schedTime";
import { normalizeText } from "./schedAttendantTools";

// ---------------------------------------------------------------------------
// Nomes das tools
// ---------------------------------------------------------------------------

export const SCHED_COPILOT_READ_NAMES = ["getAgendaDay", "listAgendaPending", "findFreeTimes", "findAgendaGaps"] as const;
export const SCHED_COPILOT_WRITE_NAMES = [
  "bookAppointment",
  "rescheduleAppointment",
  "cancelAppointment",
  "approveAppointment",
  "rejectAppointment",
  "setAppointmentStatus",
  "undoAppointmentChange",
  "closeResourceDay",
  "reopenResourceDay",
  "resolveAgendaConflict",
] as const;
export const SCHED_COPILOT_TOOL_NAMES: readonly string[] = [...SCHED_COPILOT_READ_NAMES, ...SCHED_COPILOT_WRITE_NAMES];

export function isSchedCopilotTool(name: string): boolean {
  return SCHED_COPILOT_TOOL_NAMES.includes(name);
}
export function isSchedCopilotReadTool(name: string): boolean {
  return (SCHED_COPILOT_READ_NAMES as readonly string[]).includes(name);
}
export function isSchedCopilotWriteTool(name: string): boolean {
  return (SCHED_COPILOT_WRITE_NAMES as readonly string[]).includes(name);
}

/** Teto de itens que uma leitura devolve ao modelo (o resto vira `ha_mais`). */
export const MAX_LIST_ITEMS = 25;
export const MAX_GAP_DAYS = 7;
export const DEFAULT_GAP_MIN = 30;
export const MAX_FIND_RESULTS = 8;
/** Validade da prévia (a mesma do resto do Copiloto: o chamador passa o TTL; este é o padrão dos testes). */
export const SCHED_PREVIEW_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const SCHED_READ_RESULT_FIELDS = ["status", "resumo", "itens", "vagas", "contagens", "ha_mais", "error", "proximo_passo"];
export const SCHED_WRITE_RESULT_FIELDS = ["status", "error", "proximo_passo", "pendingActionId", "preview", "avisos", "atencao", "message"];

const DATE_HELP =
  "'hoje', 'amanha', 'depois_de_amanha', 'ontem', um dia da semana ('segunda'...'domingo' = a próxima ocorrência a partir de hoje) ou AAAA-MM-DD. O servidor calcula a data no fuso da organização: NUNCA calcule datas você mesmo.";
const START_HELP =
  "Horário do atendimento. Use `offer` (referência devolvida por findFreeTimes nesta conversa) OU `startLocal` (AAAA-MM-DDTHH:mm, hora local da organização, só se a equipe disse data e hora explícitas).";
const REF_HELP = "Referência curta do agendamento (campo `ref`) devolvida por getAgendaDay ou listAgendaPending NESTA conversa. Nunca invente.";

const START_PROPS = {
  offer: { type: "string", description: "Referência de horário devolvida por findFreeTimes nesta conversa (ex.: o3x1.ab2)" },
  startLocal: { type: "string", description: "AAAA-MM-DDTHH:mm no fuso da organização (encaixe com data e hora explícitas)" },
};

export const SCHED_COPILOT_READ_TOOLS: AgentToolSpec[] = [
  {
    name: "getAgendaDay",
    description:
      "Agenda de um dia (o que a equipe tem hoje, amanhã, na quinta): agendamentos com horário, cliente, serviço, sala/profissional e situação, mais o resumo de vagas por sala/profissional. Quem só vê a própria agenda recebe só os próprios agendamentos. Cada item traz `ref` para remarcar/cancelar/aprovar.",
    parameters: objectSchema(
      {
        date: { type: "string", description: `Dia. ${DATE_HELP}` },
        resourceName: { type: "string", description: "Opcional: só uma sala/profissional/equipamento (nome como na agenda)" },
      },
      ["date"]
    ),
    permission: { category: "agenda", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: SCHED_READ_RESULT_FIELDS,
  },
  {
    name: "listAgendaPending",
    description:
      "Pendências da agenda: propostas aguardando aprovação, agendamentos sem lugar (conflito), sem desfecho (já passaram e ninguém marcou atendido/faltou) e sugestões. Devolve contagens e os primeiros itens com `ref`.",
    parameters: objectSchema({}, []),
    permission: { category: "agenda", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: SCHED_READ_RESULT_FIELDS,
  },
  {
    name: "findFreeTimes",
    description:
      "Busca horários LIVRES para um serviço (mesma busca da tela, com os motivos e o 'encostado' no atendimento vizinho). Devolve até 8 horários, cada um com `ref` (referência para marcar). Use antes de bookAppointment.",
    parameters: objectSchema(
      {
        serviceName: { type: "string", description: "Nome do serviço (como no catálogo da agenda)" },
        date: { type: "string", description: `Dia ou janela. ${DATE_HELP} Também 'esta_semana' ou 'proxima_semana' (até 7 dias).` },
        period: { type: "string", enum: ["manha", "tarde", "noite", "qualquer"], description: "Opcional: período do dia" },
        resourceName: { type: "string", description: "Opcional: só esta sala/profissional" },
        people: { type: "integer", description: "Opcional: pessoas juntas (1 a 4)" },
        limit: { type: "integer", description: "Opcional: quantos horários (1 a 8; padrão 5)" },
      },
      ["serviceName", "date"]
    ),
    permission: { category: "agenda", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: SCHED_READ_RESULT_FIELDS,
  },
  {
    name: "findAgendaGaps",
    description:
      "Buracos da agenda: janelas livres entre atendimentos, por sala/profissional, no dia ou até 7 dias. Para a equipe saber onde encaixar alguém.",
    parameters: objectSchema(
      {
        date: { type: "string", description: `Primeiro dia. ${DATE_HELP}` },
        days: { type: "integer", description: "Opcional: quantos dias (1 a 7; padrão 1)" },
        minMinutes: { type: "integer", description: "Opcional: tamanho mínimo do buraco em minutos (padrão 30)" },
        resourceName: { type: "string", description: "Opcional: só esta sala/profissional" },
        includeEdges: { type: "boolean", description: "Opcional: inclui também a sobra no começo/fim do expediente (padrão: só entre atendimentos)" },
      },
      ["date"]
    ),
    permission: { category: "agenda", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: SCHED_READ_RESULT_FIELDS,
  },
];

const RESOURCE_NAME_HELP =
  "SÓ se o usuário pediu essa sala/profissional/equipamento com as palavras dele; nunca por conta própria. Omitido, o sistema mantém o profissional, usa a sala atual e, se ela estiver fechada, bloqueada ou cheia, a prévia propõe outra sala equivalente livre (e diz a troca) ou recusa. Citado e fechado: a prévia mostra ATENÇÃO e a confirmação vale como exceção consciente.";

const WRITE_NOTE =
  " Escrita em DUAS FASES: esta ferramenta só monta a prévia e devolve confirmacao_necessaria; nada muda até o usuário confirmar no cartão. Avisos de regra aparecem na prévia e a decisão é dele. Nenhuma mensagem é enviada ao cliente.";

export const SCHED_COPILOT_WRITE_TOOLS: AgentToolSpec[] = [
  {
    name: "bookAppointment",
    description:
      "Marca horário para um contato/lead. O contato vem do `id` de searchContacts (ou do leadId de listLeads): se a busca trouxer mais de um candidato, PERGUNTE qual antes. O horário vem de `offer` (findFreeTimes) ou `startLocal` explícito." +
      WRITE_NOTE,
    parameters: objectSchema(
      {
        contactId: { type: "string", description: "id do contato (searchContacts)" },
        leadId: { type: "string", description: "id do lead (listLeads), alternativa ao contactId" },
        serviceName: { type: "string", description: "Nome do serviço" },
        ...START_PROPS,
        resourceName: { type: "string", description: RESOURCE_NAME_HELP },
        notes: { type: "string", description: "Opcional: observação interna curta" },
      },
      ["serviceName"]
    ),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "rescheduleAppointment",
    description: `Remarca um agendamento (de → para). ${REF_HELP} ${START_HELP}` + WRITE_NOTE,
    parameters: objectSchema({ ref: { type: "string", description: REF_HELP }, ...START_PROPS, resourceName: { type: "string", description: RESOURCE_NAME_HELP } }, ["ref"]),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "cancelAppointment",
    description: `Cancela um agendamento (a equipe cancela; o cliente NÃO é avisado por esta ferramenta). ${REF_HELP}` + WRITE_NOTE,
    parameters: objectSchema({ ref: { type: "string", description: REF_HELP }, reason: { type: "string", description: "Opcional: motivo curto" } }, ["ref"]),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "destructive",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "approveAppointment",
    description: `Aprova uma proposta que aguarda aprovação (vira marcado). ${REF_HELP}` + WRITE_NOTE,
    parameters: objectSchema({ ref: { type: "string", description: REF_HELP } }, ["ref"]),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "rejectAppointment",
    description: `Recusa uma proposta que aguarda aprovação (cancela a vaga; o cliente NÃO é avisado por aqui). ${REF_HELP}` + WRITE_NOTE,
    parameters: objectSchema({ ref: { type: "string", description: REF_HELP }, reason: { type: "string", description: "Opcional: motivo curto" } }, ["ref"]),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "destructive",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "setAppointmentStatus",
    description: `Marca a situação de um agendamento: confirmado, chegou, atendido (completed) ou faltou (no_show). ${REF_HELP}` + WRITE_NOTE,
    parameters: objectSchema(
      {
        ref: { type: "string", description: REF_HELP },
        to: { type: "string", enum: ["confirmed", "checked_in", "completed", "no_show"], description: "Nova situação" },
      },
      ["ref", "to"]
    ),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "undoAppointmentChange",
    description: `Desfaz a última mudança de situação de um agendamento (volta ao estado anterior). ${REF_HELP}` + WRITE_NOTE,
    parameters: objectSchema({ ref: { type: "string", description: REF_HELP } }, ["ref"]),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "closeResourceDay",
    description:
      "Fecha uma sala/profissional/equipamento em um dia (ou a agenda INTEIRA, só com permissão de gestão da agenda). A prévia mostra o impacto real: quantos mudam de sala, quantos ficam sem lugar. Profissional nunca é trocado sozinho; nada é cancelado nem enviado ao cliente." +
      WRITE_NOTE,
    parameters: objectSchema(
      {
        resourceName: { type: "string", description: "Sala/profissional/equipamento. Omita SÓ com wholeAgenda=true" },
        wholeAgenda: { type: "boolean", description: "true = fecha a agenda inteira da organização no dia (exige gestão da agenda)" },
        date: { type: "string", description: `Dia. ${DATE_HELP}` },
        reason: { type: "string", description: "Opcional: motivo curto" },
      },
      ["date"]
    ),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "destructive",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "reopenResourceDay",
    description:
      "Reabre uma sala/profissional/equipamento (ou a agenda inteira, com gestão) num dia que foi fechado. Não desfaz realocações já feitas." + WRITE_NOTE,
    parameters: objectSchema(
      {
        resourceName: { type: "string", description: "Sala/profissional/equipamento. Omita SÓ com wholeAgenda=true" },
        wholeAgenda: { type: "boolean", description: "true = reabre a agenda inteira no dia (exige gestão da agenda)" },
        date: { type: "string", description: `Dia. ${DATE_HELP}` },
      },
      ["date"]
    ),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
  {
    name: "resolveAgendaConflict",
    description:
      "Resolve um agendamento 'sem lugar' (conflito) listado por listAgendaPending: `useSuggestion` (aplica a sugestão N da lista), `reassign` (troca a sala/profissional), `reschedule` (novo horário) ou `cancel`. " +
      REF_HELP +
      WRITE_NOTE,
    parameters: objectSchema(
      {
        ref: { type: "string", description: REF_HELP },
        action: { type: "string", enum: ["useSuggestion", "reassign", "reschedule", "cancel"], description: "Como resolver" },
        suggestion: { type: "integer", description: "Para useSuggestion: número da sugestão (1, 2, 3) mostrada na lista" },
        resourceName: { type: "string", description: "Para reassign: sala/profissional que substitui o que saiu" },
        ...START_PROPS,
        reason: { type: "string", description: "Para cancel: motivo curto" },
      },
      ["ref", "action"]
    ),
    permission: { category: "agenda", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: SCHED_WRITE_RESULT_FIELDS,
  },
];

// ---------------------------------------------------------------------------
// Registro por membro: módulo ligado + nível do membro (o registry estático é filtrado por aqui)
// ---------------------------------------------------------------------------

export type SchedSessionInfo = { on: boolean; canView: boolean; canEdit: boolean; canManage: boolean };
export const SCHED_OFF: SchedSessionInfo = { on: false, canView: false, canEdit: false, canManage: false };

/** A spec entra no turno? Tool de agenda só com o módulo ligado e conforme a permissão `agenda` DO MEMBRO. */
export function schedSpecAllowed(spec: Pick<AgentToolSpec, "name" | "effect">, info: SchedSessionInfo | undefined): boolean {
  if (!isSchedCopilotTool(spec.name)) return true;
  if (!info || !info.on) return false;
  return spec.effect === "read" ? info.canView : info.canEdit;
}

/** Bloco do prompt (só quando há tools de agenda no turno). Curto: o detalhe está nas descrições das tools. */
export function schedPromptBlock(info: SchedSessionInfo | undefined): string {
  if (!info || !info.on || !info.canView) return "";
  const base =
    "AGENDA: você consulta a agenda de agendamentos de clientes (getAgendaDay, listAgendaPending, findFreeTimes, findAgendaGaps). Não calcule datas: passe 'hoje', 'amanha', dia da semana ou AAAA-MM-DD e o servidor resolve no fuso da organização. Responda com dia da semana e horário (ex.: qui, 27/11 às 14:30).";
  if (!info.canEdit) return `${base} O usuário só pode consultar a agenda.`;
  return `${base} Para marcar, remarcar, cancelar, aprovar, mudar situação, fechar sala/profissional ou resolver conflito, use as ferramentas de escrita: elas só montam a PRÉVIA e o usuário confirma no cartão (nada é enviado ao cliente). Marque só com o id vindo de searchContacts/listLeads; se houver mais de um candidato, pergunte. Use a referência (ref) devolvida pelas leituras desta conversa para remarcar/cancelar/aprovar, e o horário de findFreeTimes (offer). Avisos de regra: mostre ao usuário, a decisão é dele; se a prévia trouxer ATENÇÃO (recurso fechado que ELE pediu) ou \"Troca de lugar\", repita isso com clareza antes de pedir a confirmação. Só cite sala/profissional (resourceName) quando o usuário pedir.`;
}

// ---------------------------------------------------------------------------
// Referências curtas (por conversa, sem tabela)
// ---------------------------------------------------------------------------

/** Hash de 32 bits (FNV-1a) em base 36: determinístico, sem dependência. */
export function fnv36(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export type RefKind = "a" | "o";
const REF_RE = /^([ao])([0-9a-z]{3,8})\.([0-9a-z]{7})$/;

/** Verificação de 32 bits (7 caracteres em base 36), amarrada à conversa, ao documento/serviço E ao minuto da referência. */
function check(kind: RefKind, threadId: string, key: string, minute: number): string {
  return fnv36(`${threadId}|${kind}|${key}|${minute}`).padStart(7, "0").slice(-7);
}

/**
 * Referência curta de um agendamento (`a…`) ou de uma oferta de horário (`o…`) NESTA conversa do Copiloto.
 * Formato `<tipo><minuto do início em base 36>.<7 caracteres de verificação (32 bits)>`; a verificação cobre conversa, documento/serviço e minuto: o minuto permite achar o
 * agendamento pelo índice de início sem varrer a org, e a verificação amarra a referência à conversa e ao
 * documento (outra conversa, ou uma referência inventada, não confere). Quem usa SEMPRE confere a org e a
 * permissão do membro depois de resolver.
 */
export function makeRef(kind: RefKind, startTime: number, threadId: string, key: string): string {
  const minute = Math.floor(startTime / 60_000);
  return `${kind}${minute.toString(36)}.${check(kind, threadId, key, minute)}`;
}

export function parseRef(raw: unknown, kind: RefKind): { startMinute: number; check: string } | null {
  if (typeof raw !== "string") return null;
  const m = REF_RE.exec(raw.trim().toLowerCase());
  if (!m || m[1] !== kind) return null;
  const minute = parseInt(m[2], 36);
  if (!Number.isFinite(minute) || minute <= 0) return null;
  return { startMinute: minute, check: m[3] };
}

/** A verificação do candidato bate com a da referência? */
export function refMatches(kind: RefKind, parsed: { startMinute: number; check: string }, threadId: string, key: string): boolean {
  return check(kind, threadId, key, parsed.startMinute) === parsed.check;
}

// ---------------------------------------------------------------------------
// Datas (no fuso da org; nada de data calculada pelo modelo)
// ---------------------------------------------------------------------------

const WEEKDAY_BY_NAME: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};
const RANGE_TOKENS = new Set(["esta_semana", "proxima_semana", "proximos_dias"]);

function token(ref: string): string {
  return normalizeText(ref).replace(/-feira$/, "").replace(/[\s-]+/g, "_");
}

export type StaffDates = { ok: true; from: LocalDate; to: LocalDate; echo: string } | { ok: false; error: string };

/**
 * Datas relativas resolvidas aqui (`copilotDates`/`schedRelativeDates` não cobrem "quinta" nem "ontem"):
 * dia da semana = a próxima ocorrência a partir de HOJE (inclusive). `allowPast`: leituras da agenda aceitam
 * ontem e datas passadas; buscas de horário e escritas não.
 */
export function resolveStaffDates(ref: unknown, now: number, tz: string, opts: { range: boolean; allowPast: boolean }): StaffDates {
  assertValidTimezone(tz);
  if (typeof ref !== "string" || !ref.trim()) return { ok: false, error: "Informe o dia (hoje, amanhã, um dia da semana ou AAAA-MM-DD)." };
  const today = localDateOf(now, tz);
  const t = token(ref);
  const single = (d: LocalDate): StaffDates => ({ ok: true, from: d, to: d, echo: formatLocalDateLabel(d) });
  if (t === "ontem") return opts.allowPast ? single(addLocalDays(today, -1)) : { ok: false, error: "Esse dia já passou. Peça uma data a partir de hoje." };
  if (t in WEEKDAY_BY_NAME) {
    const delta = (WEEKDAY_BY_NAME[t] - weekdayOf(today) + 7) % 7;
    return single(addLocalDays(today, delta));
  }
  const iso = ref.trim();
  if (isValidLocalDate(iso)) {
    if (!opts.allowPast && iso < today) return { ok: false, error: `A data ${formatLocalDateLabel(iso)} já passou. Peça uma data a partir de hoje.` };
    return single(iso);
  }
  const res = resolveDateRef(ref as DateRef, now, tz);
  if (!res.ok) return res;
  if (!opts.range && (res.from !== res.to || RANGE_TOKENS.has(t))) return { ok: false, error: "Peça um dia só (hoje, amanhã, um dia da semana ou AAAA-MM-DD)." };
  return res;
}

/** `AAAA-MM-DDTHH:mm` (ou com espaço) na hora local da org → UTC ms. Hora inexistente (DST) é recusada. */
export function parseStartLocal(raw: unknown, tz: string): { ok: true; startTime: number; date: LocalDate; minutes: number } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Use startLocal no formato AAAA-MM-DDTHH:mm." };
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m || !isValidLocalDate(m[1])) return { ok: false, error: "Use startLocal no formato AAAA-MM-DDTHH:mm (hora local da organização)." };
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return { ok: false, error: "Hora inválida em startLocal." };
  const minutes = hh * 60 + mm;
  const startTime = atLocalMinutes(m[1], minutes, tz);
  if (localDateOf(startTime, tz) !== m[1] || minutesOfDay(startTime, tz) !== minutes) {
    return { ok: false, error: "Esse horário não existe nesse dia (mudança de horário de verão). Escolha outro." };
  }
  return { ok: true, startTime, date: m[1], minutes };
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

/** Texto de terceiros (nome de contato, motivo, observação) → uma linha curta, sem controle nem marcação. */
export function safeText(raw: unknown, max = 60): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[`<>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Tira pontos e espaços do fim (a prévia acrescenta o próprio ponto final). */
export function trimEndDots(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
/** Minutos do dia → "09:30" (1440 = "24:00"). */
export function hhmm(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}
export function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

const STATUS_PT: Record<string, string> = {
  pending_approval: "aguardando aprovação",
  scheduled: "marcado",
  confirmed: "confirmado",
  checked_in: "chegou",
  completed: "atendido",
  no_show: "faltou",
  cancelled: "cancelado",
  rescheduled: "remarcado",
};
export function statusPt(status: string): string {
  return STATUS_PT[status] ?? status;
}

/** Resource names + códigos de aviso → linha da prévia. */
export function warningsLine(warnings: ReadonlyArray<{ message: string }>): string {
  return warnings.map((w) => safeText(w.message, 140)).join("; ");
}

export type ViolationLike = { code: string; severity: "block" | "warn"; message: string };
/** Violações → texto curto (bloqueios primeiro). */
export function violationsText(violations: ReadonlyArray<ViolationLike>): string {
  const ordered = [...violations].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1));
  return ordered.map((v) => safeText(v.message, 160)).join(" ");
}

/** Nome de recurso/serviço citado pelo modelo: exato (sem acento nem caixa); senão único por trecho; senão ambíguo/ausente. */
export function matchByName<T extends { name: string }>(items: readonly T[], input: unknown): { kind: "one"; item: T } | { kind: "many"; items: T[] } | { kind: "none" } {
  const wanted = typeof input === "string" ? normalizeText(input) : "";
  if (!wanted) return { kind: "none" };
  const exact = items.filter((i) => normalizeText(i.name) === wanted);
  if (exact.length === 1) return { kind: "one", item: exact[0] };
  if (exact.length > 1) return { kind: "many", items: exact };
  const partial = items.filter((i) => normalizeText(i.name).includes(wanted));
  if (partial.length === 1) return { kind: "one", item: partial[0] };
  if (partial.length > 1) return { kind: "many", items: partial };
  return { kind: "none" };
}
