/**
 * Busca de foto de perfil — passos de REDE compartilhados (sem `ctx`): contato 1 a 1,
 * grupo (gateway do bridge) e contato do Instagram/Messenger (CDN da Meta) baixam e
 * validam do MESMO jeito. Nunca loga URL, telefone nem JID.
 */
import {
  AVATAR_FETCH_TIMEOUT_MS,
  MAX_AVATAR_BYTES,
  type AvatarMime,
  buildAvatarRequestBody,
  isAllowedAvatarUrl,
  parseAvatarResponse,
  readBodyCapped,
  validateAvatarBytes,
} from "./bridgeAvatar";

export type DownloadedAvatar = { bytes: Uint8Array; mime: AvatarMime; size: number };

/**
 * Baixa a imagem: sem seguir redirecionamento (3xx/opaco = erro; só `followOneRedirect`,
 * usado pela Meta, segue UM, com o host de destino validado por `allowUrl` antes de
 * buscar; o segundo redirect é erro), host do destino conferido de novo, `Content-Length` e corpo lido com teto, tipo pelos BYTES.
 * `null` em qualquer recusa ou falha de rede.
 */
export async function downloadAvatarImage(
  url: string,
  opts: { allowUrl: (url: string) => boolean; maxBytes: number; followOneRedirect?: boolean }
): Promise<DownloadedAvatar | null> {
  const get = (u: string) => fetch(u, { redirect: "manual", signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS) });
  let img = await get(url);
  if (opts.followOneRedirect && img.status >= 300 && img.status < 400) {
    const location = img.headers.get("location");
    await img.body?.cancel().catch(() => undefined);
    let target: string | null = null;
    try {
      target = location ? new URL(location, url).href : null;
    } catch {
      target = null;
    }
    if (!target || !opts.allowUrl(target)) return null;
    img = await get(target);
  }
  const declared = Number(img.headers.get("content-length") ?? "0");
  if (img.status < 200 || img.status >= 300 || declared > opts.maxBytes || (img.url && !opts.allowUrl(img.url))) {
    await img.body?.cancel().catch(() => undefined);
    return null;
  }
  const bytes = await readBodyCapped(img, opts.maxBytes);
  const checked = bytes ? validateAvatarBytes(bytes, opts.maxBytes) : null;
  if (!bytes || !checked) return null;
  return { bytes, mime: checked.mime, size: checked.size };
}

export type GatewayAvatarPlan = {
  baseUrl: string;
  /** Já decifrado. */
  token: string;
  /** Telefone (só dígitos) ou JID de grupo (`…@g.us`). */
  target: string;
  pictureId: string | null;
  hasBlob: boolean;
};

export type GatewayAvatarResult =
  | { kind: "outcome"; outcome: "same" | "hidden" | "none" | "error" | "rate_limited" }
  | { kind: "new"; image: DownloadedAvatar; pictureId?: string };

/** `POST /user/avatar` + download da miniatura. Lança só por falha de rede (o chamador trata como `error`). */
export async function fetchGatewayAvatar(plan: GatewayAvatarPlan): Promise<GatewayAvatarResult> {
  const res = await fetch(`${plan.baseUrl.replace(/\/+$/, "")}/user/avatar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: plan.token },
    body: buildAvatarRequestBody(plan.target),
    signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* texto cru */
  }
  const parsed = parseAvatarResponse(res.status, body);
  if (parsed.kind !== "ok") return { kind: "outcome", outcome: parsed.kind };
  if (!isAllowedAvatarUrl(parsed.url)) return { kind: "outcome", outcome: "error" };
  if (plan.hasBlob && plan.pictureId && parsed.pictureId === plan.pictureId) {
    return { kind: "outcome", outcome: "same" };
  }
  const image = await downloadAvatarImage(parsed.url, { allowUrl: isAllowedAvatarUrl, maxBytes: MAX_AVATAR_BYTES });
  if (!image) return { kind: "outcome", outcome: "error" };
  return { kind: "new", image, ...(parsed.pictureId ? { pictureId: parsed.pictureId } : {}) };
}
