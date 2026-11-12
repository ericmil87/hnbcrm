/**
 * Cores do QR code do grupo (S8): fonte única, sempre escuro sobre claro em
 * qualquer tema (leitores falham com o código invertido). Iguais aos tokens
 * `qr-fg`/`qr-bg` de `index.css` (`--rgb-qr-fg: 17 27 33`, `--rgb-qr-bg: 255 255 255`);
 * `themeTokens.test.ts` confere. São constantes e não `var()` porque atributo
 * SVG com variável CSS não é confiável em todo leitor/renderizador.
 */
export const QR_FG = "#111B21";
export const QR_BG = "#FFFFFF";
