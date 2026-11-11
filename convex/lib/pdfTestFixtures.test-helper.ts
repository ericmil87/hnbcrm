/**
 * Gerador de PDFs SINTÉTICOS para os testes do extrator (sem binário no repo).
 * Reproduz os casos do spike P0.5: texto com acentos, muitas páginas, só
 * imagem (escaneado), criptografado, truncado e bomba de descompressão.
 * Arquivo de teste (não é módulo do Convex: o nome tem dois pontos e fica
 * fora do glob de módulos dos testes).
 */
import { deflateRawSync, deflateSync } from "node:zlib";

type Obj = string | Buffer;

function b(s: string): Buffer {
  return Buffer.from(s, "latin1");
}

export function stream(dict: string, data: Buffer): Buffer {
  return Buffer.concat([b(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, b("\nendstream")]);
}

/** objs[i] é o corpo do objeto i+1; o objeto 1 deve ser o Catalog. */
export function assemblePdf(objs: Obj[], trailerExtra = ""): Buffer {
  const parts: Buffer[] = [b("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let len = parts[0].length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(len);
    const chunk = Buffer.concat([b(`${i + 1} 0 obj\n`), typeof body === "string" ? b(body) : body, b("\nendobj\n")]);
    parts.push(chunk);
    len += chunk.length;
  });
  const xrefAt = len;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(b(xref));
  return Buffer.concat(parts);
}

function pdfString(s: string): string {
  return `(${s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

/** Texto em Helvetica/WinAnsi (acentos latin-1). `pages` = linhas por página. */
export function textPdf(pages: string[][], opts: { shareContent?: boolean; trailerExtra?: string; extra?: Obj[] } = {}): Buffer {
  const objs: Obj[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(""); // Pages, preenchido depois
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const content = (lines: string[]) =>
    stream("", b(`BT /F1 12 Tf 14 TL 50 780 Td ${lines.map((l) => `${pdfString(l)} Tj T*`).join(" ")} ET`));
  const kids: number[] = [];
  let sharedId = 0;
  if (opts.shareContent) {
    objs.push(content(pages[0]));
    sharedId = objs.length;
  }
  for (const lines of pages) {
    let contentId = sharedId;
    if (!opts.shareContent) {
      objs.push(content(lines));
      contentId = objs.length;
    }
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    kids.push(objs.length);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  for (const e of opts.extra ?? []) objs.push(e);
  return assemblePdf(objs, opts.trailerExtra);
}

/** Uma página só com imagem (sem texto): "escaneado". */
export function scannedPdf(): Buffer {
  const px = Buffer.alloc(64 * 64, 0x80);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    stream("", b("q 500 0 0 700 50 70 cm /Im1 Do Q")),
    stream("/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(px)),
  ]);
}

/** Dicionário /Encrypt no trailer (recusado na pré-varredura). */
export function encryptedPdf(): Buffer {
  return textPdf([["Tabela de preços confidencial com muitos itens e valores."]], {
    trailerExtra: "/Encrypt 99 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] ",
  });
}

/** Stream Flate que expande para `mb` MB de zeros. */
export function bombPdf(mb: number): Buffer {
  const zeros = deflateSync(Buffer.alloc(mb * 1024 * 1024), { level: 9 });
  const base = textPdf([["Folheto"]], {
    extra: [stream("/Filter /FlateDecode", zeros)],
  });
  return base;
}

/** Página cujo conteúdo é UM stream com o dicionário dado (como as PoCs da revisão). */
export function pdfWithContentStream(data: Buffer, dictExtra: string, extraObjs: Obj[] = [], withLength = true): Buffer {
  const dict = `${withLength ? `/Length ${data.length} ` : ""}${dictExtra}`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    Buffer.concat([b(`<< ${dict} >>\nstream\n`), data, b("\nendstream")]),
    ...extraObjs,
  ]);
}

/**
 * Objeto 4 com o texto CRU entre `4 0 obj\n` e o dado (dicionário + palavra
 * `stream` + quebra), para reproduzir variações de sintaxe que o pdf.js aceita.
 */
export function pdfWithRawStreamPrefix(data: Buffer, prefix: (length: number) => string): Buffer {
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    Buffer.concat([b(prefix(data.length)), data, b("\nendstream")]),
  ]);
}

/** zlib de `mb` MB de espaços (cabeçalho padrão 0x78). */
export function zlibBomb(mb: number): Buffer {
  return deflateSync(Buffer.alloc(mb * 1024 * 1024, 0x20), { level: 9 });
}

/** Mesmo deflate com CMF 0x68 (janela menor; o pdf.js aceita, a checagem antiga pulava). */
export function zlibBombCmf68(mb: number): Buffer {
  const d = Buffer.from(zlibBomb(mb));
  d[0] = 0x68;
  let flg = d[1] & 0xe0;
  while (((0x68 << 8) + flg) % 31 !== 0) flg++;
  d[1] = flg;
  return d;
}

/**
 * zlib cujo 1º bloco é "stored" com o texto literal "endstream endobj" (um
 * `endstream` falso cedo no dado), seguido do deflate da bomba.
 */
export function zlibBombWithFakeEndstream(mb: number): Buffer {
  const literal = b("\nendstream\nendobj\n");
  const stored = Buffer.alloc(5);
  stored[0] = 0x00; // BFINAL=0, BTYPE=00
  stored.writeUInt16LE(literal.length, 1);
  stored.writeUInt16LE(~literal.length & 0xffff, 3);
  const rest = deflateRawSync(Buffer.alloc(mb * 1024 * 1024, 0x20), { level: 9 });
  return Buffer.concat([Buffer.from([0x78, 0xda]), stored, literal, rest]);
}

/** ASCII85 (Adobe) sem o "<~" inicial, com "~>" final. */
export function ascii85(data: Buffer): string {
  let out = "";
  for (let i = 0; i < data.length; i += 4) {
    const chunk = Buffer.alloc(4);
    data.copy(chunk, 0, i, Math.min(i + 4, data.length));
    const n = Math.min(4, data.length - i);
    let v = chunk.readUInt32BE(0);
    if (v === 0 && n === 4) {
      out += "z";
      continue;
    }
    const chars: string[] = [];
    for (let k = 0; k < 5; k++) {
      chars.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += chars.slice(0, n + 1).join("");
  }
  return out + "~>";
}

/** Conteúdo de página com texto, comprimido com Flate (PDF "normal" moderno). */
export function flateTextPdf(lines: string[]): Buffer {
  const content = b(`BT /F1 12 Tf 14 TL 50 780 Td ${lines.map((l) => `${pdfString(l)} Tj T*`).join(" ")} ET`);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    stream("/Filter /FlateDecode", deflateSync(content)),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ]);
}
