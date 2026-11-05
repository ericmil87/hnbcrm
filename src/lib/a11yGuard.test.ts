// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Guarda de acessibilidade dos controles (analisa o JSX de `src/components`):
 * 1. `<button>` / `<Button iconOnly>` cujo conteúdo é só um ícone do lucide precisa de `aria-label`
 *    (ou `aria-labelledby`);
 * 2. `title=` não é permitido em `<button>`, `<Button>`, `<a>`, `<Link>` e `<input>` dentro de
 *    layout/ ui/ inbox/ funnel/ settings/: use `Tooltip` (dica) ou `aria-label` (nome).
 *    `title` continua válido em TEXTO truncado.
 *
 * Exceções pontuais ("arquivo:tag:ordem" na ocorrência do arquivo) com motivo; máximo de 15.
 */
const SRC = resolve(__dirname, "..");
const TITLE_SCOPE = ["components/layout/", "components/ui/", "components/inbox/", "components/funnel/", "components/settings/"];
const TITLE_TAGS = new Set(["button", "Button", "a", "Link", "input"]);

const ALLOWLIST: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

function attrNames(attrs: ts.JsxAttributes): Set<string> {
  const names = new Set<string>();
  for (const a of attrs.properties) {
    if (ts.isJsxSpreadAttribute(a)) names.add("...spread");
    else names.add(a.name.getText());
  }
  return names;
}

function scan(file: string) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lucide = new Set<string>();
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && (n.moduleSpecifier as ts.StringLiteral).text === "lucide-react") {
      const nb = n.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) nb.elements.forEach((e) => lucide.add(e.name.text));
    }
  });
  const rel = relative(SRC, file).split(sep).join("/");
  const issues: { key: string; msg: string }[] = [];
  const counters: Record<string, number> = {};

  const isIcon = (n: ts.Node): boolean => {
    if (ts.isJsxSelfClosingElement(n)) return lucide.has(n.tagName.getText());
    // `{cond ? <Icon/> : <Icon2/>}` ou `{<Icon/>}`
    if (ts.isJsxExpression(n) && n.expression) {
      const e = n.expression;
      if (ts.isConditionalExpression(e)) return [e.whenTrue, e.whenFalse].every((b) => isIconExpr(b));
      return isIconExpr(e);
    }
    return false;
  };
  const isIconExpr = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isJsxSelfClosingElement(e)) return lucide.has(e.tagName.getText());
    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText();
      const attrs = attrNames(opening.attributes);
      const line = sf.getLineAndCharacterOfPosition(opening.getStart()).line + 1;
      counters[tag] = (counters[tag] ?? 0) + 1;
      const key = `${rel}:${tag}:${counters[tag]}`;

      const iconOnlyButton = tag === "button" || (tag === "Button" && attrs.has("iconOnly"));
      if (iconOnlyButton && ts.isJsxElement(node)) {
        const kids = node.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
        const onlyIcons = kids.length > 0 && kids.every(isIcon);
        const named = attrs.has("aria-label") || attrs.has("aria-labelledby") || attrs.has("...spread");
        if (onlyIcons && !named) issues.push({ key, msg: `${rel}:${line} — <${tag}> só com ícone sem aria-label` });
      }
      if (TITLE_TAGS.has(tag) && attrs.has("title") && TITLE_SCOPE.some((s) => rel.startsWith(s))) {
        issues.push({ key, msg: `${rel}:${line} — title= em <${tag}> (use Tooltip ou aria-label)` });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return issues;
}

describe("a11yGuard", () => {
  const all = walk(resolve(SRC, "components")).flatMap(scan);
  const unexpected = all.filter((i) => !(i.key in ALLOWLIST));

  it("controles só com ícone têm nome acessível e controles não usam title=", () => {
    expect(unexpected.map((i) => i.msg)).toEqual([]);
  });

  it("allowlist pequena, com motivo e sem entradas obsoletas", () => {
    const keys = Object.keys(ALLOWLIST);
    expect(keys.length).toBeLessThanOrEqual(15);
    for (const k of keys) {
      expect(ALLOWLIST[k].length, k).toBeGreaterThan(10);
      expect(all.some((i) => i.key === k), `entrada obsoleta ${k}`).toBe(true);
    }
  });
});
