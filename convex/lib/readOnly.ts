/**
 * Modo leitura (B7): teste vencido, `read_only` e `canceled`. `resolveEntitlements`
 * é a fonte da decisão (`aiAllowed`/`outboundAllowed`); aqui ficam os guards com
 * `ctx` que as portas de escrita chamam. Org `legacy`/sem plano: nunca bloqueia.
 *
 * O que o modo leitura NÃO bloqueia (testes provam): inbound (bridge/Meta/IG),
 * exportação, leitura e organização interna (notas, tarefas, leads).
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { resolveEntitlements } from "./entitlements";

export const READ_ONLY_SEND_MESSAGE = "Conta em modo leitura: assine um plano para voltar a enviar.";

/** Org em modo leitura para ENVIO? (puro; `now` do chamador) */
export function outboundBlockedFor(org: Pick<Doc<"organizations">, "settings" | "billing"> | null | undefined, now: number): boolean {
  return org ? !resolveEntitlements(org, now).outboundAllowed : false;
}

/** Recusa envio humano/campanha em modo leitura (ConvexError PT-BR). */
export async function assertOutboundAllowed(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  now: number = Date.now()
): Promise<void> {
  const org = await ctx.db.get(organizationId);
  if (outboundBlockedFor(org, now)) throw new ConvexError(READ_ONLY_SEND_MESSAGE);
}

/** Recusa criar recurso novo (canal, API key, webhook) em modo leitura. */
export async function assertPlanWritable(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  what: string,
  now: number = Date.now()
): Promise<void> {
  const org = await ctx.db.get(organizationId);
  if (outboundBlockedFor(org, now)) {
    throw new ConvexError(`Conta em modo leitura: assine um plano para ${what}.`);
  }
}
