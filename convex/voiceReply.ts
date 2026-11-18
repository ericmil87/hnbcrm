/**
 * Resposta em áudio do atendente (onboarding v2, P4.1) — parte com banco.
 *
 *  - `getVoiceReplySettings` (query pública, `settings:view`): o que a UI de
 *    configuração (P4.2) precisa mostrar. Escrita = `aiSettings.setFeatureToggles`
 *    (porta `setFeatureTogglesCore`, `via:"settings"`).
 *  - `internalInsertVoiceNoteFile`: linha de `files` do ogg gerado, SEM
 *    `messageId` (o commit do atendente vincula; commit recusado → a action
 *    descarta pela `attendantAgenda.internalDiscardUnlinkedFiles`).
 *  - `internalInsertWebAudioFile` / `internalDiscardWebAudioFile` (P4.2b): o WAV
 *    da resposta em áudio do chat do onboarding (tocado direto pelo navegador),
 *    `fileType:"other"` + `metadata.kind:"onboarding_voice_reply"`. Quem vincula
 *    é `onboardingChat.internalAttachReplyAudio`; a limpeza (7 dias) é
 *    `onboardingChat.internalExpireOnboardingAudio`.
 *
 * Regras e cálculo: `lib/tts.ts`. Rede: `voiceReplyNode.ts`.
 */
import { v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAccountWithEmail, requirePermission } from "./lib/auth";
import { deleteFileRow, insertFileRow } from "./lib/storageUsage";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import {
  TTS_VOICES,
  VOICE_NOTICE_MAX_CHARS,
  getTtsConfig,
  isTtsVoice,
  normalizeVoiceNotice,
  resolveAttendantVoice,
  toSpeakableText,
  voiceNoticeError,
} from "./lib/tts";
import { orgAiActive } from "./lib/agentSecurity";
import { voiceNoteConverterConfigured } from "./lib/voiceNoteConvert";
import { platformTtsAllowed } from "./lib/agentRoutes";
import { resolveEntitlements } from "./lib/entitlements";
import { READ_ONLY_AI_MESSAGE, SPEND_CAP_BLOCKED_MESSAGE, isValidMonthKey } from "./lib/aiSpend";
import { spendStatusFor } from "./aiSpend";
import { evaluateFixedWindow } from "./lib/onboardingBudget";
import {
  VOICE_PREVIEW_CACHE_MS,
  VOICE_PREVIEW_FILE_KIND,
  VOICE_PREVIEW_FILE_MIME,
  VOICE_PREVIEW_FILE_NAME,
  VOICE_PREVIEW_RATE_LIMITS,
  VOICE_PREVIEW_TTL_MS,
  voicePreviewCacheKey,
  voicePreviewRateKey,
  voiceSampleText,
  voiceTextReasonLabel,
} from "./lib/voicePreview";
import { synthesizeVoicePreview, voicePreviewResultValidator } from "./lib/voicePreviewOps";

/** Nome do anexo gerado (o tipo `audio/ogg` sai como `data:audio/ogg;base64` no bridge). */
export const VOICE_REPLY_FILE_NAME = "resposta-em-audio.ogg";
export const VOICE_REPLY_FILE_MIME = "audio/ogg";
/** Resposta em áudio do chat do onboarding: WAV (PCM 24 kHz mono), tocado direto pelo navegador. */
export const WEB_VOICE_REPLY_FILE_NAME = "resposta-em-audio.wav";
export const WEB_VOICE_REPLY_FILE_MIME = "audio/wav";
export const WEB_VOICE_REPLY_FILE_KIND = "onboarding_voice_reply";

export const getVoiceReplySettings = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({
      /** `aiConfig.voiceReplyEnabled === true` (ausente = desligado). */
      enabled: v.boolean(),
      /** Voz que será usada agora (org válida > env > padrão). */
      voice: v.string(),
      /** Voz gravada na org, se houver (pode ser inválida/antiga). */
      configuredVoice: v.union(v.string(), v.null()),
      defaultVoice: v.string(),
      voices: v.array(v.string()),
      /** Aviso de voz sintética (null = sem aviso). */
      notice: v.union(v.string(), v.null()),
      noticeMaxChars: v.number(),
      model: v.string(),
      /** A plataforma tem o necessário (chave do OpenRouter + conversor da VPS). */
      platformReady: v.boolean(),
      /** IA da org ativa (mestre + aceite LGPD): sem ela o atendente não responde nada. */
      aiActive: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const org = await ctx.db.get(args.organizationId);
    if (!org) return null;
    const ai = org.settings.aiConfig;
    const configured = typeof ai?.voiceReplyVoice === "string" ? ai.voiceReplyVoice : null;
    return {
      enabled: ai?.voiceReplyEnabled === true,
      voice: resolveAttendantVoice(configured ?? undefined),
      configuredVoice: configured,
      defaultVoice: getTtsConfig("attendant").voice,
      voices: [...TTS_VOICES],
      notice: typeof ai?.voiceReplyNotice === "string" && ai.voiceReplyNotice.length > 0 ? ai.voiceReplyNotice : null,
      noticeMaxChars: VOICE_NOTICE_MAX_CHARS,
      model: getTtsConfig("attendant").model,
      platformReady: Boolean(process.env.OPENROUTER_API_KEY) && voiceNoteConverterConfigured(),
      aiActive: orgAiActive(org),
    };
  },
});

export const internalInsertVoiceNoteFile = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    storageId: v.id("_storage"),
    size: v.number(),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    return await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: VOICE_REPLY_FILE_NAME,
      mimeType: VOICE_REPLY_FILE_MIME,
      size: args.size,
      fileType: "message_attachment",
      uploadedBy: args.agentMemberId,
      createdAt: Date.now(),
    });
  },
});


/**
 * Linha de `files` do WAV da resposta em áudio do chat do onboarding (P4.2b).
 * O membro tem que ser da org (quem conduz a sessão). Conta na cota de storage
 * pela porta `insertFileRow`.
 */
export const internalInsertWebAudioFile = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    storageId: v.id("_storage"),
    size: v.number(),
    /** Id da síntese no turno (`<turno>:tts`): acha o arquivo se a action lançar depois de gravar. */
    requestId: v.optional(v.string()),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.memberId);
    if (!member || member.organizationId !== args.organizationId) throw new Error("Membro não encontrado");
    return await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: WEB_VOICE_REPLY_FILE_NAME,
      mimeType: WEB_VOICE_REPLY_FILE_MIME,
      size: args.size,
      fileType: "other",
      uploadedBy: args.memberId,
      metadata: { kind: WEB_VOICE_REPLY_FILE_KIND, ...(args.requestId ? { requestId: args.requestId.slice(0, 120) } : {}) },
      createdAt: Date.now(),
    });
  },
});

/**
 * Descarta o WAV de uma resposta em áudio que não chegou a ser vinculado (ou que
 * venceu): linha de `files` + blob pela porta `lib/fileRefs.ts`. Só arquivo da
 * org E do tipo do onboarding (nunca apaga outro anexo). Idempotente.
 */
export const internalDiscardWebAudioFile = internalMutation({
  args: { organizationId: v.id("organizations"), fileId: v.id("files") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file || file.organizationId !== args.organizationId) return false;
    if (file.metadata?.kind !== WEB_VOICE_REPLY_FILE_KIND) return false;
    await deleteBlobIfUnreferenced(ctx, file);
    await deleteFileRow(ctx, file);
    return true;
  },
});

/**
 * Rede de segurança do turno (P4.2b): quando a action de síntese LANÇA depois de
 * gravar (erro de plataforma), o turno não recebe o `fileId`. Acha o WAV pelo
 * `metadata.requestId` entre os arquivos da org criados desde `since` (índice
 * `by_organization_and_created`, no máximo 100 linhas lidas) e descarta.
 */
export const internalDiscardWebAudioByRequest = internalMutation({
  args: { organizationId: v.id("organizations"), requestId: v.string(), since: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_organization_and_created", (q) => q.eq("organizationId", args.organizationId).gte("createdAt", args.since))
      .take(100);
    let discarded = 0;
    for (const file of rows) {
      if (file.metadata?.kind !== WEB_VOICE_REPLY_FILE_KIND || file.metadata?.requestId !== args.requestId) continue;
      await deleteBlobIfUnreferenced(ctx, file);
      await deleteFileRow(ctx, file);
      discarded += 1;
    }
    return discarded;
  },
});

// ── Teste da voz nas Configurações (amostra e simulador com voz) ────────────

const PREVIEW_AI_OFF_MESSAGE = "Ative a IA da organização (e aceite os termos de IA) para testar a voz.";

/**
 * WAV de teste ainda reaproveitável (mesma voz + mesmo texto, nos últimos 10 min).
 * Lê no máximo 200 arquivos recentes da org: numa org que sobe muito anexo, o
 * pior caso é não achar o cache e sintetizar de novo (o limite por usuário vale).
 */
async function findCachedPreview(
  ctx: Pick<MutationCtx, "db">,
  organizationId: Doc<"organizations">["_id"],
  cacheKey: string,
  now: number
): Promise<Doc<"files"> | null> {
  const rows = await ctx.db
    .query("files")
    .withIndex("by_organization_and_created", (q) =>
      q.eq("organizationId", organizationId).gte("createdAt", now - VOICE_PREVIEW_CACHE_MS)
    )
    .order("desc")
    .take(200);
  return rows.find((f) => f.metadata?.kind === VOICE_PREVIEW_FILE_KIND && f.metadata?.cacheKey === cacheKey) ?? null;
}

/**
 * Porta de entrada de toda síntese de TESTE (`lib/voicePreviewOps.ts`), numa
 * transação: quem chama tem `settings:view` e conta com e-mail (como o
 * simulador; a voz gasta da plataforma), IA ativa, fora do modo leitura e abaixo
 * do teto em R$; voz de catálogo; cache do mesmo texto+voz (não conta no limite
 * nem paga); depois a janela por usuário (6/min, 60/dia) e por org (200/dia).
 * Recusa NÃO consome a janela.
 */
export const internalBeginVoicePreview = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    voice: v.string(),
    /** Texto falável exato (vai ao TTS e compõe a chave do cache). */
    text: v.string(),
    now: v.number(),
    month: v.string(),
  },
  returns: v.union(
    v.object({ status: v.literal("cached"), url: v.string(), durationSec: v.number() }),
    v.object({
      status: v.literal("go"),
      memberId: v.id("teamMembers"),
      cacheKey: v.string(),
    }),
    v.object({ status: v.literal("refused"), message: v.string(), reason: v.optional(v.string()) })
  ),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "view");
    await requireAccountWithEmail(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { status: "refused" as const, message: "Organização não encontrada." };
    if (!isTtsVoice(args.voice)) {
      return { status: "refused" as const, message: "Voz desconhecida: escolha uma das vozes da lista." };
    }
    const text = args.text.trim();
    if (text.length === 0) return { status: "refused" as const, message: "Não há nada para falar." };
    if (!orgAiActive(org)) return { status: "refused" as const, message: PREVIEW_AI_OFF_MESSAGE };
    if (!resolveEntitlements(org, args.now).aiAllowed) {
      return { status: "refused" as const, message: READ_ONLY_AI_MESSAGE, reason: "teto_de_gastos" };
    }
    if (isValidMonthKey(args.month) && (await spendStatusFor(ctx, org, args.month)).blocked) {
      return { status: "refused" as const, message: SPEND_CAP_BLOCKED_MESSAGE, reason: "teto_de_gastos" };
    }

    const providerConfig = org.settings.aiConfig?.providerConfig;
    // Mesma trava do runtime (a retenção não foi validada no endpoint de áudio)
    // e da porta (BYO/`opencode-only` não usam a chave da plataforma): antes de
    // consumir a janela.
    if (providerConfig?.strictZdr === true) {
      return { status: "refused" as const, message: voiceTextReasonLabel("zdr_nao_validado"), reason: "zdr_nao_validado" };
    }
    if (!platformTtsAllowed(providerConfig)) {
      return { status: "refused" as const, message: voiceTextReasonLabel("rota_sem_openrouter"), reason: "rota_sem_openrouter" };
    }

    const cacheKey = voicePreviewCacheKey(args.voice, text);
    const cached = await findCachedPreview(ctx, org._id, cacheKey, args.now);
    if (cached) {
      const url = await ctx.storage.getUrl(cached.storageId as Id<"_storage">);
      if (url) {
        const durationSec = typeof cached.metadata?.durationSec === "number" ? cached.metadata.durationSec : 0;
        return { status: "cached" as const, url, durationSec };
      }
    }

    // Janela fixa em duas fases: só grava se TODAS permitirem.
    const subjects: Array<{ scope: "user" | "org"; id: string }> = [
      { scope: "user", id: member.userId ?? member._id },
      { scope: "org", id: org._id },
    ];
    const plan: Array<{ key: string; doc: Doc<"onboardingRateLimits"> | null; next: { windowStart: number; count: number } }> =
      [];
    for (const s of subjects) {
      for (const spec of VOICE_PREVIEW_RATE_LIMITS[s.scope]) {
        const key = voicePreviewRateKey(s.scope, s.id, spec.name);
        const doc = await ctx.db
          .query("onboardingRateLimits")
          .withIndex("by_key", (q) => q.eq("key", key))
          .unique();
        const res = evaluateFixedWindow(doc ? { windowStart: doc.windowStart, count: doc.count } : null, args.now, spec);
        if (!res.allowed) {
          const seconds = Math.max(1, Math.ceil(res.retryAfterMs / 1000));
          const wait = seconds < 120 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
          return {
            status: "refused" as const,
            message:
              s.scope === "user"
                ? `Muitos testes de voz em pouco tempo. Tente de novo em ${wait}.`
                : `A organização chegou ao limite de testes de voz de hoje. Tente de novo em ${wait}.`,
          };
        }
        plan.push({ key, doc, next: res.next });
      }
    }
    for (const p of plan) {
      if (p.doc) await ctx.db.patch(p.doc._id, p.next);
      else await ctx.db.insert("onboardingRateLimits", { key: p.key, ...p.next });
    }

    return {
      status: "go" as const,
      memberId: member._id,
      cacheKey,
    };
  },
});

/**
 * Linha de `files` do WAV de teste (nunca vinculada a mensagem, lead nem
 * contato) + faxina agendada para `VOICE_PREVIEW_TTL_MS` depois.
 */
export const internalInsertVoicePreviewFile = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    storageId: v.id("_storage"),
    size: v.number(),
    cacheKey: v.string(),
    durationSec: v.number(),
  },
  returns: v.id("files"),
  handler: async (ctx, args) => {
    const member = await ctx.db.get(args.memberId);
    if (!member || member.organizationId !== args.organizationId) throw new Error("Membro não encontrado");
    const fileId = await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: VOICE_PREVIEW_FILE_NAME,
      mimeType: VOICE_PREVIEW_FILE_MIME,
      size: args.size,
      fileType: "other",
      uploadedBy: args.memberId,
      metadata: { kind: VOICE_PREVIEW_FILE_KIND, cacheKey: args.cacheKey.slice(0, 80), durationSec: args.durationSec },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(VOICE_PREVIEW_TTL_MS, internal.voiceReply.internalDiscardVoicePreview, {
      organizationId: args.organizationId,
      fileId,
    });
    return fileId;
  },
});

/** Apaga o WAV de teste (linha + blob pela porta `lib/fileRefs.ts`). Só `voice_preview` da org; idempotente. */
export const internalDiscardVoicePreview = internalMutation({
  args: { organizationId: v.id("organizations"), fileId: v.id("files") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId);
    if (!file || file.organizationId !== args.organizationId) return false;
    if (file.metadata?.kind !== VOICE_PREVIEW_FILE_KIND || file.messageId !== undefined) return false;
    await deleteBlobIfUnreferenced(ctx, file);
    await deleteFileRow(ctx, file);
    return true;
  },
});

/**
 * "Ouvir amostra" (Configurações › Comportamento na conversa › Responder em
 * áudio): o aviso de voz sintética (rascunho ainda não salvo também vale) +
 * uma saudação curta, ditos com a voz escolhida. Mesmas regras do aviso que o
 * core aplica ao salvar (`voiceNoticeError`) e mesma porta de TTS do atendente.
 * Não grava nada da configuração nem do CRM.
 */
export const previewVoiceSample = action({
  args: {
    organizationId: v.id("organizations"),
    voice: v.string(),
    /** Aviso a falar no início (vazio/ausente = só a saudação). */
    notice: v.optional(v.string()),
  },
  returns: voicePreviewResultValidator,
  handler: async (ctx, args) => {
    const trimmed = (args.notice ?? "").replace(/\s+/g, " ").trim();
    const noticeError = voiceNoticeError(trimmed);
    if (noticeError) return { ok: false as const, message: noticeError };
    const text = toSpeakableText(voiceSampleText(normalizeVoiceNotice(trimmed)));
    return await synthesizeVoicePreview(ctx, { organizationId: args.organizationId, voice: args.voice, text });
  },
});
