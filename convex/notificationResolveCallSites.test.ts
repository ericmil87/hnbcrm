// @vitest-environment node
/**
 * Guard B1: quem resolve o assunto de uma notificação passa pela porta
 * `resolveEntityNotifications` (convex/lib/notificationResolve.ts) — nenhum
 * ponto "limpa" o sino por conta própria e nenhum ponto novo fica de fora.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

/** Corpo de `[export] [async] function name` até a próxima declaração de topo. */
function bodyOf(file: string, name: string): string {
  const text = src(file);
  const m = new RegExp(`(?:export )?(?:async )?function ${name}\\b`).exec(text);
  if (!m) throw new Error(`${name} não encontrado em ${file}`);
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/\n(?:export |async function |function |const [a-zA-Z]+ = )/);
  return next === -1 ? rest : rest.slice(0, next);
}

const CALLS = /resolveEntityNotifications\(/;

describe("call sites da porta resolveEntityNotifications", () => {
  const cases: Array<[string, string, string]> = [
    ["aceitar pedido de ajuda", "handoffs.ts", "acceptHandoffCore"],
    ["rejeitar pedido de ajuda", "handoffs.ts", "rejectHandoffCore"],
    ["aprovar rascunho", "attendant.ts", "acceptAiDraftCore"],
    ["descartar rascunho", "attendant.ts", "discardAiDraftCore"],
    ["regenerar rascunho", "attendant.ts", "requestAiDraftCore"],
    ["devolver à IA (cancela repasse)", "attendant.ts", "returnToAiCore"],
    ["concluir tarefa", "lib/taskOps.ts", "applyTaskCompletion"],
  ];
  for (const [label, file, fn] of cases) {
    test(label, () => {
      expect(bodyOf(file, fn)).toMatch(CALLS);
    });
  }

  test("abrir/marcar conversa como lida", () => {
    const text = src("conversations.ts");
    const i = text.indexOf("export const markConversationRead");
    expect(i).toBeGreaterThan(-1);
    expect(text.slice(i, i + 1500)).toMatch(CALLS);
  });

  test("excluir tarefa: todo delete de task passa por resolveTaskNotifications", () => {
    const text = src("tasks.ts");
    const deletes = text.match(/await ctx\.db\.delete\((?:args\.taskId|task\._id)\);/g) ?? [];
    const resolves = text.match(/await resolveTaskNotifications\(ctx, task, "task_deleted"\);/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    expect(resolves.length).toBe(deletes.length);
  });

  test("reconectar canal (bridge e Meta)", () => {
    expect(src("channelConfigs.ts")).toMatch(/target: \{ channelId: args\.configId \}/);
    expect(src("metaMessaging.ts")).toMatch(/target: \{ metaConnectionId/);
  });

  test("Telegram não marca readAt à mão: usa a porta", () => {
    const text = src("lib/telegramActions.ts");
    expect(text).toMatch(CALLS);
    expect(text).not.toMatch(/patch\(n\._id, \{ readAt/);
  });

  test("dedupe do rascunho (attendant e groupAgent) exige rascunho ainda pendente", () => {
    expect(src("attendant.ts")).toMatch(/draftNotificationAlreadyPending\(/);
    expect(src("groupAgent.ts")).toMatch(/draftNotificationAlreadyPending\(/);
  });

  test("destinatário vivo: createNotification recusa revogado/sem userId; removeTeamMember limpa", () => {
    expect(src("lib/notify.ts")).toMatch(/isMembershipRevoked\(member\) \|\| !member\.userId/);
    expect(src("teamMembers.ts")).toMatch(/markMemberNotificationsRead\(/);
  });
});
