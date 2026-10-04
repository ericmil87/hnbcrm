/// <reference types="vite/client" />
/**
 * Purga das orgs criadas por contas ANÔNIMAS (`opsPurge.internalPurgeAnonymousOrganizations`).
 * Prova que a seleção é fail-closed (humano com e-mail, só IA, sem membro, slug
 * protegido, bridge pareado ficam), que o dryRun não escreve nada, que a
 * execução apaga a org inteira + os usuários anônimos órfãos (e só eles), que
 * blob compartilhado com outra org fica, e que rodar de novo não acha alvo.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const DEPLOY = "test-deploy-123";

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CONVEX_SITE_URL", `https://${DEPLOY}.convex.site`);
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function drain() {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function mkOrg(slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function mkUser(kind: "anon" | "email" | "noEmailPassword") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", kind === "email" ? { email: "real@acme.com.br", name: "Real" } : { isAnonymous: kind === "anon" });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: kind === "anon" ? "anonymous" : "password",
      providerAccountId: kind === "email" ? "real@acme.com.br" : `acc-${userId}`,
    });
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86400000 });
    await ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: Date.now() + 86400000 });
    return userId;
  });
}

async function addMember(organizationId: Id<"organizations">, userId: Id<"users"> | undefined, type: "human" | "ai" = "human") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: type === "ai" ? "Robô" : "Pessoa",
      role: type === "ai" ? "ai" : "admin",
      type,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Board+estágio, contato, lead, conversa, mensagens, API key, arquivo com blob. */
async function fillOrg(organizationId: Id<"organizations">, memberId: Id<"teamMembers">, opts: { storageId?: string } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Funil", color: "#000", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    await ctx.db.insert("stages", { organizationId, boardId, name: "Novo", color: "#111", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const stageId = (await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", boardId)).first())!._id;
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Cli", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Lead", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "low", temperature: "cold",
      tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", { organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 2, createdAt: now, updatedAt: now });
    for (let i = 0; i < 2; i++) {
      await ctx.db.insert("messages", {
        organizationId, conversationId, leadId, direction: "inbound", senderType: "contact", content: `m${i}`, contentType: "text", isInternal: false, createdAt: now + i,
      });
    }
    await ctx.db.insert("apiKeys", { organizationId, teamMemberId: memberId, name: "k", keyHash: `h-${organizationId}`, isActive: true, createdAt: now });
    const storageId = opts.storageId ?? (await ctx.storage.store(new Blob(["conteudo"])));
    const fileId = await ctx.db.insert("files", { organizationId, storageId, name: "a.pdf", mimeType: "application/pdf", size: 8, fileType: "other", createdAt: now });
    return { leadId, contactId, conversationId, fileId, storageId };
  });
}

async function snapshot() {
  return await t.run(async (ctx) => {
    const tables = ["organizations", "teamMembers", "users", "authAccounts", "authSessions", "authRefreshTokens", "leads", "contacts", "conversations", "messages", "apiKeys", "files", "boards", "stages"] as const;
    const out: Record<string, number> = {};
    for (const table of tables) out[table] = (await ctx.db.query(table).collect()).length;
    return out;
  });
}

const run = (
  args: { dryRun?: boolean; maxOrgs?: number; confirmDeployment?: string; batchSize?: number; expectTargetIds?: Id<"organizations">[] } = {},
) =>
  t.mutation(internal.opsPurge.internalPurgeAnonymousOrganizations, { confirmDeployment: DEPLOY, ...args });

describe("internalPurgeAnonymousOrganizations", () => {
  test("seleção fail-closed + dryRun não escreve nada", async () => {
    // alvo: 100% anônima
    const anonOrg = await mkOrg("anon-1");
    const anonUser = await mkUser("anon");
    const anonMember = await addMember(anonOrg, anonUser);
    await addMember(anonOrg, undefined, "ai"); // IA não decide
    await fillOrg(anonOrg, anonMember);
    // mista: humano com e-mail + anônimo → nunca alvo
    const mixed = await mkOrg("mista");
    const realUser = await mkUser("email");
    await addMember(mixed, realUser);
    const anon2 = await mkUser("anon");
    await addMember(mixed, anon2);
    // só IA
    const aiOnly = await mkOrg("so-ia");
    await addMember(aiOnly, undefined, "ai");
    // sem membro
    const empty = await mkOrg("vazia");
    // user sem e-mail mas sem conta anonymous → não é alvo
    const odd = await mkOrg("estranha");
    await addMember(odd, await mkUser("noEmailPassword"));
    // slug protegido, 100% anônima
    const prot = await mkOrg("eric-milfont");
    await addMember(prot, await mkUser("anon"));
    // bridge pareado
    const bridgeOrg = await mkOrg("anon-bridge");
    await addMember(bridgeOrg, await mkUser("anon"));
    await t.run(async (ctx) => {
      await ctx.db.insert("channelConfigs", {
        organizationId: bridgeOrg, channel: "whatsapp", provider: "bridge", displayName: "Zap", status: "active", bridgeSessionState: "connected", createdAt: 0, updatedAt: 0,
      } as never);
    });
    // anônimo que também é membro de org legítima
    const shared = await mkUser("anon");
    await addMember(anonOrg, shared);
    await addMember(mixed, shared);

    const before = await snapshot();
    const res = await run();
    expect(res.dryRun).toBe(true);
    expect(res.phase).toBe("plan");
    const plan = res.plan!;
    expect(plan.targets.map((x) => x.slug)).toEqual(["anon-1"]);
    expect(plan.targets[0].counts.leads).toBe(1);
    expect(plan.targets[0].counts.messages).toBe(2);
    expect(plan.targets[0].counts.apiKeys).toBe(1);
    expect(plan.targets[0].memberCount).toBe(3);
    expect(plan.orgsSemMembro.map((o) => o.organizationId)).toEqual([empty]);
    const skipped = Object.fromEntries(plan.skipped.map((s) => [s.slug, s.reason]));
    expect(skipped).toEqual({ "so-ia": "aiOnly", "eric-milfont": "protected", "anon-bridge": "bridgeConnected" });
    expect(plan.legitOrgs).toBe(2); // mista + estranha
    expect(plan.usersToDelete).toEqual([anonUser]);
    expect(plan.usersKept).toEqual([{ userId: shared, otherOrgSlugs: ["mista"] }]);
    expect(await snapshot()).toEqual(before);
    await drain();
    expect(await snapshot()).toEqual(before);
  });

  test("confirmDeployment errado lança", async () => {
    await expect(run({ confirmDeployment: "careful-anaconda-127" })).rejects.toThrow(/confirmDeployment/);
    await expect(run({ confirmDeployment: "" })).rejects.toThrow(/confirmDeployment/);
    // substring não basta: comparação exata com o nome do deployment
    await expect(run({ confirmDeployment: "convex" })).rejects.toThrow(/confirmDeployment/);
    await expect(run({ confirmDeployment: "test-deploy" })).rejects.toThrow(/confirmDeployment/);
    await expect(run({ confirmDeployment: `${DEPLOY}.convex.site` })).rejects.toThrow(/confirmDeployment/);
    expect((await run()).phase).toBe("plan");
  });

  test("execução apaga a org anônima inteira e só os usuários órfãos; idempotente", async () => {
    const anonOrg = await mkOrg("anon-1");
    const anonUser = await mkUser("anon");
    const m = await addMember(anonOrg, anonUser);
    const filled = await fillOrg(anonOrg, m);
    const shared = await mkUser("anon");
    await addMember(anonOrg, shared);

    const legit = await mkOrg("real");
    const realUser = await mkUser("email");
    const rm = await addMember(legit, realUser);
    await addMember(legit, shared); // anônimo dentro de org legítima: o user fica
    const legitData = await fillOrg(legit, rm);

    const res = await run({ dryRun: false });
    expect(res.dryRun).toBe(false);
    await drain();

    await t.run(async (ctx) => {
      expect(await ctx.db.get(anonOrg)).toBeNull();
      expect(await ctx.db.get(filled.leadId)).toBeNull();
      expect(await ctx.db.get(filled.fileId)).toBeNull();
      expect(await ctx.storage.get(filled.storageId as Id<"_storage">)).toBeNull();
      for (const table of ["leads", "contacts", "conversations", "messages", "apiKeys", "files", "boards", "stages", "teamMembers"] as const) {
        const rows = (await ctx.db.query(table).collect()) as Array<{ organizationId?: Id<"organizations"> }>;
        expect(rows.filter((r) => r.organizationId === anonOrg)).toEqual([]);
        expect(rows.filter((r) => r.organizationId === legit).length).toBeGreaterThan(0);
      }
      // user anônimo órfão some com contas, sessões e tokens
      expect(await ctx.db.get(anonUser)).toBeNull();
      expect(await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", anonUser)).collect()).toEqual([]);
      expect(await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", anonUser)).collect()).toEqual([]);
      // anônimo com membership em org legítima e user real ficam
      expect(await ctx.db.get(shared)).not.toBeNull();
      expect(await ctx.db.get(realUser)).not.toBeNull();
      expect(await ctx.db.get(legit)).not.toBeNull();
      expect(await ctx.storage.get(legitData.storageId as Id<"_storage">)).not.toBeNull();
      // sem refresh token pendurado
      const tokens = await ctx.db.query("authRefreshTokens").collect();
      for (const tk of tokens) expect(await ctx.db.get(tk.sessionId)).not.toBeNull();
    });

    const after = await snapshot();
    const again = await run();
    expect(again.plan!.targets).toEqual([]);
    expect(again.plan!.usersToDelete).toEqual([]);
    expect(again.plan!.orphanAnonUsersAlready).toEqual([]);
    await run({ dryRun: false });
    await drain();
    expect(await snapshot()).toEqual(after);
  });

  test("blob compartilhado com outra org não é apagado", async () => {
    const legit = await mkOrg("real");
    const rm = await addMember(legit, await mkUser("email"));
    const legitData = await fillOrg(legit, rm);

    const anonOrg = await mkOrg("anon-1");
    const m = await addMember(anonOrg, await mkUser("anon"));
    const anonData = await fillOrg(anonOrg, m, { storageId: legitData.storageId });

    await run({ dryRun: false });
    await drain();
    await t.run(async (ctx) => {
      expect(await ctx.db.get(anonData.fileId)).toBeNull();
      expect(await ctx.db.get(legitData.fileId)).not.toBeNull();
      expect(await ctx.storage.get(legitData.storageId as Id<"_storage">)).not.toBeNull();
    });
  });

  test("volume maior que o lote: reagenda até esvaziar; maxOrgs limita a passada", async () => {
    const orgs: Id<"organizations">[] = [];
    for (const slug of ["anon-a", "anon-b", "anon-c"]) {
      const org = await mkOrg(slug);
      const m = await addMember(org, await mkUser("anon"));
      await fillOrg(org, m);
      orgs.push(org);
    }
    // 400 mensagens extras na primeira org → mais de um lote de 180
    await t.run(async (ctx) => {
      const conv = (await ctx.db.query("conversations").withIndex("by_organization", (q) => q.eq("organizationId", orgs[0])).first())!;
      for (let i = 0; i < 400; i++) {
        await ctx.db.insert("messages", {
          organizationId: orgs[0], conversationId: conv._id, direction: "inbound", senderType: "contact", content: `x${i}`, contentType: "text", isInternal: false, createdAt: i,
        });
      }
    });

    const first = await run({ dryRun: false, maxOrgs: 2 });
    expect(first.orgRemoved).toBe(false);
    expect(first.rescheduled).toBe(true);
    await drain();
    const left = await t.run(async (ctx) => (await ctx.db.query("organizations").collect()).map((o) => o.slug));
    expect(left).toHaveLength(1);
    await t.run(async (ctx) => {
      expect(await ctx.db.query("messages").withIndex("by_organization", (q) => q.eq("organizationId", orgs[0])).first()).toBeNull();
    });
    // os 2 users das orgs purgadas sumiram; o da org restante continua (ainda é membro)
    const anonUsers = await t.run(async (ctx) => (await ctx.db.query("users").collect()).length);
    expect(anonUsers).toBe(1);

    await run({ dryRun: false });
    await drain();
    expect(await snapshot()).toMatchObject({ organizations: 0, users: 0, messages: 0, teamMembers: 0, authSessions: 0, authRefreshTokens: 0 });
  });

  test("lote cortando entre o admin anônimo e a IA/pendente não aborta nem deixa casca", async () => {
    const org = await mkOrg("anon-corte");
    const admin = await addMember(org, await mkUser("anon")); // criado ANTES da IA
    await addMember(org, undefined, "ai");
    await t.run(async (ctx) => {
      await ctx.db.insert("teamMembers", {
        organizationId: org, name: "Pendente", email: "pendente@exemplo.com.br", role: "agent", type: "human", status: "active", createdAt: 0, updatedAt: 0,
      });
    });
    await fillOrg(org, admin);

    const plan = (await run()).plan!;
    expect(plan.targets[0].pendingHumans).toEqual([{ memberId: expect.any(String), email: "pendente@exemplo.com.br" }]);

    await run({ dryRun: false, batchSize: 1 });
    await drain();
    expect(await snapshot()).toMatchObject({ organizations: 0, teamMembers: 0, users: 0, leads: 0, messages: 0, files: 0, stages: 0 });
  });

  test("isAnonymous endurecido: conta extra ou flag ausente tiram a org da lista", async () => {
    const extra = await mkOrg("anon-com-senha");
    const u1 = await mkUser("anon");
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", { userId: u1, provider: "password", providerAccountId: "x@y.com" });
    });
    await addMember(extra, u1);
    const noFlag = await mkOrg("anon-sem-flag");
    const u2 = await mkUser("anon");
    await t.run(async (ctx) => ctx.db.patch(u2, { isAnonymous: undefined }));
    await addMember(noFlag, u2);

    const plan = (await run()).plan!;
    expect(plan.targets).toEqual([]);
    expect(plan.legitOrgs).toBe(2);
  });

  test("expectTargetIds: conjunto diferente recusa sem escrever; igual executa", async () => {
    const a = await mkOrg("anon-a");
    await addMember(a, await mkUser("anon"));
    const b = await mkOrg("anon-b");
    await addMember(b, await mkUser("anon"));
    const before = await snapshot();

    await expect(run({ dryRun: false, expectTargetIds: [a] })).rejects.toThrow(/expectTargetIds/);
    await expect(run({ dryRun: false, expectTargetIds: [a, b, (await mkOrg("real")) as Id<"organizations">] })).rejects.toThrow(/expectTargetIds/);
    await t.run(async (ctx) => {
      const real = await ctx.db.query("organizations").withIndex("by_slug", (q) => q.eq("slug", "real")).first();
      await ctx.db.delete(real!._id);
    });
    expect(await snapshot()).toEqual(before);

    const ids = (await run()).plan!.targets.map((x) => x.organizationId);
    await run({ dryRun: false, expectTargetIds: ids });
    await drain();
    expect(await snapshot()).toMatchObject({ organizations: 0, users: 0 });
  });
});
