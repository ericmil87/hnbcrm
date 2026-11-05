import type { SettingsPanelDef } from "@/components/settings/registry";

/** Minúsculas e sem acento: "Transcrição" -> "transcricao". */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

type Searchable = Pick<SettingsPanelDef, "label" | "description" | "keywords">;

/** Filtra painéis por rótulo, palavras-chave e descrição; todas as palavras da busca precisam casar. */
export function searchSettingsPanels<P extends Searchable>(panels: ReadonlyArray<P>, query: string): P[] {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...panels];
  return panels.filter((p) => {
    const haystack = normalizeSearch([p.label, ...(p.keywords ?? []), p.description].join(" "));
    return terms.every((t) => haystack.includes(t));
  });
}
