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

  test("a seção usada existe em Settings.tsx", () => {
    expect(section).toBe("channels");
    expect(read("src/components/Settings.tsx")).toMatch(new RegExp(`\\{\\s*id:\\s*"${section}"`));
  });

  test("o caminho está sob /app/configuracoes, como o roteador do app", () => {
    expect(url.pathname).toBe("/app/configuracoes");
    expect(read("src/main.tsx")).toMatch(/path="\/app"|path:\s*["']\/app["']|\/app/);
    expect(read("src/main.tsx")).toMatch(/configuracoes/);
  });

  test("o frontend lê meta e pendente da URL", () => {
    const channels = read("src/components/settings/ChannelsSection.tsx");
    expect(channels).toMatch(/"meta"/);
    expect(channels).toMatch(/"pendente"/);
  });

  test("o RETURN_PATH gravado no state usa o mesmo caminho", () => {
    expect(read("convex/metaMessaging.ts")).toContain('RETURN_PATH = "/app/configuracoes?secao=channels"');
  });
});
