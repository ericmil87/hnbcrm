/**
 * PDF legítimo GRANDE e SINTÉTICO (~`targetMb` MB no arquivo) para o teto de
 * 20 MB do onboarding: `textPages` páginas de texto (conteúdo Flate) + imagens
 * Flate de bytes pseudoaleatórios (quase incompressíveis, então o arquivo
 * fica do tamanho pedido) + opcionalmente `fontMb` MB descomprimidos de um
 * stream de "fonte" Flate (não-imagem: conta na pré-varredura) com compressão
 * ~`fontRatio`:1. Determinístico. Arquivo de teste (fora do glob de módulos).
 */
import { deflateSync } from "node:zlib";
import { assemblePdf, stream } from "./pdfTestFixtures.test-helper";

type Obj = string | Buffer;

function pdfString(s: string): string {
  return `(${s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

export function bigLegitPdf(opts: { targetMb: number; textPages?: number; fontMb?: number; fontRatio?: number }): Buffer {
  const { targetMb, textPages = 150, fontMb = 0, fontRatio = 2 } = opts;
  let seed = 987654321;
  const rnd = (n: number) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      out[i] = (seed >>> 8) & 255;
    }
    return out;
  };
  const objs: Obj[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(""); // Pages
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (let p = 0; p < textPages; p++) {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `Pagina ${p + 1} linha ${i + 1}: Pizza margherita R$ ${40 + i},00 - atendimento de segunda a sabado`
    );
    const body = `BT /F1 11 Tf 12 TL 40 800 Td ${lines.map((l) => `${pdfString(l)} Tj T*`).join(" ")} ET`;
    objs.push(stream("/Filter /FlateDecode", deflateSync(Buffer.from(body, "latin1"))));
    const contentId = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    kids.push(objs.length);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  for (let left = fontMb; left > 0; left -= 15) {
    // Streams de "fonte" de até 15 MB descomprimidos (abaixo do teto de 16 MB por stream).
    const total = Math.min(15, left) * 1024 * 1024;
    const rndPart = Math.max(1, Math.round(total / fontRatio));
    const font = Buffer.concat([rnd(rndPart), Buffer.alloc(total - rndPart)]);
    objs.push(stream("/Filter /FlateDecode /Length1 0", deflateSync(font, { level: 1 })));
  }
  const used = objs.reduce<number>((n, o) => n + o.length, 0);
  const imgBytes = Math.max(0, targetMb * 1024 * 1024 - used - 4096);
  const perImg = 4 * 1024 * 1024;
  for (let left = imgBytes; left > 0; left -= perImg) {
    const n = Math.min(perImg, left);
    const side = Math.floor(Math.sqrt(n / 3));
    objs.push(
      stream(
        `/Type /XObject /Subtype /Image /Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
        deflateSync(rnd(side * side * 3), { level: 1 })
      )
    );
  }
  return assemblePdf(objs);
}
