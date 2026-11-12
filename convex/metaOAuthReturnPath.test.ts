// @vitest-environment node
/**
 * Build guard: a URL de retorno do OAuth da Meta tem de cair numa rota e numa
 * seção que EXISTEM no app (rotas sob /app; seção de canais = id "channels").
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { redirectUrlFor } from "./lib/metaOAuth";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("retorno do OAuth da Meta aponta para uma tela real", () => {
  const url = new URL(redirectUrlFor("https://app.example.test", "ok"));
  const section = url.searchParams.get("secao");

  test("a seção usada existe no registro de Configurações", () => {
    expect(section).toBe("channels");
    expect(read("src/components/settings/registry.ts")).toMatch(new RegExp(`\\{\\s*id:\\s*"${section}"`));
  });

  test("o painel de canais tem componente e nenhuma regra de visibilidade extra", () => {
    const registry = read("src/components/settings/registry.ts");
    const start = registry.indexOf('id: "channels"');
    const block = registry.slice(start, registry.indexOf("\n  },", start));
    expect(block).toMatch(/Component:/);
    expect(block).not.toMatch(/visible:/);
  });

  test("o caminho está sob /app/configuracoes, como o roteador do app", () => {
    expect(url.pathname).toBe("/app/configuracoes");
    // The route table lives in src/appRoutes.tsx (shared by main.tsx and the build-time prerender).
    expect(read("src/appRoutes.tsx")).toMatch(/path="\/app"|path:\s*["']\/app["']|\/app/);
    expect(read("src/appRoutes.tsx")).toMatch(/configuracoes/);
  });

  test("o frontend lê meta e pendente da URL", () => {
    const channels = read("src/components/settings/channels/ChannelsPanel.tsx");
    expect(channels).toMatch(/"meta"/);
    expect(channels).toMatch(/"pendente"/);
  });

  test("o RETURN_PATH gravado no state usa o mesmo caminho", () => {
    expect(read("convex/metaMessaging.ts")).toContain('RETURN_PATH = "/app/configuracoes?secao=channels"');
  });
});
