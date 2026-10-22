/**
 * Porta única de agendamento de webhooks (perf Convex I/O, onda 2).
 *
 * Antes, toda mutation com side effect agendava
 * `internal.nodeActions.triggerWebhooks` incondicionalmente — e na maioria das
 * orgs (sem webhook nenhum) isso custava 1 job em `_scheduled_functions`, 1
 * execução de action Node e 1 runQuery por evento, para nada.
 *
 * Agora o gate acontece NA MUTATION, com uma consulta indexada direta (sem
 * flag/contador denormalizado — nada a manter em sincronia): org sem webhook
 * lê 0 documentos e não agenda nada. A action continua filtrando com o MESMO
 * predicado (`webhookMatches`) em `webhookTrigger.getMatchingWebhooks` —
 * defesa em profundidade, porque o webhook pode ser desativado entre o
 * agendamento e a execução.
 *
 * Teste de build `webhookDispatchPort.test.ts` quebra se alguém voltar a
 * agendar `triggerWebhooks` direto.
 */
import type { GenericDatabaseReader, Scheduler } from "convex/server";
import { internal } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";

/**
 * Teto de webhooks lidos por org — o MESMO da action, para o gate nunca
 * descartar um evento que a action entregaria (org com mais webhooks que
 * isso já era truncada antes).
 */
export const WEBHOOK_SCAN_LIMIT = 100;

/** Predicado único: webhook ativo inscrito no evento (ou em `"*"`). */
export function webhookMatches(
  w: Pick<Doc<"webhooks">, "isActive" | "events">,
  event: string
): boolean {
  return w.isActive && (w.events.includes(event) || w.events.includes("*"));
}

/**
 * Memo POR TRANSAÇÃO da lista de webhooks da org: uma mutation que emite N
 * eventos na mesma org (ex.: mensagem + lead + conversa) lê `webhooks` uma vez
 * só. A chave é o objeto `ctx.db` — único por execução de função, então o memo
 * morre com a transação (WeakMap) e nunca vaza entre transações. Seguro porque
 * nenhum caminho de emissão de evento escreve em `webhooks` na mesma transação
 * (o CRUD de `webhooks.ts` não emite eventos pela porta); se um dia escrever,
 * o memo serviria uma lista velha dentro daquela transação.
 */
const webhooksByDb = new WeakMap<object, Map<string, Doc<"webhooks">[]>>();

async function orgWebhooks(
  db: GenericDatabaseReader<DataModel>,
  organizationId: Id<"organizations">
): Promise<Doc<"webhooks">[]> {
  let perOrg = webhooksByDb.get(db);
  if (!perOrg) {
    perOrg = new Map();
    webhooksByDb.set(db, perOrg);
  }
  const cached = perOrg.get(organizationId);
  if (cached) return cached;
  const rows = await db
    .query("webhooks")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(WEBHOOK_SCAN_LIMIT);
  perOrg.set(organizationId, rows);
  return rows;
}

/**
 * Agenda o disparo do evento SÓ se a org tiver ao menos um webhook ativo que
 * case com ele. Devolve `true` quando agendou.
 */
export async function scheduleWebhookEvent(
  ctx: { db: GenericDatabaseReader<DataModel>; scheduler: Scheduler },
  args: { organizationId: Id<"organizations">; event: string; payload: unknown }
): Promise<boolean> {
  const webhooks = await orgWebhooks(ctx.db, args.organizationId);
  if (!webhooks.some((w) => webhookMatches(w, args.event))) return false;
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: args.organizationId,
    event: args.event,
    payload: args.payload,
  });
  return true;
}
