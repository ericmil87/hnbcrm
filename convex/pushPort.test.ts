// @vitest-environment node
/**
 * Teste de BUILD da porta única do Web Push (E1): só `pushNode.ts` importa
 * `web-push`, lê a chave privada/assunto VAPID e fala com o serviço de push.
 * A chave PÚBLICA também pode ser lida por `push.ts` (`getVapidPublicKey`).
 * Só o dispatcher (`lib/notificationChannels.ts`) e o reenvio em `push.ts`
 * agendam `internal.push.internalDeliverPush`; só `push.ts` agenda o envio.
 *
 * Proibido fora da porta (código E comentário — a regra é simples de propósito).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "__fixtures__" || entry === "node_modules") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(p);
  }
  return acc;
}

const files = () => walk(CONVEX_DIR).map((p) => ({ rel: path.relative(CONVEX_DIR, p), src: readFileSync(p, "utf8") }));

const RULES: { name: string; re: RegExp; allowed: string[] }[] = [
  { name: "import de web-push", re: /from\s+["']web-push["']|require\(\s*["']web-push["']\s*\)/g, allowed: ["pushNode.ts"] },
  { name: "VAPID_PRIVATE_KEY", re: /\bVAPID_PRIVATE_KEY\b/g, allowed: ["pushNode.ts"] },
  { name: "VAPID_SUBJECT", re: /\bVAPID_SUBJECT\b/g, allowed: ["pushNode.ts"] },
  { name: "VAPID_PUBLIC_KEY", re: /\bVAPID_PUBLIC_KEY\b/g, allowed: ["pushNode.ts", "push.ts"] },
  { name: "envio (internal.pushNode)", re: /internal\.pushNode\./g, allowed: ["push.ts"] },
  {
    name: "agendamento da entrega (internal.push.internalDeliverPush)",
    re: /internal\.push\.internalDeliverPush\b/g,
    allowed: ["lib/notificationChannels.ts", "push.ts"],
  },
];

describe("porta única do Web Push", () => {
  for (const rule of RULES) {
    test(`${rule.name} só em ${rule.allowed.join(", ")}`, () => {
      const offenders: string[] = [];
      for (const { rel, src } of files()) {
        if (rule.allowed.includes(rel.split(path.sep).join("/"))) continue;
        rule.re.lastIndex = 0;
        if (rule.re.test(src)) offenders.push(rel);
      }
      expect(offenders).toEqual([]);
    });
  }

  test("pushNode.ts é \"use node\" e não exporta query/mutation", () => {
    const src = readFileSync(path.join(CONVEX_DIR, "pushNode.ts"), "utf8");
    expect(src.startsWith('"use node";')).toBe(true);
    expect(src).not.toMatch(/\b(internalMutation|internalQuery|mutation|query)\(/);
  });

  test("createNotification passa pelo dispatcher (Telegram/push/e-mail não saem direto de notify.ts)", () => {
    const notify = readFileSync(path.join(CONVEX_DIR, "lib/notify.ts"), "utf8");
    expect(notify).toMatch(/dispatchNotificationChannels\(/);
    expect(notify).not.toMatch(/internal\.telegram\.internalDeliverNotification/);
  });

  test("e-mail de rede de segurança: call sites dos tipos da escada não agendam dispatchNotification direto", () => {
    const SAFETY_NET = ["handoffRequested", "taskAssigned", "taskDueSoon", "taskOverdue", "taskOverdueSummary", "taskCommentMention"];
    const offenders: string[] = [];
    for (const { rel, src } of files()) {
      if (rel.endsWith("notificationChannels.ts") || rel.endsWith("email.ts") || rel.endsWith("emailTemplates.ts")) continue;
      const re = /runAfter\([^,]+,\s*internal\.email\.dispatchNotification,\s*\{[\s\S]{0,400}?eventType:\s*"(\w+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) if (SAFETY_NET.includes(m[1])) offenders.push(`${rel}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});
