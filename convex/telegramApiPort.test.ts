// @vitest-environment node
/**
 * Teste de BUILD da porta única do Telegram (D13): só `lib/telegramApi.ts`
 * fala com a Bot API e só ele lê o token. Um `fetch` para api.telegram.org em
 * outro arquivo pularia o tratamento de 429/403, o no-op sem token do DEV
 * (D14) e a regra de nunca logar o token (ele vai na URL).
 *
 * Proibido fora da porta (em código E comentário — a regra é simples de propósito):
 *  - o host `telegram.org` (api.telegram.org, inclusive montado em string);
 *  - o nome da env `TELEGRAM_BOT_TOKEN`.
 * `opsTelegram.ts` pode ler `TELEGRAM_BOT_USERNAME`/`TELEGRAM_WEBHOOK_SECRET`
 * (não são o token) e chama apenas os wrappers da porta.
 *
 * O link público `https://t.me/<bot>` não é a Bot API e não é proibido.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const PORT = "lib/telegramApi.ts";
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "host da Bot API", re: /telegram\.org/gi },
  { name: "token do bot", re: /\bTELEGRAM_BOT_TOKEN\b/g },
];

function findHits(src: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of FORBIDDEN) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) hits.push(`${src.slice(0, m.index).split("\n").length}: ${name} (${m[0]})`);
  }
  return hits;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "__fixtures__" || entry === "node_modules") continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

const rel = (abs: string) => path.relative(CONVEX_DIR, abs).split(path.sep).join("/");

describe("heurística (auto-teste)", () => {
  test("pega host e token em qualquer forma", () => {
    expect(findHits(`await fetch("https://api.telegram.org/bot" + t + "/sendMessage")`)).toHaveLength(1);
    expect(findHits("const u = `https://api.TELEGRAM.org/bot${x}`;")).toHaveLength(1);
    expect(findHits(`const t = process.env.TELEGRAM_BOT_TOKEN;`)).toHaveLength(1);
    expect(findHits(`process.env["TELEGRAM_BOT_TOKEN"]`)).toHaveLength(1);
  });
  test("não pega o deep link público nem as outras envs", () => {
    expect(findHits(`https://t.me/hnbcrm_bot?start=abc`)).toEqual([]);
    expect(findHits(`process.env.TELEGRAM_BOT_USERNAME; process.env.TELEGRAM_WEBHOOK_SECRET`)).toEqual([]);
  });
});

describe("porta única da Bot API", () => {
  test("nada fora de lib/telegramApi.ts fala com telegram.org ou lê o token", () => {
    const violations: string[] = [];
    for (const abs of walk(CONVEX_DIR)) {
      const r = rel(abs);
      if (r === PORT) continue;
      for (const hit of findHits(readFileSync(abs, "utf8"))) violations.push(`${r}:${hit}`);
    }
    expect(
      violations,
      "A Bot API do Telegram só pode ser chamada por convex/lib/telegramApi.ts (porta única, D13): " +
        "ela trata 429/403, vira no-op sem token no DEV e nunca loga o token.",
    ).toEqual([]);
  });

  test("controle positivo: a porta tem o host e o token", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    expect(src).toMatch(/https:\/\/api\.telegram\.org/);
    expect(src).toMatch(/process\.env\.TELEGRAM_BOT_TOKEN/);
  });

  test("a porta nunca loga a URL nem o token", () => {
    const src = readFileSync(path.join(CONVEX_DIR, PORT), "utf8");
    const logLines = src.split("\n").filter((l) => /console\.(log|warn|error|info|debug)\(/.test(l));
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      expect(line, line).not.toMatch(/\btoken\b|API_BASE|\burl\b|params|description|chat_id|text/i);
    }
  });

  test("os módulos do Telegram usam os wrappers da porta", () => {
    for (const r of ["telegram.ts", "opsTelegram.ts"]) {
      const src = readFileSync(path.join(CONVEX_DIR, r), "utf8");
      expect(src, r).toMatch(/from\s*["']\.\/lib\/telegramApi["']/);
      expect(src, r).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
