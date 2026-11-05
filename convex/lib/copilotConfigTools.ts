/**
 * Tools do Copiloto para LER e PROPOR mudanças no Atendente IA (fv2-16).
 * Chamadas por `copilot.ts` (ramo `default` dos executores) DEPOIS do
 * `assertAgentCan` (`settings:view` na leitura, `settings:manage` na escrita) e
 * por `copilotPendingActions.confirmPendingActionCore` na confirmação.
 *
 * Regras (plano de onboarding IA, seção C):
 *  - Fase 1 NUNCA escreve: grava `pendingActions` com `preview` Antes/Depois e
 *    `args` com ids resolvidos NO SERVIDOR + `beforeHash` do estado atual.
 *  - A execução (`executeConfigPendingAction`) passa pelos cores de
 *    `attendantConfigOps.ts` com `via` ("copilot" | "telegram") e re-checa
 *    permissão, e-mail, org, gate do autopilot e `beforeHash`.
 *  - O modelo nunca vê ids: atendente por NOME, canal por APELIDO.
 *  - NUNCA: ligar a IA, aceites (LGPD, bridge, autopilot antecipado), provider/
 *    modelo/teto, provisionar canal. Vira `requer_acao_humana` (instrução + url).
 *  - `scope.via === "telegram_auto"` é recusado: configuração só com confirmação.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { assertAgentCan, orgAiActive } from "./agentSecurity";
import { readAgentTexts } from "./agentProfileTexts";
import {
  computeAcceptanceMetrics,
  patchChannelTranscriptionCore,
  setFeatureTogglesCore,
  updateAgentProfileCore,
  type AgentProfilePatch,
} from "./attendantConfigOps";
import { requireAccountWithEmail } from "./auth";
import { MAX_CHAIN_LIMIT, MAX_DAILY_CAP } from "./followUpSettings";
import { DEFAULT_HANDOFF_KEYWORDS, normalizeHandoffText } from "./handoffKeywords";
import { renderPersonaSeed, segmentTemplate } from "./onboardingTemplates";
import { safeTimezone } from "./promptDateTime";
import { buildStatusDetail } from "../onboarding";
import {
  buildConfigPreview,
  formatSchedule,
  hashBefore,
  type ConfigSnapshot,
} from "./copilotConfigPreview";

const READ_TOOLS = ["getAttendantConfig", "getAttendantSetupGuide"] as const;
const WRITE_TOOLS = [
  "updateAttendantPersona",
  "updateAttendantKnowledge",
  "setAttendantMode",
  "setAttendantHours",
  "setHandoffRules",
  "setFollowUpSettings",
  "setAiFeatures",
] as const;

export const isConfigCopilotReadTool = (name: string) => (READ_TOOLS as readonly string[]).includes(name);
export const isConfigCopilotWriteTool = (name: string) => (WRITE_TOOLS as readonly string[]).includes(name);
/** `pendingActions.tool` = o próprio nome da tool de escrita. */
export const isConfigPendingTool = (tool: string) => isConfigCopilotWriteTool(tool);

export const TELEGRAM_AUTO_REFUSAL = "Mudanças de configuração só com sua confirmação";
export const CONFIG_CHANGED_MESSAGE = "A configuração mudou desde a proposta; peça de novo ao Copiloto";

const TEXT_LIMIT = 20_000;
const READ_TEXT_LIMIT = 6_000;
const AI_SETTINGS_URL = "/app/configuracoes?secao=ai";
const CHANNELS_URL = "/app/configuracoes?secao=channels";
const MIN_REVIEWED = 10;
const MIN_ACCEPTANCE = 0.6;

type Db = QueryCtx["db"];

export type ConfigWriteScope = {
  organizationId: Id<"organizations">;
  member: Doc<"teamMembers">;
  threadId?: Id<"copilotThreads">;
  pendingActionTtlMs: number;
  /** "telegram_auto" = turno automático do Telegram: sempre recusado. */
  via?: "copilot" | "telegram_auto";
};

const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

function humanAction(instruction: string, url: string, message?: string): Record<string, unknown> {
  return { status: "requer_acao_humana", instruction, url, ...(message ? { message } : {}) };
}

/** Remove `undefined` (recursivo): valores aninhados com undefined não são Convex values. */
function clean<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clean) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = clean(v);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Resolução (atendente por nome, canais por apelido)
// ---------------------------------------------------------------------------

async function listAttendants(db: Db, organizationId: Id<"organizations">): Promise<Doc<"teamMembers">[]> {
  const ais = await db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "ai"))
    .take(50);
  return ais.filter(
    (m) => m.agentProfile?.kind === "attendant" && m.removedAt === undefined && m.status !== "inactive"
  );
}

type Resolved = { agent: Doc<"teamMembers"> } | { fail: Record<string, unknown> };

async function resolveAttendant(db: Db, organizationId: Id<"organizations">, name: unknown): Promise<Resolved> {
  const attendants = await listAttendants(db, organizationId);
  if (attendants.length === 0) {
    return {
      fail: humanAction(
        "Esta organização ainda não tem Atendente IA. Crie um em Configurações › IA (o Copiloto não cria atendentes).",
        AI_SETTINGS_URL
      ),
    };
  }
  if (attendants.length === 1) return { agent: attendants[0]! };
  const wanted = typeof name === "string" ? norm(name) : "";
  const hit = wanted ? attendants.find((a) => norm(a.name) === wanted) : undefined;
  if (hit) return { agent: hit };
  return {
    fail: {
      error: wanted
        ? "Não encontrei um atendente com esse nome. Diga qual deles."
        : "Há mais de um atendente. Diga o nome do atendente.",
      attendants: attendants.map((a) => a.name),
    },
  };
}

async function whatsappChannels(db: Db, organizationId: Id<"organizations">) {
  const all = await db
    .query("channelConfigs")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(50);
  return all;
}

// ---------------------------------------------------------------------------
// Gate do autopilot (mesma regra do `updateAgentProfileCore`)
// ---------------------------------------------------------------------------

async function autopilotGate(ctx: { db: Db }, agent: Doc<"teamMembers">) {
  const m = await computeAcceptanceMetrics(ctx, agent.organizationId, agent._id);
  return { ok: m.reviewed >= MIN_REVIEWED && m.acceptanceRate >= MIN_ACCEPTANCE, reviewed: m.reviewed, rate: m.acceptanceRate };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function truncate(text: string): { text: string; cut: boolean } {
  return text.length > READ_TEXT_LIMIT
    ? { text: text.slice(0, READ_TEXT_LIMIT), cut: true }
    : { text, cut: false };
}

export async function runConfigCopilotReadTool(
  ctx: QueryCtx,
  name: string,
  args: Record<string, unknown>,
  scope: { organizationId: Id<"organizations"> }
): Promise<Record<string, unknown>> {
  const org = await ctx.db.get(scope.organizationId);
  if (!org) return { error: "Organização não encontrada" };

  if (name === "getAttendantSetupGuide") {
    const detail = await buildStatusDetail(ctx, org, false, true);
    const biz = detail.business;
    const segment = typeof args.segment === "string" && args.segment.trim() ? args.segment.trim() : detail.segment;
    const template = segmentTemplate(segment);
    const summary = [
      biz?.displayName && `Nome: ${biz.displayName}`,
      biz?.offer && `Oferta: ${biz.offer}`,
      biz?.audience && `Público: ${biz.audience}`,
      biz?.tone && `Tom: ${biz.tone}`,
      biz?.region && `Região: ${biz.region}`,
    ].filter(Boolean);
    const steps = detail.steps ?? {};
    return {
      segment: template.key,
      businessSummary: summary.length ? summary.join("\n") : "O negócio ainda não foi descrito.",
      personaSeed: renderPersonaSeed(template, {
        negocio: biz?.displayName ?? org.name,
        oferta: biz?.offer,
        tom: biz?.tone,
      }),
      faqSeed: template.faqSeed,
      handoffSeed: dedupeKeywords([...DEFAULT_HANDOFF_KEYWORDS, ...template.handoffKeywords]),
      missingSteps: Object.entries(steps)
        .filter(([, status]) => status === "pending")
        .map(([key]) => key),
    };
  }

  const resolved = await resolveAttendant(ctx.db, scope.organizationId, args.attendantName);
  if ("fail" in resolved) return resolved.fail;
  const { agent } = resolved;
  const profile = agent.agentProfile!;
  const texts = await readAgentTexts(ctx, agent);
  const persona = truncate(texts.systemPrompt ?? "");
  const knowledge = truncate(texts.knowledge ?? "");
  const channels = await whatsappChannels(ctx.db, scope.organizationId);
  const scoped = profile.channelConfigIds;
  const gate = await autopilotGate(ctx, agent);
  const aiConfig = org.settings.aiConfig;
  const warnings: string[] = [];
  if (persona.cut) warnings.push(`A persona tem ${(texts.systemPrompt ?? "").length} caracteres; mostrei só os primeiros ${READ_TEXT_LIMIT}.`);
  if (knowledge.cut) warnings.push(`O conhecimento tem ${(texts.knowledge ?? "").length} caracteres; mostrei só os primeiros ${READ_TEXT_LIMIT}.`);
  return {
    name: agent.name,
    mode: profile.mode,
    language: profile.language ?? "pt-BR",
    persona: persona.text,
    knowledge: knowledge.text,
    handoffKeywords: effectiveKeywords(profile.handoffKeywords),
    schedule: profile.schedule
      ? { ...profile.schedule, label: formatSchedule(profile.schedule) }
      : { label: formatSchedule(null) },
    followUps: profile.followUps ?? { mode: "draft" },
    channels: channels.map((c) => ({
      label: c.displayName,
      channel: c.channel,
      attends: !scoped || scoped.length === 0 || scoped.includes(c._id),
      transcription: c.channel === "whatsapp" ? c.autoTranscribeAudio === true : null,
    })),
    visionEnabled: aiConfig?.visionEnabled === true,
    transcription: channels
      .filter((c) => c.channel === "whatsapp")
      .map((c) => ({ label: c.displayName, enabled: c.autoTranscribeAudio === true })),
    bridgeAiAckDone: aiConfig?.bridgeAiAck !== undefined,
    autopilotEligible: gate.ok,
    aiActive: orgAiActive(org),
    attendants: (await listAttendants(ctx.db, scope.organizationId)).map((a) => a.name),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

// ---------------------------------------------------------------------------
// Palavras de repasse
// ---------------------------------------------------------------------------

function dedupeKeywords(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = raw.trim();
    const key = normalizeHandoffText(k);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/** Lista que vale hoje: a configurada (substitui a padrão) ou a padrão. */
function effectiveKeywords(configured: readonly string[] | undefined): string[] {
  return configured && configured.length > 0 ? [...configured] : [...DEFAULT_HANDOFF_KEYWORDS];
}

// ---------------------------------------------------------------------------
// Plano (o que a confirmação executa) e snapshots
// ---------------------------------------------------------------------------

type Plan = {
  agentMemberId?: Id<"teamMembers">;
  profilePatch?: AgentProfilePatch;
  rename?: string;
  visionEnabled?: boolean;
  channelConfigIds?: Id<"channelConfigs">[];
  transcriptionEnabled?: boolean;
};

const PATCH_KEYS = [
  "systemPrompt",
  "knowledge",
  "language",
  "mode",
  "schedule",
  "handoffKeywords",
  "followUps",
] as const;

/** Estado ATUAL dos campos que o plano toca (base do preview e do `beforeHash`). */
async function currentSnapshot(
  ctx: { db: Db },
  org: Doc<"organizations">,
  agent: Doc<"teamMembers"> | null,
  plan: Plan
): Promise<ConfigSnapshot> {
  const out: ConfigSnapshot = {};
  if (agent?.agentProfile) {
    const profile = agent.agentProfile;
    const patch = plan.profilePatch ?? {};
    const texts =
      "systemPrompt" in patch || "knowledge" in patch ? await readAgentTexts(ctx as QueryCtx, agent) : null;
    out.attendant = agent.name;
    if (plan.rename !== undefined) out.name = agent.name;
    if ("systemPrompt" in patch) out.systemPrompt = texts?.systemPrompt ?? "";
    if ("knowledge" in patch) out.knowledge = texts?.knowledge ?? "";
    if ("language" in patch) out.language = profile.language ?? null;
    if ("mode" in patch) out.mode = profile.mode;
    if ("schedule" in patch) out.schedule = profile.schedule ?? null;
    if ("handoffKeywords" in patch) out.handoffKeywords = effectiveKeywords(profile.handoffKeywords);
    if ("followUps" in patch) {
      out.followUps = profile.followUps ?? null;
      out.attendantMode = profile.mode; // a prévia avisa diferente conforme o modo
    }
  }
  if (plan.visionEnabled !== undefined) out.visionEnabled = org.settings.aiConfig?.visionEnabled === true;
  if (plan.channelConfigIds) {
    const transcription: Record<string, boolean> = {};
    for (const id of plan.channelConfigIds) {
      const cfg = await ctx.db.get(id);
      if (cfg) transcription[cfg.displayName] = cfg.autoTranscribeAudio === true;
    }
    out.transcription = transcription;
  }
  return out;
}

/** Estado DEPOIS, com as mesmas chaves do `currentSnapshot`. */
function afterSnapshot(
  plan: Plan,
  attendant: string | undefined,
  labels: string[]
): ConfigSnapshot {
  const out: ConfigSnapshot = {};
  if (attendant) out.attendant = attendant;
  if (plan.rename !== undefined) out.name = plan.rename;
  const patch = (plan.profilePatch ?? {}) as Record<string, unknown>;
  for (const key of PATCH_KEYS) {
    if (!(key in patch)) continue;
    if (key === "handoffKeywords") out[key] = effectiveKeywords(patch[key] as string[]);
    else out[key] = patch[key] ?? null;
  }
  if (plan.visionEnabled !== undefined) out.visionEnabled = plan.visionEnabled;
  if (plan.channelConfigIds) {
    const transcription: Record<string, boolean> = {};
    for (const label of labels) transcription[label] = plan.transcriptionEnabled === true;
    out.transcription = transcription;
  }
  return out;
}

/** Remove do plano o que já está como o usuário pediu. */
function pruneUnchanged(plan: Plan, before: ConfigSnapshot, after: ConfigSnapshot): Plan {
  const next: Plan = { ...plan };
  const same = (key: string) => hashBefore(before[key]) === hashBefore(after[key]);
  if (next.rename !== undefined && same("name")) delete next.rename;
  if (next.profilePatch) {
    const patch = { ...next.profilePatch } as Record<string, unknown>;
    for (const key of PATCH_KEYS) if (key in patch && same(key)) delete patch[key];
    if (Object.keys(patch).length) next.profilePatch = patch as AgentProfilePatch;
    else delete next.profilePatch;
  }
  if (next.visionEnabled !== undefined && same("visionEnabled")) delete next.visionEnabled;
  if (next.channelConfigIds && same("transcription")) {
    delete next.channelConfigIds;
    delete next.transcriptionEnabled;
  }
  return next;
}

const planIsEmpty = (plan: Plan) =>
  plan.rename === undefined &&
  !plan.profilePatch &&
  plan.visionEnabled === undefined &&
  !plan.channelConfigIds;

// ---------------------------------------------------------------------------
// Escrita — fase 1 (proposta; NUNCA escreve nada além do `pendingActions`)
// ---------------------------------------------------------------------------

const DAY_ALIASES: Record<string, number> = {
  dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6,
};

function parseDays(raw: unknown): number[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "days deve ser uma lista (seg, ter, qua, qui, sex, sab, dom)" };
  const out = new Set<number>();
  for (const item of raw) {
    const key = typeof item === "string" ? norm(item).slice(0, 3) : "";
    if (!(key in DAY_ALIASES)) return { error: `Dia inválido: ${String(item)}. Use seg, ter, qua, qui, sex, sab, dom.` };
    out.add(DAY_ALIASES[key]!);
  }
  return [...out].sort((a, b) => a - b);
}

function int(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function runConfigCopilotWriteTool(
  ctx: MutationCtx,
  name: string,
  args: Record<string, unknown>,
  scope: ConfigWriteScope
): Promise<Record<string, unknown>> {
  if (scope.via === "telegram_auto") return { error: TELEGRAM_AUTO_REFUSAL };
  const org = await ctx.db.get(scope.organizationId);
  if (!org) return { error: "Organização não encontrada" };

  let agent: Doc<"teamMembers"> | null = null;
  const plan: Plan = {};
  let channelLabels: string[] = [];
  const warnings: string[] = [];

  if (name !== "setAiFeatures") {
    const resolved = await resolveAttendant(ctx.db, scope.organizationId, args.attendantName);
    if ("fail" in resolved) return resolved.fail;
    agent = resolved.agent;
    plan.agentMemberId = agent._id;
  }
  const profile = agent?.agentProfile;
  const patch: Record<string, unknown> = {};

  switch (name) {
    case "updateAttendantPersona": {
      if (typeof args.newName === "string") {
        const n = args.newName.trim();
        if (!n || n.length > 60 || /[\r\n]/.test(n)) return { error: "O nome deve ter de 1 a 60 caracteres, em uma só linha" };
        plan.rename = n;
      }
      if (typeof args.persona === "string") {
        if (!args.persona.trim() || args.persona.length > TEXT_LIMIT) return { error: `A persona deve ter de 1 a ${TEXT_LIMIT} caracteres` };
        patch.systemPrompt = args.persona;
      }
      if (typeof args.language === "string") {
        const l = args.language.trim();
        if (!l || l.length > 20) return { error: "Idioma inválido (exemplo: pt-BR)" };
        patch.language = l;
      }
      if (plan.rename === undefined && Object.keys(patch).length === 0) {
        return { error: "Informe ao menos um ajuste: newName, persona ou language" };
      }
      break;
    }
    case "updateAttendantKnowledge": {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim() || text.length > TEXT_LIMIT) return { error: `O texto deve ter de 1 a ${TEXT_LIMIT} caracteres` };
      if (args.mode !== "append" && args.mode !== "replace") return { error: 'mode deve ser "append" ou "replace"' };
      let finalText = text;
      if (args.mode === "append") {
        const current = (await readAgentTexts(ctx, agent!)).knowledge ?? "";
        finalText = current.trim() ? `${current}\n\n${text}` : text;
        if (finalText.length > TEXT_LIMIT) {
          return { error: `Com o acréscimo o conhecimento passaria de ${TEXT_LIMIT} caracteres (hoje: ${current.length}). Resuma e use mode "replace".` };
        }
      }
      patch.knowledge = finalText;
      break;
    }
    case "setAttendantMode": {
      if (args.mode !== "suggest" && args.mode !== "autopilot") return { error: 'mode deve ser "suggest" ou "autopilot"' };
      if (args.mode === "autopilot" && profile!.mode !== "autopilot") {
        const gate = await autopilotGate(ctx, agent!);
        if (!gate.ok) {
          return humanAction(
            `O autopilot só é liberado com ${MIN_REVIEWED} sugestões revisadas e ${Math.round(MIN_ACCEPTANCE * 100)}% de aceitação ` +
              `(hoje: ${gate.reviewed} revisadas, ${Math.round(gate.rate * 100)}% aceitas). Para ativar antes disso, abra ` +
              `Configurações › IA, escolha "Ativar o autopilot antes do gate" e confirme o aceite de risco. O Copiloto não faz esse aceite.`,
            AI_SETTINGS_URL
          );
        }
      }
      patch.mode = args.mode;
      break;
    }
    case "setAttendantHours": {
      if (args.always === true) {
        patch.schedule = null;
        break;
      }
      const cur = profile!.schedule;
      const startHour = int(args.startHour) ?? cur?.startHour;
      const endHour = int(args.endHour) ?? cur?.endHour;
      if (startHour === undefined || endHour === undefined) {
        return { error: "Informe startHour e endHour (ou always=true para atender 24 h)" };
      }
      if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 1 || endHour > 24 || startHour >= endHour) {
        return { error: "Horário inválido: início de 0 a 23, fim de 1 a 24, e o início antes do fim" };
      }
      let days: number[] | undefined = cur?.days;
      if (args.days !== undefined) {
        const parsed = parseDays(args.days);
        if ("error" in parsed) return parsed;
        days = parsed.length === 0 || parsed.length === 7 ? undefined : parsed;
      }
      patch.schedule = {
        timezone: safeTimezone(org.settings.timezone),
        startHour,
        endHour,
        ...(days ? { days } : {}),
      };
      break;
    }
    case "setHandoffRules": {
      if (args.mode !== "append" && args.mode !== "replace") return { error: 'mode deve ser "append" ou "replace"' };
      const given = Array.isArray(args.keywords) ? args.keywords : [];
      if (given.length > 30) return { error: "No máximo 30 palavras por vez" };
      const keywords: string[] = [];
      for (const k of given) {
        if (typeof k !== "string" || !k.trim() || k.trim().length > 40) return { error: "Cada palavra deve ter de 1 a 40 caracteres" };
        keywords.push(k.trim());
      }
      if (args.mode === "append" && keywords.length === 0) return { error: "Informe as palavras a acrescentar" };
      // `matchesHandoffKeyword`: uma lista configurada SUBSTITUI a padrão. Para a
      // mudança do usuário não desligar as frases padrão sem ninguém perceber,
      // as padrão entram sempre; "replace" troca só as do usuário.
      const kept = args.mode === "append" ? (profile!.handoffKeywords ?? []) : [];
      const list = dedupeKeywords([...DEFAULT_HANDOFF_KEYWORDS, ...kept, ...keywords]);
      patch.handoffKeywords = args.mode === "replace" && keywords.length === 0 ? [] : list;
      break;
    }
    case "setFollowUpSettings": {
      const next: Record<string, unknown> = { ...(profile!.followUps ?? { mode: "draft" }) };
      let touched = false;
      if (args.mode !== undefined) {
        if (args.mode !== "off" && args.mode !== "draft" && args.mode !== "send") return { error: 'mode deve ser "off", "draft" ou "send"' };
        next.mode = args.mode;
        touched = true;
      }
      for (const key of ["maxChain", "quietStartHour", "quietEndHour", "dailyCap"] as const) {
        if (args[key] === undefined) continue;
        const n = int(args[key]);
        if (n === undefined || !Number.isInteger(n)) return { error: `${key} deve ser um número inteiro` };
        next[key] = n;
        touched = true;
      }
      if (!touched) return { error: "Informe ao menos um ajuste de follow-up" };
      // Pré-validação das faixas (o core valida de novo ao confirmar).
      const f = next as { maxChain?: number; quietStartHour?: number; quietEndHour?: number; dailyCap?: number };
      if (f.maxChain !== undefined && (f.maxChain < 1 || f.maxChain > MAX_CHAIN_LIMIT)) return { error: `maxChain deve ficar entre 1 e ${MAX_CHAIN_LIMIT}` };
      for (const h of [f.quietStartHour, f.quietEndHour]) {
        if (h !== undefined && (h < 0 || h > 24)) return { error: "As horas da janela de envio ficam entre 0 e 24" };
      }
      if ((f.quietStartHour ?? 8) >= (f.quietEndHour ?? 20)) return { error: "A janela de envio precisa começar antes de terminar" };
      if (f.dailyCap !== undefined && (f.dailyCap < 0 || f.dailyCap > MAX_DAILY_CAP)) return { error: `dailyCap deve ficar entre 0 e ${MAX_DAILY_CAP} (0 = sem teto)` };
      patch.followUps = next;
      break;
    }
    case "setAiFeatures": {
      const t = args.transcription as { channelLabel?: unknown; all?: unknown; enabled?: unknown } | undefined;
      if (args.vision === undefined && t === undefined) return { error: "Informe vision e/ou transcription" };
      if (args.vision !== undefined) {
        if (typeof args.vision !== "boolean") return { error: "vision deve ser verdadeiro ou falso" };
        if (!orgAiActive(org)) {
          return humanAction(
            "A IA da organização está desligada. Para ligar a leitura de imagens, primeiro ative a IA em Configurações › IA (aceite LGPD). O Copiloto não faz esse aceite.",
            AI_SETTINGS_URL
          );
        }
        plan.visionEnabled = args.vision;
      }
      if (t !== undefined) {
        if (typeof t !== "object" || t === null || typeof t.enabled !== "boolean") return { error: "transcription.enabled deve ser verdadeiro ou falso" };
        const wa = (await whatsappChannels(ctx.db, scope.organizationId)).filter((c) => c.channel === "whatsapp");
        if (wa.length === 0) {
          return humanAction("Não há canal de WhatsApp conectado. Conecte um em Configurações › Canais.", CHANNELS_URL);
        }
        let chosen = wa;
        if (t.all !== true) {
          const wanted = typeof t.channelLabel === "string" ? norm(t.channelLabel) : "";
          if (wanted) {
            chosen = wa.filter((c) => norm(c.displayName) === wanted);
            if (chosen.length === 0) return { error: "Não encontrei um canal de WhatsApp com esse apelido.", channels: wa.map((c) => c.displayName) };
            if (chosen.length > 1) return { error: "Mais de um canal tem esse apelido; peça para renomear um deles.", channels: wa.map((c) => c.displayName) };
          } else if (wa.length > 1) {
            return { error: "Há mais de um canal de WhatsApp. Diga o apelido do canal ou all=true.", channels: wa.map((c) => c.displayName) };
          }
        }
        if (new Set(chosen.map((c) => norm(c.displayName))).size !== chosen.length) {
          return { error: "Há canais de WhatsApp com o mesmo apelido; renomeie um deles antes.", channels: wa.map((c) => c.displayName) };
        }
        plan.channelConfigIds = chosen.map((c) => c._id);
        plan.transcriptionEnabled = t.enabled;
        channelLabels = chosen.map((c) => c.displayName);
        if (t.enabled && !process.env.WHISPER_SERVICE_URL) {
          warnings.push(
            "O serviço de transcrição não está configurado neste ambiente (WHISPER_SERVICE_URL): a opção será gravada, mas os áudios só serão transcritos quando ele estiver ativo."
          );
        }
      }
      break;
    }
    default:
      return { error: `Tool não implementada: ${name}` };
  }

  if (Object.keys(patch).length) plan.profilePatch = patch as AgentProfilePatch;

  const before = await currentSnapshot(ctx, org, agent, plan);
  const after = afterSnapshot(plan, agent?.name, channelLabels);
  const pruned = pruneUnchanged(plan, before, after);
  if (planIsEmpty(pruned)) {
    return { status: "sem_mudanca", message: "Já está assim; não há nada a mudar.", ...(warnings.length ? { warnings } : {}) };
  }
  // Recalcula com o plano podado (só o que de fato muda entra na prévia e no hash).
  const beforeFinal = await currentSnapshot(ctx, org, agent, pruned);
  const afterFinal = afterSnapshot(pruned, agent?.name, channelLabels);
  const preview = buildConfigPreview(name, beforeFinal, afterFinal);

  const now = Date.now();
  const pendingActionId = await ctx.db.insert("pendingActions", {
    organizationId: scope.organizationId,
    requestedBy: scope.member._id,
    threadId: scope.threadId,
    tool: name,
    args: clean({ ...pruned, beforeHash: hashBefore(beforeFinal) }) as Record<string, unknown>,
    preview,
    status: "pending",
    expiresAt: now + scope.pendingActionTtlMs,
    createdAt: now,
  });
  return {
    status: "confirmacao_necessaria",
    pendingActionId,
    preview,
    message: 'Confira o "Antes/Depois" e confirme no cartão para aplicar.',
    ...(warnings.length ? { warnings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Escrita — fase 2 (confirmação do humano)
// ---------------------------------------------------------------------------

export type ConfigPendingOutcome = { ok: true; message: string } | { ok: false; message: string };

const fail = (message: string): ConfigPendingOutcome => ({ ok: false, message });

export async function executeConfigPendingAction(
  ctx: MutationCtx,
  pending: Doc<"pendingActions">,
  member: Doc<"teamMembers">,
  via: "copilot" | "telegram"
): Promise<ConfigPendingOutcome> {
  if (member.organizationId !== pending.organizationId) return fail("Ação de outra organização");
  // Re-checados AGORA: o papel pode ter mudado e a confirmação do Telegram não tem sessão.
  try {
    await assertAgentCan(ctx, member._id, "settings", "manage");
  } catch {
    return fail("Você não tem mais permissão para alterar as configurações de IA");
  }
  if (!member.userId) return fail("Esta ação exige uma conta com e-mail");
  try {
    await requireAccountWithEmail(ctx, member.userId);
  } catch (e) {
    return fail(e instanceof ConvexError ? String(e.data) : "Esta ação exige uma conta com e-mail");
  }

  const org = await ctx.db.get(pending.organizationId);
  if (!org) return fail("Organização não encontrada");
  const { beforeHash, ...rest } = pending.args as Record<string, unknown>;
  const plan = rest as Plan;

  let agent: Doc<"teamMembers"> | null = null;
  if (plan.agentMemberId) {
    agent = await ctx.db.get(plan.agentMemberId);
    if (
      !agent ||
      agent.organizationId !== pending.organizationId ||
      agent.type !== "ai" ||
      agent.agentProfile?.kind !== "attendant" ||
      agent.removedAt !== undefined ||
      agent.status === "inactive"
    ) {
      return fail("O atendente não existe mais");
    }
  }

  if (plan.profilePatch?.mode === "autopilot" && agent!.agentProfile!.mode !== "autopilot") {
    const gate = await autopilotGate(ctx, agent!);
    if (!gate.ok) {
      return fail(
        `O autopilot exige ${MIN_REVIEWED} sugestões revisadas e ${Math.round(MIN_ACCEPTANCE * 100)}% de aceitação (hoje: ${gate.reviewed} revisadas, ${Math.round(gate.rate * 100)}% aceitas). ${AI_SETTINGS_URL}`
      );
    }
  }
  if (plan.visionEnabled !== undefined && !orgAiActive(org)) {
    return fail("Ative a IA primeiro (Configurações › IA)");
  }

  const current = await currentSnapshot(ctx, org, agent, plan);
  if (hashBefore(current) !== beforeHash) return fail(CONFIG_CHANGED_MESSAGE);

  if (agent && (plan.profilePatch || plan.rename !== undefined)) {
    await updateAgentProfileCore(ctx, {
      agent,
      member,
      patch: plan.profilePatch ?? {},
      rename: plan.rename,
      via,
    });
  }
  if (plan.visionEnabled !== undefined) {
    await setFeatureTogglesCore(ctx, { org, member, toggles: { visionEnabled: plan.visionEnabled }, via });
  }
  for (const id of plan.channelConfigIds ?? []) {
    const config = await ctx.db.get(id);
    if (!config || config.organizationId !== pending.organizationId) return fail("O canal não existe mais");
    await patchChannelTranscriptionCore(ctx, { config, member, enabled: plan.transcriptionEnabled === true, via });
  }
  return { ok: true, message: agent ? `Atendente «${plan.rename ?? agent.name}» atualizado` : "Recursos de IA atualizados" };
}
