/**
 * Semente de teste da Agenda v2 (A3a; reutilizável nos próximos PRs). Duas orgs; na org A: membros com
 * `agenda` em cada nível (manage/edit/view_all/view_own/none), cada um com e-mail; na org B: um admin.
 * Cria também funil/etapas, contato, lead e conversa para os testes de vínculos.
 */
import type { TestConvex } from "convex-test";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";
import { DEFAULT_PERMISSIONS } from "./permissions";

export type Person = { userId: Id<"users">; memberId: Id<"teamMembers"> };
export type AgendaSeed = Awaited<ReturnType<typeof seedAgenda>>;

export async function seedAgenda(t: TestConvex<typeof schema>, opts: { modules?: boolean } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (name: string, modules: boolean) =>
      await ctx.db.insert("organizations", {
        name,
        slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...(modules ? { modules: { scheduling: true } } : {}) },
        createdAt: now,
        updatedAt: now,
      });
    const orgId = await mkOrg("Clinica Teste", opts.modules !== false);
    const otherOrgId = await mkOrg("Outra Org", opts.modules !== false);

    const mk = async (
      organizationId: Id<"organizations">,
      name: string,
      role: "admin" | "manager" | "agent",
      agenda?: "none" | "view_own" | "view_all" | "edit" | "manage"
    ): Promise<Person> => {
      const userId = await ctx.db.insert("users", { email: `${name.toLowerCase().replace(/\W+/g, ".")}@teste.dev`, name });
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type: "human",
        status: "active",
        ...(agenda ? { permissions: { ...DEFAULT_PERMISSIONS[role === "admin" ? "agent" : role], agenda } } : {}),
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };
    const admin = await mk(orgId, "Admin", "admin");
    const manager = await mk(orgId, "Gerente", "manager");
    const agent = await mk(orgId, "Atendente", "agent");
    const viewAll = await mk(orgId, "Leitor Geral", "agent", "view_all");
    const viewOwn = await mk(orgId, "Leitor Proprio", "agent", "view_own");
    const none = await mk(orgId, "Sem Agenda", "agent", "none");
    const outsider = await mk(otherOrgId, "Admin Outra", "admin");

    const mkFunnel = async (organizationId: Id<"organizations">) => {
      const boardId = await ctx.db.insert("boards", {
        organizationId, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      });
      const lostStageId = await ctx.db.insert("stages", {
        organizationId, boardId, name: "Perdido", color: "#ef4444", order: 1, isClosedWon: false, isClosedLost: true, createdAt: now, updatedAt: now,
      });
      return { boardId, stageId, lostStageId };
    };
    const funnel = await mkFunnel(orgId);
    const otherFunnel = await mkFunnel(otherOrgId);

    const contactId = await ctx.db.insert("contacts", { organizationId: orgId, firstName: "Cliente", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId: orgId, title: "Lead", contactId, boardId: funnel.boardId, stageId: funnel.stageId, value: 0, currency: "BRL",
      priority: "low", temperature: "cold", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now,
      createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: orgId, leadId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });
    return { orgId, otherOrgId, admin, manager, agent, viewAll, viewOwn, none, outsider, funnel, otherFunnel, contactId, leadId, conversationId };
  });
}

export const identityOf = (p: Person) => ({ subject: `${p.userId}|s1` });
