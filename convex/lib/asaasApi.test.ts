import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AsaasError,
  asaasConfig,
  asaasWebhookToken,
  cancelSubscription,
  configureCustomerNotifications,
  createSubscription,
  createWebhook,
  getPayment,
  isAsaasEnabled,
  listSubscriptionPayments,
  upsertCustomer,
} from "./asaasApi";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];

function stubFetch(responder: (call: Call) => unknown | { status: number }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = {
        url,
        method: String(init.method),
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const out = responder(call) as { status?: number } | undefined;
      if (out && typeof out === "object" && "status" in out && Object.keys(out).length === 1) {
        return new Response("{}", { status: out.status });
      }
      return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
}

beforeEach(() => {
  vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
  vi.stubEnv("ASAAS_ENV", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("configuração", () => {
  test("sem chave a integração está desligada; ambiente padrão é sandbox", () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    expect(isAsaasEnabled()).toBe(false);
    expect(asaasConfig()).toBeNull();
    vi.stubEnv("ASAAS_API_KEY", "$aact_test_fake");
    expect(asaasConfig()).toMatchObject({ env: "sandbox", baseUrl: "https://api-sandbox.asaas.com/v3" });
    vi.stubEnv("ASAAS_ENV", "production");
    expect(asaasConfig()).toMatchObject({ env: "production", baseUrl: "https://api.asaas.com/v3" });
    vi.stubEnv("ASAAS_ENV", "qualquer-coisa");
    expect(asaasConfig()?.env).toBe("sandbox");
  });

  test("token do webhook", () => {
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "");
    expect(asaasWebhookToken()).toBeNull();
    vi.stubEnv("ASAAS_WEBHOOK_TOKEN", "  segredo-do-webhook-fake  ");
    expect(asaasWebhookToken()).toBe("segredo-do-webhook-fake");
  });

  test("sem chave, qualquer chamada falha sem tocar a rede", async () => {
    vi.stubEnv("ASAAS_API_KEY", "");
    stubFetch(() => ({}));
    await expect(getPayment("pay_1")).rejects.toThrow(/desligada/);
    expect(calls).toHaveLength(0);
  });
});

describe("chamadas", () => {
  test("headers: access_token e User-Agent; base do ambiente", async () => {
    stubFetch(() => ({ id: "pay_1", status: "PENDING" }));
    await getPayment("pay_1");
    expect(calls[0].url).toBe("https://api-sandbox.asaas.com/v3/payments/pay_1");
    expect(calls[0].headers.access_token).toBe("$aact_test_fake");
    expect(calls[0].headers["User-Agent"]).toMatch(/HNBCRM/);
  });

  test("upsertCustomer cria quando não existe e atualiza quando existe (externalReference = org)", async () => {
    stubFetch((c) => (c.method === "GET" ? { data: [] } : { id: "cus_1" }));
    expect(await upsertCustomer({ name: "Empresa", cpfCnpj: "11222333000181", email: "fin@x.com.br", externalReference: "org1" })).toEqual({ id: "cus_1" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(calls[0].url).toContain("externalReference=org1");
    expect(calls[1].body).toMatchObject({ externalReference: "org1", name: "Empresa" });

    stubFetch((c) => (c.method === "GET" ? { data: [{ id: "cus_9" }] } : { id: "cus_9" }));
    expect(await upsertCustomer({ name: "Empresa", cpfCnpj: "11222333000181", email: "fin@x.com.br", externalReference: "org1" })).toEqual({ id: "cus_9" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v3/customers", "PUT /v3/customers/cus_9"]);
  });

  test("notificações: padrão liga só o e-mail; quiet desliga tudo no cliente", async () => {
    stubFetch((c) => (c.url.includes("/notifications") && c.method === "GET" ? { data: [{ id: "not_1" }, { id: "not_2" }] } : {}));
    await configureCustomerNotifications("cus_1", { quiet: false });
    const puts = calls.filter((c) => c.method === "PUT" && c.url.includes("/notifications/"));
    expect(puts).toHaveLength(2);
    expect(puts[0].body).toMatchObject({ emailEnabledForCustomer: true, smsEnabledForCustomer: false, phoneCallEnabledForCustomer: false, whatsappEnabledForCustomer: false });

    stubFetch(() => ({}));
    await configureCustomerNotifications("cus_1", { quiet: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ notificationDisabled: true });
  });

  test("assinatura nasce UNDEFINED (cliente escolhe o meio na fatura)", async () => {
    stubFetch(() => ({ id: "sub_1" }));
    await createSubscription({ customer: "cus_1", value: 497, cycle: "MONTHLY", nextDueDate: "2026-12-01", description: "HNBCRM · plano Profissional", externalReference: "org1" });
    expect(calls[0].body).toMatchObject({ billingType: "UNDEFINED", value: 497, cycle: "MONTHLY", externalReference: "org1" });
  });

  test("cobranças da assinatura, cancelamento e webhook", async () => {
    stubFetch((c) => (c.method === "GET" ? { data: [{ id: "pay_1", invoiceUrl: "https://example.com/i/1" }] } : {}));
    expect((await listSubscriptionPayments("sub_1"))[0].invoiceUrl).toBe("https://example.com/i/1");
    stubFetch(() => ({}));
    await cancelSubscription("sub_1");
    expect(calls[0].method).toBe("DELETE");
    stubFetch(() => ({ id: "wh_1" }));
    await createWebhook({ name: "HNBCRM", url: "https://x.convex.site/webhooks/asaas", email: "ops@x.com.br", authToken: "token-fake-com-mais-de-32-caracteres-xx" });
    expect(calls[0].body).toMatchObject({ enabled: true, sendType: "SEQUENTIALLY", apiVersion: 3, authToken: "token-fake-com-mais-de-32-caracteres-xx" });
    expect((calls[0].body as { events: string[] }).events).toEqual(expect.arrayContaining(["PAYMENT_RECEIVED", "PAYMENT_OVERDUE"]));
  });

  test("erro HTTP vira AsaasError sem o corpo (que teria PII) e sem a chave", async () => {
    stubFetch(() => ({ status: 400 }));
    const err = await getPayment("pay_1").catch((e) => e);
    expect(err).toBeInstanceOf(AsaasError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("Asaas GET /payments: HTTP 400");
    expect(err.message).not.toContain("aact");
  });

  test("falha de rede também vira AsaasError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket com cpf 52998224725"); }));
    const err = await getPayment("pay_1").catch((e) => e);
    expect(err).toBeInstanceOf(AsaasError);
    expect(err.message).not.toContain("52998224725");
  });
});
