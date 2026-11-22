/**
 * Agenda v2: rótulo dos blocos ESTREITOS da grade (PURO). Bloco estreito só tem espaço para o primeiro nome, e
 * homônimos lado a lado ficavam indistinguíveis ("Teste", "Teste", "Teste"). Regra: primeiro nome + inicial do
 * sobrenome quando cabe ("Teste A."); se dois blocos que se sobrepõem no tempo (mesmo grupo na grade) ficam com o
 * mesmo rótulo, usa a inicial do sobrenome mesmo apertado, e se ainda assim repetem (mesmo nome completo) soma a hora.
 */
import { widthClass } from "./agendaBlockText";

/** Largura média de um caractere do texto `text-micro` (px) e as folgas laterais do bloco estreito. */
const CHAR_PX = 5.6;
const PAD_PX = 10;

export interface NameInput {
  id: string;
  label: string;
  startMin: number;
  endMin: number;
  /** "09:00" (fuso da org): só entra no rótulo quando nada mais distingue. */
  time: string;
  /** Largura do bloco em px; ausente = largo (não entra no mapa). */
  widthPx?: number;
}

export interface BlockName {
  text: string;
  /** O rótulo já traz a hora porque nome e inicial se repetem num bloco vizinho. */
  withTime: boolean;
}

const words = (label: string) => label.trim().split(/\s+/).filter(Boolean);

/** "Teste Ana Souza" -> "Teste S." (inicial do ÚLTIMO nome); um nome só -> ele mesmo. */
export function firstNameAndInitial(label: string): string {
  const w = words(label);
  if (w.length < 2) return w[0] ?? label;
  return `${w[0]} ${w[w.length - 1][0].toUpperCase()}.`;
}

function fits(text: string, widthPx: number): boolean {
  return text.length * CHAR_PX + PAD_PX <= widthPx;
}

/**
 * Rótulo por bloco estreito (< 90 px). Blocos médios e largos mostram o nome inteiro e ficam fora do mapa.
 * Só compara blocos que se sobrepõem no tempo (o grupo de blocos lado a lado).
 */
export function blockNames(items: readonly NameInput[]): Map<string, BlockName> {
  const out = new Map<string, BlockName>();
  const narrow = items.filter((i) => widthClass(i.widthPx) === "tiny" || widthClass(i.widthPx) === "narrow");
  const first = (i: NameInput) => words(i.label)[0] ?? i.label;
  const withInitial = (i: NameInput) => firstNameAndInitial(i.label);
  for (const i of narrow) {
    const candidate = withInitial(i);
    out.set(i.id, { text: fits(candidate, i.widthPx ?? 0) ? candidate : first(i), withTime: false });
  }
  // Grupos de sobreposição no tempo (todos os itens, para o grupo ser o mesmo que a grade desenha).
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const groups: NameInput[][] = [];
  let end = -1;
  for (const i of sorted) {
    if (groups.length === 0 || i.startMin >= end) groups.push([i]);
    else groups[groups.length - 1].push(i);
    end = Math.max(end, i.endMin, i.startMin + 1);
  }
  const key = (t: string) => t.toLocaleLowerCase("pt-BR");
  for (const group of groups) {
    const inGroup = group.filter((i) => out.has(i.id));
    const byText = new Map<string, NameInput[]>();
    for (const i of inGroup) byText.set(key(out.get(i.id)!.text), [...(byText.get(key(out.get(i.id)!.text)) ?? []), i]);
    for (const same of byText.values()) {
      if (same.length < 2) continue;
      // 1) A inicial do sobrenome, mesmo que o texto fique apertado (a ponta é cortada com reticências).
      const initials = new Set(same.map((i) => key(withInitial(i))));
      if (initials.size === same.length) {
        for (const i of same) out.set(i.id, { text: withInitial(i), withTime: false });
        continue;
      }
      // 2) Mesmo nome e inicial: a hora é o que sobra; quem tem nome idêntico a outro recebe a hora.
      const dup = new Map<string, number>();
      for (const i of same) dup.set(key(withInitial(i)), (dup.get(key(withInitial(i))) ?? 0) + 1);
      for (const i of same) {
        const clash = (dup.get(key(withInitial(i))) ?? 0) > 1;
        const text = initials.size > 1 || !fits(withInitial(i), i.widthPx ?? 0) ? withInitial(i) : out.get(i.id)!.text;
        out.set(i.id, { text: clash ? `${text} ${i.time}` : text, withTime: clash });
      }
    }
  }
  return out;
}
