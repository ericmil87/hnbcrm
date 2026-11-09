/**
 * Formatador ÚNICO de título/corpo das notificações do sino (B2).
 *
 * Todo `createNotification` monta `title`/`body` por aqui (guard
 * `notificationTypesParity.test.ts`). Regras:
 * - PT-BR com o vocabulário do app (`src/lib/vocab.ts`: "pedido de ajuda",
 *   "Resposta sugerida", "Conversas"), sem aspas misturadas.
 * - Datas/horas no FUSO DA ORG (`settings.timezone`; inválido/ausente =
 *   America/Sao_Paulo, via `safeTimezone`).
 * - Nome do contato ≤ 24 grafemas, demais nomes ≤ 48, corpo ≤ 140. Corte por
 *   `Intl.Segmenter` quando o runtime tem; senão por code point agrupando
 *   marcas combinantes, ZWJ, seletores de variação, tons de pele e bandeiras.
 * - NUNCA telefone ou e-mail no texto: nome que é telefone/e-mail vira
 *   "Contato"; trechos livres passam por `scrubPii`. O texto pode chegar à
 *   tela de bloqueio (push, PR-E).
 *
 * Módulo puro: sem ctx, sem relógio (o `now` vem de quem chama).
 */
import { safeTimezone } from "./promptDateTime";
import { languageName, sameLanguage, DEFAULT_TEAM_LANGUAGE } from "./languages";

export const CONTACT_MAX = 24;
export const NAME_MAX = 48;
export const BODY_MAX = 140;
export const CONTACT_FALLBACK = "Contato";

export type NotificationCopy = { title: string; body?: string };

export type CopyInput =
  | { type: "task_assigned"; taskTitle: string; actorName?: string; dueAt?: number }
  | { type: "task_comment_mention"; taskTitle: string; actorName: string; excerpt: string }
  | { type: "task_due_soon"; taskTitle: string; dueAt?: number; /** Lembrete disparado no prazo: "vence agora". */ dueNow?: boolean; /** Lembrete adiado ("Adiar") já depois do prazo: "Lembrete: {tarefa}". */ snoozed?: boolean }
  | { type: "task_overdue"; taskTitle: string; dueAt?: number }
  | { type: "handoff_requested"; contactName?: string; reason?: string; fromHumanName?: string }
  | { type: "handoff_resolved"; contactName?: string; actorName: string; outcome: "accepted" | "rejected" }
  | { type: "ai_draft_pending"; contactName?: string; groupName?: string; count?: number }
  | { type: "campaign_completed"; campaignName: string; sent: number; failed: number; replied: number }
  | { type: "campaign_paused"; campaignName: string; reason?: string }
  | { type: "group_joined"; groupName: string }
  | {
      type: "group_mention";
      groupName: string;
      senderName?: string;
      preview?: string;
      keyword?: string;
      count?: number;
    }
  | { type: "group_post_pending"; postName: string; preview?: string }
  | { type: "group_post_failed"; postName: string; reason?: string; kind: "paused" | "not_sent" | "ai_failed" }
  | { type: "group_opportunity"; groupName: string; label: string; memberName?: string; summary: string }
  | { type: "group_digest"; groupName: string; summary: string }
  | { type: "ai_followup_needs_human"; contactName?: string; taskTitle?: string; reason: string }
  | {
      type: "conversation_transferred";
      kind: "assign" | "transfer";
      actorName: string;
      contactName?: string;
      departmentName?: string;
      note?: string;
    }
  | {
      type: "channel_session_lost";
      provider: "whatsapp" | "meta";
      channelName: string;
      state?: string;
      detail?: string;
    }
  | { type: "ai_spend_warning"; pct: number; costBrl: string; capBrl: string; month: string }
  | { type: "ai_spend_reached"; costBrl: string; capBrl: string; blockMode: boolean }
  | { type: "new_message"; contactName?: string; count: number; preview?: string }
  | { type: "lead_assigned"; leadTitle: string; actorName?: string };

export type CopyOptions = { timeZone?: string | null; now?: number };

// ---------------------------------------------------------------------------
// Grafemas
// ---------------------------------------------------------------------------

export function hasIntlSegmenter(): boolean {
  return typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function";
}

const ZWJ = 0x200d;
const isVariationSelector = (cp: number) => (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isTag = (cp: number) => cp >= 0xe0020 && cp <= 0xe007f;
const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const MARK = /\p{M}/u;

/** Fallback sem `Intl.Segmenter`: code points com junção das sequências comuns. */
function clustersByCodePoint(text: string): string[] {
  const out: string[] = [];
  let prevZwj = false;
  let riOpen = false; // primeira metade de uma bandeira à espera da segunda
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const joins =
      out.length > 0 &&
      (prevZwj ||
        cp === ZWJ ||
        isVariationSelector(cp) ||
        isSkinTone(cp) ||
        isTag(cp) ||
        MARK.test(ch) ||
        (riOpen && isRegionalIndicator(cp)));
    if (joins) {
      out[out.length - 1] += ch;
      if (isRegionalIndicator(cp)) riOpen = false;
    } else {
      out.push(ch);
      riOpen = isRegionalIndicator(cp);
    }
    prevZwj = cp === ZWJ;
  }
  return out;
}

export function splitGraphemes(text: string, opts: { useSegmenter?: boolean } = {}): string[] {
  const use = opts.useSegmenter ?? hasIntlSegmenter();
  if (use) {
    const Seg = (Intl as unknown as { Segmenter: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  }
  return clustersByCodePoint(text);
}

/** Corta em `max` grafemas (o "…" conta como um). Nunca parte emoji, família ou bandeira. */
export function truncateGraphemes(text: string, max: number, opts: { useSegmenter?: boolean } = {}): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const parts = splitGraphemes(clean, opts);
  if (parts.length <= max) return clean;
  return `${parts.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// PII
// ---------------------------------------------------------------------------

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
// Sequência com ≥ 8 dígitos (com +, espaço, parênteses, ponto ou hífen no meio).
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

/** Tira e-mails e números longos (telefone, CPF) de um trecho livre. */
export function scrubPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[e-mail]")
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 8 ? "[telefone]" : m));
}

/** Nome exibível: telefone/e-mail (ou vazio) vira o rótulo genérico. */
export function safeName(name: string | null | undefined, max: number, fallback: string): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return fallback;
  const scrubbed = scrubPii(raw).replace(/\[(?:e-mail|telefone)\]/g, "").replace(/\s+/g, " ").trim();
  if (!/[\p{L}]/u.test(scrubbed)) return fallback;
  return truncateGraphemes(scrubbed, max);
}

export const contactLabel = (name?: string | null) => safeName(name, CONTACT_MAX, CONTACT_FALLBACK);
const entity = (name: string | null | undefined, fallback: string) => safeName(name, NAME_MAX, fallback);

function bodyOf(text: string | null | undefined): string | undefined {
  const raw = (text ?? "").trim();
  if (!raw) return undefined;
  return truncateGraphemes(scrubPii(raw), BODY_MAX);
}

// ---------------------------------------------------------------------------
// Datas no fuso da org
// ---------------------------------------------------------------------------

function dayKey(ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ts);
}

export function formatTimeInZone(ts: number, timeZone?: string | null): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: safeTimezone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ts);
}

/** "às 14:30" / "amanhã às 14:30" / "ontem às 14:30" / "em 08/11 às 14:30". */
export function whenLabel(ts: number, opts: CopyOptions): string {
  const tz = safeTimezone(opts.timeZone);
  const time = formatTimeInZone(ts, tz);
  if (opts.now === undefined) {
    const date = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(ts);
    return `em ${date} às ${time}`;
  }
  const day = dayKey(ts, tz);
  const DAY = 24 * 60 * 60 * 1000;
  if (day === dayKey(opts.now, tz)) return `às ${time}`;
  if (day === dayKey(opts.now + DAY, tz)) return `amanhã às ${time}`;
  if (day === dayKey(opts.now - DAY, tz)) return `ontem às ${time}`;
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(ts);
  return `em ${date} às ${time}`;
}

// ---------------------------------------------------------------------------
// Prévia de mensagem (multilíngue)
// ---------------------------------------------------------------------------

export type PreviewMessage = {
  content: string;
  contentType: string;
  translatedText?: string;
  transcriptText?: string;
  metadata?: Record<string, unknown> | null;
};

/** "inglês", "espanhol", "português (Portugal)" — para "(traduzido do …)". */
function languageLower(code: string): string {
  const name = languageName(code);
  return name ? name.charAt(0).toLowerCase() + name.slice(1) : code;
}

/**
 * Texto de UMA mensagem do cliente para a prévia: tradução pronta da org
 * (`metadata.translation.status === "done"` + `translatedText`) com
 * "(traduzido do inglês)"; senão o original. Mídia vira rótulo curto.
 */
export function translatedPreview(
  m: Pick<PreviewMessage, "translatedText" | "metadata">,
  /** Idioma da equipe da org (`resolveTranslationSettings(org).teamLanguage`); ausente = pt-BR. */
  teamLanguage?: string
): string | undefined {
  const t = m.metadata?.translation as { status?: string; sourceLang?: string } | undefined;
  if (t?.status !== "done" || !m.translatedText?.trim()) return undefined;
  const team = teamLanguage || DEFAULT_TEAM_LANGUAGE;
  const lang = t.sourceLang && !sameLanguage(t.sourceLang, team) ? t.sourceLang : undefined;
  return lang ? `${m.translatedText.trim()} (traduzido do ${languageLower(lang)})` : m.translatedText.trim();
}

export function messagePreview(m: PreviewMessage, teamLanguage?: string): string {
  const translated = translatedPreview(m, teamLanguage);
  if (translated) return translated;
  const text = m.content?.trim() ?? "";
  switch (m.contentType) {
    case "image":
      return text && !/^\[[^\]]*\]$/.test(text) ? `Foto: ${text}` : "Foto";
    case "audio":
      return m.transcriptText?.trim() ? `Áudio: ${m.transcriptText.trim()}` : "Áudio";
    case "file":
      return "Arquivo";
    default:
      return text;
  }
}

// ---------------------------------------------------------------------------
// Formatador
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function notificationCopy(input: CopyInput, opts: CopyOptions = {}): NotificationCopy {
  switch (input.type) {
    case "task_assigned": {
      const task = entity(input.taskTitle, "Tarefa");
      const due = input.dueAt ? ` · vence ${whenLabel(input.dueAt, opts)}` : "";
      return {
        title: input.actorName ? `${entity(input.actorName, "Alguém")} atribuiu uma tarefa a você` : "Nova tarefa para você",
        body: bodyOf(`${task}${due}`),
      };
    }
    case "task_comment_mention":
      return {
        title: `${entity(input.actorName, "Alguém")} mencionou você em ${entity(input.taskTitle, "uma tarefa")}`,
        body: bodyOf(input.excerpt),
      };
    case "task_due_soon": {
      const task = entity(input.taskTitle, "Tarefa");
      return {
        title: input.snoozed
          ? `Lembrete: ${task}`
          : input.dueNow
          ? `${task} vence agora`
          : input.dueAt
            ? `${task} vence ${whenLabel(input.dueAt, opts)}`
            : `${task} vence em breve`,
        body: "Lembrete da tarefa",
      };
    }
    case "task_overdue":
      return {
        title: `Tarefa atrasada: ${entity(input.taskTitle, "Tarefa")}`,
        body: input.dueAt ? `Venceu ${whenLabel(input.dueAt, opts)}` : undefined,
      };
    case "handoff_requested": {
      const who = input.fromHumanName ? entity(input.fromHumanName, "Alguém") : "A IA";
      return { title: `${who} pediu ajuda: ${contactLabel(input.contactName)}`, body: bodyOf(input.reason) };
    }
    case "handoff_resolved": {
      const actor = entity(input.actorName, "Alguém");
      const contact = contactLabel(input.contactName);
      return {
        title:
          input.outcome === "accepted"
            ? `${actor} assumiu a conversa com ${contact}`
            : `${actor} devolveu à IA a conversa com ${contact}`,
      };
    }
    case "ai_draft_pending": {
      const n = Math.max(1, input.count ?? 1);
      const where = input.groupName ? `o grupo ${entity(input.groupName, "Grupo")}` : contactLabel(input.contactName);
      return {
        title: n === 1 ? `A IA sugeriu uma resposta para ${where}` : `A IA sugeriu ${n} respostas para ${where}`,
        body: "Resposta sugerida aguardando sua revisão",
      };
    }
    case "campaign_completed":
      return {
        title: `Campanha ${entity(input.campaignName, "sem nome")} concluída`,
        body: `${input.sent} ${plural(input.sent, "enviada", "enviadas")} · ${input.failed} ${plural(input.failed, "falha", "falhas")} · ${input.replied} ${plural(input.replied, "resposta", "respostas")}`,
      };
    case "campaign_paused":
      return {
        title: `Campanha ${entity(input.campaignName, "sem nome")} pausada por segurança`,
        body: bodyOf(input.reason),
      };
    case "group_joined":
      return {
        title: `Entrou no grupo ${entity(input.groupName, "sem nome")}`,
        body: "Marque Acompanhar para as mensagens deste grupo aparecerem em Conversas.",
      };
    case "group_mention": {
      const group = entity(input.groupName, "um grupo");
      const n = Math.max(1, input.count ?? 1);
      const title = input.keyword
        ? `${truncateGraphemes(input.keyword, 24)} no grupo ${group}${n > 1 ? ` (${n})` : ""}`
        : n === 1
          ? `Mencionaram você no grupo ${group}`
          : `${n} menções a você no grupo ${group}`;
      const sender = safeName(input.senderName, CONTACT_MAX, "Um membro");
      return { title, body: bodyOf(input.preview ? `${sender}: ${input.preview}` : undefined) };
    }
    case "group_post_pending":
      return { title: `Aprovar publicação ${entity(input.postName, "sem nome")}`, body: bodyOf(input.preview) };
    case "group_post_failed": {
      const post = entity(input.postName, "sem nome");
      const title =
        input.kind === "paused"
          ? `Publicação ${post} foi pausada`
          : input.kind === "not_sent"
            ? `Publicação ${post} não foi enviada`
            : `A IA não conseguiu escrever a publicação ${post}`;
      return { title, body: bodyOf(input.reason) };
    }
    case "group_opportunity":
      return {
        title: `${input.label} no grupo ${entity(input.groupName, "sem nome")}`,
        body: bodyOf(`${safeName(input.memberName, CONTACT_MAX, "Um membro")}: ${input.summary}`),
      };
    case "group_digest":
      return { title: `Resumo do dia: ${entity(input.groupName, "grupo")}`, body: bodyOf(input.summary) };
    case "ai_followup_needs_human":
      return {
        title: input.contactName
          ? `A IA não conseguiu fazer o follow-up: ${contactLabel(input.contactName)}`
          : "A IA não conseguiu fazer o follow-up",
        body: bodyOf(input.taskTitle ? `${input.taskTitle} · ${input.reason}` : input.reason),
      };
    case "conversation_transferred": {
      const actor = entity(input.actorName, "Alguém");
      const contact = contactLabel(input.contactName);
      const title =
        input.kind === "assign"
          ? `${actor} atribuiu a conversa com ${contact} a você`
          : input.departmentName
            ? `${actor} transferiu a conversa com ${contact} para ${entity(input.departmentName, "o setor")}`
            : `${actor} transferiu a conversa com ${contact} para você`;
      return { title, body: bodyOf(input.note) };
    }
    case "channel_session_lost": {
      if (input.provider === "whatsapp") {
        return {
          title: `WhatsApp ${entity(input.channelName, "Número")} perdeu a conexão`,
          body: bodyOf(input.detail),
        };
      }
      const label = entity(input.channelName, "Página");
      const page = /^página\b/i.test(label) ? label : `Página ${label}`;
      if (input.state === "revoked") return { title: `A autorização da ${page} foi removida`, body: bodyOf(input.detail) };
      if (input.state === "reauth_required") return { title: `${page} precisa ser reconectada`, body: bodyOf(input.detail) };
      return { title: `Reconecte ${label} para manter o acesso`, body: "Reconecte a conta para manter o acesso às mensagens." };
    }
    case "ai_spend_warning":
      return {
        title: `Gasto de IA em ${Math.round(input.pct)}% do teto do mês`,
        body: `Gasto aproximado ${input.costBrl} de ${input.capBrl} em ${input.month}.`,
      };
    case "ai_spend_reached":
      return input.blockMode
        ? {
            title: "Teto de gastos de IA atingido: IA só sugere respostas",
            body: bodyOf(
              `Gasto aproximado ${input.costBrl} de ${input.capBrl}. Os outros recursos de IA ficam suspensos até o próximo mês.`
            ),
          }
        : {
            title: "Teto de gastos de IA atingido",
            body: `Gasto aproximado ${input.costBrl} de ${input.capBrl}. A IA continua funcionando.`,
          };
    case "new_message": {
      const n = Math.max(1, input.count);
      const contact = contactLabel(input.contactName);
      return {
        title: n === 1 ? `Mensagem nova de ${contact}` : `${n} mensagens novas de ${contact}`,
        body: bodyOf(input.preview),
      };
    }
    case "lead_assigned": {
      const lead = contactLabel(input.leadTitle);
      return {
        title: input.actorName ? `${entity(input.actorName, "Alguém")} atribuiu o lead ${lead} a você` : `Lead ${lead} atribuído a você`,
      };
    }
  }
}

/** Todos os tipos que o formatador cobre (paridade com o schema). */
export const COPY_TYPES = [
  "task_assigned",
  "task_comment_mention",
  "task_due_soon",
  "task_overdue",
  "handoff_requested",
  "handoff_resolved",
  "ai_draft_pending",
  "campaign_completed",
  "campaign_paused",
  "group_joined",
  "group_mention",
  "group_post_pending",
  "group_post_failed",
  "group_opportunity",
  "group_digest",
  "ai_followup_needs_human",
  "conversation_transferred",
  "channel_session_lost",
  "ai_spend_warning",
  "ai_spend_reached",
  "new_message",
  "lead_assigned",
] as const satisfies readonly CopyInput["type"][];
