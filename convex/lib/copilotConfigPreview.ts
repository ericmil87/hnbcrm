/**
 * Prévia "Antes → Depois" e hash de estado das tools de configuração do
 * Atendente IA no Copiloto (fv2-16). Módulo PURO (sem `_generated`, sem I/O):
 * o executor em `copilotConfigTools.ts` monta os snapshots `before`/`after` e
 * grava o resultado em `pendingActions.preview`; o hash do `before` vai em
 * `args.beforeHash` e é recalculado na confirmação.
 */

export type ConfigSnapshot = Record<string, unknown>;

/** Máximo de linhas de diff mostradas em textos longos (persona, conhecimento). */
export const PREVIEW_MAX_DIFF_LINES = 12;
const MAX_LINE_CHARS = 120;

/** Frase fixa de risco do autopilot (também usada pelo executor). */
export const AUTOPILOT_RISK_LINE = "A IA vai responder sozinha aos clientes, sem aprovação";

const DAY_LABELS: Record<number, string> = {
  0: "dom",
  1: "seg",
  2: "ter",
  3: "qua",
  4: "qui",
  5: "sex",
  6: "sáb",
};
/** Ordem da semana para exibição: segunda primeiro, domingo por último. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export type DiffLine = { type: "-" | "+"; line: string };

/**
 * Diff de linhas simples (multiconjunto): linhas só do `before` saem como "-",
 * linhas só do `after` como "+". Linhas vazias são ignoradas. Sem dependência.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const split = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  const a = split(before);
  const b = split(after);
  const counts = new Map<string, number>();
  for (const l of b) counts.set(l, (counts.get(l) ?? 0) + 1);
  const removed: DiffLine[] = [];
  const left = new Map(counts);
  for (const l of a) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else removed.push({ type: "-", line: l });
  }
  const seen = new Map<string, number>();
  for (const l of a) seen.set(l, (seen.get(l) ?? 0) + 1);
  const added: DiffLine[] = [];
  for (const l of b) {
    const n = seen.get(l) ?? 0;
    if (n > 0) seen.set(l, n - 1);
    else added.push({ type: "+", line: l });
  }
  return [...removed, ...added];
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * Hash determinístico (FNV-1a 32 + djb2 32 sobre o JSON canônico, chaves
 * ordenadas, `undefined` ignorado). Não é criptográfico: serve só para detectar
 * que o estado mudou entre a proposta e a confirmação.
 */
export function hashBefore(value: unknown): string {
  const text = JSON.stringify(canonical(value) ?? null);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + c) >>> 0;
  }
  return fnv.toString(16).padStart(8, "0") + djb.toString(16).padStart(8, "0");
}

type Schedule = { timezone: string; startHour: number; endHour: number; days?: number[] } | null | undefined;

export function formatDays(days: number[] | undefined): string {
  const set = new Set(days ?? []);
  if (!days || days.length === 0 || set.size >= 7) return "todos os dias";
  const ordered = WEEK_ORDER.filter((d) => set.has(d));
  const runs: number[][] = [];
  for (const d of ordered) {
    const last = runs[runs.length - 1];
    if (last && WEEK_ORDER.indexOf(last[last.length - 1]!) + 1 === WEEK_ORDER.indexOf(d)) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) =>
      r.length >= 3
        ? `${DAY_LABELS[r[0]!]} a ${DAY_LABELS[r[r.length - 1]!]}`
        : r.map((d) => DAY_LABELS[d]).join(", ")
    )
    .join(", ");
}

export function formatSchedule(schedule: Schedule): string {
  if (!schedule) return "sempre (24 h)";
  return `${formatDays(schedule.days)}, ${schedule.startHour}h às ${schedule.endHour}h (${schedule.timezone})`;
}

function chars(n: number): string {
  return `${n} caractere${n === 1 ? "" : "s"}`;
}

function textStats(text: string): string {
  if (!text.trim()) return "vazio";
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return `${chars(text.length)}, ${lines} linha${lines === 1 ? "" : "s"}`;
}

function cutLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

function longTextBlock(label: string | null, before: unknown, after: unknown): string[] {
  const b = typeof before === "string" ? before : "";
  const a = typeof after === "string" ? after : "";
  const out: string[] = [];
  if (label) out.push(label);
  out.push(`Antes: ${textStats(b)}`, `Depois: ${textStats(a)}`);
  const diff = diffLines(b, a);
  const removed = diff.filter((d) => d.type === "-");
  const added = diff.filter((d) => d.type === "+");
  // Metade das linhas é reservada aos "+": o "Depois" nunca some, mesmo quando
  // o texto antigo foi todo removido. Com mais de 6 novas, mostra as 5 primeiras
  // e a ÚLTIMA (o fim do texto novo também é lido por quem confirma).
  const addBudget = Math.min(added.length, PREVIEW_MAX_DIFF_LINES / 2);
  const remShown = Math.min(removed.length, PREVIEW_MAX_DIFF_LINES - addBudget);
  const addCap = Math.min(added.length, PREVIEW_MAX_DIFF_LINES - remShown);
  for (const d of removed.slice(0, remShown)) out.push(`- ${cutLine(d.line)}`);
  if (removed.length > remShown) out.push(`(+${removed.length - remShown} linhas removidas)`);
  if (added.length <= addCap) {
    for (const d of added) out.push(`+ ${cutLine(d.line)}`);
  } else {
    for (const d of added.slice(0, addCap - 1)) out.push(`+ ${cutLine(d.line)}`);
    out.push(`(+${added.length - addCap} linhas adicionadas)`);
    out.push(`+ ${cutLine(added[added.length - 1]!.line)}`);
  }
  return out;
}

function scalarBlock(label: string | null, before: string, after: string): string[] {
  return [...(label ? [label] : []), `Antes: ${before}`, `Depois: ${after}`];
}

const MODE_LABEL: Record<string, string> = {
  suggest: "Sugestão (a IA prepara rascunhos e você aprova)",
  autopilot: "Automático / autopilot (a IA responde sozinha)",
};

const FOLLOW_MODE_LABEL: Record<string, string> = {
  off: "desligado",
  draft: "preparar rascunho",
  send: "enviar sozinha",
};

function followUpsText(f: unknown): string {
  const fu = (f ?? { mode: "draft" }) as {
    mode?: string;
    maxChain?: number;
    quietStartHour?: number;
    quietEndHour?: number;
    dailyCap?: number;
  };
  const parts = [`modo ${FOLLOW_MODE_LABEL[fu.mode ?? "draft"] ?? fu.mode}`];
  if (fu.maxChain !== undefined) parts.push(`até ${fu.maxChain} seguidos sem resposta`);
  if (fu.quietStartHour !== undefined || fu.quietEndHour !== undefined) {
    parts.push(`janela ${fu.quietStartHour ?? 8}h às ${fu.quietEndHour ?? 20}h`);
  }
  if (fu.dailyCap !== undefined) parts.push(fu.dailyCap === 0 ? "sem teto diário" : `teto de ${fu.dailyCap} por dia`);
  return parts.join(", ");
}

function yesNo(v: unknown): string {
  return v === true ? "ligado" : "desligado";
}

function listDiff(before: string[], after: string[]): string[] {
  const added = after.filter((k) => !before.includes(k));
  const removed = before.filter((k) => !after.includes(k));
  const out: string[] = [];
  if (added.length) out.push(`+ ${added.map(cutLine).join("; ")}`);
  if (removed.length) out.push(`- ${removed.map(cutLine).join("; ")}`);
  return out;
}

/**
 * Prévia PT-BR "Antes → Depois", sem markdown pesado (cabe no Telegram).
 * `before`/`after` são snapshots dos campos que a tool toca; `attendant` (nome
 * do atendente) pode vir em qualquer um dos dois.
 */
export function buildConfigPreview(tool: string, before: ConfigSnapshot, after: ConfigSnapshot): string {
  const who = (after.attendant ?? before.attendant) as string | undefined;
  const head = (what: string) => (who ? `Atendente "${who}": ${what}` : what);
  const lines: string[] = [];
  switch (tool) {
    case "updateAttendantPersona": {
      lines.push(head("jeito de atender (persona)"));
      if ("name" in after) lines.push(...scalarBlock("Nome", String(before.name ?? ""), String(after.name ?? "")));
      if ("systemPrompt" in after) lines.push(...longTextBlock("Persona", before.systemPrompt, after.systemPrompt));
      if ("language" in after) {
        lines.push(...scalarBlock("Idioma", String(before.language ?? "pt-BR"), String(after.language ?? "pt-BR")));
      }
      break;
    }
    case "updateAttendantKnowledge":
      lines.push(head("o que a IA sabe (conhecimento)"));
      lines.push(...longTextBlock(null, before.knowledge, after.knowledge));
      break;
    case "setAttendantMode":
      lines.push(head("modo de atendimento"));
      lines.push(...scalarBlock(null, MODE_LABEL[String(before.mode)] ?? String(before.mode), MODE_LABEL[String(after.mode)] ?? String(after.mode)));
      if (after.mode === "autopilot") lines.push(`Atenção: ${AUTOPILOT_RISK_LINE}.`);
      break;
    case "setAttendantHours":
      lines.push(head("horário de atendimento"));
      lines.push(...scalarBlock(null, formatSchedule(before.schedule as Schedule), formatSchedule(after.schedule as Schedule)));
      break;
    case "setHandoffRules": {
      const b = (before.handoffKeywords as string[] | undefined) ?? [];
      const a = (after.handoffKeywords as string[] | undefined) ?? [];
      lines.push(head("quando chamar a equipe (palavras de repasse)"));
      lines.push(`Antes: ${b.length} palavra${b.length === 1 ? "" : "s"}/frase${b.length === 1 ? "" : "s"}`);
      lines.push(`Depois: ${a.length} palavra${a.length === 1 ? "" : "s"}/frase${a.length === 1 ? "" : "s"}`);
      lines.push(...listDiff(b, a));
      lines.push('Obs.: com lista configurada, "atendente" ou "humano" soltos em mensagem curta deixam de chamar a equipe; só as frases valem.');
      break;
    }
    case "setFollowUpSettings":
      lines.push(head("follow-up automático"));
      lines.push(...scalarBlock(null, followUpsText(before.followUps), followUpsText(after.followUps)));
      if ((after.followUps as { mode?: string } | null | undefined)?.mode === "send") {
        lines.push(
          before.attendantMode === "autopilot"
            ? "Atenção: a IA vai enviar os follow-ups sozinha, sem aprovação."
            : "Atenção: os follow-ups serão enviados sozinhos quando o Atendente IA estiver em Responder sozinha."
        );
      }
      break;
    case "setAiFeatures": {
      lines.push("Recursos de IA (áudio e imagens)");
      if ("visionEnabled" in after) {
        lines.push(...scalarBlock("Leitura de imagens", yesNo(before.visionEnabled), yesNo(after.visionEnabled)));
      }
      const tb = (before.transcription ?? {}) as Record<string, unknown>;
      const ta = (after.transcription ?? {}) as Record<string, unknown>;
      for (const label of Object.keys(ta)) {
        lines.push(...scalarBlock(`Transcrição de áudio — ${label}`, yesNo(tb[label]), yesNo(ta[label])));
      }
      break;
    }
    default:
      lines.push(head("configuração"));
  }
  return lines.join("\n");
}
