/**
 * Core das respostas rápidas ("/" no composer). `quickReplies.create` e a
 * aplicação do Rascunho de Operação do onboarding usam a MESMA validação e o
 * mesmo insert. Quem chama já autorizou o `member`.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const QUICK_REPLY_SHORTCUT_RE = /^[a-z0-9][a-z0-9-_]{0,23}$/;
export const QUICK_REPLY_MAX_CONTENT = 2000;

export function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\//, "").toLowerCase();
}

/** Valida e normaliza; lança com a mensagem PT-BR de sempre. */
export function validateQuickReplyInput(raw: { shortcut: string; content: string }): {
  shortcut: string;
  content: string;
} {
  const shortcut = normalizeShortcut(raw.shortcut);
  if (!QUICK_REPLY_SHORTCUT_RE.test(shortcut)) {
    throw new Error("Atalho inválido — use letras, números, hífen (até 24 caracteres)");
  }
  const content = raw.content.trim();
  if (!content || content.length > QUICK_REPLY_MAX_CONTENT) {
    throw new Error("Conteúdo obrigatório (até 2000 caracteres)");
  }
  return { shortcut, content };
}

export async function findQuickReplyByShortcut(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  shortcut: string,
): Promise<Doc<"quickReplies"> | null> {
  return await ctx.db
    .query("quickReplies")
    .withIndex("by_organization_and_shortcut", (q) =>
      q.eq("organizationId", organizationId).eq("shortcut", shortcut),
    )
    .first();
}

/**
 * Cria a resposta rápida. `onDuplicate:"throw"` (padrão, UI) recusa atalho
 * repetido; `"skip"` (onboarding, re-executável) devolve `null` sem tocar na
 * resposta existente (o texto do usuário vence).
 */
export async function createQuickReplyCore(
  ctx: MutationCtx,
  params: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    shortcut: string;
    content: string;
    onDuplicate?: "throw" | "skip";
  },
): Promise<Id<"quickReplies"> | null> {
  const { shortcut, content } = validateQuickReplyInput(params);
  const existing = await findQuickReplyByShortcut(ctx, params.organizationId, shortcut);
  if (existing) {
    if (params.onDuplicate === "skip") return null;
    throw new Error(`Já existe uma resposta com o atalho /${shortcut}`);
  }
  const now = Date.now();
  return await ctx.db.insert("quickReplies", {
    organizationId: params.organizationId,
    shortcut,
    content,
    createdBy: params.member._id,
    createdAt: now,
    updatedAt: now,
  });
}
