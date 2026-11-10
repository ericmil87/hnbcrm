/// <reference types="vite/client" />
/**
 * B7a: cadastro em teste (`BILLING_TRIAL_ON_SIGNUP`), 1 teste por usuário.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { resolveEntitlements } from "./lib/entitlements";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const mkUser = (email: string) => t.run((ctx) => ctx.db.insert("users", { email }));
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const getOrg = (id: Id<"organizations">) => t.run((ctx) => ctx.db.get(id));
const grants = () => t.run((ctx) => ctx.db.query("trialGrants").collect());

describe("cadastro em teste (B7a)", () => {
  test("env ausente: nasce legacy como hoje, sem grant (regressão)", async () => {
    const u = await mkUser("a@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "A", slug: "a-legacy" });
    expect((await getOrg(id))?.billing).toMatchObject({ status: "legacy" });
    expect(await grants()).toHaveLength(0);
    expect(resolveEntitlements(await getOrg(id), NOW).gated).toBe(false);
  });

  test("env diferente de 'true' também não liga", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "1");
    const u = await mkUser("b@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "B", slug: "b-legacy" });
    expect((await getOrg(id))?.billing?.status).toBe("legacy");
  });

  test("env ligada: Profissional por 30 dias, grant registrado", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "true");
    const u = await mkUser("c@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "C", slug: "c-trial" });
    const org = await getOrg(id);
    expect(org?.billing).toMatchObject({ status: "trial", plan: "profissional", trialEndsAt: NOW + 30 * DAY, periodStart: NOW });
    expect(await grants()).toEqual([expect.objectContaining({ userId: u, organizationId: id, startedAt: NOW, endsAt: NOW + 30 * DAY })]);
    const ent = resolveEntitlements(org, NOW + DAY);
    expect(ent).toMatchObject({ gated: true, plan: "profissional", aiAllowed: true, outboundAllowed: true });
    expect(ent.limits.aiAttendances).toBe(300);
    // Vencido o teste, o resolve já bloqueia IA e envio (o cron só vira o status).
    expect(resolveEntitlements(org, NOW + 31 * DAY)).toMatchObject({ aiAllowed: false, outboundAllowed: false });
  });

  test("1 teste por usuário: a 2ª org herda o MESMO trialEndsAt (não ganha 30 dias novos) e não é bloqueada", async () => {
    vi.stubEnv("BILLING_TRIAL_ON_SIGNUP", "true");
    const u = await mkUser("d@acme.com.br");
    const first = await as(u).mutation(api.organizations.createOrganization, { name: "D1", slug: "d1" });
    vi.setSystemTime(NOW + 10 * DAY);
    const second = await as(u).mutation(api.organizations.createOrganization, { name: "D2", slug: "d2" });
    expect((await getOrg(second))?.billing).toMatchObject({ status: "trial", trialEndsAt: NOW + 30 * DAY });
    expect((await getOrg(first))?.billing?.trialEndsAt).toBe(NOW + 30 * DAY);
    expect(await grants()).toHaveLength(2);
    // Depois do prazo, a 3ª nasce em teste já vencido (só leitura), sem 30 dias novos.
    vi.setSystemTime(NOW + 40 * DAY);
    const third = await as(u).mutation(api.organizations.createOrganization, { name: "D3", slug: "d3" });
    expect((await getOrg(third))?.billing?.trialEndsAt).toBe(NOW + 30 * DAY);
    expect(resolveEntitlements(await getOrg(third), Date.now()).aiAllowed).toBe(false);
    // Outro usuário tem o próprio teste.
    const other = await mkUser("e@acme.com.br");
    const o = await as(other).mutation(api.organizations.createOrganization, { name: "E", slug: "e1" });
    expect((await getOrg(o))?.billing?.trialEndsAt).toBe(NOW + 70 * DAY);
  });
});
