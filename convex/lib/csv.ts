/**
 * CSV RFC 4180 — parser e serializador puros (sem deps Convex, sem deps npm).
 *
 * Referência única do produto para CSV (export/import). Regras:
 * - BOM (﻿) tolerado na leitura e SEMPRE emitido na escrita (Excel/pt-BR).
 * - Delimitador auto-detectado na leitura entre `,`, `;` e TAB (fora de aspas).
 * - Aspas com escape por duplicação (`""`) e quebras de linha dentro do campo.
 * - Linhas totalmente vazias são ignoradas (inclusive antes do cabeçalho).
 * - Cabeçalhos vazios viram `coluna_<n>`; duplicados ganham sufixo ` (2)`,
 *   ` (3)`… porque as linhas voltam indexadas por cabeçalho.
 */

export interface ParsedCsv {
  /** Cabeçalhos normalizados (únicos, sem BOM, sem espaços nas pontas). */
  headers: string[];
  /** Uma linha por registro, indexada pelo cabeçalho. Valores crus (sem trim). */
  rows: Record<string, string>[];
  /** Delimitador efetivamente usado na leitura. */
  delimiter: string;
}

export interface ParseCsvOptions {
  /** Força o delimitador em vez de auto-detectar. */
  delimiter?: string;
}

export interface SerializeCsvOptions {
  /** Delimitador de saída (default `,`). */
  delimiter?: string;
  /** Prefixo BOM (default true). */
  bom?: boolean;
  /** Fim de linha (default `\r\n`, conforme RFC 4180). */
  eol?: string;
  /**
   * Neutraliza injeção de fórmula em planilhas prefixando `'` em valores que
   * começam com `= + - @` (default false — preserva fidelidade de round-trip).
   */
  escapeFormulas?: boolean;
}

export const CSV_BOM = "\uFEFF";

const DEFAULT_DELIMITERS = [",", ";", "\t"];

/** Detecta o delimitador contando ocorrências fora de aspas na 1ª linha útil. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // Linha vazia antes do cabeçalho: continua procurando.
      if (!sawContent && counts[","] + counts[";"] + counts["\t"] === 0) continue;
      break;
    }
    if (ch in counts) counts[ch]++;
    else if (ch.trim() !== "") sawContent = true;
  }
  let best = ",";
  for (const d of DEFAULT_DELIMITERS) {
    if (counts[d] > counts[best]) best = d;
  }
  return best;
}

/** Máquina de estados RFC 4180: devolve os registros crus como arrays. */
function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let dirty = false; // algum caractere já entrou no registro corrente

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    record.push(field);
    field = "";
    records.push(record);
    record = [];
    dirty = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      // Aspas só abrem no início do campo (tolerando espaços antes).
      if (field.trim() === "") {
        field = "";
        inQuotes = true;
        dirty = true;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === delimiter) {
      endField();
      dirty = true;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      continue;
    }

    field += ch;
    dirty = true;
  }

  if (dirty || field !== "" || record.length > 0) endRecord();

  return records;
}

const isBlankRecord = (record: string[]): boolean =>
  record.every((cell) => cell.trim() === "");

/** Cabeçalhos únicos e não-vazios (as linhas são indexadas por eles). */
function normalizeHeaders(raw: string[]): string[] {
  const used = new Map<string, number>();
  return raw.map((cell, index) => {
    let name = cell.replace(/^\uFEFF/, "").trim();
    if (name === "") name = `coluna_${index + 1}`;
    const seen = used.get(name) ?? 0;
    used.set(name, seen + 1);
    if (seen === 0) return name;
    let candidate = `${name} (${seen + 1})`;
    let bump = seen + 1;
    while (used.has(candidate)) {
      bump++;
      candidate = `${name} (${bump})`;
    }
    used.set(candidate, 1);
    return candidate;
  });
}

/**
 * Lê um CSV completo. Tolera BOM, CRLF/LF/CR, aspas com quebra de linha,
 * linhas vazias e linhas com menos/mais colunas que o cabeçalho (faltantes
 * viram string vazia; excedentes são descartadas).
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): ParsedCsv {
  const clean = typeof text === "string" ? text.replace(/^\uFEFF/, "") : "";
  if (clean.trim() === "") {
    return { headers: [], rows: [], delimiter: options.delimiter ?? "," };
  }

  const delimiter = options.delimiter ?? detectDelimiter(clean);
  const records = parseRecords(clean, delimiter).filter((r) => !isBlankRecord(r));
  if (records.length === 0) return { headers: [], rows: [], delimiter };

  const headers = normalizeHeaders(records[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = record[c] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows, delimiter };
}

/** Converte qualquer valor em célula de texto (arrays viram `a;b`). */
export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return isNaN(value.getTime()) ? "" : value.toISOString();
  if (Array.isArray(value)) return value.map((v) => formatCsvValue(v)).join(";");
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** `=`, `+`, `@`, TAB e CR no início da célula são sempre gatilho de fórmula. */
const FORMULA_PREFIX_RE = /^[=+@\t\r]/;

/**
 * Número puro negativo: "-123", "-1234.56"/"-1,5" (um único separador) ou
 * "-1.234,56"/"-1.234.567,89" (milhar por ponto + decimal por vírgula, pt-BR).
 * `-` sozinho NÃO é sinal de fórmula em planilha — é sinal de número — então
 * uma célula assim não deve levar o prefixo `'` (senão "-123" vira "'-123" e a
 * coluna numérica é corrompida ao reimportar/abrir no Excel).
 */
const NEGATIVE_NUMBER_RE = /^-(?:\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:[.,]\d+)?)$/;

/** `-` só é tratado como início de fórmula quando a célula não é um número puro. */
function needsFormulaEscape(cell: string): boolean {
  if (FORMULA_PREFIX_RE.test(cell)) return true;
  if (cell.startsWith("-")) return !NEGATIVE_NUMBER_RE.test(cell);
  return false;
}

function escapeCell(raw: string, delimiter: string, escapeFormulas: boolean): string {
  let cell = raw;
  if (escapeFormulas && needsFormulaEscape(cell)) cell = `'${cell}`;
  const needsQuotes =
    cell.includes(delimiter) ||
    cell.includes('"') ||
    cell.includes("\n") ||
    cell.includes("\r") ||
    cell !== cell.trim();
  if (!needsQuotes) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

/**
 * Serializa linhas (objetos indexados por cabeçalho) em CSV com BOM e escape
 * RFC 4180. Colunas ausentes na linha viram célula vazia.
 */
export function serializeCsv(
  headers: string[],
  rows: Array<Record<string, unknown>>,
  options: SerializeCsvOptions = {}
): string {
  const delimiter = options.delimiter ?? ",";
  const eol = options.eol ?? "\r\n";
  const escapeFormulas = options.escapeFormulas ?? false;
  const bom = options.bom ?? true;

  const lines: string[] = [];
  lines.push(headers.map((h) => escapeCell(String(h), delimiter, escapeFormulas)).join(delimiter));
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => escapeCell(formatCsvValue(row?.[h]), delimiter, escapeFormulas))
        .join(delimiter)
    );
  }

  return (bom ? CSV_BOM : "") + lines.join(eol) + eol;
}
