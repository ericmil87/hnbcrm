import { describe, expect, test } from "vitest";
import { ORG_SLUG_MAX, ORG_SLUG_MAX_ATTEMPTS, orgSlugBase, orgSlugCandidate, pickFreeOrgSlug, slugifyOrgName } from "./orgSlug";

describe("slugifyOrgName", () => {
  test("sem acentos, minúsculas, hífens", () => {
    expect(slugifyOrgName("Clínica São João & Filhos!")).toBe("clinica-sao-joao-filhos");
    expect(slugifyOrgName("  --Minha   Empresa--  ")).toBe("minha-empresa");
  });
  test("limita o tamanho sem deixar hífen na ponta", () => {
    const s = slugifyOrgName("a".repeat(30) + " " + "b".repeat(30));
    expect(s.length).toBeLessThanOrEqual(ORG_SLUG_MAX);
    expect(s.endsWith("-")).toBe(false);
  });
  test("nome só com símbolos cai em organizacao", () => {
    expect(slugifyOrgName("!!!")).toBe("");
    expect(orgSlugBase("!!!")).toBe("organizacao");
  });
});

describe("pickFreeOrgSlug", () => {
  test("nome livre usa o slug puro", async () => {
    expect(await pickFreeOrgSlug("Acme Ltda", async () => false)).toBe("acme-ltda");
  });
  test("repetido ganha -2, -3", async () => {
    const taken = new Set(["acme", "acme-2"]);
    expect(await pickFreeOrgSlug("Acme", async (s) => taken.has(s))).toBe("acme-3");
  });
  test("esgotadas as tentativas usa sufixo aleatório curto", async () => {
    const slug = await pickFreeOrgSlug("Acme", async (s) => !/-[a-z0-9]{4}$/.test(s) || s === orgSlugCandidate("acme", 2), () => 0.5);
    expect(slug).toMatch(/^acme-[a-z0-9]{4}$/);
    expect(ORG_SLUG_MAX_ATTEMPTS).toBeGreaterThan(2);
  });
  test("candidato respeita o tamanho máximo", () => {
    expect(orgSlugCandidate("x".repeat(ORG_SLUG_MAX), 12).length).toBeLessThanOrEqual(ORG_SLUG_MAX);
  });
});
