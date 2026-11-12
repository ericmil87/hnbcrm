// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Fase 0 de SEO: indexação controlada pelos arquivos servidos na raiz (vercel.json, robots.txt, sitemap.xml).
const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const vercel = JSON.parse(read("vercel.json")) as { headers: HeaderRule[] };

// Vercel casa `source` como regex ancorada; o mesmo critério serve para checar conflitos.
function headersFor(path: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const rule of vercel.headers) {
    if (!new RegExp(`^${rule.source}$`).test(path)) continue;
    for (const h of rule.headers) (out[h.key] ??= []).push(h.value);
  }
  return out;
}

describe("vercel.json: X-Robots-Tag", () => {
  it("área logada (/app/*) e /entrar são noindex, nofollow", () => {
    for (const path of ["/app/painel", "/app/entrada/conversas", "/entrar"]) {
      expect(headersFor(path)["X-Robots-Tag"], path).toEqual(["noindex, nofollow"]);
    }
  });

  it("formulários de clientes (/f/*) são noindex", () => {
    for (const path of ["/f/abc123", "/f/abc123/obrigado"]) {
      expect(headersFor(path)["X-Robots-Tag"], path).toEqual(["noindex"]);
    }
  });

  it("conversa de onboarding (/comecar) é noindex", () => {
    expect(headersFor("/comecar")["X-Robots-Tag"]).toEqual(["noindex"]);
  });

  it("páginas públicas não recebem X-Robots-Tag", () => {
    for (const path of ["/", "/precos", "/developers", "/termos", "/privacidade"]) {
      expect(headersFor(path)["X-Robots-Tag"], path).toBeUndefined();
    }
  });

  it("os headers de segurança existentes continuam valendo em /app e em páginas públicas", () => {
    expect(headersFor("/app/painel")["X-Frame-Options"]).toEqual(["DENY"]);
    expect(headersFor("/precos")["X-Frame-Options"]).toEqual(["DENY"]);
    expect(headersFor("/f/abc123")["X-Frame-Options"]).toBeUndefined();
  });
});

// Lê robots.txt em grupos (User-agent ... linhas até a próxima linha em branco).
function robotsGroups(text: string) {
  const groups: { agents: string[]; rules: string[] }[] = [];
  let current: { agents: string[]; rules: string[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) {
      current = null;
      lastWasAgent = false;
      continue;
    }
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(field)) {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
    } else if (current) {
      current.rules.push(`${field.toLowerCase()}: ${value}`);
      lastWasAgent = false;
    }
  }
  return groups;
}

describe("robots.txt", () => {
  const groups = robotsGroups(read("public/robots.txt"));
  const generic = groups.find((g) => g.agents.includes("*"));
  const aiAgents = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"];

  it("grupo * bloqueia /app/, /entrar e /f/ e libera o resto", () => {
    expect(generic).toBeDefined();
    expect(generic!.rules).toEqual(
      expect.arrayContaining(["allow: /", "disallow: /app/", "disallow: /entrar", "disallow: /f/"]),
    );
  });

  it.each(aiAgents)("%s pode indexar as páginas públicas e segue os mesmos bloqueios", (agent) => {
    const group = groups.find((g) => g.agents.includes(agent));
    expect(group, agent).toBeDefined();
    expect(group!.rules).toEqual(
      expect.arrayContaining(["allow: /", "disallow: /app/", "disallow: /entrar", "disallow: /f/"]),
    );
  });

  it("declara o sitemap", () => {
    expect(read("public/robots.txt")).toMatch(/^Sitemap: https:\/\/hnbcrm\.com\/sitemap\.xml$/m);
  });
});

describe("sitemap.xml", () => {
  const xml = read("public/sitemap.xml");
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const locs = urls.map((u) => u.match(/<loc>([^<]+)<\/loc>/)?.[1]);

  it("lista só as páginas públicas de valor", () => {
    expect(locs.sort()).toEqual(
      [
        "https://hnbcrm.com/",
        "https://hnbcrm.com/precos",
        "https://hnbcrm.com/developers",
        "https://hnbcrm.com/termos",
        "https://hnbcrm.com/privacidade",
      ].sort(),
    );
  });

  it("não inclui o playground", () => {
    expect(xml).not.toMatch(/playground/);
  });

  it("não tem changefreq nem priority", () => {
    expect(xml).not.toMatch(/<changefreq>/);
    expect(xml).not.toMatch(/<priority>/);
  });

  it("todas as URLs têm lastmod 2026-11-11", () => {
    for (const u of urls) {
      expect(u).toMatch(/<lastmod>2026-11-11<\/lastmod>/);
    }
  });
});
