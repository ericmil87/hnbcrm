/// <reference types="vite/client" />
/**
 * Gate de webhooks (perf Convex I/O, onda 2): `scheduleWebhookEvent` só agenda
 * `nodeActions.triggerWebhooks` quando a org tem um webhook ATIVO inscrito no
 * evento (ou em "*"). Org sem webhook = 0 jobs.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { scheduleWebhookEvent, webhookMatches, WEBHOOK_SCAN_LIMIT } from "./lib/webhookDispatch";
import { WEBHOOK_TRIGGERED_STAMP_MS } from "./webhookTrigger";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

type T = ReturnType<typeof convexTest>;

// Relógio falso: o job agendado (runAfter 0) nunca dispara a action com fetch
// real nem escreve depois que o teste acabou.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedOrg(t: T): Promise<Id<"organizations">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("organizations", {
      name: "Org",
      slug: `org-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

async function addWebhook(
  t: T,
  organizationId: Id<"organizations">,
  events: string[],
  isActive = true
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("webhooks", {
      organizationId,
      name: "Hook",
      url: "https://example.test/hook",
      events,
      secret: "segredo-de-teste",
      isActive,
      createdAt: Date.now(),
    });
  });
}

async function emit(t: T, organizationId: Id<"organizations">, event: string) {
  return await t.run(async (ctx) =>
    scheduleWebhookEvent(ctx, { organizationId, event, payload: { x: 1 } })
  );
}

async function webhookJobs(t: T) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("triggerWebhooks"));
  });
}

describe("webhookMatches", () => {
  test("ativo + evento exato ou '*'", () => {
    expect(webhookMatches({ isActive: true, events: ["lead.created"] }, "lead.created")).toBe(true);
    expect(webhookMatches({ isActive: true, events: ["*"] }, "lead.updated")).toBe(true);
    expect(webhookMatches({ isActive: true, events: ["lead.created"] }, "lead.updated")).toBe(false);
    expect(webhookMatches({ isActive: false, events: ["*"] }, "lead.created")).toBe(false);
    // prefixo não é curinga
    expect(webhookMatches({ isActive: true, events: ["lead.*"] }, "lead.created")).toBe(false);
  });
});

describe("scheduleWebhookEvent", () => {
  test("org sem webhook → nenhum job", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    expect(await emit(t, org, "lead.created")).toBe(false);
    expect(await webhookJobs(t)).toHaveLength(0);
  });

  test("webhook inativo → nenhum job", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["*"], false);
    expect(await emit(t, org, "lead.created")).toBe(false);
    expect(await webhookJobs(t)).toHaveLength(0);
  });

  test("webhook de outro evento → nenhum job", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["lead.created"]);
    expect(await emit(t, org, "lead.updated")).toBe(false);
    expect(await webhookJobs(t)).toHaveLength(0);
  });

  test("webhook de OUTRA org não conta", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const other = await seedOrg(t);
    await addWebhook(t, other, ["*"]);
    expect(await emit(t, org, "lead.created")).toBe(false);
    expect(await webhookJobs(t)).toHaveLength(0);
  });

  test("'*' → 1 job com os args intactos", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["*"]);
    expect(await emit(t, org, "lead.created")).toBe(true);
    const jobs = await webhookJobs(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toEqual({ organizationId: org, event: "lead.created", payload: { x: 1 } });
  });

  test("evento exato → 1 job; vários webhooks casando continuam sendo 1 job", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["lead.created"]);
    await addWebhook(t, org, ["*"]);
    expect(await emit(t, org, "lead.created")).toBe(true);
    expect(await webhookJobs(t)).toHaveLength(1);
  });

  test(`teto: lê até ${WEBHOOK_SCAN_LIMIT} webhooks (o mesmo da action) — além disso o evento cai`, async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    // WEBHOOK_SCAN_LIMIT inativos ANTES do único que casa: fica fora da janela,
    // exatamente como na action (`getMatchingWebhooks`), que também o perderia.
    await t.run(async (ctx) => {
      for (let i = 0; i < WEBHOOK_SCAN_LIMIT; i++) {
        await ctx.db.insert("webhooks", {
          organizationId: org, name: `h${i}`, url: "https://example.test", events: ["x"],
          secret: "s", isActive: false, createdAt: Date.now(),
        });
      }
    });
    await addWebhook(t, org, ["*"]);
    expect(await emit(t, org, "lead.created")).toBe(false);
    const matching = await t.query(internal.webhookTrigger.getMatchingWebhooks, {
      organizationId: org,
      event: "lead.created",
    });
    expect(matching).toHaveLength(0);
  });

  test("a action devolve só os que casam (mesmo predicado)", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["lead.created"]);
    await addWebhook(t, org, ["lead.updated"]);
    await addWebhook(t, org, ["*"], false);
    const matching = await t.query(internal.webhookTrigger.getMatchingWebhooks, {
      organizationId: org,
      event: "lead.created",
    });
    expect(matching).toHaveLength(1);
  });
});

describe("memo por transação", () => {
  test("3 eventos na mesma org/transação leem `webhooks` uma vez só", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["*"]);
    const queried = await t.run(async (ctx) => {
      const spy = vi.spyOn(ctx.db, "query");
      for (const event of ["lead.created", "lead.updated", "message.received"]) {
        expect(await scheduleWebhookEvent(ctx, { organizationId: org, event, payload: {} })).toBe(true);
      }
      const calls = spy.mock.calls.filter(([table]) => table === "webhooks").length;
      spy.mockRestore();
      return calls;
    });
    expect(queried).toBe(1);
    expect(await webhookJobs(t)).toHaveLength(3);
  });

  test("o memo não atravessa transações nem orgs", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    const other = await seedOrg(t);
    await addWebhook(t, other, ["*"]);
    // 1ª transação: org sem webhook
    expect(await emit(t, org, "lead.created")).toBe(false);
    // na mesma transação, a OUTRA org tem a própria leitura
    await t.run(async (ctx) => {
      expect(await scheduleWebhookEvent(ctx, { organizationId: org, event: "x", payload: {} })).toBe(false);
      expect(await scheduleWebhookEvent(ctx, { organizationId: other, event: "x", payload: {} })).toBe(true);
    });
    // webhook criado depois: a transação seguinte enxerga
    await addWebhook(t, org, ["*"]);
    expect(await emit(t, org, "lead.created")).toBe(true);
  });
});

describe("updateWebhookTriggered (carimbo de 5 min)", () => {
  async function stampOf(t: T, id: Id<"webhooks">) {
    return await t.run(async (ctx) => (await ctx.db.get(id))?.lastTriggered);
  }

  test("duas entregas seguidas gravam uma vez; depois de 5 min grava de novo", async () => {
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["*"]);
    const id = await t.run(async (ctx) => (await ctx.db.query("webhooks").first())!._id);
    expect(await stampOf(t, id) ?? undefined).toBeUndefined();

    await t.mutation(internal.webhookTrigger.updateWebhookTriggered, { webhookId: id });
    const first = await stampOf(t, id);
    expect(first).toBe(Date.parse("2026-10-22T12:00:00Z"));

    vi.setSystemTime(new Date(first! + 60_000));
    await t.mutation(internal.webhookTrigger.updateWebhookTriggered, { webhookId: id });
    expect(await stampOf(t, id)).toBe(first);

    vi.setSystemTime(new Date(first! + WEBHOOK_TRIGGERED_STAMP_MS));
    await t.mutation(internal.webhookTrigger.updateWebhookTriggered, { webhookId: id });
    expect(await stampOf(t, id)).toBe(first! + WEBHOOK_TRIGGERED_STAMP_MS);
  });

  test("webhook apagado → no-op", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t);
    await addWebhook(t, org, ["*"]);
    const id = await t.run(async (ctx) => {
      const w = (await ctx.db.query("webhooks").first())!;
      await ctx.db.delete(w._id);
      return w._id;
    });
    await expect(
      t.mutation(internal.webhookTrigger.updateWebhookTriggered, { webhookId: id })
    ).resolves.toBeNull();
  });
});
