/// <reference types="vite/client" />
// Modelo padrão `deepseek-flash-latest` (22/11/2026): cadeia de fallback em cada
// modo, id aposentado como alias, recusa de escolha nova e troca em massa.
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { resolveOrgRoutes, resolveProductRoutes } from "./lib/agentRoutes";
import { chatWithFallback, resolvePlatformChain } from "./lib/llm";
import { encryptSecret } from "./lib/secretCrypto";
import {
  DEFAULT_MODELS,
  DEFAULT_STORED_MODELS,
  MODEL_FALLBACKS,
  RETIRED_MODEL_ALIASES,
  modelPrice,
} from "./lib/llm/registry";

const modules = import.meta.glob("./**/*.*s");
const NEW = "deepseek-flash-latest";
const OLD = "deepseek-v4-flash";

function envKeys(keys: { go?: string; or?: string }) {
  vi.stubEnv("OPENCODE_GO_API", keys.go ?? "");
  vi.stubEnv("OPENROUTER_API_KEY", keys.or ?? "");
  vi.stubEnv("LLM_PLATFORM_ORDER", "");
}
const noCtx = { runQuery: async () => null } as never;
const summary = (r: { providerId: string; model: string }[]) => r.map((x) => `${x.providerId}:${x.model}`);

afterEach(() => vi.unstubAllEnvs());

describe("padrão de código", () => {
  test("atendente e classificador usam o alias; preço do antigo segue na tabela", () => {
    expect(DEFAULT_MODELS.attendant).toBe(NEW);
    expect(DEFAULT_MODELS.classify).toBe(NEW);
    expect(DEFAULT_STORED_MODELS.attendant).toBe(NEW);
    expect(DEFAULT_MODELS.vision).toBe("deepseek-v4-flash-vision-exp");
    expect(modelPrice(OLD)).toMatchObject({ inPerM: 0.132, outPerM: 0.28 });
    expect(modelPrice("deepseek/deepseek-v4-flash")).toMatchObject({ inPerM: 0.132 });
    expect(modelPrice("deepseek-v4-flash-0731")).not.toBeNull();
  });
});

describe("cadeia da plataforma", () => {
  test("com as duas chaves: alias no OpenRouter, depois o antigo no OpenCode Go e no OpenRouter", async () => {
    envKeys({ go: "go", or: "or" });
    const routes = await resolveOrgRoutes(noCtx, "x" as never, null, NEW, "attendant");
    expect(summary(routes)).toEqual([
      `openrouter:~deepseek/deepseek-flash-latest`,
      `openrouter:deepseek/deepseek-v4-flash`,
      `opencode-go:${OLD}`,
    ]);
    // trava ZDR + allow_fallbacks intactas em todo elo do OpenRouter
    for (const r of routes.filter((x) => x.providerId === "openrouter")) {
      expect(r.extraBody?.provider).toMatchObject({ data_collection: "deny", require_parameters: true });
      expect(r.zdr.zdrCapable).toBe(true);
    }
  });

  test("429 do OpenRouter no alias: o elo seguinte existe e usa o antigo", async () => {
    envKeys({ go: "go", or: "or" });
    const routes = await resolveOrgRoutes(noCtx, "x" as never, null, NEW, "attendant");
    expect(routes.length).toBeGreaterThan(1);
    expect(routes[1].canonicalModel).toBe(OLD);
    expect(routes[1].providerId).toBe("openrouter");
  });

  test("sem OPENROUTER_API_KEY: cai no antigo via OpenCode Go", async () => {
    envKeys({ go: "go" });
    expect(summary(await resolveOrgRoutes(noCtx, "x" as never, null, NEW, "attendant"))).toEqual([
      `opencode-go:${OLD}`,
    ]);
  });

  test("sem nenhuma chave: sem rota (mesmo que antes)", async () => {
    envKeys({});
    expect(await resolveOrgRoutes(noCtx, "x" as never, null, NEW, "attendant")).toEqual([]);
  });

  test("openrouter-first / openrouter-only / opencode-only respeitam a ordem da org", async () => {
    envKeys({ go: "go", or: "or" });
    const o = (platformOrder: "openrouter-first" | "openrouter-only" | "opencode-only") =>
      resolveOrgRoutes(noCtx, "x" as never, { platformOrder }, NEW, "attendant").then(summary);
    const orFirst = [
      `openrouter:~deepseek/deepseek-flash-latest`,
      `openrouter:deepseek/deepseek-v4-flash`,
      `opencode-go:${OLD}`,
    ];
    expect(await o("openrouter-first")).toEqual(orFirst);
    expect(await resolveOrgRoutes(noCtx, "x" as never, { platformOrder: "auto" }, NEW, "attendant").then(summary)).toEqual(orFirst);
    expect(await o("openrouter-only")).toHaveLength(2);
    expect(await o("opencode-only")).toEqual([`opencode-go:${OLD}`]);
  });

  test("strictZdr mantém só rotas ZDR (todas as da plataforma são)", async () => {
    envKeys({ go: "go", or: "or" });
    const routes = await resolveOrgRoutes(noCtx, "x" as never, { strictZdr: true }, NEW, "attendant");
    expect(routes).toHaveLength(3);
  });

  test("quem escolheu outro modelo não ganha fallback novo", async () => {
    envKeys({ go: "go", or: "or" });
    expect(Object.keys(MODEL_FALLBACKS)).toEqual([NEW]);
    const kimi = await resolveOrgRoutes(noCtx, "x" as never, null, "kimi-k2.7-code", "copilot");
    expect(kimi.every((r) => r.canonicalModel === "kimi-k2.7-code")).toBe(true);
  });

  test("id aposentado gravado na org roda como o alias (com a mesma rede)", async () => {
    envKeys({ go: "go", or: "or" });
    expect(RETIRED_MODEL_ALIASES[OLD]).toBe(NEW);
    expect(RETIRED_MODEL_ALIASES["deepseek-v4-flash-0731"]).toBe(NEW);
    for (const stored of [OLD, "deepseek-v4-flash-0731"]) {
      const routes = await resolveOrgRoutes(noCtx, "x" as never, null, stored, "attendant");
      expect(routes[0].canonicalModel).toBe(NEW);
      expect(routes).toHaveLength(3);
    }
  });

  test("Copiloto no Telegram sem OpenRouter segue no modelo do Copiloto; tradução usa a rede", async () => {
    envKeys({ go: "go" });
    const tg = await resolveProductRoutes(noCtx, "x" as never, null, "telegramCopilot");
    expect(tg.canonicalModel).toBe("kimi-k2.7-code");
    const tr = await resolveProductRoutes(noCtx, "x" as never, null, "translation");
    expect(summary(tr.routes)).toEqual([`opencode-go:${OLD}`]);
  });
});

describe("BYO", () => {
  async function byoCtx() {
    vi.stubEnv("CHANNEL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const enc = await encryptSecret("chave-propria");
    return { runQuery: async () => enc } as never;
  }
  const cfg = (provider: string, baseUrl?: string) =>
    ({ mode: "byo", byo: { provider, baseUrl, apiKeyRef: { kind: "orgSecret", id: "s" } } }) as never;

  test("chave OpenRouter própria: o alias funciona, rota única, sem fallback da plataforma", async () => {
    envKeys({ go: "go", or: "or" });
    const routes = await resolveOrgRoutes(await byoCtx(), "x" as never, cfg("openrouter"), NEW, "attendant");
    expect(summary(routes)).toEqual(["openrouter:~deepseek/deepseek-flash-latest"]);
    expect(routes[0].endpoint.apiKey).toBe("chave-propria");
  });

  test("chave de outro provedor: troca o alias pelo modelo que o provedor conhece", async () => {
    envKeys({ go: "go", or: "or" });
    const go = await resolveOrgRoutes(await byoCtx(), "x" as never, cfg("opencode-go"), NEW, "attendant");
    expect(summary(go)).toEqual([`opencode-go:${OLD}`]);
    const custom = await resolveOrgRoutes(await byoCtx(), "x" as never, cfg("custom", "https://x.test/v1"), NEW, "attendant");
    expect(summary(custom)).toEqual([`custom:${OLD}`]);
  });

  test("BYO com id aposentado gravado também vira o alias", async () => {
    const routes = await resolveOrgRoutes(await byoCtx(), "x" as never, cfg("openrouter"), OLD, "attendant");
    expect(routes[0].canonicalModel).toBe(NEW);
  });
});

async function seed(t: ReturnType<typeof convexTest>, slug: string, models?: Record<string, string>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.5,
          ...(models ? { providerConfig: { mode: "platform" as const, zdr: true, models: models as never } } : {}),
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    return { organizationId, userId };
  });
}

describe("setModels e getModelOptions", () => {
  const stored = { copilot: "kimi-k2.7-code", attendant: OLD, classify: OLD };

  test("recusa o antigo como escolha NOVA, aceita manter o já gravado", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t, "a", stored);
    const as = t.withIdentity({ subject: `${userId}|s` });
    await expect(
      as.mutation(api.aiSettings.setModels, {
        organizationId,
        models: { copilot: "kimi-k2.7-code", attendant: "deepseek-v4-flash-0731", classify: NEW },
      })
    ).rejects.toThrow(/aposentado/);
    // manter o que já está gravado no mesmo papel passa
    await as.mutation(api.aiSettings.setModels, {
      organizationId,
      models: { copilot: "kimi-k2.7-code", attendant: OLD, classify: OLD },
    });
    await as.mutation(api.aiSettings.setModels, {
      organizationId,
      models: { copilot: "kimi-k2.7-code", attendant: NEW, classify: NEW },
    });
    // já trocado: o antigo deixou de ser aceito
    await expect(
      as.mutation(api.aiSettings.setModels, {
        organizationId,
        models: { copilot: "kimi-k2.7-code", attendant: OLD, classify: NEW },
      })
    ).rejects.toThrow(/aposentado/);
  });

  test("lista de opções esconde os antigos, salvo o que a org ainda tem gravado", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t, "a", stored);
    const b = await seed(t, "b");
    const idsA = (await t.withIdentity({ subject: `${a.userId}|s` }).query(api.aiSettings.getModelOptions, { organizationId: a.organizationId })).map((m: { id: string }) => m.id);
    const idsB = (await t.withIdentity({ subject: `${b.userId}|s` }).query(api.aiSettings.getModelOptions, { organizationId: b.organizationId })).map((m: { id: string }) => m.id);
    expect(idsB).toContain(NEW);
    expect(idsB).not.toContain(OLD);
    expect(idsB).not.toContain("deepseek-v4-flash-0731");
    expect(idsA).toContain(OLD);
    expect(idsA).not.toContain("deepseek-v4-flash-0731");
  });
});

describe("internalReplaceModelAllOrgs", () => {
  test("dryRun lista slug+papéis sem gravar; o real troca, audita por org e ignora org sem modelos gravados", async () => {
    const t = convexTest(schema, modules);
    await seed(t, "tem-antigo", { copilot: "kimi-k2.7-code", attendant: OLD, classify: OLD });
    await seed(t, "outro-modelo", { copilot: "kimi-k2.7-code", attendant: "glm-5.2", classify: "glm-5.2" });
    await seed(t, "sem-gravado");

    const dry = await t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, { from: OLD, to: NEW });
    expect(dry).toMatchObject({ dryRun: true, isDone: true, scanned: 3 });
    expect(dry.affected).toEqual([{ slug: "tem-antigo", roles: ["attendant", "classify"] }]);
    expect(await t.run((ctx) => ctx.db.query("auditLogs").collect())).toHaveLength(0);

    const real = await t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, {
      from: OLD, to: NEW, dryRun: false,
    });
    expect(real.affected).toEqual(dry.affected);
    const orgs = await t.run((ctx) => ctx.db.query("organizations").collect());
    const by = Object.fromEntries(orgs.map((o) => [o.slug, o.settings.aiConfig?.providerConfig?.models]));
    expect(by["tem-antigo"]).toMatchObject({ attendant: NEW, classify: NEW, copilot: "kimi-k2.7-code" });
    expect(by["outro-modelo"]).toMatchObject({ attendant: "glm-5.2" });
    expect(by["sem-gravado"]).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("auditLogs").collect())).toHaveLength(1);

    // idempotente
    const again = await t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, { from: OLD, to: NEW, dryRun: false });
    expect(again.affected).toEqual([]);
  });

  test("pagina por cursor e recusa destino desconhecido", async () => {
    const t = convexTest(schema, modules);
    for (const s of ["a", "b", "c"]) await seed(t, s, { copilot: "kimi-k2.7-code", attendant: OLD, classify: OLD });
    const p1 = await t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, { from: OLD, to: NEW, pageSize: 2 });
    expect(p1.isDone).toBe(false);
    expect(p1.affected).toHaveLength(2);
    const p2 = await t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, { from: OLD, to: NEW, pageSize: 2, cursor: p1.continueCursor });
    expect(p2.isDone).toBe(true);
    expect(p2.affected).toHaveLength(1);
    await expect(
      t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, { from: OLD, to: "inventado" })
    ).rejects.toThrow(/desconhecido/);
  });
});

describe("chatWithFallback com a cadeia do alias (fetch simulado)", () => {
  const ok = () =>
    new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "oi" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const sessionErr = () =>
    new Response(JSON.stringify({ error: { message: "Request is missing x-opencode-session" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  const req = { messages: [{ role: "user" as const, content: "oi" }] };
  const run = async (routes: Parameters<typeof chatWithFallback>[0], answer: (model: string, url: string) => Response) => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const model = JSON.parse(init.body).model as string;
        calls.push(model);
        return answer(model, url);
      })
    );
    vi.useFakeTimers();
    const p = chatWithFallback(routes, req).then(
      (r) => ({ r }),
      (e) => ({ e })
    );
    await vi.runAllTimersAsync();
    const out = (await p) as { r?: Awaited<ReturnType<typeof chatWithFallback>>; e?: { status?: number } };
    vi.useRealTimers();
    return { calls, r: out.r, e: out.e };
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("429 no alias, 200 no OpenRouter com o v4-flash (cadeia real do modo auto)", async () => {
    envKeys({ go: "go", or: "or" });
    const routes = await resolveOrgRoutes(noCtx, "x" as never, null, NEW, "attendant");
    const { calls, r } = await run(routes, (m) => (m.includes("flash-latest") ? new Response("x", { status: 429 }) : ok()));
    expect(r?.usedRoute).toMatchObject({ providerId: "openrouter", canonicalModel: OLD });
    expect(calls.at(-1)).toBe("deepseek/deepseek-v4-flash");
  });

  test("400 x-opencode-session no Go avança ao próximo elo; outros 400 não", async () => {
    const go = resolvePlatformChain(OLD, { opencodeGoKey: "go", openrouterKey: "or" }); // [go, openrouter]
    const a = await run(go, (_m, url) => (url.includes("opencode") ? sessionErr() : ok()));
    expect(a.r?.usedRoute.providerId).toBe("openrouter");
    const b = await run(go, (_m, url) =>
      url.includes("opencode")
        ? new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400, headers: { "Content-Type": "application/json" } })
        : ok()
    );
    expect(b.calls).toHaveLength(1);
    expect(b.e).toMatchObject({ status: 400 });
  });

  test("429 no alias, 400 de sessão no Go, 200 no elo seguinte", async () => {
    const [alias] = resolvePlatformChain(NEW, { openrouterKey: "or" });
    const [goV4, orV4] = resolvePlatformChain(OLD, { opencodeGoKey: "go", openrouterKey: "or" });
    const { r } = await run([alias, goV4, orV4], (m, url) =>
      m.includes("flash-latest") ? new Response("x", { status: 429 }) : url.includes("opencode") ? sessionErr() : ok()
    );
    expect(r?.usedRoute.canonicalModel).toBe(OLD);
    expect(r?.usedRoute.providerId).toBe("openrouter");
  });

  test("todos falham: sobe o erro do PRIMEIRO elo (429), não o do último", async () => {
    const [alias] = resolvePlatformChain(NEW, { openrouterKey: "or" });
    const [goV4, orV4] = resolvePlatformChain(OLD, { opencodeGoKey: "go", openrouterKey: "or" });
    const { e } = await run([alias, goV4, orV4], (_m, url) =>
      url.includes("opencode") ? sessionErr() : new Response("limite", { status: 429 })
    );
    expect(e).toMatchObject({ status: 429 });
  });
});

describe("itens da revisão", () => {
  const stored = { copilot: "kimi-k2.7-code", attendant: OLD, classify: OLD };

  test("ops recusam id aposentado como destino", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, "a", { ...stored, attendant: "glm-5.2" });
    await expect(
      t.mutation(internal.aiSettings.internalReplaceModelAllOrgs, { from: "glm-5.2", to: OLD })
    ).rejects.toThrow(/aposentado/);
    await expect(
      t.mutation(internal.aiSettings.internalReplaceOrgModel, { organizationId: s.organizationId, from: "glm-5.2", to: "deepseek-v4-flash-0731" })
    ).rejects.toThrow(/aposentado/);
  });

  test("setModels e setProviderMode preservam providerConfig.products", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t, "p", { copilot: "kimi-k2.7-code", attendant: NEW, classify: NEW });
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(organizationId))!;
      const ai = org.settings.aiConfig!;
      await ctx.db.patch(organizationId, {
        settings: {
          ...org.settings,
          aiConfig: {
            ...ai,
            providerConfig: {
              ...ai.providerConfig!,
              products: { attendant: { order: "openrouter-only" }, vision: { model: "deepseek-v4-flash-vision-exp" } },
            },
          },
        },
      });
    });
    const as = t.withIdentity({ subject: `${userId}|s` });
    await as.mutation(api.aiSettings.setModels, {
      organizationId,
      models: { copilot: "kimi-k2.7-code", attendant: "glm-5.2", classify: "glm-5.2" },
      nonZdrAck: true,
    });
    await as.mutation(api.aiSettings.setProviderMode, { organizationId, mode: "platform" });
    const org = await t.run((ctx) => ctx.db.get(organizationId));
    expect(org?.settings.aiConfig?.providerConfig?.models?.attendant).toBe("glm-5.2");
    expect(org?.settings.aiConfig?.providerConfig?.products).toEqual({
      attendant: { order: "openrouter-only" },
      vision: { model: "deepseek-v4-flash-vision-exp" },
    });
  });

  test("trocar só o copiloto (UI manda classify = attendant) não é barrado com attendant aposentado gravado", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t, "c", { copilot: "kimi-k2.7-code", attendant: OLD, classify: NEW });
    const as = t.withIdentity({ subject: `${userId}|s` });
    await as.mutation(api.aiSettings.setModels, {
      organizationId,
      models: { copilot: "kimi-k3", attendant: OLD, classify: OLD },
      nonZdrAck: true,
    });
  });

  test("getModelOptions considera gravado o modelo fixado no Telegram/tradução", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t, "tg", { copilot: "kimi-k2.7-code", attendant: NEW, classify: NEW });
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(organizationId))!;
      const ai = org.settings.aiConfig!;
      await ctx.db.patch(organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...ai, providerConfig: { ...ai.providerConfig!, products: { telegramCopilot: { model: OLD } } } },
        },
      });
    });
    const ids = (await t.withIdentity({ subject: `${userId}|s` }).query(api.aiSettings.getModelOptions, { organizationId })).map((m: { id: string }) => m.id);
    expect(ids).toContain(OLD);
  });

  test("Telegram fixado em id aposentado mantém a rede do alias", async () => {
    envKeys({ go: "go", or: "or" });
    const cfg = { products: { telegramCopilot: { model: OLD } } } as never;
    const r = await resolveProductRoutes(noCtx, "x" as never, cfg, "telegramCopilot");
    expect(summary(r.routes)).toHaveLength(3);
    expect(r.routes[0].canonicalModel).toBe(NEW);
  });

  test("agentProfile.model recusa aposentado e desconhecido em gravação nova, aceita manter", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, userId } = await seed(t, "ap", { copilot: "kimi-k2.7-code", attendant: NEW, classify: NEW });
    const agentId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("teamMembers", {
        organizationId, name: "IA", role: "agent", type: "ai", status: "active", createdAt: now, updatedAt: now,
        agentProfile: { kind: "attendant", mode: "suggest", model: OLD } as never,
      });
    });
    await t.run((ctx) => ctx.db.patch(userId, { email: "a@teste.com" }));
    const as = t.withIdentity({ subject: `${userId}|s` });
    const upd = (model: string) =>
      as.mutation(api.aiSettings.updateAgentProfile, { agentMemberId: agentId, patch: { model } });
    await expect(upd("deepseek-v4-flash-0731")).rejects.toThrow(/aposentado/);
    await expect(upd("inventado-9")).rejects.toThrow(/conhecido/);
    await upd(OLD); // mantém o já gravado
    await upd(NEW);
  });
});
