/**
 * Política de download de mídia em grupos de WhatsApp (v0.62) — lado do front.
 *
 * O servidor resolve o modo efetivo (`effectiveMedia`/`groupMedia`) e a tela só
 * mostra; o default fica replicado aqui para o caso de um campo ausente não
 * virar "undefined" na UI (espelha `GROUP_MEDIA_DEFAULT_MODE` do backend).
 */

export type GroupMediaMode = "all" | "mentions" | "off";
export type GroupMediaOverride = "inherit" | GroupMediaMode;
export type GroupMediaKind = "image" | "audio" | "video" | "document";

export type GroupMediaPolicy = Record<GroupMediaKind, GroupMediaMode>;
export type GroupMediaOverrides = Record<GroupMediaKind, GroupMediaOverride>;

export const GROUP_MEDIA_DEFAULT_MODE: GroupMediaMode = "mentions";
export const GROUP_MEDIA_KINDS: GroupMediaKind[] = ["image", "audio", "video", "document"];

export const GROUP_MEDIA_KIND_LABELS: Record<GroupMediaKind, string> = {
  image: "Imagens",
  audio: "Áudios",
  video: "Vídeos",
  document: "Documentos",
};

export const GROUP_MEDIA_MODE_LABELS: Record<GroupMediaMode, string> = {
  all: "Sempre",
  mentions: "Só quando é com a gente",
  off: "Nunca",
};

/** Rótulo curto, para caber num chip da linha do grupo. */
export const GROUP_MEDIA_MODE_SHORT: Record<GroupMediaMode, string> = {
  all: "sempre",
  mentions: "só com a gente",
  off: "nunca",
};

const MODES = new Set<string>(["all", "mentions", "off"]);

function asMode(value: unknown): GroupMediaMode {
  return typeof value === "string" && MODES.has(value)
    ? (value as GroupMediaMode)
    : GROUP_MEDIA_DEFAULT_MODE;
}

/** Completa uma política parcial (ou ausente) com o default. */
export function normalizeGroupMedia(
  policy: Partial<Record<GroupMediaKind, unknown>> | null | undefined
): GroupMediaPolicy {
  return {
    image: asMode(policy?.image),
    audio: asMode(policy?.audio),
    video: asMode(policy?.video),
    document: asMode(policy?.document),
  };
}

/** Override por grupo: ausente/desconhecido = herda do número. */
export function normalizeGroupMediaOverrides(
  policy: Partial<Record<GroupMediaKind, unknown>> | null | undefined
): GroupMediaOverrides {
  const pick = (value: unknown): GroupMediaOverride =>
    typeof value === "string" && MODES.has(value) ? (value as GroupMediaMode) : "inherit";
  return {
    image: pick(policy?.image),
    audio: pick(policy?.audio),
    video: pick(policy?.video),
    document: pick(policy?.document),
  };
}

export function presetGroupMedia(mode: GroupMediaMode): GroupMediaPolicy {
  return { image: mode, audio: mode, video: mode, document: mode };
}

/** O preset que a política inteira representa, se representar algum. */
export function matchingPreset(policy: GroupMediaPolicy): GroupMediaMode | null {
  const first = policy.image;
  return GROUP_MEDIA_KINDS.every((k) => policy[k] === first) ? first : null;
}

/**
 * Resumo compacto para a linha do grupo: "Mídia: só com a gente" quando os
 * quatro tipos concordam, senão o que difere ("Mídia: só com a gente · áudios
 * sempre"). O modo majoritário vira a base para o texto ficar curto.
 */
export function summarizeGroupMedia(policy: GroupMediaPolicy): string {
  const uniform = matchingPreset(policy);
  if (uniform) return `Mídia: ${GROUP_MEDIA_MODE_SHORT[uniform]}`;
  const counts = new Map<GroupMediaMode, number>();
  for (const k of GROUP_MEDIA_KINDS) counts.set(policy[k], (counts.get(policy[k]) ?? 0) + 1);
  // Empate: o default vence (é o que a maioria das orgs vai reconhecer).
  let base: GroupMediaMode = GROUP_MEDIA_DEFAULT_MODE;
  let best = counts.get(base) ?? 0;
  for (const [mode, count] of counts) {
    if (count > best) {
      base = mode;
      best = count;
    }
  }
  const diffs = GROUP_MEDIA_KINDS.filter((k) => policy[k] !== base).map(
    (k) => `${GROUP_MEDIA_KIND_LABELS[k].toLowerCase()} ${GROUP_MEDIA_MODE_SHORT[policy[k]]}`
  );
  return `Mídia: ${GROUP_MEDIA_MODE_SHORT[base]} · ${diffs.join(" · ")}`;
}

/** O grupo tem algum override (algo diferente de "herdar")? */
export function hasGroupMediaOverride(overrides: GroupMediaOverrides): boolean {
  return GROUP_MEDIA_KINDS.some((k) => overrides[k] !== "inherit");
}

// ─── Estado da mídia de uma mensagem no inbox ───────────────────────────────

export type DeferredMediaKind = GroupMediaKind | "sticker";

export type MessageMediaState =
  | { state: "none" }
  | {
      /** Não baixada pela política — dá para baixar sob demanda. */
      state: "deferred";
      kind: DeferredMediaKind;
      filename?: string;
      fileLength?: number;
      expiresAt?: number;
    }
  | { state: "expired"; kind: DeferredMediaKind; filename?: string }
  | {
      /**
       * Nunca vai ser baixada: passa do teto de 25 MB (`tooBig`) ou o tipo de
       * arquivo não é aceito (`rejected`). Sem botão — o motivo aparece.
       */
      state: "unavailable";
      kind: DeferredMediaKind;
      filename?: string;
      reason: "too_big" | "rejected";
      fileLength?: number;
      detail?: string;
    }
  | { state: "purged"; kind: DeferredMediaKind };

function asDeferredKind(value: unknown): DeferredMediaKind {
  if (value === "sticker") return "sticker";
  if (value === "image" || value === "audio" || value === "video" || value === "document") {
    return value;
  }
  // `ptt`/voice note chega como "audio" no parser; qualquer outro vira arquivo.
  if (value === "ptt" || value === "voice") return "audio";
  return "document";
}

/**
 * Lê `metadata.mediaDeferred`/`metadata.mediaPurged`. NÃO é "problema de
 * mídia": o placeholder é neutro, e `hasMediaProblem` ignora estes campos.
 * `mediaPurged` vence — o arquivo existiu e foi apagado de propósito.
 */
export function getMessageMediaState(
  metadata: Record<string, any> | null | undefined
): MessageMediaState {
  const purged = metadata?.mediaPurged;
  if (purged && typeof purged === "object") {
    return { state: "purged", kind: asDeferredKind(purged.kind) };
  }
  const deferred = metadata?.mediaDeferred;
  if (!deferred || typeof deferred !== "object") return { state: "none" };
  const kind = asDeferredKind(deferred.kind);
  const filename =
    typeof deferred.filename === "string" && deferred.filename.trim() !== ""
      ? deferred.filename
      : undefined;
  const fileLength =
    typeof deferred.fileLength === "number" && deferred.fileLength > 0
      ? deferred.fileLength
      : undefined;
  if (deferred.tooBig === true) {
    return { state: "unavailable", kind, filename, reason: "too_big", fileLength };
  }
  if (typeof deferred.rejected === "string") {
    return {
      state: "unavailable",
      kind,
      filename,
      reason: "rejected",
      detail: deferred.rejected,
    };
  }
  if (deferred.expired === true) return { state: "expired", kind, filename };
  return {
    state: "deferred",
    kind,
    filename,
    fileLength,
    expiresAt: typeof deferred.expiresAt === "number" ? deferred.expiresAt : undefined,
  };
}

export const DEFERRED_KIND_LABELS: Record<DeferredMediaKind, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
};
