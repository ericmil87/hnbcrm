/**
 * Inscrição na lista de novidades: `POST /api/v1/public/newsletter` (Convex HTTP,
 * `convex/hnbcrmLeads.ts`). A rota cria um lead com a etiqueta `newsletter` na org
 * interna do HNBCRM. Corpo máximo de 2 KB.
 */
import { convexSiteUrl } from "./onboardingStream";

export interface NewsletterSignupInput {
  email: string;
  name?: string;
  /** Onde a pessoa se inscreveu (ex.: "landing", "manifesto"). */
  source?: string;
  /** Isca anti-robô: sempre vazia para gente de verdade. */
  _honeypot?: string;
}

type FailCode = "invalid" | "rate_limited" | "unavailable" | "error";

export type NewsletterSignupResult = { ok: true } | { ok: false; code: FailCode; message: string };

const FALLBACK: Record<FailCode, string> = {
  invalid: "Confira o e-mail e tente de novo.",
  rate_limited: "Muitas tentativas em pouco tempo. Tente de novo mais tarde.",
  unavailable: "A inscrição está indisponível agora. Tente de novo mais tarde.",
  error: "Não foi possível inscrever agora. Tente de novo mais tarde.",
};

function isFailCode(x: unknown): x is FailCode {
  return typeof x === "string" && x in FALLBACK;
}

export async function submitNewsletterSignup(
  input: NewsletterSignupInput,
  fetchImpl: typeof fetch = fetch,
  cloudUrl: string | undefined = import.meta.env.VITE_CONVEX_URL as string | undefined,
): Promise<NewsletterSignupResult> {
  const base = convexSiteUrl(cloudUrl);
  if (!base) return { ok: false, code: "unavailable", message: FALLBACK.unavailable };
  try {
    const res = await fetchImpl(`${base}/api/v1/public/newsletter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data: unknown = await res.json().catch(() => null);
    const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    if (res.ok && body.ok === true) return { ok: true };
    const code: FailCode = isFailCode(body.code) ? body.code : "error";
    const message = code === "invalid" && typeof body.message === "string" && body.message ? body.message : FALLBACK[code];
    return { ok: false, code, message };
  } catch {
    return { ok: false, code: "error", message: FALLBACK.error };
  }
}
