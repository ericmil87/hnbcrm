/**
 * ÚNICO arquivo que fala com o Asaas (a chave do Asaas não tem escopo: dá acesso total
 * à conta, então nada mais pode conhecê-la). Guard: `asaasApiPort.test.ts` falha se outro
 * arquivo citar o host do Asaas, ler `ASAAS_API_KEY`/`ASAAS_ENV` ou montar o header `access_token`.
 *
 * Envs do Convex (por deployment; DEV sempre sandbox):
 *  - `ASAAS_API_KEY`: sem ela a integração está DESLIGADA (tudo manual, nada quebra);
 *  - `ASAAS_ENV`: "production" | "sandbox" (padrão sandbox);
 *  - `ASAAS_WEBHOOK_TOKEN`: segredo do webhook (o Asaas o devolve no header `asaas-access-token`).
 *
 * Nunca loga chave, CPF/CNPJ, e-mail nem corpo de resposta: os erros carregam só o status HTTP
 * e o primeiro segmento do caminho. Timeout de 15 s por chamada.
 */

const USER_AGENT = "HNBCRM-Billing/1.0";
const TIMEOUT_MS = 15_000;
const BASE_URL = { production: "https://api.asaas.com/v3", sandbox: "https://api-sandbox.asaas.com/v3" } as const;

export type AsaasEnv = keyof typeof BASE_URL;
export type AsaasConfig = { apiKey: string; env: AsaasEnv; baseUrl: string };

export function asaasConfig(): AsaasConfig | null {
  const apiKey = process.env.ASAAS_API_KEY?.trim();
  if (!apiKey) return null;
  const env: AsaasEnv = process.env.ASAAS_ENV?.trim().toLowerCase() === "production" ? "production" : "sandbox";
  return { apiKey, env, baseUrl: BASE_URL[env] };
}

/** Integração ligada? (única forma de os outros arquivos saberem sem tocar na chave). */
export function isAsaasEnabled(): boolean {
  return asaasConfig() !== null;
}

/** Segredo do webhook (`ASAAS_WEBHOOK_TOKEN`); `null` se ausente. */
export function asaasWebhookToken(): string | null {
  return process.env.ASAAS_WEBHOOK_TOKEN?.trim() || null;
}

export class AsaasError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AsaasError";
    this.status = status;
  }
}

async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { body?: unknown; query?: Record<string, string | number> } = {}
): Promise<T> {
  const cfg = asaasConfig();
  if (!cfg) throw new AsaasError("Integração com o Asaas desligada (ASAAS_API_KEY ausente)", 0);
  const qs = opts.query
    ? `?${Object.entries(opts.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")}`
    : "";
  const label = `${method} /${path.split("/").filter(Boolean)[0] ?? ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}${path}${qs}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        access_token: cfg.apiKey,
        "User-Agent": USER_AGENT,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
  } catch {
    throw new AsaasError(`Asaas ${label}: falha de rede ou tempo esgotado`, 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new AsaasError(`Asaas ${label}: HTTP ${res.status}`, res.status);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new AsaasError(`Asaas ${label}: resposta inválida`, res.status);
  }
}

type List<T> = { data?: T[]; hasMore?: boolean };

// ── Tipos mínimos (só o que o app lê) ───────────────────────────────────────

export type AsaasPayment = {
  id: string;
  customer?: string;
  subscription?: string | null;
  externalReference?: string | null;
  status?: string;
  value?: number;
  netValue?: number;
  billingType?: string;
  dueDate?: string;
  paymentDate?: string | null;
  confirmedDate?: string | null;
  dateCreated?: string;
  description?: string | null;
  invoiceUrl?: string | null;
  invoiceNumber?: string | null;
  transactionReceiptUrl?: string | null;
  deleted?: boolean;
};

export type AsaasSubscription = {
  id: string;
  customer?: string;
  externalReference?: string | null;
  status?: string;
  value?: number;
  cycle?: string;
  nextDueDate?: string;
  deleted?: boolean;
};

export type AsaasWebhookConfig = { id?: string; name?: string; url?: string; enabled?: boolean };

// ── Clientes ─────────────────────────────────────────────────────────────────

/** Cria ou atualiza o cliente da org (`externalReference` = id da org). */
export async function upsertCustomer(input: {
  name: string;
  cpfCnpj: string;
  email: string;
  externalReference: string;
}): Promise<{ id: string }> {
  const found = await call<List<{ id: string }>>("GET", "/customers", {
    query: { externalReference: input.externalReference, limit: 1 },
  });
  const existing = found.data?.[0];
  const body = { name: input.name, cpfCnpj: input.cpfCnpj, email: input.email, externalReference: input.externalReference };
  if (existing) {
    await call("PUT", `/customers/${existing.id}`, { body });
    return { id: existing.id };
  }
  const created = await call<{ id: string }>("POST", "/customers", { body });
  return { id: created.id };
}

/**
 * Notificações do Asaas ao cliente. Padrão: liga só o e-mail (SMS e ligação custam e
 * duplicam). Com `quiet` (org em silêncio) desliga TODAS no cliente (`notificationDisabled`).
 */
export async function configureCustomerNotifications(customerId: string, opts: { quiet: boolean }): Promise<void> {
  if (opts.quiet) {
    await call("PUT", `/customers/${customerId}`, { body: { notificationDisabled: true } });
    return;
  }
  await call("PUT", `/customers/${customerId}`, { body: { notificationDisabled: false } });
  const list = await call<List<{ id: string }>>("GET", `/customers/${customerId}/notifications`, { query: { limit: 20 } });
  for (const n of list.data ?? []) {
    await call("PUT", `/notifications/${n.id}`, {
      body: {
        enabled: true,
        emailEnabledForCustomer: true,
        smsEnabledForCustomer: false,
        phoneCallEnabledForCustomer: false,
        whatsappEnabledForCustomer: false,
      },
    });
  }
}

// ── Assinaturas e cobranças ──────────────────────────────────────────────────

/** Assinatura com `billingType: UNDEFINED`: o cliente escolhe Pix/boleto/cartão na fatura hospedada. */
export async function createSubscription(input: {
  customer: string;
  value: number;
  cycle: "MONTHLY" | "YEARLY";
  nextDueDate: string; // AAAA-MM-DD
  description: string;
  externalReference: string;
}): Promise<AsaasSubscription> {
  return await call<AsaasSubscription>("POST", "/subscriptions", {
    body: { ...input, billingType: "UNDEFINED" },
  });
}

/**
 * Reprecifica a assinatura para as PRÓXIMAS cobranças (`updatePendingPayments: false` não mexe
 * na cobrança já emitida).
 */
export async function updateSubscriptionValue(id: string, value: number): Promise<void> {
  await call("PUT", `/subscriptions/${encodeURIComponent(id)}`, { body: { value, updatePendingPayments: false } });
}

export async function getSubscription(id: string): Promise<AsaasSubscription> {
  return await call<AsaasSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
}

export async function cancelSubscription(id: string): Promise<void> {
  await call("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
}

export async function getPayment(id: string): Promise<AsaasPayment> {
  return await call<AsaasPayment>("GET", `/payments/${encodeURIComponent(id)}`);
}

/** Cobranças já geradas pela assinatura (a 1ª nasce na criação). */
export async function listSubscriptionPayments(subscriptionId: string): Promise<AsaasPayment[]> {
  const res = await call<List<AsaasPayment>>("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`, {
    query: { limit: 10 },
  });
  return res.data ?? [];
}

// ── Webhook e conta ──────────────────────────────────────────────────────────

export const ASAAS_WEBHOOK_EVENTS = [
  "PAYMENT_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_OVERDUE",
  "PAYMENT_REFUNDED",
  "PAYMENT_DELETED",
  "SUBSCRIPTION_DELETED",
  "SUBSCRIPTION_INACTIVATED",
] as const;

export async function listWebhooks(): Promise<AsaasWebhookConfig[]> {
  const res = await call<List<AsaasWebhookConfig>>("GET", "/webhooks", { query: { limit: 100 } });
  return res.data ?? [];
}

export async function createWebhook(input: { name: string; url: string; email: string; authToken: string }): Promise<{ id: string }> {
  return await call<{ id: string }>("POST", "/webhooks", {
    body: {
      name: input.name,
      url: input.url,
      email: input.email,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: input.authToken,
      sendType: "SEQUENTIALLY",
      events: [...ASAAS_WEBHOOK_EVENTS],
    },
  });
}

/** Nome da conta (para o ping de ops; quem chama mascara). */
export async function getAccountName(): Promise<string | null> {
  const res = await call<{ name?: string; companyName?: string; tradingName?: string }>("GET", "/myAccount/commercialInfo");
  return res.companyName ?? res.tradingName ?? res.name ?? null;
}
