/// <reference types="vite/client" />
/**
 * T08 — dedupe do 9º dígito no ingest: contato gravado com uma grafia é achado
 * pela outra, sem duplicar; sem merge; org não-55 não gera variantes.
 */
import { expect, test, describe } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { findOrCreateContactByPhone } from "./lib/inboundRouting";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

async function mkOrg(t: ReturnType<typeof convexTest>, defaultCountryCode?: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("organizations", {
      name: "Org", slug: `org-${Math.random()}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...(defaultCountryCode ? { defaultCountryCode } : {}) } as any,
      createdAt: now, updatedAt: now,
    });
  });
}
const mkContact = (t: ReturnType<typeof convexTest>, organizationId: any, phone?: string, whatsappNumber?: string) =>
  t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("contacts", { organizationId, phone, whatsappNumber, tags: [], createdAt: now, updatedAt: now } as any);
  });
// Por padrão simula o ingest (JID real do canal); `jid:false` = campanha/nova conversa.
const ingest = (t: ReturnType<typeof convexTest>, organizationId: any, phone: string, jid = true) =>
  t.run((ctx) => findOrCreateContactByPhone(ctx, { organizationId, phone, phoneIsChannelJid: jid }));

describe("dedupe 9º dígito", () => {
  test("gravado com 12 dígitos, mensagem com 13 -> mesmo contato, whatsappNumber atualizado", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const id = await mkContact(t, org, "558588887777", "558588887777");
    expect(await ingest(t, org, "5585988887777")).toBe(id);
    const c = await t.run((ctx) => ctx.db.get(id));
    expect(c?.whatsappNumber).toBe("5585988887777");
    expect(c?.phone).toBe("558588887777");
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.metadata?.previousWhatsappNumber === "558588887777")).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(1);
  });

  test("o inverso: gravado com 13, mensagem com 12", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const id = await mkContact(t, org, "5585988887777", "5585988887777");
    expect(await ingest(t, org, "558588887777")).toBe(id);
    expect((await t.run((ctx) => ctx.db.get(id)))?.whatsappNumber).toBe("558588887777");
  });

  test("acha por whatsappNumber quando phone é outro", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const id = await mkContact(t, org, "558533334444", "5585988887777");
    expect(await ingest(t, org, "558588887777")).toBe(id);
    expect((await t.run((ctx) => ctx.db.get(id)))?.phone).toBe("558533334444");
  });

  test("dois colidentes: escolhe o mais antigo e audita", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const a = await mkContact(t, org, "558588887777", "558588887777");
    const b = await mkContact(t, org, "5585988887777", "5585988887777");
    expect(await ingest(t, org, "5585988887777")).toBe(a);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    const dup = audits.find((x) => x.metadata?.collidingContactIds);
    expect(dup?.severity).toBe("low");
    expect(dup?.metadata?.collidingContactIds).toEqual([a, b]);
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(2);
  });

  test("número BR acha a outra grafia mesmo em org estrangeira", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t, "1");
    const id = await mkContact(t, org, "558588887777", "558588887777");
    expect(await ingest(t, org, "5585988887777")).toBe(id);
  });

  test("número não-BR de 12/13 dígitos não gera variante", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const id = await mkContact(t, org, "447911123456", "447911123456");
    expect(await ingest(t, org, "4479111234567")).not.toBe(id);
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(2);
  });

  test("sem o flag de JID (campanha) acha o contato e NÃO altera whatsappNumber", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const id = await mkContact(t, org, "558588887777", "558588887777");
    expect(await ingest(t, org, "5585988887777", false)).toBe(id);
    expect((await t.run((ctx) => ctx.db.get(id)))?.whatsappNumber).toBe("558588887777");
    const empty = await mkContact(t, org, "558511112222");
    expect(await ingest(t, org, "5585911112222", false)).toBe(empty);
    expect((await t.run((ctx) => ctx.db.get(empty)))?.whatsappNumber).toBeUndefined();
  });

  test("achado por phone com whatsappNumber de OUTRO número não é sobrescrito", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const id = await mkContact(t, org, "558588887777", "5511999990000");
    expect(await ingest(t, org, "558588887777")).toBe(id);
    expect((await t.run((ctx) => ctx.db.get(id)))?.whatsappNumber).toBe("5511999990000");
  });

  test("colisão já auditada não grava audit a cada inbound", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    await mkContact(t, org, "558588887777", "558588887777");
    await mkContact(t, org, "5585988887777", "5585988887777");
    await ingest(t, org, "558588887777");
    await ingest(t, org, "558588887777");
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.filter((x) => x.metadata?.collidingContactIds)).toHaveLength(1);
  });

  test("contato de outra org não é achado", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const other = await mkOrg(t);
    const id = await mkContact(t, other, "558588887777");
    expect(await ingest(t, org, "5585988887777")).not.toBe(id);
  });

  test("op reporta colisão e não escreve", async () => {
    const t = convexTest(schema, modules);
    const org = await mkOrg(t);
    const a = await mkContact(t, org, "558588887777");
    const b = await mkContact(t, org, undefined, "5585988887777");
    await mkContact(t, org, "5511999990000");
    const r = await t.query(internal.contacts.internalReportPhoneDuplicates, { organizationId: org });
    expect(r.scanned).toBe(3);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].key).toBe([a, b].sort().join("|"));
    expect([...r.groups[0].contactIds].sort()).toEqual([a, b].sort());
    expect(await t.run((ctx) => ctx.db.query("auditLogs").collect())).toHaveLength(0);
  });
});
