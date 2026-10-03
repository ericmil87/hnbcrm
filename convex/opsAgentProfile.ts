/**
 * Ops SEM sessão de usuário para manutenção de perfil de agente e de campos
 * personalizados de uma org — o caminho usado para aplicar versões novas de
 * prompt/knowledge de um atendente em produção (ex.: Guardião v4, 02/10/2026)
 * sem mutation temporária.
 *
 * Todas são `internalMutation` com `dryRun` DEFAULT TRUE: a chamada sem a flag
 * só relata o que faria. Toda escrita grava auditLog `actorType:"system"` com
 * a `version` informada, para a trilha em /app/auditoria.
 *
 * Uso (prod): npx convex run --prod opsAgentProfile:internalSetAgentProfileText "$(cat args.json)"
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { auditTextSnapshot } from "./lib/auditText";

const TEXT_FIELDS = ["systemPrompt", "knowledge", "disclosure"] as const;

export const internalSetAgentProfileText = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    field: v.union(v.literal("systemPrompt"), v.literal("knowledge"), v.literal("disclosure")),
    text: v.string(),
    // Trava otimista: recusa se o texto atual não tiver este tamanho (evita
    // sobrescrever uma edição feita pela UI entre o dump e a aplicação).
    expectedCurrentLength: v.optional(v.number()),
    version: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    applied: v.boolean(),
    field: v.string(),
    beforeLength: v.number(),
    afterLength: v.number(),
    changed: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const member = await ctx.db.get(args.agentMemberId);
    if (!member || member.organizationId !== args.organizationId) {
      throw new Error("Membro não pertence à organização");
    }
    if (member.type !== "ai" || !member.agentProfile) {
      throw new Error("Membro não é um agente de IA com perfil");
    }
    if (!TEXT_FIELDS.includes(args.field)) throw new Error("Campo inválido");
    const current = (member.agentProfile[args.field] ?? "") as string;
    if (args.expectedCurrentLength !== undefined && current.length !== args.expectedCurrentLength) {
      throw new Error(
        `Texto atual tem ${current.length} caracteres, esperado ${args.expectedCurrentLength} — refaça o dump antes de aplicar`
      );
    }
    const changed = current !== args.text;
    if (dryRun || !changed) {
      return {
        applied: false,
        field: args.field,
        beforeLength: current.length,
        afterLength: args.text.length,
        changed,
      };
    }
    const now = Date.now();
    await ctx.db.patch(args.agentMemberId, {
      agentProfile: { ...member.agentProfile, [args.field]: args.text },
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: args.agentMemberId,
      action: "update",
      actorType: "system",
      changes: {
        // Texto (não só tamanho) para dar para reverter; acima do teto vai
        // truncado com o hash do completo (lib/auditText.ts).
        before: { [args.field]: await auditTextSnapshot(current) },
        after: { [args.field]: await auditTextSnapshot(args.text) },
      },
      metadata: {
        op: "internalSetAgentProfileText",
        field: args.field,
        version: args.version,
        beforeLength: current.length,
        afterLength: args.text.length,
      },
      description: `Perfil do agente "${member.name}": ${args.field} atualizado por ops${args.version ? ` (${args.version})` : ""}`,
      severity: "medium",
      createdAt: now,
    });
    return {
      applied: true,
      field: args.field,
      beforeLength: current.length,
      afterLength: args.text.length,
      changed,
    };
  },
});

export const internalUpsertFieldDefinitions = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    fields: v.array(
      v.object({
        key: v.string(),
        name: v.string(),
        type: v.union(
          v.literal("text"),
          v.literal("number"),
          v.literal("boolean"),
          v.literal("date"),
          v.literal("select"),
          v.literal("multiselect")
        ),
        entityType: v.optional(v.union(v.literal("lead"), v.literal("contact"))),
        options: v.optional(v.array(v.string())),
      })
    ),
    version: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    applied: v.boolean(),
    created: v.array(v.string()),
    existing: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const all = await ctx.db
      .query("fieldDefinitions")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    const created: string[] = [];
    const existing: string[] = [];
    let order = all.reduce((max, f) => Math.max(max, f.order), -1) + 1;
    const now = Date.now();
    for (const f of args.fields) {
      if (!/^[a-z0-9_]{1,64}$/.test(f.key)) throw new Error(`Chave inválida: ${f.key}`);
      const entity = f.entityType ?? "lead";
      const dup = all.find((d) => d.key === f.key && (d.entityType ?? "lead") === entity);
      if (dup) {
        existing.push(f.key);
        continue;
      }
      created.push(f.key);
      if (dryRun) continue;
      const id = await ctx.db.insert("fieldDefinitions", {
        organizationId: args.organizationId,
        name: f.name,
        key: f.key,
        type: f.type,
        entityType: entity,
        options: f.options,
        isRequired: false,
        order: order++,
        createdAt: now,
      });
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "fieldDefinition",
        entityId: id,
        action: "create",
        actorType: "system",
        metadata: { op: "internalUpsertFieldDefinitions", key: f.key, type: f.type, entityType: entity, version: args.version },
        description: `Campo personalizado "${f.name}" (${f.key}) criado por ops${args.version ? ` (${args.version})` : ""}`,
        severity: "low",
        createdAt: now,
      });
    }
    return { applied: !dryRun, created, existing };
  },
});
