/// <reference types="vite/client" />
/**
 * "Nova conversa" no inbox: contato → lead → conversa → 1ª mensagem iniciados
 * por um humano. Nenhuma mensagem real sai — o dispatch fica só agendado.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  canSendFreeTextOnStart,
  phoneLookupCandidates,
  phoneSpellingVariants,
  pickCanonicalFromCheck,
  resolveStartPhone,
} from "./lib/startConversation";
import { encryptSecret } from "./lib/secretCrypto";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = Date.UTC(2026, 9, 2, 15, 0);
const TEST_KEY = btoa("A".repeat(32));

/**
 * wuzapi fake: `POST /user/check`. `registered` = números como o WhatsApp os
 * conhece (o JID); uma consulta em qualquer grafia BR do número acha a conta e
 * devolve o JID registrado — igual ao gateway real. Sem `registered`, todo
 * número consultado existe com o próprio JID.
 */
/**
 * Stub do wuzapi `POST /user/check`. `registered` = grafias com conta; por
 * padrão o JID é de telefone. `jid: "lid"` imita o gateway real de 03/10/2026,
 * que devolve `…@lid` (identidade interna, não é telefone) e diz "sim" para as
 * duas grafias BR (o servidor normaliza o 9º dígito).
 */
function wuzapiCheck(registered?: string[], opts: { jid?: "phone" | "lid"; lid?: string; exact?: boolean } = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const users = (body?.Phone as string[]).map((q) => {
      // Sem `exact`, imita o servidor do WhatsApp normalizando o 9º dígito BR
      // (a grafia irmã também responde "sim").
      const hit =
        registered === undefined
          ? q
          : opts.exact
            ? registered.find((r) => r === q)
            : registered.find((r) => phoneLookupCandidates(q).includes(r));
      if (!hit) return { Query: q, IsInWhatsapp: false, JID: "" };
      const jid = opts.jid === "lid" ? `${opts.lid ?? "180002129735765"}@lid` : `${hit}@s.whatsapp.net`;
      return { Query: q, IsInWhatsapp: true, JID: jid };
    });
    return new Response(JSON.stringify({ code: 200, success: true, data: { Users: users } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  wuzapiCheck();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(t: TestConvex<typeof schema>) {
  const bridgeToken = await encryptSecret("fake-bridge-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const org = (name: string, slug: string) =>
      ctx.db.insert("organizations", {
        name,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", aiConfig: { enabled: true, autoAssign: true, handoffThreshold: 0.5 } } as any,
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await org("Org", "org-start");
    const otherOrgId = await org("Outra", "outra-start");

    const member = async (orgId: typeof organizationId, name: string, role: "admin" | "agent", permissions?: any) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: orgId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        ...(permissions ? { permissions } : {}),
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };
    const agent = await member(organizationId, "Agente", "agent");
    const viewer = await member(organizationId, "Leitor", "agent", {
      leads: "view_all", contacts: "view", inbox: "view_all", tasks: "view_all", reports: "view",
      team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view",
    });
    // IA ativa: com autoAssign ligado, ensureLeadForContact a escolheria.
    await ctx.db.insert("teamMembers", {
      organizationId, name: "Atendente", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" } as any, createdAt: now, updatedAt: now,
    } as any);

    const board = async (orgId: typeof organizationId, name: string, isDefault: boolean, order: number) => {
      const boardId = await ctx.db.insert("boards", { organizationId: orgId, name, color: "#6366f1", isDefault, order, createdAt: now, updatedAt: now });
      const s1 = await ctx.db.insert("stages", { organizationId: orgId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      const s2 = await ctx.db.insert("stages", { organizationId: orgId, boardId, name: "Contato feito", color: "#6366f1", order: 1, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
      return { boardId, stageIds: [s1, s2] };
    };
    const vendas = await board(organizationId, "Vendas", true, 0);
    const eventos = await board(organizationId, "Eventos", false, 1);
    await board(otherOrgId, "Vendas", true, 0);

    const channel = (orgId: typeof organizationId, provider: "meta" | "bridge", displayName: string) =>
      ctx.db.insert("channelConfigs", {
        organizationId: orgId,
        channel: "whatsapp",
        provider,
        displayName,
        status: "active",
        ...(provider === "bridge"
          ? { bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: `inst_${displayName}`, bridgeTokenEncrypted: bridgeToken, bridgeTokenLast4: "cret", bridgeSessionState: "connected" as const, bridgePhone: "5585911112222" }
          : { phoneNumberId: "pn_1", accessTokenEncrypted: "enc:tok", accessTokenLast4: "1234", appSecretEncrypted: "enc:app", verifyToken: "vt", displayPhoneNumber: "+55 85 3333-4444" }),
        createdAt: now,
        updatedAt: now,
      } as any);
    const bridgeId = await channel(organizationId, "bridge", "Bridge");
    const metaId = await channel(organizationId, "meta", "Oficial");
    const otherChannelId = await channel(otherOrgId, "bridge", "Outro");
    const disabledId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Desligado", status: "disabled", createdAt: now, updatedAt: now,
    } as any);

    return { organizationId, otherOrgId, agent, viewer, vendas, eventos, bridgeId, metaId, otherChannelId, disabledId };
  });
}

describe("lib/startConversation", () => {
  test("só o bridge aceita texto livre na abertura", () => {
    expect(canSendFreeTextOnStart("bridge")).toBe(true);
    expect(canSendFreeTextOnStart("meta")).toBe(false);
  });
  test("normaliza com 9º dígito e procura também a grafia antiga", () => {
    const r = resolveStartPhone("(85) 8888-7777");
    expect(r).toEqual({ ok: true, phone: "5585988887777" });
    expect(phoneLookupCandidates("5585988887777")).toEqual(["5585988887777", "558588887777"]);
    expect(resolveStartPhone("123").ok).toBe(false);
  });
});

describe("lib/startConversation — checagem no WhatsApp", () => {
  test("grafias nos dois sentidos (com e sem o 9º dígito)", () => {
    expect(phoneSpellingVariants("5581981392929")).toEqual(["5581981392929", "558181392929"]);
    expect(phoneLookupCandidates("558181392929")).toEqual(["558181392929", "5581981392929"]);
    // fixo e internacional: uma grafia só
    expect(phoneLookupCandidates("558533334444")).toEqual(["558533334444"]);
    expect(phoneLookupCandidates("15550000001")).toEqual(["15550000001"]);
  });
  test("pickCanonicalFromCheck: JID manda; sem JID usa a grafia confirmada; ninguém = fora", () => {
    const cands = ["5581981392929", "558181392929"];
    expect(
      pickCanonicalFromCheck(
        [
          { phone: "5581981392929", onWhatsapp: true, jid: "558181392929@s.whatsapp.net" },
          { phone: "558181392929", onWhatsapp: true, jid: "558181392929@s.whatsapp.net" },
        ],
        cands
      )
    ).toEqual({ onWhatsapp: true, canonicalPhone: "558181392929", jid: "558181392929@s.whatsapp.net" });
    // a grafia antiga é a única no WhatsApp
    expect(
      pickCanonicalFromCheck(
        [
          { phone: "5581981392929", onWhatsapp: false },
          { phone: "558181392929", onWhatsapp: true, jid: "558181392929:12@s.whatsapp.net" },
        ],
        cands
      )
    ).toMatchObject({ onWhatsapp: true, canonicalPhone: "558181392929" });
    // JID implausível → cai na grafia confirmada
    expect(pickCanonicalFromCheck([{ phone: "558181392929", onWhatsapp: true, jid: "abc@s.whatsapp.net" }], cands)).toEqual({
      onWhatsapp: true,
      canonicalPhone: "558181392929",
    });
    expect(pickCanonicalFromCheck([{ phone: "5581981392929", onWhatsapp: false }, { phone: "558181392929", onWhatsapp: false }], cands)).toEqual({
      onWhatsapp: false,
    });
  });
});

describe("startConversation — número conferido no WhatsApp (bridge)", () => {
  test("celular registrado SEM o 9: cria o contato com o número canônico (bug de 02/10)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mock = wuzapiCheck(["558181392929"]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "81981392929", content: "Oi",
    });
    expect(res).toMatchObject({ createdContact: true, verified: true, canonicalPhone: "558181392929", phoneChanged: false });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("https://wuzapi.example.com/user/check");
    expect(mock.calls[0].body.Phone).toEqual(["5581981392929", "558181392929"]);
    await t.run(async (ctx) => {
      const contact = (await ctx.db.get(res.contactId))!;
      expect(contact).toMatchObject({ phone: "558181392929", whatsappNumber: "558181392929" });
      expect(await ctx.db.query("contacts").collect()).toHaveLength(1);
    });
  });

  test("contato já gravado como o WhatsApp o conhece é reaproveitado (sem duplicar)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const contactId = await t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "Eric", phone: "558181392929", whatsappNumber: "558181392929", tags: [], createdAt: NOW, updatedAt: NOW })
    );
    wuzapiCheck(["558181392929"]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "(81) 98139-2929",
    });
    expect(res).toMatchObject({ contactId, createdContact: false, verified: true, phoneChanged: false });
    await t.run(async (ctx) => {
      expect(await ctx.db.query("contacts").collect()).toHaveLength(1);
    });
  });

  test("número fora do WhatsApp: erro ANTES de qualquer escrita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    wuzapiCheck([]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    await expect(
      asAgent.action(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-7777", content: "Oi",
      })
    ).rejects.toThrow(/não tem WhatsApp/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("contacts").collect()).toHaveLength(0);
      expect(await ctx.db.query("leads").collect()).toHaveLength(0);
      expect(await ctx.db.query("conversations").collect()).toHaveLength(0);
    });
  });

  test("gateway com erro: segue com o número normalizado e devolve verified:false", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-8888",
    });
    expect(res).toMatchObject({ verified: false, verifyReason: "gateway_error", canonicalPhone: "5585999998888", createdContact: true });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(res.contactId))!.phone).toBe("5585999998888");
    });
  });

  test("Meta: nenhuma chamada ao gateway e verified:false", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mock = wuzapiCheck();
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.metaId, phone: "85999993333",
    });
    expect(res).toMatchObject({ verified: false, verifyReason: "meta", canonicalPhone: "5585999993333" });
    expect(mock.fn).not.toHaveBeenCalled();
  });

  test("contato escolhido com a grafia errada é corrigido para o número canônico (audit com previousPhone)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const contactId = await t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "Eric", phone: "5581981392929", whatsappNumber: "5581981392929", tags: [], createdAt: NOW, updatedAt: NOW })
    );
    wuzapiCheck(["558181392929"]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });

    const check = await asAgent.action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, contactId,
    });
    expect(check).toEqual({ status: "on_whatsapp", canonicalPhone: "558181392929", phoneDisplay: "+55 (81) 8139-2929", changed: true });

    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, contactId,
    });
    expect(res).toMatchObject({ contactId, verified: true, canonicalPhone: "558181392929", phoneChanged: true });
    await t.run(async (ctx) => {
      const contact = (await ctx.db.get(contactId))!;
      expect(contact).toMatchObject({ phone: "558181392929", whatsappNumber: "558181392929" });
      expect(contact.searchText).toContain("558181392929");
      const audit = (await ctx.db.query("auditLogs").collect()).find((a) => a.entityType === "conversation")!;
      expect(audit.metadata?.previousPhone).toBe("5581981392929");
    });
  });

  test("contato escolhido com a grafia errada quando JÁ existe o contato canônico: usa o canônico, não duplica telefone", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bogusId = await t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: s.organizationId, phone: "5581981392929", whatsappNumber: "5581981392929", tags: [], createdAt: NOW, updatedAt: NOW })
    );
    const canonicalId = await t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "Eric", phone: "558181392929", whatsappNumber: "558181392929", tags: [], createdAt: NOW + 1, updatedAt: NOW + 1 })
    );
    wuzapiCheck(["558181392929"]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, contactId: bogusId,
    });
    expect(res).toMatchObject({ contactId: canonicalId, verified: true, canonicalPhone: "558181392929" });
    await t.run(async (ctx) => {
      // O contato errado NÃO foi reescrito — segue com a grafia antiga, para a equipe excluir.
      expect((await ctx.db.get(bogusId))!.phone).toBe("5581981392929");
      const owners = (await ctx.db.query("contacts").collect()).filter((c) => c.phone === "558181392929");
      expect(owners).toHaveLength(1);
      const audit = (await ctx.db.query("auditLogs").collect()).find((a) => a.entityType === "conversation")!;
      expect(audit.metadata?.switchedFromContactId).toBe(bogusId);
    });
  });

  test("LID não é telefone (caso real 03/10): gateway devolve @lid e confirma as duas grafias → vence a que já é contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ericId = await t.run((ctx) =>
      ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "Eric", phone: "558181392929", whatsappNumber: "558181392929", tags: [], createdAt: NOW, updatedAt: NOW })
    );
    // As duas grafias "existem" e o JID é um LID.
    wuzapiCheck(["558181392929", "5581981392929"], { jid: "lid" });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const check = await asAgent.action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "81981392929",
    });
    expect(check).toMatchObject({ status: "on_whatsapp", canonicalPhone: "558181392929", changed: true, ambiguous: true, lid: "180002129735765@lid" });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "81981392929",
    });
    expect(res).toMatchObject({ contactId: ericId, createdContact: false, canonicalPhone: "558181392929", verified: true });
    await t.run(async (ctx) => {
      const phones = (await ctx.db.query("contacts").collect()).map((c) => c.phone);
      expect(phones).not.toContain("180002129735765");
      expect(phones.filter((p) => p === "558181392929")).toHaveLength(1);
    });
  });

  test("LID + só a grafia sem o 9 confirmada → canônico é a sem o 9, sem ambiguidade", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    wuzapiCheck(["558181392929"], { jid: "lid", exact: true });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const check = await asAgent.action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "81981392929",
    });
    expect(check).toMatchObject({ status: "on_whatsapp", canonicalPhone: "558181392929", changed: true });
    expect((check as any).ambiguous).toBeUndefined();
  });

  test("LID + duas grafias confirmadas + nenhum contato → fica a digitada (normalizada), marcada ambígua", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    wuzapiCheck(["558599998888", "5585999998888"], { jid: "lid", lid: "123456789012345" });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const check = await asAgent.action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-8888",
    });
    expect(check).toMatchObject({ status: "on_whatsapp", canonicalPhone: "5585999998888", changed: false, ambiguous: true });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-8888",
    });
    await t.run(async (ctx) => {
      const c = (await ctx.db.get(res.contactId))!;
      expect(c.phone).toBe("5585999998888");
    });
  });

  test("checkWhatsappNumber: bridge desconectado não chama o gateway; Meta = unverified; telefone inválido lança", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mock = wuzapiCheck();
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    expect(
      await asAgent.action(api.startConversation.checkWhatsappNumber, { organizationId: s.organizationId, channelConfigId: s.metaId, phone: "85999993333" })
    ).toEqual({ status: "unverified", reason: "meta", phone: "5585999993333" });
    await t.run((ctx) => ctx.db.patch(s.bridgeId, { bridgeSessionState: "disconnected" } as any));
    expect(
      await asAgent.action(api.startConversation.checkWhatsappNumber, { organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85999993333" })
    ).toEqual({ status: "unverified", reason: "bridge_offline", phone: "5585999993333" });
    expect(mock.fn).not.toHaveBeenCalled();
    await expect(
      asAgent.action(api.startConversation.checkWhatsappNumber, { organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "123" })
    ).rejects.toThrow(/Telefone/);
  });

  test("prévia com phoneIsCanonical não re-acrescenta o 9", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const p = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "558181392929", phoneIsCanonical: true,
    });
    expect(p).toMatchObject({ phone: "558181392929", phoneDisplay: "+55 (81) 8139-2929", phoneValid: true });
    const p2 = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "558181392929",
    });
    expect(p2.phone).toBe("5581981392929");
  });
});

describe("startConversation", () => {
  test("número novo cria contato + lead (dono = quem iniciou, funil escolhido) + conversa + mensagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId,
      channelConfigId: s.bridgeId,
      phone: "85 99999-1111",
      firstName: "Maria",
      lastName: "Souza",
      boardId: s.eventos.boardId,
      stageId: s.eventos.stageIds[1],
      content: "Olá Maria, tudo bem?",
    });
    expect(res).toMatchObject({ createdContact: true, createdLead: true, createdConversation: true, channelSwitched: false });
    expect(res.messageId).toBeDefined();

    await t.run(async (ctx) => {
      const contact = (await ctx.db.get(res.contactId))!;
      expect(contact).toMatchObject({ phone: "5585999991111", whatsappNumber: "5585999991111", firstName: "Maria", lastName: "Souza" });
      const lead = (await ctx.db.get(res.leadId))!;
      expect(lead.assignedTo).toBe(s.agent.memberId); // não a IA, apesar do autoAssign
      expect(lead.boardId).toBe(s.eventos.boardId);
      expect(lead.stageId).toBe(s.eventos.stageIds[1]);
      expect(lead.title).toBe("Maria Souza");
      const source = (await ctx.db.get(lead.sourceId!))!;
      expect(source.name).toBe("Conversa iniciada pela equipe");
      const conv = (await ctx.db.get(res.conversationId))!;
      expect(conv.channelConfigId).toBe(s.bridgeId);
      expect(conv.messageCount).toBe(1);
      const msg = (await ctx.db.get(res.messageId!))!;
      expect(msg).toMatchObject({ direction: "outbound", senderId: s.agent.memberId, senderType: "human", content: "Olá Maria, tudo bem?", contentType: "text" });
      const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
      expect(scheduled.some((f) => f.name.includes("whatsapp"))).toBe(true);
      const audits = await ctx.db.query("auditLogs").collect();
      const convAudit = audits.find((a) => a.entityType === "conversation");
      expect(convAudit).toMatchObject({ action: "create", severity: "low" });
    });
  });

  test("contato com lead e conversa: reaproveita tudo, troca o número e desarquiva", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { contactId, leadId, conversationId } = await t.run(async (ctx) => {
      const now = Date.now();
      const contactId = await ctx.db.insert("contacts", { organizationId: s.organizationId, firstName: "João", phone: "558588887777", whatsappNumber: "558588887777", tags: [], createdAt: now, updatedAt: now });
      const leadId = await ctx.db.insert("leads", {
        organizationId: s.organizationId, title: "João", contactId, boardId: s.vendas.boardId, stageId: s.vendas.stageIds[0],
        value: 0, currency: "BRL", priority: "medium", temperature: "cold", tags: [], customFields: {}, conversationStatus: "new",
        lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId, channel: "whatsapp", channelConfigId: s.metaId, status: "active",
        messageCount: 3, archivedAt: now - 1000, createdAt: now, updatedAt: now,
      });
      return { contactId, leadId, conversationId };
    });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    wuzapiCheck(["558588887777"]);

    // telefone digitado COM o 9º dígito acha o contato gravado sem ele
    const preview = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "(85) 98888-7777",
    });
    expect(preview.contact?.id).toBe(contactId);
    expect(preview.lead).toMatchObject({ id: leadId, boardName: "Vendas", stageName: "Novo" });
    expect(preview.conversation).toMatchObject({ id: conversationId, archived: true });
    expect(preview.defaultBoard).toBeNull();

    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "(85) 98888-7777",
    });
    expect(res).toMatchObject({ contactId, leadId, conversationId, createdContact: false, createdLead: false, createdConversation: false, channelSwitched: true, unarchived: true, verified: true, canonicalPhone: "558588887777", phoneChanged: false });
    expect(res.messageId).toBeUndefined();
    await t.run(async (ctx) => {
      const conv = (await ctx.db.get(conversationId))!;
      expect(conv.archivedAt).toBeUndefined();
      expect(conv.channelConfigId).toBe(s.bridgeId);
      const lead = (await ctx.db.get(leadId))!;
      expect(lead.assignedTo).toBeUndefined(); // lead existente: dono intocado
    });

    // idempotente: de novo não cria nada
    const again = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, contactId,
    });
    expect(again).toMatchObject({ conversationId, createdConversation: false, channelSwitched: false, unarchived: false });
  });

  test("Meta + texto livre é recusado sem escrever nada; sem texto abre a conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    await expect(
      asAgent.action(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.metaId, phone: "85999993333", content: "Oi",
      })
    ).rejects.toThrow(/template/);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("contacts").collect()).toHaveLength(0);
    });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.metaId, phone: "85999993333",
    });
    expect(res.createdConversation).toBe(true);
  });

  test("opt-out: sem aceite lança OPT_OUT:, com aceite segue e audita como high", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: "5585999994444", source: "manual", createdAt: Date.now() } as any);
    });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const preview = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "85 99999-4444",
    });
    expect(preview.optedOut).toBe(true);
    await expect(
      asAgent.action(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-4444", content: "Oi",
      })
    ).rejects.toThrow(/^OPT_OUT:/);
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85 99999-4444", content: "Oi", optOutAck: true,
    });
    await t.run(async (ctx) => {
      const audit = (await ctx.db.query("auditLogs").collect()).find((a) => a.entityType === "conversation" && a.entityId === res.conversationId)!;
      expect(audit.severity).toBe("high");
      expect(audit.metadata?.optOutAcknowledged).toBe(true);
    });
  });

  test("telefone inválido, canal de outra org, canal desativado e funil inválido dão erro", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    await expect(
      asAgent.action(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "123" })
    ).rejects.toThrow(/Telefone/);
    await expect(
      asAgent.action(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.otherChannelId, phone: "85999995555" })
    ).rejects.toThrow(/não encontrado/);
    await expect(
      asAgent.action(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.disabledId, phone: "85999995555" })
    ).rejects.toThrow(/não está ativo/);
    await expect(
      asAgent.action(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85999995555", boardId: s.vendas.boardId, stageId: s.eventos.stageIds[0],
      })
    ).rejects.toThrow(/não pertence/);
  });

  test("membro com inbox view_all não pode iniciar nem pré-visualizar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asViewer = t.withIdentity({ subject: `${s.viewer.userId}|s1` });
    await expect(
      asViewer.action(api.startConversation.startConversation, { organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "85999996666" })
    ).rejects.toThrow(/Permissão insuficiente/);
    await expect(
      asViewer.query(api.startConversation.previewStartConversation, { organizationId: s.organizationId, phone: "85999996666" })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("listSendableWhatsappChannels: só ativos, só campos da allowlist, sem segredo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asViewer = t.withIdentity({ subject: `${s.viewer.userId}|s1` });
    const list = await asViewer.query(api.startConversation.listSendableWhatsappChannels, { organizationId: s.organizationId });
    expect(list.map((c) => c.displayName).sort()).toEqual(["Bridge", "Oficial"]);
    for (const c of list) {
      expect(Object.keys(c).sort()).toEqual(["_id", "connected", "displayName", "phoneDisplay", "provider", "sessionState"]);
      expect(JSON.stringify(c)).not.toMatch(/enc:|v1:|wuzapi|inst_|pn_1|vt|1234|cret/);
    }
    const bridge = list.find((c) => c.provider === "bridge")!;
    expect(bridge).toMatchObject({ connected: true, phoneDisplay: "+55 (85) 91111-2222" });
  });
});

describe("startConversation — DDI padrão da org (v0.67)", () => {
  test("org com DDI 1: '(212) 555-1234' vira o contato 12125551234", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, defaultCountryCode: "1" } });
    });
    const mock = wuzapiCheck(["12125551234"]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const preview = await asAgent.query(api.startConversation.previewStartConversation, {
      organizationId: s.organizationId, phone: "(212) 555-1234",
    });
    expect(preview).toMatchObject({ phone: "12125551234", phoneDisplay: "+1 (212) 555-1234", phoneValid: true, phoneError: null });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "(212) 555-1234", content: "Hi",
    });
    expect(res).toMatchObject({ createdContact: true, verified: true, canonicalPhone: "12125551234" });
    expect(mock.calls[0].body.Phone).toEqual(["12125551234"]);
    await t.run(async (ctx) => {
      const contact = (await ctx.db.get(res.contactId))!;
      expect(contact).toMatchObject({ phone: "12125551234", whatsappNumber: "12125551234" });
    });
  });

  test("org com DDI 1: número curto ganha a dica de NANP, não a de DDD", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.organizationId))!;
      await ctx.db.patch(s.organizationId, { settings: { ...org.settings, defaultCountryCode: "1" } });
    });
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    await expect(
      asAgent.action(api.startConversation.startConversation, {
        organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "555 1234",
      })
    ).rejects.toThrow(/10 dígitos.*código do país/);
  });

  test("org BR: '+1 212 555 1234' fica 12125551234 (o + não é jogado fora)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mock = wuzapiCheck(["12125551234"]);
    const asAgent = t.withIdentity({ subject: `${s.agent.userId}|s1` });
    const res = await asAgent.action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.bridgeId, phone: "+1 212 555 1234",
    });
    expect(res).toMatchObject({ createdContact: true, canonicalPhone: "12125551234" });
    expect(mock.calls[0].body.Phone).toEqual(["12125551234"]);
  });

  test("resolveStartPhone: mensagens por país padrão", () => {
    expect(resolveStartPhone("1234567", "55")).toMatchObject({ ok: false, error: expect.stringMatching(/DDD.*\+ e o código do país/) });
    expect(resolveStartPhone("1234567", "1")).toMatchObject({ ok: false, error: expect.stringMatching(/10 dígitos/) });
    expect(resolveStartPhone("12345", "44")).toMatchObject({ ok: false, error: expect.stringMatching(/código de área/) });
    expect(resolveStartPhone("(212) 555-1234", "1")).toEqual({ ok: true, phone: "12125551234" });
  });
});
