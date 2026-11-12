/// <reference types="vite/client" />
/** `createOrganization` sem `slug` gera um livre a partir do nome; `slug` explícito repetido segue recusando. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
const slugOf = (id: Id<"organizations">) => t.run(async (ctx) => (await ctx.db.get(id))!.slug);

describe("createOrganization: slug automático", () => {
  test("sem slug deriva do nome (sem acentos)", async () => {
    const u = await mkUser("a@acme.com.br");
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "Clínica São João" });
    expect(await slugOf(id)).toBe("clinica-sao-joao");
  });

  test("dois nomes iguais geram slugs distintos", async () => {
    const u = await mkUser("b@acme.com.br");
    const v = await mkUser("c@acme.com.br");
    const a = await as(u).mutation(api.organizations.createOrganization, { name: "Acme" });
    const b = await as(v).mutation(api.organizations.createOrganization, { name: "Acme" });
    expect([await slugOf(a), await slugOf(b)]).toEqual(["acme", "acme-2"]);
  });

  test("gerado não colide com slug explícito já existente", async () => {
    const u = await mkUser("d@acme.com.br");
    await as(u).mutation(api.organizations.createOrganization, { name: "X", slug: "loja" });
    const id = await as(u).mutation(api.organizations.createOrganization, { name: "Loja" });
    expect(await slugOf(id)).toBe("loja-2");
  });

  test("slug explícito repetido continua dando o mesmo erro", async () => {
    const u = await mkUser("e@acme.com.br");
    await as(u).mutation(api.organizations.createOrganization, { name: "Um", slug: "repetido" });
    await expect(as(u).mutation(api.organizations.createOrganization, { name: "Dois", slug: "repetido" })).rejects.toThrow(
      /Este endereço \(slug\) já está em uso por outra organização/,
    );
  });
});
