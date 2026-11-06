// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Guarda de chaves entre irmãos fixos no JSX (analisa `src/components` e `src/pages`).
 *
 * Quando dois elementos IRMÃOS de uma lista fixa de filhos (não um `.map`) recebem `key`, o
 * valor precisa ser distinto em tempo de execução. Duas chaves iguais (`key={conversa._id}` no
 * cabeçalho e `key={selectedConversation}` no composer, mesmo id) fazem o React perder o rastro
 * de um dos irmãos: ao trocar de conversa o antigo nunca é desmontado e os cabeçalhos
 * empilham. Por isso, entre irmãos com `key`, no máximo um pode ter chave sem texto estático
 * (`key={id}`); os demais usam literal ou template com texto próprio (`key={\`header:${id}\`}`),
 * e o formato estático (`header:*`) não pode se repetir.
 */
const SRC = resolve(__dirname, "..");
const ROOTS = ["components", "pages"].map((d) => join(SRC, d));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Elementos que um filho JSX pode render direto (atravessa `{a ? <X/> : <Y/>}` e `{a && <X/>}`). */
function directElements(node: ts.Node): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return [node];
  if (ts.isParenthesizedExpression(node)) return directElements(node.expression);
  if (ts.isJsxExpression(node)) return node.expression ? directElements(node.expression) : [];
  if (ts.isConditionalExpression(node)) return [...directElements(node.whenTrue), ...directElements(node.whenFalse)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return directElements(node.right);
  }
  return [];
}

function keyOf(el: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttribute | undefined {
  const attrs = ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes;
  return attrs.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === "key");
}

/** Formato estático da chave (`header:*`), ou null quando ela é uma expressão sem texto fixo. */
function staticShape(attr: ts.JsxAttribute): string | null {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      const shape = e.head.text + e.templateSpans.map((s) => "*" + s.literal.text).join("");
      return shape.replace(/\*/g, "") ? shape : null;
    }
  }
  return null;
}

function scan(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const rel = relative(SRC, file).split(sep).join("/");
  const issues: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // Cada filho fixo é uma posição; um ternário ocupa uma posição só (seus ramos não são irmãos).
      const keyed = node.children.flatMap((child) =>
        directElements(child)
          .map((el) => ({ el, attr: keyOf(el) }))
          .filter((x): x is { el: ts.JsxElement | ts.JsxSelfClosingElement; attr: ts.JsxAttribute } => !!x.attr)
          .slice(0, 1)
      );
      if (keyed.length >= 2) {
        const seen = new Map<string, number>();
        const bare = keyed.filter(({ attr }) => staticShape(attr) === null);
        for (const { attr } of keyed) {
          const line = sf.getLineAndCharacterOfPosition(attr.getStart()).line + 1;
          const shape = staticShape(attr);
          if (shape === null) {
            if (bare.length >= 2) {
              issues.push(`${rel}:${line} — ${attr.getText()} entre irmãos com key: use um prefixo próprio (\`header:\${id}\`)`);
            }
          } else if (seen.has(shape)) {
            issues.push(`${rel}:${line} — formato de key "${shape}" repetido (linha ${seen.get(shape)})`);
          } else seen.set(shape, line);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return issues;
}

describe("chaves entre irmãos fixos no JSX", () => {
  it("irmãos com key têm prefixos estáticos distintos (senão o React empilha o irmão antigo)", () => {
    const issues = ROOTS.flatMap((root) => walk(root)).flatMap(scan);
    expect(issues).toEqual([]);
  });
});
