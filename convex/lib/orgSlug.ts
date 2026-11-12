/**
 * Slug (identificador) de organização, derivado do nome. Funções puras, usadas pelo servidor
 * (`createOrganization`) e pelo front (pré-visualização, se houver).
 */
export const ORG_SLUG_MAX = 40;
/** Tentativas `nome`, `nome-2`, … antes de cair no sufixo aleatório. */
export const ORG_SLUG_MAX_ATTEMPTS = 20;

/** Sem acentos, minúsculas, hífens, tamanho máximo. Pode devolver "" (nome só com símbolos). */
export function slugifyOrgName(text: string, max: number = ORG_SLUG_MAX): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/** Base do slug gerado: o nome limpo ou "organizacao" quando nada sobra. */
export function orgSlugBase(name: string): string {
  return slugifyOrgName(name) || "organizacao";
}

/** Candidato da tentativa `attempt` (1 = base; 2.. = base-2..), respeitando o tamanho máximo. */
export function orgSlugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, ORG_SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/** Último recurso: base + 4 caracteres aleatórios (`random` em [0,1), injetável em teste). */
export function orgSlugRandom(base: string, random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  const suffix = `-${s}`;
  return `${base.slice(0, ORG_SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

/** Procura um slug livre; `isTaken` consulta o banco. */
export async function pickFreeOrgSlug(
  name: string,
  isTaken: (slug: string) => Promise<boolean>,
  random: () => number = Math.random,
): Promise<string> {
  const base = orgSlugBase(name);
  for (let attempt = 1; attempt <= ORG_SLUG_MAX_ATTEMPTS; attempt++) {
    const candidate = orgSlugCandidate(base, attempt);
    if (!(await isTaken(candidate))) return candidate;
  }
  return orgSlugRandom(base, random);
}
