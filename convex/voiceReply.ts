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
import { internalMutation, query } from "./_generated/server";
import { requirePermission } from "./lib/auth";
import { deleteFileRow, insertFileRow } from "./lib/storageUsage";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import { TTS_VOICES, VOICE_NOTICE_MAX_CHARS, getTtsConfig, resolveAttendantVoice } from "./lib/tts";
import { orgAiActive } from "./lib/agentSecurity";
import { voiceNoteConverterConfigured } from "./lib/voiceNoteConvert";

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
      metadata: { kind: WEB_VOICE_REPLY_FILE_KIND },
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
