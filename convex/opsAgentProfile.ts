/**
 * Ops SEM sessão de usuário para manutenção de perfil de agente e de campos
 * personalizados de uma org — o caminho usado para aplicar versões novas de
 * prompt/knowledge de um atendente em produção (ex.: Guia v4, 02/10/2026)
 * sem mutation temporária.
 *
 * Todas são `internalMutation` com `dryRun` DEFAULT TRUE: a chamada sem a flag
 * só relata o que faria. Toda escrita grava auditLog `actorType:"system"` com
 * a `version` informada, para a trilha em /app/auditoria.
 *
 * Uso (prod): npx convex run --prod opsAgentProfile:internalSetAgentProfileText "$(cat args.json)"
 */
import { v } from "convex/values";
import { internalMutation, MutationCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { auditTextSnapshot } from "./lib/auditText";
import { resolveDisclosureMode } from "./lib/disclosure";
import {
  migrateMemberTexts,
  readAgentTexts,
  restoreMemberTextsToDoc,
  writeAgentTexts,
} from "./lib/agentProfileTexts";

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
    // persona/conhecimento: tabela `agentProfileTexts` (ou o doc, se legado);
    // `disclosure` fica no doc (pequeno, lido em todo commit).
    const current =
      args.field === "disclosure"
        ? (member.agentProfile.disclosure ?? "")
        : ((await readAgentTexts(ctx, member))[args.field] ?? "");
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
    if (args.field === "disclosure") {
      await ctx.db.patch(args.agentMemberId, {
        agentProfile: { ...member.agentProfile, disclosure: args.text },
        updatedAt: now,
      });
    } else {
      // Grava na tabela e migra o membro legado na mesma transação.
      await writeAgentTexts(ctx, member, { [args.field]: args.text }, { now });
    }
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

/**
 * v0.71: troca o modo de divulgação do atendente (`first_reply` | `on_demand`,
 * ver lib/disclosure.ts) sem sessão de usuário. dryRun DEFAULT TRUE.
 *
 * Uso: npx convex run --prod opsAgentProfile:internalSetDisclosureMode '{"organizationId":"…","agentMemberId":"…","mode":"on_demand","dryRun":true}'
 */
export const internalSetDisclosureMode = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    mode: v.union(v.literal("first_reply"), v.literal("on_demand")),
    version: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    applied: v.boolean(),
    before: v.string(),
    after: v.string(),
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
    const before = resolveDisclosureMode(member.agentProfile);
    const changed = before !== args.mode;
    if (dryRun || !changed) {
      return { applied: false, before, after: args.mode, changed };
    }
    const now = Date.now();
    await ctx.db.patch(args.agentMemberId, {
      agentProfile: { ...member.agentProfile, disclosureMode: args.mode },
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: args.agentMemberId,
      action: "update",
      actorType: "system",
      changes: { before: { disclosureMode: before }, after: { disclosureMode: args.mode } },
      metadata: { op: "internalSetDisclosureMode", version: args.version },
      description: `Perfil do agente "${member.name}": divulgação ${args.mode === "on_demand" ? "sob demanda" : "na 1ª resposta"} (ops)${args.version ? ` (${args.version})` : ""}`,
      severity: "medium",
      createdAt: now,
    });
    return { applied: true, before, after: args.mode, changed };
  },
});

/**
 * v0.71: ajusta as REGRAS DO FUNIL (`pipelineConfig.advanceRules`) e/ou a lista de
 * campos capturáveis (`pipelineConfig.captureFields`) do atendente sem sessão de
 * usuário. Os demais campos de `pipelineConfig` (board, estágios, threshold…) são
 * preservados. `captureFields` é validada contra `fieldDefinitions` da org: chave
 * desconhecida recusa a operação. dryRun DEFAULT TRUE.
 *
 * Uso: npx convex run --prod opsAgentProfile:internalSetPipelineRules '{"organizationId":"…","agentMemberId":"…","advanceRules":"…","captureFields":["…"],"version":"…","dryRun":true}'
 */
export const internalSetPipelineRules = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    advanceRules: v.optional(v.string()),
    captureFields: v.optional(v.array(v.string())),
    version: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    applied: v.boolean(),
    changed: v.boolean(),
    advanceRules: v.object({ beforeLength: v.number(), afterLength: v.number(), changed: v.boolean() }),
    captureFields: v.object({ before: v.array(v.string()), after: v.array(v.string()), changed: v.boolean() }),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (args.advanceRules === undefined && args.captureFields === undefined) {
      throw new Error("Informe advanceRules e/ou captureFields");
    }
    const member = await ctx.db.get(args.agentMemberId);
    if (!member || member.organizationId !== args.organizationId) {
      throw new Error("Membro não pertence à organização");
    }
    if (member.type !== "ai" || !member.agentProfile) {
      throw new Error("Membro não é um agente de IA com perfil");
    }
    const current = member.agentProfile.pipelineConfig ?? {};
    const beforeRules = current.advanceRules ?? "";
    const afterRules = args.advanceRules ?? beforeRules;
    const beforeFields = current.captureFields ?? [];
    const afterFields = args.captureFields ?? beforeFields;

    if (args.captureFields !== undefined) {
      const defs = await ctx.db
        .query("fieldDefinitions")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .collect();
      const known = new Set(defs.map((d) => d.key));
      const unknown = afterFields.filter((k) => !known.has(k));
      if (unknown.length > 0) {
        throw new Error(`captureFields desconhecidos em fieldDefinitions: ${unknown.join(", ")}`);
      }
    }

    const rulesChanged = afterRules !== beforeRules;
    const fieldsChanged = JSON.stringify(afterFields) !== JSON.stringify(beforeFields);
    const changed = rulesChanged || fieldsChanged;
    const report = {
      changed,
      advanceRules: { beforeLength: beforeRules.length, afterLength: afterRules.length, changed: rulesChanged },
      captureFields: { before: beforeFields, after: afterFields, changed: fieldsChanged },
    };
    if (dryRun || !changed) {
      return { applied: false, ...report };
    }
    const now = Date.now();
    await ctx.db.patch(args.agentMemberId, {
      agentProfile: {
        ...member.agentProfile,
        pipelineConfig: { ...current, advanceRules: afterRules, captureFields: afterFields },
      },
      updatedAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "teamMember",
      entityId: args.agentMemberId,
      action: "update",
      actorType: "system",
      changes: {
        before: { advanceRules: await auditTextSnapshot(beforeRules), captureFields: beforeFields },
        after: { advanceRules: await auditTextSnapshot(afterRules), captureFields: afterFields },
      },
      metadata: { op: "internalSetPipelineRules", version: args.version },
      description: `Perfil do agente "${member.name}": regras do funil/campos capturáveis (ops)${args.version ? ` (${args.version})` : ""}`,
      severity: "medium",
      createdAt: now,
    });
    return { applied: true, ...report };
  },
});

/**
 * Perf Convex I/O, onda 2 — migra `agentProfile.systemPrompt`/`.knowledge` do
 * doc do membro IA para a tabela `agentProfileTexts` (ver lib/agentProfileTexts.ts).
 *
 * Por membro IA com perfil e SEM `textsMigratedAt`: grava a linha, tira os dois
 * campos do doc e carimba `textsMigratedAt`, na MESMA transação. Idempotente
 * (membro já migrado é só contado). dryRun DEFAULT TRUE. Paginado por cursor
 * sobre `teamMembers` (membros IA são dezenas por deployment: uma página de
 * 100 costuma bastar; repita com `cursor: continueCursor` enquanto `isDone` for false).
 *
 * Ordem em PROD:
 *   1. deploy (schema aditivo: tabela + `textsMigratedAt`; leitores com dual-read);
 *   2. npx convex run --prod opsAgentProfile:internalMigrateAgentTexts '{}'   (dryRun: confira `pending`)
 *   3. npx convex run --prod opsAgentProfile:internalMigrateAgentTexts '{"dryRun":false}'
 *   4. repita o passo 2 — `pending` precisa vir 0 —, e confira um atendente no
 *      simulador ("Testar") e no editor (persona/conhecimento carregam).
 * Rollback: internalRestoreAgentTextsToDoc (mesma forma), ANTES de reverter o código.
 */
const migrationArgs = {
  organizationId: v.optional(v.id("organizations")),
  dryRun: v.optional(v.boolean()),
  cursor: v.optional(v.union(v.string(), v.null())),
  pageSize: v.optional(v.number()),
};
const migrationReturns = v.object({
  dryRun: v.boolean(),
  scanned: v.number(),
  pending: v.number(),
  applied: v.number(),
  skipped: v.number(),
  members: v.array(
    v.object({
      memberId: v.id("teamMembers"),
      organizationId: v.id("organizations"),
      name: v.string(),
      systemPromptLength: v.number(),
      knowledgeLength: v.number(),
    })
  ),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});

type MigrationMember = {
  memberId: Id<"teamMembers">;
  organizationId: Id<"organizations">;
  name: string;
  systemPromptLength: number;
  knowledgeLength: number;
};

async function pageAiMembers(
  ctx: MutationCtx,
  args: { organizationId?: Id<"organizations">; cursor?: string | null; pageSize?: number }
) {
  const numItems = Math.min(Math.max(Math.floor(args.pageSize ?? 100), 1), 200);
  const orgId = args.organizationId;
  const page = orgId
    ? await ctx.db
        .query("teamMembers")
        .withIndex("by_organization_and_type", (q) => q.eq("organizationId", orgId).eq("type", "ai"))
        .paginate({ cursor: args.cursor ?? null, numItems })
    : await ctx.db.query("teamMembers").paginate({ cursor: args.cursor ?? null, numItems });
  return {
    scanned: page.page.length,
    members: page.page.filter((m) => m.type === "ai" && m.agentProfile !== undefined),
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

export const internalMigrateAgentTexts = internalMutation({
  args: migrationArgs,
  returns: migrationReturns,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const page = await pageAiMembers(ctx, args);
    const now = Date.now();
    const members: MigrationMember[] = [];
    let applied = 0;
    let skipped = 0;
    for (const m of page.members) {
      const profile = m.agentProfile!;
      if (profile.textsMigratedAt !== undefined) {
        skipped++;
        continue;
      }
      const systemPromptLength = profile.systemPrompt?.length ?? 0;
      const knowledgeLength = profile.knowledge?.length ?? 0;
      members.push({
        memberId: m._id,
        organizationId: m.organizationId,
        name: m.name,
        systemPromptLength,
        knowledgeLength,
      });
      if (dryRun) continue;
      if (await migrateMemberTexts(ctx, m, now)) {
        applied++;
        await ctx.db.insert("auditLogs", {
          organizationId: m.organizationId,
          entityType: "teamMember",
          entityId: m._id,
          action: "update",
          actorType: "system",
          metadata: { op: "internalMigrateAgentTexts", systemPromptLength, knowledgeLength },
          description: `Perfil do agente "${m.name}": persona/conhecimento movidos para armazenamento próprio (ops)`,
          severity: "low",
          createdAt: now,
        });
      }
    }
    return {
      dryRun,
      scanned: page.scanned,
      pending: members.length,
      applied,
      skipped,
      members,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

/** Rollback de `internalMigrateAgentTexts`: devolve o texto ao doc e apaga a linha. dryRun DEFAULT TRUE. */
export const internalRestoreAgentTextsToDoc = internalMutation({
  args: migrationArgs,
  returns: migrationReturns,
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const page = await pageAiMembers(ctx, args);
    const now = Date.now();
    const members: MigrationMember[] = [];
    let applied = 0;
    let skipped = 0;
    for (const m of page.members) {
      if (m.agentProfile!.textsMigratedAt === undefined) {
        skipped++;
        continue;
      }
      const texts = await readAgentTexts(ctx, m);
      const systemPromptLength = texts.systemPrompt?.length ?? 0;
      const knowledgeLength = texts.knowledge?.length ?? 0;
      members.push({
        memberId: m._id,
        organizationId: m.organizationId,
        name: m.name,
        systemPromptLength,
        knowledgeLength,
      });
      if (dryRun) continue;
      if (await restoreMemberTextsToDoc(ctx, m, now)) {
        applied++;
        await ctx.db.insert("auditLogs", {
          organizationId: m.organizationId,
          entityType: "teamMember",
          entityId: m._id,
          action: "update",
          actorType: "system",
          metadata: { op: "internalRestoreAgentTextsToDoc", systemPromptLength, knowledgeLength },
          description: `Perfil do agente "${m.name}": persona/conhecimento devolvidos ao perfil (ops, rollback)`,
          severity: "low",
          createdAt: now,
        });
      }
    }
    return {
      dryRun,
      scanned: page.scanned,
      pending: members.length,
      applied,
      skipped,
      members,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
