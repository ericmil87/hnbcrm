/**
 * `POST /webhooks/asaas`: "persistir -> agendar -> 200" (padrão bridge/Meta/Telegram), fora do
 * REST `/api/v1` (autenticado pelo segredo do emissor, não por chave de API de org).
 *
 *  1. Integração desligada (sem `ASAAS_API_KEY`) ou sem `ASAAS_WEBHOOK_TOKEN`: 503.
 *  2. Header `asaas-access-token` comparado em tempo constante: ausente/errado = 401.
 *  3. Corpo que não é JSON, ou sem `id`/`event`: 200 (repetir não adianta).
 *  4. `internalIngestEvent` grava o evento (dedupe por `id`; repetido = 200 no-op) e agenda o
 *     processamento, que RELÊ o pagamento na API antes de mudar qualquer estado. Se gravar falhar:
 *     500 (o Asaas repete).
 *
 * O corpo NUNCA é logado (tem nome, CPF/CNPJ e e-mail).
 */
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { safeEqual } from "./lib/metaSignedRequest";
import { asaasWebhookToken, isAsaasEnabled } from "./lib/asaasApi";

export const ASAAS_TOKEN_HEADER = "asaas-access-token";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export const asaasWebhook = httpAction(async (ctx, request) => {
  const expected = asaasWebhookToken();
  if (!isAsaasEnabled() || !expected) return new Response("Service Unavailable", { status: 503 });
  const received = request.headers.get(ASAAS_TOKEN_HEADER);
  if (!received || !safeEqual(received, expected)) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 200 });
  }
  const root = obj(body);
  const eventId = str(root?.id);
  const event = str(root?.event);
  if (!eventId || !event) return new Response(null, { status: 200 });
  const payment = obj(root?.payment);
  const subscription = obj(root?.subscription);
  try {
    await ctx.runMutation(internal.billingAsaas.internalIngestEvent, {
      eventId,
      event,
      ...(str(payment?.id) ? { paymentId: str(payment?.id) } : {}),
      // Evento de pagamento traz a assinatura em `payment.subscription`; de assinatura, em `subscription.id`.
      ...(str(payment?.subscription) || str(subscription?.id)
        ? { subscriptionId: str(payment?.subscription) ?? str(subscription?.id) }
        : {}),
    });
  } catch {
    return new Response("Error", { status: 500 });
  }
  return new Response(null, { status: 200 });
});
