/**
 * Teste de BUILD da porta de `conversations.unreadCount`/`hasUnread`: todo
 * `patch`/`replace`/`insert`/`Object.assign` que escreve o contador usa
 * `...unreadFields(n)` (lib/unreadFields.ts). Escrever `unreadCount:` direto
 * deixa a flag `hasUnread` (índice do chip "Não lidas" por tempo) fora de
 * sincronia. Heurística por leitura dos fontes (como leadStageMovePort.test.ts).
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;
const KEY_RE = /(?<![.\w$])["']?unreadCount["']?\s*(?::|,|\})/;

function sliceBalanced(src: string, openIdx: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return src.slice(openIdx);
}

function findUnreadWrites(src: string, file = "<mem>") {
  const out: { file: string; line: number; snippet: string }[] = [];
  const re = /(?:\.(?:patch|replace|insert)|Object\.assign)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const call = sliceBalanced(src, m.index + m[0].length - 1, "(", ")");
    const line = src.slice(0, m.index).split("\n").length;
    const snippet = call.replace(/\s+/g, " ").slice(0, 100);
    if (KEY_RE.test(call)) { out.push({ file, line, snippet }); continue; }
    const lastArg = /,\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(call.replace(/\s+/g, " ").trim());
    if (!lastArg) continue;
    const name = lastArg[1];
    const before = src.slice(0, m.index);
    const decl = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*\\{`, "g"))].at(-1);
    const literal = decl ? sliceBalanced(before, decl.index! + decl[0].length - 1, "{", "}") : "";
    const assigned = new RegExp(`\\b${name}(?:\\.unreadCount|\\[["']unreadCount["']\\])\\s*=`).test(before);
    if (KEY_RE.test(literal) || assigned) out.push({ file, line, snippet });
  }
  return out;
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

describe("porta de unreadCount/hasUnread", () => {
  test("heurística (auto-teste)", () => {
    expect(findUnreadWrites(`ctx.db.patch(id, { unreadCount: 0, lastReadAt })`)).toHaveLength(1);
    expect(findUnreadWrites(`ctx.db.insert("conversations", {\n a: 1,\n unreadCount: 0 })`)).toHaveLength(1);
    expect(findUnreadWrites(`Object.assign(patch, { unreadCount })`)).toHaveLength(1);
    expect(findUnreadWrites(`const p = { unreadCount: 1 };\nawait ctx.db.patch(id, p);`)).toHaveLength(1);
    expect(findUnreadWrites(`ctx.db.patch(id, { ...unreadFields(0), lastReadAt })`)).toHaveLength(0);
    expect(findUnreadWrites(`ctx.db.patch(id, { x: c.unreadCount })`)).toHaveLength(0);
  });

  test("nenhuma escrita de unreadCount fora da porta", () => {
    const bad = walk(CONVEX_DIR).flatMap((full) =>
      findUnreadWrites(readFileSync(full, "utf8"), path.relative(CONVEX_DIR, full))
    );
    expect(bad).toEqual([]);
  });
});
