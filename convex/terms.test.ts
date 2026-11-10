/// <reference types="vite/client" />
/**
 * 7b: aceite dos Termos. Só a versão vigente é aceita, o aceite é append-only e
 * idempotente por (usuário, versão), e `createOrganization` grava o aceite junto.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { TERMS_VERSION } from "./lib/terms";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

const mkUser = (email: string) => t.run((ctx) => ctx.db.insert("users", { email }));
const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });
const rows = () => t.run((ctx) => ctx.db.query("termsAcceptances").collect());

describe("getMyTermsStatus / acceptTerms", () => {
  test("não logado: status null e aceite recusado", async () => {
    expect(await t.query(api.terms.getMyTermsStatus, {})).toBeNull();
    await expect(t.mutation(api.terms.acceptTerms, { version: TERMS_VERSION })).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });

  test("aceita a versão vigente; status reflete; segundo aceite não duplica", async () => {
    const u = await mkUser("a@acme.com.br");
    expect(await as(u).query(api.terms.getMyTermsStatus, {})).toEqual({ currentVersion: TERMS_VERSION, acceptedVersion: null });
    const first = await as(u).mutation(api.terms.acceptTerms, { version: TERMS_VERSION, userAgent: "Mozilla/5.0 teste" });
    expect(first).toEqual({ version: TERMS_VERSION, alreadyAccepted: false });
    const again = await as(u).mutation(api.terms.acceptTerms, { version: TERMS_VERSION });
    expect(again.alreadyAccepted).toBe(true);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ userId: u, version: TERMS_VERSION, userAgent: "Mozilla/5.0 teste" });
    expect(await as(u).query(api.terms.getMyTermsStatus, {})).toEqual({ currentVersion: TERMS_VERSION, acceptedVersion: TERMS_VERSION });
  });

  test("versão diferente da atual é recusada (e nada é gravado)", async () => {
    const u = await mkUser("b@acme.com.br");
    await expect(as(u).mutation(api.terms.acceptTerms, { version: "2020-01-01" })).rejects.toThrow(/atualizados/);
    expect(await rows()).toHaveLength(0);
  });

  test("o aceite de um usuário não aparece para outro", async () => {
    const a = await mkUser("c@acme.com.br");
    const b = await mkUser("d@acme.com.br");
    await as(a).mutation(api.terms.acceptTerms, { version: TERMS_VERSION });
    expect((await as(b).query(api.terms.getMyTermsStatus, {}))?.acceptedVersion).toBeNull();
  });

  test("userAgent é truncado", async () => {
    const u = await mkUser("e@acme.com.br");
    await as(u).mutation(api.terms.acceptTerms, { version: TERMS_VERSION, userAgent: "x".repeat(500) });
    expect((await rows())[0].userAgent).toHaveLength(200);
  });
});

describe("createOrganization com acceptedTermsVersion", () => {
  test("grava o aceite com a org", async () => {
    const u = await mkUser("f@acme.com.br");
    const orgId = await as(u).mutation(api.organizations.createOrganization, {
      name: "Org T",
      slug: "org-t-terms",
      acceptedTermsVersion: TERMS_VERSION,
    });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ userId: u, organizationId: orgId, version: TERMS_VERSION });
  });

  test("versão errada recusa ANTES de criar a org; sem o argumento nada é gravado", async () => {
    const u = await mkUser("g@acme.com.br");
    await expect(
      as(u).mutation(api.organizations.createOrganization, { name: "Org U", slug: "org-u", acceptedTermsVersion: "1999-01-01" })
    ).rejects.toThrow(/atualizados/);
    expect(await t.run((ctx) => ctx.db.query("organizations").collect())).toHaveLength(0);
    await as(u).mutation(api.organizations.createOrganization, { name: "Org V", slug: "org-v" });
    expect(await rows()).toHaveLength(0);
  });

  test("quem já aceitou antes não ganha linha duplicada ao criar org", async () => {
    const u = await mkUser("h@acme.com.br");
    await as(u).mutation(api.terms.acceptTerms, { version: TERMS_VERSION });
    await as(u).mutation(api.organizations.createOrganization, { name: "Org W", slug: "org-w2", acceptedTermsVersion: TERMS_VERSION });
    expect(await rows()).toHaveLength(1);
  });
});
