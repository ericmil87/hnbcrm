/**
 * Triagem de "Importar contatos do celular" (PR6). PURO: monta as linhas a
 * partir do .vcf lido (`vcard.ts`), normaliza telefones com a regra única do
 * backend (`convex/lib/phone.ts`, DDI padrão da org), junta repetidos do
 * arquivo, sugere "Pessoal" para parentes e monta o envio só com as linhas
 * escolhidas (minimização: o resto do arquivo nunca sai do navegador).
 */
import { formatPhoneForDisplay, normalizeCampaignPhone, phoneLookupCandidates } from "../../convex/lib/phone";
import type { VCardContact } from "./vcard";

export const TRIAGE_CHOICES = ["lead", "personal", "team", "supplier", "partner", "skip"] as const;
export type TriageChoice = (typeof TRIAGE_CHOICES)[number];
/** Escolha que vira contato no CRM ("skip" = não importar). */
export type ImportChoice = Exclude<TriageChoice, "skip">;

export const TRIAGE_CHOICE_LABEL: Record<TriageChoice, string> = {
  lead: "Lead",
  personal: "Pessoal",
  team: "Equipe",
  supplier: "Fornecedor",
  partner: "Parceiro",
  skip: "Não importar",
};

const MAX_PHONES = 5;
const MAX_EMAILS = 3;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TriageRow {
  /** Chave estável na sessão (ordem no arquivo). */
  key: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
  /** E.164 sem "+", celular primeiro, sem repetição. */
  phones: string[];
  emails: string[];
  company?: string;
  title?: string;
  /** Nome parece de parente (mãe, tio, sobrenome do dono…): sugerido como Pessoal. */
  familyHint: boolean;
}

export interface TriageBuildResult {
  rows: TriageRow[];
  /** Contatos lidos do arquivo. */
  total: number;
  /** Sem telefone válido nem e-mail (ficam de fora). */
  withoutContact: number;
  /** Entradas juntadas com outra do mesmo arquivo (mesmo telefone ou e-mail). */
  merged: number;
}

/** Minúsculas sem acento (comparação de nomes). */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Palavras de parentesco/afeto (sem acento) que sugerem contato pessoal. */
const FAMILY_WORDS = new Set([
  "mae", "mamae", "mainha", "pai", "papai", "painho",
  "vo", "vovo", "avo", "avos", "vozinha", "vozinho",
  "tio", "tia", "titio", "titia",
  "filho", "filha", "filhao", "filhota",
  "irmao", "irma", "mano", "mana", "maninho", "maninha",
  "esposa", "esposo", "marido", "mulher", "amor", "mozao", "mozinho", "namorada", "namorado", "noiva", "noivo",
  "primo", "prima", "sobrinho", "sobrinha", "neto", "neta",
  "sogra", "sogro", "cunhado", "cunhada", "genro", "nora",
  "madrinha", "padrinho", "afilhado", "afilhada", "dinda", "dindo",
]);

/** Palavras de negócio: "Mãe Terra Restaurante", "Pai Inácio Pousada" não são família. */
const BUSINESS_WORDS = new Set([
  "restaurante", "pousada", "hotel", "loja", "bar", "lanchonete", "padaria", "mercado", "supermercado",
  "farmacia", "clinica", "oficina", "studio", "estudio", "salao", "barbearia", "academia", "escola",
  "imobiliaria", "advocacia", "consultoria", "distribuidora", "comercio", "servicos", "ltda", "eireli", "me",
  "pizzaria", "acai", "pet", "petshop", "construtora", "auto", "pecas", "transportes", "turismo", "delivery",
  "atacado", "moveis", "cafe", "cafeteria", "boutique", "store", "shop",
]);

function nameTokens(name: string): string[] {
  return foldText(name)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Nome sugere parente: palavra de parentesco inteira, ou o sobrenome de quem
 * importa/do dono depois do primeiro nome. Nome com palavra de negócio nunca.
 */
export function suggestsFamily(name: string | undefined, surnames: readonly string[] = []): boolean {
  if (!name) return false;
  const tokens = nameTokens(name);
  if (tokens.length === 0) return false;
  if (tokens.some((t) => BUSINESS_WORDS.has(t))) return false;
  if (tokens.some((t) => FAMILY_WORDS.has(t))) return true;
  const folded = surnames.map((s) => foldText(s.trim())).filter((s) => s.length >= 3);
  return tokens.slice(1).some((t) => folded.includes(t));
}

/** Celular antes de fixo; "pref" antes do resto. */
function phoneRank(types: string[]): number {
  let rank = 2;
  if (types.includes("cell") || types.includes("mobile") || types.includes("iphone")) rank = 0;
  else if (types.includes("main") || types.includes("pref")) rank = 1;
  else if (types.includes("fax") || types.includes("pager")) rank = 3;
  return rank;
}

function splitFullName(fullName: string): { firstName?: string; lastName?: string } {
  const tokens = fullName.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return {};
  return { firstName: tokens[0], lastName: tokens.slice(1).join(" ") || undefined };
}

class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/**
 * Monta as linhas da triagem: normaliza telefones (DDI padrão da org),
 * descarta quem não tem telefone nem e-mail e junta entradas repetidas do
 * arquivo (mesmo telefone, inclusive a outra grafia do 9º dígito, ou e-mail).
 */
export function buildTriageRows(
  contacts: readonly VCardContact[],
  defaultCountry: string,
  surnames: readonly string[] = [],
): TriageBuildResult {
  type Prepared = {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    phones: string[];
    emails: string[];
    company?: string;
    title?: string;
  };
  const prepared: Prepared[] = [];
  let withoutContact = 0;

  for (const contact of contacts) {
    const ranked = contact.phones
      .map((p, index) => ({ p, index, rank: phoneRank(p.types) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index);
    const phones: string[] = [];
    for (const { p } of ranked) {
      const normalized = normalizeCampaignPhone(p.value, defaultCountry);
      if (normalized.ok && !phones.includes(normalized.phone)) phones.push(normalized.phone);
    }
    const emails: string[] = [];
    for (const e of contact.emails) {
      const email = e.value.trim().toLowerCase();
      if (EMAIL_RE.test(email) && !emails.includes(email)) emails.push(email);
    }
    if (phones.length === 0 && emails.length === 0) {
      withoutContact++;
      continue;
    }
    const fromFull = contact.fullName ? splitFullName(contact.fullName) : {};
    const firstName = contact.firstName ?? (contact.lastName ? undefined : fromFull.firstName);
    const lastName = contact.lastName ?? (contact.firstName ? undefined : fromFull.lastName);
    prepared.push({
      fullName: contact.fullName,
      firstName,
      lastName,
      phones,
      emails,
      company: contact.org,
      title: contact.title,
    });
  }

  // Junta repetidos (telefone com as duas grafias do 9º dígito, ou e-mail).
  const uf = new UnionFind(prepared.length);
  const seen = new Map<string, number>();
  prepared.forEach((row, index) => {
    const keys = [
      ...row.phones.flatMap((p) => phoneLookupCandidates(p).map((c) => `p:${c}`)),
      ...row.emails.map((e) => `e:${e}`),
    ];
    for (const key of keys) {
      const other = seen.get(key);
      if (other === undefined) seen.set(key, index);
      else uf.union(other, index);
    }
  });

  const groups = new Map<number, Prepared[]>();
  prepared.forEach((row, index) => {
    const root = uf.find(index);
    groups.set(root, [...(groups.get(root) ?? []), row]);
  });

  const rows: TriageRow[] = [];
  for (const [root, members] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
    const named = members.find((m) => m.fullName || m.firstName || m.lastName) ?? members[0];
    const phones: string[] = [];
    const emails: string[] = [];
    for (const m of members) {
      for (const p of m.phones) {
        const variants = phoneLookupCandidates(p);
        if (!phones.some((existing) => variants.includes(existing))) phones.push(p);
      }
      for (const e of m.emails) if (!emails.includes(e)) emails.push(e);
    }
    const company = members.find((m) => m.company)?.company;
    const title = members.find((m) => m.title)?.title;
    const personName = named.fullName ?? ([named.firstName, named.lastName].filter(Boolean).join(" ") || undefined);
    const displayName = personName ?? company ?? (phones[0] ? formatPhoneForDisplay(phones[0]) : emails[0]);
    rows.push({
      key: `r${root}`,
      displayName,
      firstName: named.firstName ?? (personName ? undefined : company),
      lastName: named.lastName,
      phones: phones.slice(0, MAX_PHONES),
      emails: emails.slice(0, MAX_EMAILS),
      company,
      title,
      familyHint: suggestsFamily(personName, surnames),
    });
  }

  return { rows, total: contacts.length, withoutContact, merged: prepared.length - rows.length };
}

/** Busca na triagem: nome, empresa, e-mail ou dígitos do telefone. */
export function filterTriageRows(rows: readonly TriageRow[], query: string): TriageRow[] {
  const q = foldText(query.trim());
  if (!q) return [...rows];
  const digits = q.replace(/\D+/g, "");
  return rows.filter((row) => {
    if (foldText(row.displayName).includes(q)) return true;
    if (row.company && foldText(row.company).includes(q)) return true;
    if (row.emails.some((e) => e.includes(q))) return true;
    return digits.length >= 3 && row.phones.some((p) => p.includes(digits));
  });
}

/** Escolha inicial: parente sugerido = Pessoal; o resto fica a decidir. */
export function initialChoices(rows: readonly TriageRow[]): Record<string, TriageChoice> {
  const out: Record<string, TriageChoice> = {};
  for (const row of rows) if (row.familyHint) out[row.key] = "personal";
  return out;
}

export interface ImportPayloadRow {
  firstName?: string;
  lastName?: string;
  phones: string[];
  emails: string[];
  company?: string;
  title?: string;
  choice: ImportChoice;
}

/** Só as linhas com escolha que importa (nada de "Não importar" nem "a decidir"). */
export function buildImportPayload(
  rows: readonly TriageRow[],
  choices: Readonly<Record<string, TriageChoice | undefined>>,
): ImportPayloadRow[] {
  const out: ImportPayloadRow[] = [];
  for (const row of rows) {
    const choice = choices[row.key];
    if (!choice || choice === "skip") continue;
    out.push({
      ...(row.firstName ? { firstName: row.firstName } : {}),
      ...(row.lastName ? { lastName: row.lastName } : {}),
      phones: row.phones,
      emails: row.emails,
      ...(row.company ? { company: row.company } : {}),
      ...(row.title ? { title: row.title } : {}),
      choice,
    });
  }
  return out;
}

/** Contagem por escolha (resumo do botão "Importar"). */
export function countChoices(
  rows: readonly TriageRow[],
  choices: Readonly<Record<string, TriageChoice | undefined>>,
): Record<TriageChoice | "pending", number> {
  const out: Record<TriageChoice | "pending", number> = {
    lead: 0, personal: 0, team: 0, supplier: 0, partner: 0, skip: 0, pending: 0,
  };
  for (const row of rows) out[choices[row.key] ?? "pending"]++;
  return out;
}

/** Divide em pedaços (consulta "já está no CRM" e envio). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
