/**
 * Parser do CSV colado em Configurações → Central → Investimento em mídia.
 * Formato: `data;plataforma;campanha;unidade;valor` (também aceita vírgula ou
 * tab como separador quando a linha não tem `;`). Puro — testado em
 * `adSpendCsv.test.ts`.
 */

export type AdSpendPlatform = "meta" | "google" | "other";

export interface ParsedAdSpendRow {
  line: number;
  date: string; // AAAA-MM-DD
  platform: AdSpendPlatform;
  campaignName: string;
  unitId?: string;
  unitName?: string;
  amount: number;
}

export interface AdSpendParseResult {
  rows: ParsedAdSpendRow[];
  errors: Array<{ line: number; message: string }>;
}

export interface UnitRef {
  _id: string;
  name: string;
  shortName?: string;
}

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** "28/09/2026", "28/09/26", "2026-09-28" → "2026-09-28"; senão null. */
export function parseCsvDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (br) {
    [d, m, y] = [Number(br[1]), Number(br[2]), Number(br[3])];
    if (y < 100) y += 2000;
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** "R$ 1.234,56", "1234,56", "1234.56", "1,234.56" → número; senão null. */
export function parseCsvAmount(raw: string): number | null {
  let s = raw.replace(/R\$|\s/g, "").trim();
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Vírgula decimal (pt-BR): pontos são milhar.
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma && lastComma !== -1) {
    // Ponto decimal com vírgula de milhar (en-US).
    s = s.replace(/,/g, "");
  } else if (lastDot !== -1 && lastComma === -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.234" sem decimais = milhar pt-BR.
    s = s.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parsePlatform(raw: string): AdSpendPlatform {
  const p = normalize(raw);
  if (/^(meta|facebook|fb|instagram|ig|meta ads|facebook ads)$/.test(p)) return "meta";
  if (/^(google|google ads|adwords|gads)$/.test(p)) return "google";
  return "other";
}

function splitLine(line: string): string[] {
  const sep = line.includes(";") ? ";" : line.includes("\t") ? "\t" : ",";
  return line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
}

export function parseAdSpendCsv(text: string, units: UnitRef[]): AdSpendParseResult {
  const rows: ParsedAdSpendRow[] = [];
  const errors: AdSpendParseResult["errors"] = [];
  const unitByName = new Map<string, UnitRef>();
  for (const u of units) {
    unitByName.set(normalize(u.name), u);
    if (u.shortName) unitByName.set(normalize(u.shortName), u);
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    if (!rawLine.trim()) return;
    const cells = splitLine(rawLine);
    const date = parseCsvDate(cells[0] ?? "");
    if (!date) {
      // Primeira linha sem data = cabeçalho; ignora em silêncio.
      if (idx === 0 || rows.length + errors.length === 0) return;
      errors.push({ line, message: `Data inválida "${cells[0] ?? ""}"` });
      return;
    }
    if (cells.length < 5) {
      errors.push({ line, message: "Faltam colunas (data;plataforma;campanha;unidade;valor)" });
      return;
    }
    const [, platformRaw, campaignRaw, unitRaw, amountRaw] = cells;
    const campaignName = campaignRaw.trim();
    if (!campaignName) {
      errors.push({ line, message: "Campanha vazia" });
      return;
    }
    const amount = parseCsvAmount(amountRaw);
    if (amount === null || amount < 0) {
      errors.push({ line, message: `Valor inválido "${amountRaw}"` });
      return;
    }
    let unit: UnitRef | undefined;
    if (unitRaw.trim()) {
      unit = unitByName.get(normalize(unitRaw));
      if (!unit) {
        errors.push({ line, message: `Unidade "${unitRaw}" não encontrada` });
        return;
      }
    }
    rows.push({
      line,
      date,
      platform: parsePlatform(platformRaw),
      campaignName,
      ...(unit ? { unitId: unit._id, unitName: unit.name } : {}),
      amount,
    });
  });
  return { rows, errors };
}
