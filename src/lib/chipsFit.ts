// Fileira de chips numa linha só (desktop, estilo WhatsApp Web): quais chips
// cabem na largura disponível e quais vão para o ▾ "Mais filtros". Pura
// (larguras medidas pelo componente). Testada em `chipsFit.test.ts`.

export interface FitChip {
  id: string;
  /** Largura medida (px). */
  width: number;
  /** Filtro ativo: nunca sai da fileira. */
  active: boolean;
}

export interface ChipsFitInput {
  /** Chips em ordem de prioridade (a mesma da fileira). */
  chips: readonly FitChip[];
  /** Largura do container (px). */
  containerWidth: number;
  /** Largura do ▾ do fim (sempre visível). */
  trailingWidth: number;
  /** Espaço entre itens (px). */
  gap: number;
}

export interface ChipsFitResult {
  /** Ids na fileira, na ordem original. */
  visible: string[];
  /** Ids no ▾, na ordem original. */
  overflow: string[];
}

/**
 * Ativos ficam sempre (mesmo se a soma passar da largura: um filtro ligado
 * nunca some sem ✕ para desligar). Os inativos entram por prioridade enquanto
 * cabem; o primeiro que não cabe e todos depois dele vão para o ▾ (nunca
 * mostra um de prioridade menor escondendo um maior). Largura desconhecida
 * (0, antes da 1ª medida) = tudo visível.
 */
export function fitChips({ chips, containerWidth, trailingWidth, gap }: ChipsFitInput): ChipsFitResult {
  if (containerWidth <= 0) return { visible: chips.map((c) => c.id), overflow: [] };
  const cost = (c: FitChip) => c.width + gap;
  const available = containerWidth - trailingWidth;
  let used = chips.reduce((sum, c) => (c.active ? sum + cost(c) : sum), 0);
  const keep = new Set(chips.filter((c) => c.active).map((c) => c.id));
  let stopped = false;
  for (const chip of chips) {
    if (chip.active) continue;
    if (!stopped && used + cost(chip) <= available) {
      used += cost(chip);
      keep.add(chip.id);
    } else {
      stopped = true;
    }
  }
  return {
    visible: chips.filter((c) => keep.has(c.id)).map((c) => c.id),
    overflow: chips.filter((c) => !keep.has(c.id)).map((c) => c.id),
  };
}
