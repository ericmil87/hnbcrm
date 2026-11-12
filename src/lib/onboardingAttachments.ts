/**
 * Regras puras dos anexos do chat de onboarding (`/comecar`): validação no
 * cliente ANTES de subir (o servidor valida de novo), upload pelo fluxo de
 * `files` (`generateUploadUrl` + POST + `saveFile`) e mapeamento dos códigos
 * `email_unverified`/`notice_required` para o bloco certo. Um anexo por turno.
 *
 * Tetos iguais aos de `convex/onboardingChat.ts` (PDF 20 MB, imagem 5 MB, áudio 2 MB).
 */
import { ONBOARDING_AUDIO_MAX_BYTES, ONBOARDING_IMAGE_MAX_BYTES, ONBOARDING_PDF_MAX_BYTES } from "../../convex/lib/onboardingLimits";
import type { OnboardingAttachment, OnboardingErrorCode } from "./onboardingStream";

export type FileAttachmentKind = "pdf" | "image" | "audio";

export const ATTACHMENT_MAX_BYTES: Record<FileAttachmentKind, number> = {
  pdf: ONBOARDING_PDF_MAX_BYTES,
  image: ONBOARDING_IMAGE_MAX_BYTES,
  audio: ONBOARDING_AUDIO_MAX_BYTES,
};

/** Duração máxima da gravação (o servidor fala em uns 3 minutos / 2 MB). */
export const VOICE_MAX_SECONDS = 180;

export const ATTACHMENT_URL_MAX = 2000;

/** `accept` do input de arquivo. */
export const ATTACHMENT_ACCEPT: Record<Exclude<FileAttachmentKind, "audio">, string> = {
  pdf: "application/pdf,.pdf",
  image: "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp",
};

const IMAGE_BY_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const IMAGE_MIMES = new Set(Object.values(IMAGE_BY_EXT));

export type AttachmentCheck<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/** Endereço do site/Instagram: só `https://`, sem credenciais, com domínio. */
export function validateAttachmentUrl(raw: string): AttachmentCheck<{ url: string }> {
  const value = raw.trim();
  if (!value) return { ok: false, message: "Cole o endereço do site ou do Instagram." };
  if (value.length > ATTACHMENT_URL_MAX) return { ok: false, message: "O endereço é longo demais." };
  if (!/^https:\/\//i.test(value)) return { ok: false, message: "Use um endereço que comece com https://" };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, message: "Esse endereço não parece válido. Confira e tente de novo." };
  }
  if (u.username || u.password || !u.hostname.includes(".")) {
    return { ok: false, message: "Esse endereço não parece válido. Confira e tente de novo." };
  }
  return { ok: true, url: u.toString() };
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Tipo e tamanho do arquivo escolhido. Devolve o mime que vai no upload. */
export function validateAttachmentFile(
  kind: Exclude<FileAttachmentKind, "audio">,
  file: { name: string; type: string; size: number }
): AttachmentCheck<{ mimeType: string }> {
  if (file.size <= 0) return { ok: false, message: "O arquivo está vazio." };
  const type = file.type.split(";")[0].trim().toLowerCase();
  const ext = extensionOf(file.name);
  let mimeType: string | null = null;
  if (kind === "pdf") {
    if (type === "application/pdf" || (!type && ext === "pdf")) mimeType = "application/pdf";
    if (!mimeType) return { ok: false, message: "Envie um arquivo PDF." };
  } else {
    if (IMAGE_MIMES.has(type)) mimeType = type;
    else if (!type && IMAGE_BY_EXT[ext]) mimeType = IMAGE_BY_EXT[ext];
    if (!mimeType) return { ok: false, message: "Envie uma imagem JPG, PNG ou WebP." };
  }
  if (file.size > ATTACHMENT_MAX_BYTES[kind]) {
    return { ok: false, message: `Arquivo grande demais (até ${mb(ATTACHMENT_MAX_BYTES[kind])}).` };
  }
  return { ok: true, mimeType };
}

/** Tamanho da gravação de voz (áudio ≤ 2 MB). */
export function validateVoiceSize(size: number): AttachmentCheck {
  if (size <= 0) return { ok: false, message: "A gravação ficou vazia. Grave de novo." };
  if (size > ATTACHMENT_MAX_BYTES.audio) {
    return { ok: false, message: `Áudio grande demais (até ${mb(ATTACHMENT_MAX_BYTES.audio)}, uns 3 minutos). Grave de novo, mais curto.` };
  }
  return { ok: true };
}

/** O que a pessoa escolheu enviar (antes do upload). */
export type AttachmentDraft =
  | { kind: "url"; url: string }
  | { kind: FileAttachmentKind; file: Blob; name: string; mimeType: string };

/** Texto curto da bolha da pessoa (o anexo não tem texto próprio). */
export function attachmentTurnLabel(draft: AttachmentDraft): string {
  switch (draft.kind) {
    case "url":
      try {
        return `Link: ${new URL(draft.url).host}`;
      } catch {
        return "Link do site";
      }
    case "pdf":
      return `PDF: ${draft.name}`;
    case "image":
      return `Imagem: ${draft.name}`;
    case "audio":
      return "Áudio gravado";
  }
}

export interface UploadDeps {
  organizationId: string;
  generateUploadUrl: (args: { organizationId: string }) => Promise<string>;
  saveFile: (args: {
    organizationId: string;
    storageId: string;
    name: string;
    mimeType: string;
    size: number;
    fileType: "message_attachment";
  }) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}

/** Sobe o arquivo pelo fluxo de `files` e devolve o `storageId` (um arquivo por turno). */
export async function uploadAttachmentFile(
  deps: UploadDeps,
  file: { blob: Blob; name: string; mimeType: string },
  onPhase?: (phase: "uploading" | "saving") => void
): Promise<string> {
  const doFetch = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  onPhase?.("uploading");
  const uploadUrl = await deps.generateUploadUrl({ organizationId: deps.organizationId });
  const response = await doFetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.mimeType }, body: file.blob });
  if (!response.ok) throw new Error("upload failed");
  const body = (await response.json()) as { storageId?: unknown };
  if (typeof body.storageId !== "string" || !body.storageId) throw new Error("upload failed");
  onPhase?.("saving");
  await deps.saveFile({
    organizationId: deps.organizationId,
    storageId: body.storageId,
    name: file.name,
    mimeType: file.mimeType,
    size: file.blob.size,
    fileType: "message_attachment",
  });
  return body.storageId;
}

/** Anexo do SSE para um rascunho (arquivos precisam do `storageId` do upload). */
export function toStreamAttachment(draft: AttachmentDraft, storageId?: string): OnboardingAttachment {
  if (draft.kind === "url") return { kind: "url", url: draft.url };
  if (!storageId) throw new Error("storageId ausente");
  return { kind: draft.kind, storageId };
}

/** Erro do turno que pede um bloco (conta ou aviso) em vez da mensagem genérica. */
export function gateForErrorCode(code: OnboardingErrorCode | null | undefined): "cartaoConta" | "avisoMateriais" | null {
  if (code === "email_unverified") return "cartaoConta";
  if (code === "notice_required") return "avisoMateriais";
  return null;
}

export const UPLOAD_ERROR_MESSAGE = "Não foi possível enviar o arquivo. Confira a internet e tente de novo.";
