/**
 * Envio do pedido de contato/consultoria: `POST /api/v1/public/contact` (Convex HTTP,
 * `convex/hnbcrmLeads.ts`). A rota cria o lead na org interna do HNBCRM; quando a org
 * interna não está configurada ela responde `{ok:false, code:"unavailable"}` e a tela cai
 * para o e-mail (`contactHref`).
 */
import { convexSiteUrl } from "./onboardingStream";

export type ContactRequestKind = "implantacao" | "consultoria" | "empresa";

export interface ContactRequestInput {
  name: string;
  email: string;
  phone?: string;
  business?: string;
  teamSize?: string;
  need: string;
  kind: ContactRequestKind;
  /** Isca anti-robô: sempre vazia para gente de verdade. */
  _honeypot?: string;
}

type FailCode = "invalid" | "rate_limited" | "unavailable" | "error";

export type ContactRequestResult = { ok: true } | { ok: false; code: FailCode; message: string };

const FALLBACK: Record<FailCode, string> = {
  invalid: "Confira os campos e tente de novo.",
  rate_limited: "Muitos pedidos em pouco tempo. Tente de novo mais tarde.",
  unavailable: "O formulário está indisponível agora. Fale com a gente por e-mail.",
  error: "Não foi possível enviar agora. Fale com a gente por e-mail.",
};

function isFailCode(x: unknown): x is FailCode {
  return typeof x === "string" && x in FALLBACK;
}

export async function submitContactRequest(
  input: ContactRequestInput,
  fetchImpl: typeof fetch = fetch,
  cloudUrl: string | undefined = import.meta.env.VITE_CONVEX_URL as string | undefined,
): Promise<ContactRequestResult> {
  const base = convexSiteUrl(cloudUrl);
  if (!base) return { ok: false, code: "unavailable", message: FALLBACK.unavailable };
  try {
    const res = await fetchImpl(`${base}/api/v1/public/contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data: unknown = await res.json().catch(() => null);
    const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    if (res.ok && body.ok === true) return { ok: true };
    const code: FailCode = isFailCode(body.code) ? body.code : "error";
    const message = code === "invalid" && typeof body.message === "string" ? body.message : FALLBACK[code];
    return { ok: false, code, message };
  } catch {
    return { ok: false, code: "error", message: FALLBACK.error };
  }
}
