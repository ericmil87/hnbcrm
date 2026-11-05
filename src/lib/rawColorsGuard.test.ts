// @vitest-environment node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Catraca contra cores cruas de paleta do Tailwind (`bg-red-500`, `text-sky-400`...) e `[#hex]`
 * arbitrário em `src/`. A lista é POR ARQUIVO e só desce: o teto é o máximo de ocorrências que o
 * arquivo pode ter. Arquivo fora da lista nasce com zero cor crua.
 */
const PALETTE =
  /\b(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|accent|caret|decoration|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const ARBITRARY_HEX = /-\[#[0-9a-fA-F]{3,8}\]/g;

/**
 * Cores de dado ou isoladas, aceitas por arquivo (teto = contagem atual). Nunca aumente um teto
 * para passar: migre para token ou justifique aqui.
 */
const ALLOWLIST: Record<string, number> = {
  // Cor de dado: tipo de evento do calendário (par `-400` + `light-theme:-700`).
  "components/calendar/constants.ts": 20,
  // Timeline do lead: um ponto sólido por tipo de atividade.
  "components/LeadDetailPanel.tsx": 3,
  // Bloco de código sempre escuro (#0d1117), nos dois temas.
  "components/developers/JsonHighlighter.tsx": 7,
  "components/developers/CodeBlock.tsx": 2,
  "components/developers/RequestBuilder.tsx": 2,
  // Cores canônicas do WhatsApp na pré-visualização de campanha.
  "components/campaigns/WhatsAppPreview.tsx": 30,
  "components/campaigns/WhatsAppText.tsx": 2,
  // Tema do formulário público (escolhido pelo usuário, independe do tema do app).
  "components/forms/renderer/FormField.tsx": 10,
  "components/forms/renderer/FormRenderer.tsx": 1,
  "components/forms/renderer/FormSuccess.tsx": 1,
  // Marcas de redes sociais.
  "components/SocialIcons.tsx": 3,
  // Perigo: texto branco sobre vermelho funciona em todos os temas.
  "components/ui/Button.tsx": 2,
};

const SRC = resolve(__dirname, "..");

function listSources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...listSources(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(full);
  }
  return files;
}

function countByFile(pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of listSources(SRC)) {
    const text = readFileSync(file, "utf8");
    const n = (text.match(pattern) ?? []).length;
    if (n > 0) counts[relative(SRC, file).split(sep).join("/")] = n;
  }
  return counts;
}

function rawColorCounts(): Record<string, number> {
  const palette = countByFile(PALETTE);
  const hex = countByFile(ARBITRARY_HEX);
  const total: Record<string, number> = { ...palette };
  for (const [file, n] of Object.entries(hex)) total[file] = (total[file] ?? 0) + n;
  return total;
}

describe("rawColorsGuard", () => {
  const counts = rawColorCounts();

  it("nenhum arquivo fora da lista usa cor crua", () => {
    const offenders = Object.entries(counts)
      .filter(([file]) => !(file in ALLOWLIST))
      .map(([file, n]) => `${file} (${n})`);
    expect(
      offenders,
      `Cor crua de paleta ou [#hex] fora da lista. Use tokens: superfícies bg-surface-*, texto text-text-*, ` +
        `destaque brand-*, IA ai-*, estados semantic-*, conversa bubble-*/chat-*/composer.`
    ).toEqual([]);
  });

  it("nenhum arquivo da lista passa do teto", () => {
    const over = Object.entries(ALLOWLIST)
      .filter(([file, max]) => (counts[file] ?? 0) > max)
      .map(([file, max]) => `${file}: ${counts[file]} > ${max}`);
    expect(
      over,
      `Arquivo com mais cores cruas do que o teto. Troque por token (bg-surface-*, text-text-*, brand-*, ai-*, ` +
        `semantic-*) em vez de subir o teto.`
    ).toEqual([]);
  });

  it("a lista não guarda teto folgado nem arquivo limpo (a catraca só desce)", () => {
    const stale = Object.entries(ALLOWLIST)
      .filter(([file, max]) => (counts[file] ?? 0) < max)
      .map(([file, max]) => `${file}: ${counts[file] ?? 0} < ${max}`);
    expect(stale, "Baixe o teto na ALLOWLIST para a contagem atual (ou remova o arquivo).").toEqual([]);
  });

  it("purple- só existe em JsonHighlighter.tsx (IA usa ai-*)", () => {
    const purple = countByFile(/\b(?:[a-z-]+:)*[a-z]+-purple-\d{2,3}\b/g);
    const offenders = Object.keys(purple).filter((f) => f !== "components/developers/JsonHighlighter.tsx");
    expect(offenders, "Roxo cru fora do bloco de código: use os tokens ai-* (ex.: bg-ai-600).").toEqual([]);
  });
});
