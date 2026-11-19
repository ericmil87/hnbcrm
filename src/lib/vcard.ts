/**
 * Leitor de vCard (.vcf) para "Importar contatos do celular" (PR6). PURO, roda
 * só no navegador: o arquivo nunca sai do aparelho.
 *
 * Cobre o que Google Contatos (3.0), iPhone/iCloud (3.0) e Android antigo (2.1)
 * exportam, e o 4.0:
 * - vários contatos por arquivo (`BEGIN:VCARD` … `END:VCARD`, sem caixa);
 * - linhas dobradas (CRLF + espaço/tab) e a continuação do quoted-printable
 *   (linha terminada em `=`) do 2.1;
 * - `ENCODING=QUOTED-PRINTABLE` (ou só `QUOTED-PRINTABLE`) + `CHARSET=` (UTF-8
 *   padrão; ISO-8859-1/Windows-1252 também);
 * - grupos do iPhone (`item1.TEL`), parâmetros 2.1 sem nome (`TEL;CELL;VOICE`),
 *   `TYPE=cell,voice`, `type=CELL;type=pref`, `TYPE="cell,voice"`;
 * - `TEL` em URI do 4.0 (`tel:+55…`);
 * - FN, N (família;nome;…), TEL (vários, com tipos), EMAIL, ORG, TITLE.
 * Fotos e o resto são ignorados.
 */

export interface VCardValue {
  value: string;
  /** Tipos em minúsculas (`cell`, `home`, `work`, `pref`, …). */
  types: string[];
}

export interface VCardContact {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  phones: VCardValue[];
  emails: VCardValue[];
  org?: string;
  title?: string;
}

interface ParsedLine {
  name: string;
  params: Map<string, string[]>;
  /** Parâmetros sem nome do 2.1 (`CELL`, `QUOTED-PRINTABLE`, `UTF-8`). */
  bare: string[];
  rawValue: string;
}

/** Junta linhas dobradas e as continuações do quoted-printable. */
export function unfoldVcfLines(text: string): string[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let qpOpen = false;
  for (const line of lines) {
    if (out.length > 0 && qpOpen) {
      // Continuação do quoted-printable: a linha anterior terminava em "=".
      out[out.length - 1] = out[out.length - 1].slice(0, -1) + line.replace(/^[ \t]/, "");
      qpOpen = out[out.length - 1].endsWith("=");
      continue;
    }
    if (out.length > 0 && (line.startsWith(" ") || line.startsWith("\t"))) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
    const current = out[out.length - 1];
    qpOpen = /quoted-printable/i.test(headOf(current)) && current.endsWith("=");
  }
  return out;
}

/** Parte antes do primeiro ":" fora de aspas (nome + parâmetros). */
function headOf(line: string): string {
  const index = colonIndex(line);
  return index < 0 ? line : line.slice(0, index);
}

function colonIndex(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) return i;
  }
  return -1;
}

function splitUnquoted(text: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === separator && !quoted) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function parseLine(line: string): ParsedLine | null {
  const index = colonIndex(line);
  if (index < 0) return null;
  const head = line.slice(0, index);
  const [rawName, ...rawParams] = splitUnquoted(head, ";");
  // Grupo do iPhone: "item1.TEL" → "TEL".
  const name = rawName.split(".").pop()!.trim().toUpperCase();
  const params = new Map<string, string[]>();
  const bare: string[] = [];
  for (const raw of rawParams) {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      if (raw.trim()) bare.push(raw.trim().toLowerCase());
      continue;
    }
    const key = raw.slice(0, eq).trim().toUpperCase();
    const values = raw
      .slice(eq + 1)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    params.set(key, [...(params.get(key) ?? []), ...values]);
  }
  return { name, params, bare, rawValue: line.slice(index + 1) };
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.toLowerCase();
  try {
    return new TextDecoder(label === "utf8" ? "utf-8" : label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Decodifica quoted-printable (`=C3=A3`) para texto no charset dado. */
export function decodeQuotedPrintable(value: string, charset = "utf-8"): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (ch === "=" && i === value.length - 1) {
      // "=" solto no fim: quebra suave que sobrou.
    } else {
      const code = ch.charCodeAt(0);
      if (code < 0x80) bytes.push(code);
      else for (const b of new TextEncoder().encode(ch)) bytes.push(b);
    }
  }
  return decodeBytes(Uint8Array.from(bytes), charset);
}

/** `\,` `\;` `\n` `\\` do vCard 3.0/4.0. */
function unescapeText(value: string): string {
  return value.replace(/\\([\\,;nN:])/g, (_, ch: string) => (ch === "n" || ch === "N" ? " " : ch));
}

/** Divide por ";" não escapado (componentes de N e ORG). */
function splitComponents(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      current += ch + value[i + 1];
      i++;
    } else if (ch === ";") {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function decodedValue(line: ParsedLine): string {
  const encoding = [...(line.params.get("ENCODING") ?? []), ...line.bare];
  const charset = line.params.get("CHARSET")?.[0] ?? line.bare.find((b) => /^(utf-?8|iso-8859-1|windows-1252)$/.test(b)) ?? "utf-8";
  if (encoding.includes("quoted-printable")) return decodeQuotedPrintable(line.rawValue, charset);
  return line.rawValue;
}

function typesOf(line: ParsedLine): string[] {
  const types = [...(line.params.get("TYPE") ?? []), ...line.bare];
  const ignore = new Set(["quoted-printable", "utf-8", "utf8", "iso-8859-1", "windows-1252", "internet"]);
  return Array.from(new Set(types.filter((t) => !ignore.has(t))));
}

function clean(value: string | undefined): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** Lê um .vcf com um ou vários contatos. Linhas estranhas são ignoradas (nunca lança). */
export function parseVcf(text: string): VCardContact[] {
  const contacts: VCardContact[] = [];
  let current: VCardContact | null = null;

  for (const raw of unfoldVcfLines(text)) {
    const line = raw.trim() ? raw : "";
    if (!line) continue;
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = { phones: [], emails: [] };
      continue;
    }
    if (upper === "END:VCARD") {
      if (current) contacts.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;

    switch (parsed.name) {
      case "FN": {
        current.fullName = clean(unescapeText(decodedValue(parsed)));
        break;
      }
      case "N": {
        const [family, given, additional] = splitComponents(decodedValue(parsed)).map((part) =>
          clean(unescapeText(part)),
        );
        current.lastName = family;
        current.firstName = [given, additional].filter(Boolean).join(" ") || undefined;
        break;
      }
      case "TEL": {
        const value = clean(unescapeText(decodedValue(parsed)).replace(/^tel:/i, ""));
        if (value) current.phones.push({ value, types: typesOf(parsed) });
        break;
      }
      case "EMAIL": {
        const value = clean(unescapeText(decodedValue(parsed)).replace(/^mailto:/i, ""));
        if (value) current.emails.push({ value, types: typesOf(parsed) });
        break;
      }
      case "ORG": {
        const parts = splitComponents(decodedValue(parsed)).map((part) => clean(unescapeText(part)));
        current.org = parts.filter(Boolean)[0];
        break;
      }
      case "TITLE": {
        current.title = clean(unescapeText(decodedValue(parsed)));
        break;
      }
      default:
        break;
    }
  }
  // Arquivo truncado sem END:VCARD no último contato.
  if (current) contacts.push(current);
  return contacts;
}
