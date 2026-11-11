/**
 * Varre o DOM renderizado atrás de cor crua: classe de paleta do Tailwind
 * (cor + tom numérico), hex arbitrário entre colchetes e cor literal em `style` (hex, rgb, hsl).
 * Complementa `src/lib/rawColorsGuard.test.ts` (que lê o código) olhando o que
 * de fato chega à tela, inclusive classes montadas por props.
 */
const PALETTE =
  /(?:^|[\s:])(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|accent|caret|decoration|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const ARBITRARY_HEX = /-\[#[0-9a-fA-F]{3,8}\]/;
const STYLE_COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

export function rawColorHits(root: Element): string[] {
  const hits: string[] = [];
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    const cls = el.getAttribute("class") ?? "";
    for (const token of cls.split(/\s+/)) {
      if (token && (PALETTE.test(` ${token}`) || ARBITRARY_HEX.test(token))) hits.push(`<${el.tagName.toLowerCase()}> class "${token}"`);
    }
    const style = el.getAttribute("style") ?? "";
    if (STYLE_COLOR.test(style)) hits.push(`<${el.tagName.toLowerCase()}> style "${style}"`);
  }
  return hits;
}
