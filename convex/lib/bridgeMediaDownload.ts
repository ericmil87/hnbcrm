/**
 * Download + decifra + armazenamento de UMA mídia do bridge (wuzapi).
 *
 * Núcleo único de três caminhos: o ingest 1:1, o ingest de grupo e o download
 * SOB DEMANDA da mídia de grupo que a política não baixou (v0.62). As defesas
 * da v0.53 valem igual para os três: teto de 25 MB (pelo descriptor, antes de
 * buscar os bytes, e de novo depois), allowlist de mimetype e quota da org via
 * `internalSaveInboundAttachment`. O descriptor cru (com `MediaKey`) só existe
 * na memória da action que chama.
 *
 * Nunca lança: devolve o motivo da falha para quem chama decidir o que anotar.
 */
import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { decryptSecret } from "./secretCrypto";
import {
  BridgeMediaKind,
  base64ToBytes,
  buildBridgeDownloadRequest,
  descriptorFileLength,
  parseBridgeDownloadResponse,
} from "./bridgeMedia";

export const MAX_BRIDGE_MEDIA_BYTES = 25 * 1024 * 1024; // mirror the Meta path

// whatsmeow media kinds we know how to download; anything else is treated as a document.
const KNOWN_MEDIA_KINDS: readonly BridgeMediaKind[] = ["image", "sticker", "audio", "video", "document"];
export function normalizeBridgeMediaKind(kind: string): BridgeMediaKind {
  return (KNOWN_MEDIA_KINDS as readonly string[]).includes(kind) ? (kind as BridgeMediaKind) : "document";
}

export type BridgeMediaInput = {
  kind: string;
  mimeType?: string;
  filename?: string;
  descriptor?: Record<string, any>;
};

export type BridgeMediaFetchResult =
  | { ok: true; fileId: Id<"files"> }
  | {
      ok: false;
      /**
       * `too_big` / `rejected` (allowlist ou quota) viram `mediaSkipped` no
       * ingest; `error` (config, rede, gateway) vira `mediaError`.
       */
      failure: "too_big" | "rejected" | "error";
      reason: string;
      /** Só em `rejected`: `mime` é definitivo, `quota` é transitório. */
      rejectedBy?: "mime" | "quota";
    };

export async function fetchAndStoreBridgeMedia(
  ctx: ActionCtx,
  args: {
    config: {
      organizationId: Id<"organizations">;
      bridgeBaseUrl?: string;
      bridgeTokenEncrypted?: string;
    };
    media: BridgeMediaInput;
    externalId: string;
    /**
     * Teto do fetch ao gateway. O download sob demanda passa um valor menor
     * que a trava dele — sem isto um gateway pendurado deixava a trava vencer
     * com o download ainda em voo, e um segundo clique baixava de novo.
     */
    timeoutMs?: number;
  }
): Promise<BridgeMediaFetchResult> {
  const { config, media } = args;
  try {
    if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
      return {
        ok: false,
        failure: "error",
        reason: "Configuração bridge incompleta — mídia não baixada",
      };
    }
    const descriptor = (media.descriptor ?? {}) as Record<string, any>;
    const declaredLen = descriptorFileLength(descriptor);
    if (declaredLen !== undefined && declaredLen > MAX_BRIDGE_MEDIA_BYTES) {
      // Nem busca os bytes quando o descriptor já diz que é grande demais.
      return { ok: false, failure: "too_big", reason: `mídia muito grande (${declaredLen} bytes)` };
    }
    const token = await decryptSecret(config.bridgeTokenEncrypted);
    const request = buildBridgeDownloadRequest({
      baseUrl: config.bridgeBaseUrl,
      token,
      kind: normalizeBridgeMediaKind(media.kind),
      descriptor,
    });
    const controller = args.timeoutMs !== undefined ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), args.timeoutMs)
      : undefined;
    let res: Response;
    let body: unknown;
    try {
      res = await fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        ...(controller ? { signal: controller.signal } : {}),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      if (controller?.signal.aborted) {
        return {
          ok: false,
          failure: "error",
          reason: `o gateway não respondeu em ${Math.round((args.timeoutMs ?? 0) / 1000)} s`,
        };
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const parsed = parseBridgeDownloadResponse(res.ok, res.status, body);
    if (!parsed.ok) return { ok: false, failure: "error", reason: parsed.error };

    const bytes = base64ToBytes(parsed.base64);
    if (bytes.byteLength > MAX_BRIDGE_MEDIA_BYTES) {
      return { ok: false, failure: "too_big", reason: `mídia muito grande (${bytes.byteLength} bytes)` };
    }
    const mimeType = media.mimeType ?? parsed.mimeType ?? "application/octet-stream";
    const storageId = await ctx.storage.store(new Blob([bytes], { type: mimeType }));
    const saved = await ctx.runMutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId: config.organizationId,
      storageId,
      name: media.filename ?? `whatsapp-${args.externalId}`,
      mimeType,
      size: bytes.byteLength,
    });
    if (saved.ok) return { ok: true, fileId: saved.fileId };
    // Mimetype fora da allowlist ou quota estourada (o blob já foi apagado lá).
    return {
      ok: false,
      failure: "rejected",
      reason: saved.reason,
      ...(saved.code ? { rejectedBy: saved.code } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      failure: "error",
      reason: e instanceof Error ? e.message : "media pipeline failed",
    };
  }
}
