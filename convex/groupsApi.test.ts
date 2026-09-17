/// <reference types="vite/client" />
/**
 * REST de grupos (`/api/v1/groups/*` e `/api/v1/group-posts/*`): as MESMAS
 * regras da UI, através dos wrappers `internal*` de `groupsInternal.ts`.
 *
 * O que estes testes travam, em ordem de gravidade:
 *  1. **Multi-tenant.** A chave da Org B com o id inteiro de um grupo da Org A
 *     recebe 404 — nunca o conteúdo da sala.
 *  2. **RBAC espelhado.** Ler é `inbox:view_own`, acompanhar/sincronizar é
 *     `settings:manage`, publicação é `campaigns` (view < manage < full). Uma
 *     chave de agente não ativa publicação nem liga o acompanhamento.
 *  3. **Enviar na sala é o mesmo caminho do 1:1.** `POST /groups/send` resolve
 *     a conversa do grupo e chama `conversations.internalSendMessage`, então a
 *     mensagem nasce com `mentions` e com o dispatch agendado.
 *
 * Nenhuma mensagem real sai: o `fetch` é dublado e o dispatch fica agendado.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const DAY = 24 * 60 * 60 * 1000;
/** Quarta-feira, 16/09/2026, 09:00 em São Paulo. */
const NOW = Date.UTC(2026, 8, 16, 12, 0);

const ADMIN_KEY = "hnb_test_groups_admin_1";
const MANAGER_KEY = "hnb_test_groups_manager_2";
const AGENT_KEY = "hnb_test_groups_agent_3";
const OTHER_KEY = "hnb_test_groups_other_4";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  // Nenhuma rota destes testes fala com a rede de verdade.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/user/lid/")) {
        return json({ code: 200, success: true, data: { jid: "", lid: "" } });
      }
      if (u.endsWith("/group/list")) {
        return json({ code: 200, success: true, data: { Groups: null } });
      }
      return json({ code: 200, success: true, data: {} });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seed(t: TestConvex<typeof schema>) {
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Grupos",
      slug: "org-grupos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (
      orgId: Id<"organizations">,
      name: string,
      role: "admin" | "manager" | "agent"
    ) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId: orgId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mk(organizationId, "Admin", "admin"); // settings:manage + campaigns:full
    const manager = await mk(organizationId, "Gerente", "manager"); // campaigns:manage, settings:view
    const agent = await mk(organizationId, "Vendedor", "agent"); // inbox:reply, campaigns:view

    // Outra org, com a própria chave — guarda multi-tenant.
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra",
      slug: "outra-grupos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const other = await mk(otherOrgId, "Estranho", "admin");

    for (const [key, org, member] of [
      [ADMIN_KEY, organizationId, admin.memberId],
      [MANAGER_KEY, organizationId, manager.memberId],
      [AGENT_KEY, organizationId, agent.memberId],
      [OTHER_KEY, otherOrgId, other.memberId],
    ] as const) {
      await ctx.db.insert("apiKeys", {
        organizationId: org,
        teamMemberId: member,
        name: key,
        keyHash: await sha256Hex(key),
        isActive: true,
        createdAt: now,
      });
    }
    return { organizationId, otherOrgId, admin, manager, agent, other };
  });

  // Canal bridge criado pela action real (token cifrado de verdade).
  const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
  const channelConfigId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: s.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Número da loja",
    bridgeBaseUrl: "https://wuzapi.example.com",
    bridgeInstanceId: "inst_groups_api",
    bridgeToken: "fake-instance-token",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(channelConfigId, {
      bridgeSessionState: "connected",
      bridgePhone: "558192985729",
      status: "active",
    });
  });
  await asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId });
  await asAdmin.mutation(api.groupChats.setGroupsEnabled, { channelConfigId, enabled: true });

  const groups = await t.run(async (ctx) => {
    const now = Date.now();
    const mkGroup = async (subject: string, jid: string, monitored: boolean) => {
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        kind: "group",
        externalChatId: jid,
        channel: "whatsapp",
        channelConfigId,
        status: "active",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      const groupChatId = await ctx.db.insert("groupChats", {
        organizationId: s.organizationId,
        channelConfigId,
        conversationId,
        jid,
        subject,
        monitored,
        ...(monitored ? { monitoredSince: now } : {}),
        participants: [
          {
            lid: "111@lid",
            phone: "5511999990001",
            name: "Maria",
            isAdmin: false,
            isSuperAdmin: false,
          },
          {
            lid: "222@lid",
            phone: "5511999990002",
            name: "João",
            isAdmin: true,
            isSuperAdmin: false,
          },
        ],
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(conversationId, { groupChatId });
      return { groupChatId, conversationId };
    };
    const g1 = await mkGroup("Turma da Terra", "120363111@g.us", true);
    const g2 = await mkGroup("Clube do Mel", "120363222@g.us", false);
    return { g1, g2 };
  });

  return { ...s, channelConfigId, ...groups };
}

async function call(
  t: TestConvex<typeof schema>,
  key: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
) {
  const res = await t.fetch(path, {
    method,
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

const dailySchedule = () => ({
  timezone: "America/Sao_Paulo",
  times: ["12:00"],
  days: [1, 2, 3, 4, 5, 6, 7],
  endAt: NOW + 3 * DAY,
});
const libraryContent = (texts: string[]) => ({
  kind: "library",
  library: { items: texts.map((text) => ({ text })), order: "sequential" },
});

// ─────────────────────────────────────────────────────────────────────────────

describe("REST /api/v1/groups", () => {
  test("lista os grupos do canal sem participantes e sem token do gateway", async () => {
    const t = setup();
    const s = await seed(t);

    const all = await call(t, ADMIN_KEY, "GET", "/api/v1/groups");
    expect(all.status).toBe(200);
    expect(all.json.groups).toHaveLength(2);

    const byChannel = await call(
      t,
      ADMIN_KEY,
      "GET",
      `/api/v1/groups?channelConfigId=${s.channelConfigId}`
    );
    expect(byChannel.json.groups.map((g: any) => g.subject).sort()).toEqual([
      "Clube do Mel",
      "Turma da Terra",
    ]);
    // A listagem devolve a CONTAGEM, nunca a lista de membros.
    const first = byChannel.json.groups[0];
    expect(first.participants).toBeUndefined();
    expect(first.participantsCount).toBe(2);
    expect(JSON.stringify(byChannel.json)).not.toContain("fake-instance-token");
  });

  test("get devolve os participantes; grupo de outra org é 404", async () => {
    const t = setup();
    const s = await seed(t);

    const ok = await call(
      t,
      ADMIN_KEY,
      "GET",
      `/api/v1/groups/get?groupChatId=${s.g1.groupChatId}`
    );
    expect(ok.status).toBe(200);
    expect(ok.json.group.subject).toBe("Turma da Terra");
    expect(ok.json.group.participants).toHaveLength(2);

    const cross = await call(
      t,
      OTHER_KEY,
      "GET",
      `/api/v1/groups/get?groupChatId=${s.g1.groupChatId}`
    );
    expect(cross.status).toBe(404);
    expect(JSON.stringify(cross.json)).not.toContain("Turma da Terra");
  });

  test("monitor exige settings:manage e audita a mudança", async () => {
    const t = setup();
    const s = await seed(t);

    const denied = await call(t, AGENT_KEY, "POST", "/api/v1/groups/monitor", {
      groupChatId: s.g2.groupChatId,
      monitored: true,
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe("Permissão insuficiente");

    const ok = await call(t, ADMIN_KEY, "POST", "/api/v1/groups/monitor", {
      groupChatId: s.g2.groupChatId,
      monitored: true,
    });
    expect(ok.status).toBe(200);
    const group = await t.run(async (ctx) => ctx.db.get(s.g2.groupChatId));
    expect(group!.monitored).toBe(true);

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId))
        .collect()
    );
    expect(
      audits.some(
        (a) => a.entityType === "groupChat" && String(a.description).includes("Clube do Mel")
      )
    ).toBe(true);
  });

  test("send publica na conversa do grupo com as menções e agenda o dispatch", async () => {
    const t = setup();
    const s = await seed(t);

    const sent = await call(t, AGENT_KEY, "POST", "/api/v1/groups/send", {
      groupChatId: s.g1.groupChatId,
      content: "Bom dia, @Maria!",
      mentions: ["5511999990001@s.whatsapp.net"],
    });
    expect(sent.status).toBe(201);
    expect(sent.json.conversationId).toBe(s.g1.conversationId);

    const message = await t.run(async (ctx) =>
      ctx.db.get(sent.json.messageId as Id<"messages">)
    );
    expect(message!.conversationId).toBe(s.g1.conversationId);
    expect(message!.direction).toBe("outbound");
    expect(message!.mentions).toEqual(["5511999990001@s.whatsapp.net"]);
    // Conversa de grupo não tem lead — o insert não pode exigir um.
    expect(message!.leadId).toBeUndefined();
  });

  test("send recusa grupo não acompanhado e grupo de outra org", async () => {
    const t = setup();
    const s = await seed(t);

    const naoAcompanhado = await call(t, ADMIN_KEY, "POST", "/api/v1/groups/send", {
      groupChatId: s.g2.groupChatId,
      content: "oi",
    });
    expect(naoAcompanhado.status).toBe(400);
    expect(naoAcompanhado.json.error).toMatch(/Acompanhe o grupo/i);

    const cross = await call(t, OTHER_KEY, "POST", "/api/v1/groups/send", {
      groupChatId: s.g1.groupChatId,
      content: "oi",
    });
    expect(cross.status).toBe(404);

    const semConteudo = await call(t, ADMIN_KEY, "POST", "/api/v1/groups/send", {
      groupChatId: s.g1.groupChatId,
    });
    expect(semConteudo.status).toBe(400);
  });

  test("messages devolve as mais recentes primeiro, com o autor do grupo", async () => {
    const t = setup();
    const s = await seed(t);
    await t.run(async (ctx) => {
      const base = Date.now();
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId: s.g1.conversationId,
          direction: "inbound",
          senderType: "contact",
          senderName: `Membro ${i}`,
          senderLid: "111@lid",
          senderPhone: "5511999990001",
          content: `mensagem ${i}`,
          contentType: "text",
          isInternal: false,
          createdAt: base + i * 1000,
        });
      }
    });

    const res = await call(
      t,
      AGENT_KEY,
      "GET",
      `/api/v1/groups/messages?groupChatId=${s.g1.groupChatId}&limit=2`
    );
    expect(res.status).toBe(200);
    expect(res.json.messages).toHaveLength(2);
    expect(res.json.messages[0].content).toBe("mensagem 2");
    expect(res.json.messages[0].senderName).toBe("Membro 2");
    expect(res.json.messages[0].senderPhone).toBe("5511999990001");
  });

  test("sync exige settings:manage e devolve o resultado do gateway", async () => {
    const t = setup();
    const s = await seed(t);

    const denied = await call(t, AGENT_KEY, "POST", "/api/v1/groups/sync", {
      channelConfigId: s.channelConfigId,
    });
    expect(denied.status).toBe(403);

    const ok = await call(t, ADMIN_KEY, "POST", "/api/v1/groups/sync", {
      channelConfigId: s.channelConfigId,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.detail).toMatch(/nenhum grupo/i);
  });

  test("sem chave de API nenhuma rota de grupo responde", async () => {
    const t = setup();
    await seed(t);
    const res = await t.fetch("/api/v1/groups", { method: "GET" });
    // `authenticateApiKey` lança e o mapa de erro das rotas de grupo vira 400.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/API key required/i);
  });
});

describe("REST /api/v1/group-posts", () => {
  test("criar → listar → obter → aprovar/rejeitar respeita a hierarquia de campaigns", async () => {
    const t = setup();
    const s = await seed(t);

    // `view` não cria.
    const denied = await call(t, AGENT_KEY, "POST", "/api/v1/group-posts/create", {
      name: "Bom dia",
      groupChatIds: [s.g1.groupChatId],
      schedule: dailySchedule(),
      content: libraryContent(["Bom dia, {{grupo}}!"]),
    });
    expect(denied.status).toBe(403);

    // `manage` cria.
    const created = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/create", {
      name: "Bom dia",
      groupChatIds: [s.g1.groupChatId],
      schedule: dailySchedule(),
      content: libraryContent(["Bom dia, {{grupo}}!", "Oi, {{grupo}}!"]),
    });
    expect(created.status).toBe(201);
    const groupPostId = created.json.groupPostId as string;

    const listed = await call(t, AGENT_KEY, "GET", "/api/v1/group-posts");
    expect(listed.status).toBe(200);
    expect(listed.json.posts).toHaveLength(1);
    expect(listed.json.posts[0].targetNames).toEqual(["Turma da Terra"]);
    expect(listed.json.posts[0].scheduleText).toBeTruthy();

    const got = await call(
      t,
      AGENT_KEY,
      "GET",
      `/api/v1/group-posts/get?groupPostId=${groupPostId}`
    );
    expect(got.status).toBe(200);
    expect(got.json.post.status).toBe("draft");
    expect(got.json.post.targets[0].subject).toBe("Turma da Terra");

    const updated = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/update", {
      groupPostId,
      name: "Bom dia editado",
    });
    expect(updated.status).toBe(200);
    expect(
      (await t.run(async (ctx) => ctx.db.get(groupPostId as Id<"groupPosts">)))!.name
    ).toBe("Bom dia editado");
  });

  test("ativar exige campaigns:full; pausar volta a ser manage", async () => {
    const t = setup();
    const s = await seed(t);

    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/group-posts/create", {
      name: "Rotina",
      groupChatIds: [s.g1.groupChatId],
      schedule: dailySchedule(),
      content: libraryContent(["Bom dia!"]),
    });
    const groupPostId = created.json.groupPostId as string;

    const denied = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/activate", {
      groupPostId,
    });
    expect(denied.status).toBe(403);

    const activated = await call(t, ADMIN_KEY, "POST", "/api/v1/group-posts/activate", {
      groupPostId,
    });
    expect(activated.status).toBe(200);
    const active = await t.run(async (ctx) => ctx.db.get(groupPostId as Id<"groupPosts">));
    expect(active!.status).toBe("active");
    expect(active!.nextRunAt).toBeGreaterThan(NOW);

    const paused = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/pause", {
      groupPostId,
      reason: "pausa pela API",
    });
    expect(paused.status).toBe(200);
    const doc = await t.run(async (ctx) => ctx.db.get(groupPostId as Id<"groupPosts">));
    expect(doc!.status).toBe("paused");
    expect(doc!.pausedReason).toBe("pausa pela API");
  });

  test("aprovar e rejeitar o texto pendente da IA", async () => {
    const t = setup();
    const s = await seed(t);

    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/group-posts/create", {
      name: "Rotina IA",
      groupChatIds: [s.g1.groupChatId],
      schedule: dailySchedule(),
      content: libraryContent(["Bom dia!"]),
    });
    const groupPostId = created.json.groupPostId as Id<"groupPosts">;
    await t.run(async (ctx) => {
      await ctx.db.patch(groupPostId, {
        pending: {
          slotKey: "2026-09-16T12:00",
          status: "pendingApproval",
          text: "Texto gerado pela IA",
          generatedAt: Date.now(),
          dueAt: NOW + 60 * 60 * 1000,
        },
      });
    });

    const approved = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/approve", {
      groupPostId,
      editedText: "Texto revisado pela equipe",
    });
    expect(approved.status).toBe(200);
    let doc = await t.run(async (ctx) => ctx.db.get(groupPostId));
    expect(doc!.pending!.status).toBe("approved");
    expect(doc!.pending!.editedText).toBe("Texto revisado pela equipe");

    // Rejeitar só vale com algo pendente — o já aprovado é recusado.
    const semPendente = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/reject", {
      groupPostId,
    });
    expect(semPendente.status).toBe(400);

    await t.run(async (ctx) => {
      const post = (await ctx.db.get(groupPostId))!;
      await ctx.db.patch(groupPostId, {
        pending: { ...post.pending!, status: "pendingApproval", editedText: undefined },
      });
    });
    const rejected = await call(t, MANAGER_KEY, "POST", "/api/v1/group-posts/reject", {
      groupPostId,
      reason: "fora de tom",
    });
    expect(rejected.status).toBe(200);
    doc = await t.run(async (ctx) => ctx.db.get(groupPostId));
    expect(doc!.pending!.status).toBe("rejected");
  });

  test("publicação de outra org não é vista nem alterada", async () => {
    const t = setup();
    const s = await seed(t);
    const created = await call(t, ADMIN_KEY, "POST", "/api/v1/group-posts/create", {
      name: "Só desta org",
      groupChatIds: [s.g1.groupChatId],
      schedule: dailySchedule(),
      content: libraryContent(["Bom dia!"]),
    });
    const groupPostId = created.json.groupPostId as string;

    const listed = await call(t, OTHER_KEY, "GET", "/api/v1/group-posts");
    expect(listed.status).toBe(200);
    expect(listed.json.posts).toEqual([]);

    const got = await call(
      t,
      OTHER_KEY,
      "GET",
      `/api/v1/group-posts/get?groupPostId=${groupPostId}`
    );
    expect(got.status).toBe(404);

    const paused = await call(t, OTHER_KEY, "POST", "/api/v1/group-posts/pause", {
      groupPostId,
    });
    expect(paused.status).toBe(404);
  });

  test("criar com grupo de outra org é recusado", async () => {
    const t = setup();
    const s = await seed(t);
    const res = await call(t, OTHER_KEY, "POST", "/api/v1/group-posts/create", {
      name: "Invasão",
      groupChatIds: [s.g1.groupChatId],
      schedule: dailySchedule(),
      content: libraryContent(["oi"]),
    });
    expect(res.status).toBe(404);
  });
});
