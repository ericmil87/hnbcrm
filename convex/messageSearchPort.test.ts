// @vitest-environment node
/**
 * Teste de BUILD da busca sem acento: `messages.searchNorm` (índice
 * `search_norm`) é derivado de content + transcriptText + imageDescription e
 * só fica certo se TODO escritor passar pela porta `lib/messageSearch.ts`.
 *
 *  1. todo `insert("messages", …)` embrulha o documento em `withMessageSearch(`;
 *  2. todo `.patch(` / `.replace(` cujo objeto tem a CHAVE `content`,
 *     `transcriptText` ou `imageDescription` (inline, ou num `const p = {…}`
 *     passado como último argumento) usa `withMessageSearchPatch(`;
 *  3. `searchNorm` só é escrito pela porta e pelo backfill.
 *
 * Patch legítimo de OUTRA tabela com campo `content` entra em ALLOWED com o
 * motivo (arquivo + id patcheado). Limite conhecido: objeto montado em outra
 * função escapa; a revisão continua valendo.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONVEX_DIR = __dirname;

/** "arquivo|primeiro argumento" → motivo. */
const ALLOWED: Record<string, string> = {
  "groupPostWorker.ts|post._id": "groupPosts.content (biblioteca da publicação), não é mensagem",
  "taskComments.ts|args.commentId": "taskComments.content, não é mensagem",
  "groupPosts.ts|post._id": "groupPosts.content (edição da publicação), não é mensagem",
  "campaigns.ts|campaign._id": "campaigns.content (rascunho da campanha), não é mensagem",
  "quickReplies.ts|args.quickReplyId": "quickReplies.content, não é mensagem",
};

const KEY_RE = /(?<![.\w$])["']?(content|transcriptText|imageDescription)["']?\s*(?::|,|\})/;

function sliceBalanced(src: string, openIdx: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return src.slice(openIdx);
}

type Violation = { file: string; line: number; snippet: string };

function findUnwrappedInserts(src: string, file = "<mem>"): Violation[] {
  const out: Violation[] = [];
  const re = /insert\(\s*["']messages["']\s*,\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    if (rest.startsWith("withMessageSearch(")) continue;
    out.push({ file, line: src.slice(0, m.index).split("\n").length, snippet: rest.slice(0, 60) });
  }
  return out;
}

function findUnrefreshedPatches(src: string, file = "<mem>"): Violation[] {
  const out: Violation[] = [];
  const re = /\.(?:patch|replace)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const openIdx = m.index + m[0].length - 1;
    const call = sliceBalanced(src, openIdx, "(", ")");
    if (call.includes("withMessageSearchPatch(")) continue;
    // Regex `.replace(/…/, …)` de string não é escrita no banco.
    if (/^\(\s*\//.test(call) || /^\(\s*["'`]/.test(call)) continue;
    const firstArg = call.slice(1).split(",")[0].trim();
    if (ALLOWED[`${file}|${firstArg}`]) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const snippet = call.replace(/\s+/g, " ").slice(0, 100);
    if (KEY_RE.test(call)) {
      out.push({ file, line, snippet });
      continue;
    }
    const lastArg = /,\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(call.replace(/\s+/g, " ").trim());
    if (!lastArg) continue;
    const name = lastArg[1];
    const before = src.slice(0, m.index);
    const decls = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\b[^=;]*=\\s*\\{`, "g"))];
    const decl = decls.at(-1);
    const literal = decl ? sliceBalanced(before, decl.index! + decl[0].length - 1, "{", "}") : "";
    const reassigned = new RegExp(
      `\\b${name}(?:\\.(?:content|transcriptText|imageDescription)|\\[["'](?:content|transcriptText|imageDescription)["']\\])\\s*=`
    ).test(before);
    if (KEY_RE.test(literal) || reassigned) out.push({ file, line, snippet });
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "_generated" || name === "node_modules" || name === "__fixtures__") continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const files = sourceFiles(CONVEX_DIR).map((full) => ({
  rel: path.relative(CONVEX_DIR, full).split(path.sep).join("/"),
  src: readFileSync(full, "utf8"),
}));

describe("porta de messages.searchNorm (busca sem acento)", () => {
  test("a heurística pega insert sem a porta e patch de content sem refresh", () => {
    expect(findUnwrappedInserts(`await ctx.db.insert("messages", { content: "x" });`)).toHaveLength(1);
    expect(findUnwrappedInserts(`await ctx.db.insert("messages", withMessageSearch({ content: "x" }));`)).toHaveLength(0);
    expect(findUnrefreshedPatches(`await ctx.db.patch(m._id, { content: "x" });`)).toHaveLength(1);
    expect(findUnrefreshedPatches(`await ctx.db.patch(m._id, { transcriptText });`)).toHaveLength(1);
    expect(
      findUnrefreshedPatches(`const p = { imageDescription: undefined };\nawait ctx.db.patch(m._id, p);`)
    ).toHaveLength(1);
    expect(findUnrefreshedPatches(`await ctx.db.patch(m._id, { readBy, deliveryStatus: "read" });`)).toHaveLength(0);
    expect(findUnrefreshedPatches(`s.replace(/x/g, (content: string) => content)`)).toHaveLength(0);
    expect(
      findUnrefreshedPatches(`await ctx.db.patch(m._id, withMessageSearchPatch(m, { content: "x" }));`)
    ).toHaveLength(0);
  });

  test("todo insert de mensagem passa por withMessageSearch", () => {
    const violations = files.flatMap((f) => findUnwrappedInserts(f.src, f.rel));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("todo patch de content/transcriptText/imageDescription recalcula searchNorm", () => {
    const violations = files.flatMap((f) => findUnrefreshedPatches(f.src, f.rel));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  test("o índice search_contacts só é consultado por searchContactsByText (termo dobrado)", () => {
    const users = files
      .filter((f) => /withSearchIndex\(\s*["']search_contacts["']/.test(f.src))
      .map((f) => f.rel);
    expect(users).toEqual(["lib/contactTextSearch.ts"]);
  });

  test("searchNorm só é escrito pela porta e pelo backfill", () => {
    // Escrita = chave `searchNorm:` ou atribuição; desestruturação para tirar
    // o campo da resposta (`const { searchNorm: _x, ...rest }`) não conta.
    const writes = (src: string) =>
      src
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*)/.test(l) && !/const\s*\{/.test(l))
        .some((l) => /\bsearchNorm\s*(?::|=)(?!=)/.test(l));
    const writers = files
      .filter((f) => writes(f.src))
      .map((f) => f.rel)
      .filter((rel) => rel !== "schema.ts");
    expect(writers.sort()).toEqual(["lib/messageSearch.ts", "opsSearchFold.ts"]);
  });
});
