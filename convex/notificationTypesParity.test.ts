// @vitest-environment node
/**
 * B2: paridade dos tipos de notificação — schema × sino (ícone no front) ×
 * Telegram (template ou ignorado) × formatador `notificationCopy` — e o guard
 * de que todo `createNotification` monta o texto pelo formatador.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import schema from "./schema";
import { COPY_TYPES } from "./lib/notificationCopy";
import { IGNORED_FOR_TELEGRAM, TELEGRAM_TEMPLATES } from "./lib/telegramNotifications";

const schemaTypes = (schema.tables.notifications.validator as any).fields.type.members.map((m: any) => m.value) as string[];
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("paridade de tipos de notificação", () => {
  test("formatador cobre exatamente os tipos do schema", () => {
    expect(sorted(COPY_TYPES)).toEqual(sorted(schemaTypes));
  });

  test("Telegram: todo tipo tem template ou está em IGNORED_FOR_TELEGRAM", () => {
    const decided = new Set([...Object.keys(TELEGRAM_TEMPLATES), ...IGNORED_FOR_TELEGRAM]);
    expect(schemaTypes.filter((t) => !decided.has(t))).toEqual([]);
  });

  test("front: todo tipo tem ícone no sino (NotificationPanel TYPE_ICON)", () => {
    const src = readFileSync(join(__dirname, "../src/components/notifications/NotificationPanel.tsx"), "utf8");
    const block = /const TYPE_ICON[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const keys = [...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
    expect(sorted(keys)).toEqual(sorted(schemaTypes));
  });

  test("preferência: todo tipo tem flag em PREFERENCE_FLAG (lib/notify.ts)", () => {
    const src = readFileSync(join(__dirname, "lib/notify.ts"), "utf8");
    const block = /const PREFERENCE_FLAG[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
    const keys = [...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]);
    expect(sorted(keys)).toEqual(sorted(schemaTypes));
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "_generated" || name === "node_modules") return [];
    if (statSync(p).isDirectory()) return walk(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

describe("guard: texto do sino só pelo formatador", () => {
  test("nenhum createNotification passa title/body literal", () => {
    const offenders: string[] = [];
    for (const file of walk(__dirname)) {
      const text = readFileSync(file, "utf8");
      let i = text.indexOf("createNotification(ctx, {");
      while (i !== -1) {
        // Argumentos até o fechamento `});` da chamada (as chamadas do repo são de topo de bloco).
        const end = text.indexOf("});", i);
        const call = text.slice(i, end);
        if (/\b(title|body):\s*[`"']/.test(call) || /\btitle:\s*[a-zA-Z]/.test(call)) {
          offenders.push(`${relative(__dirname, file)}:${text.slice(0, i).split("\n").length}`);
        }
        i = text.indexOf("createNotification(ctx, {", end);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("arquivos que notificam importam o formatador (ou só repassam um copy pronto)", () => {
    const missing: string[] = [];
    for (const file of walk(__dirname)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("createNotification(ctx, {")) continue;
      if (/\bnotificationCopy\b/.test(text) || /\.\.\.args\.copy/.test(text) || /\.\.\.notification,/.test(text)) continue;
      missing.push(relative(__dirname, file));
    }
    expect(missing).toEqual([]);
  });
});
