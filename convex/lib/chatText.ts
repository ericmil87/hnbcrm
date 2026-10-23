/**
 * Markdown do LLM → TEXTO PURO para Instagram Direct e Messenger (Meta
 * Messaging F3).
 *
 * Instagram e Messenger não interpretam nem markdown nem a formatação do
 * WhatsApp: `*negrito*` e `_itálico_` chegam com os marcadores crus. Então,
 * para esses canais, a saída do funil do atendente REMOVE a ênfase em vez de
 * convertê-la (o WhatsApp continua em `toWhatsAppText`).
 *
 * O que faz:
 *  - cerca de código (``` ou ~~~) e crases somem (o conteúdo fica);
 *  - escape do markdown (`\*x\*`) perde a barra e vira texto puro;
 *  - link `[t](u)` vira `t (u)` (rótulo vazio ou igual à URL vira só a URL);
 *  - títulos `# X` viram `X`; citação `> X` vira `X`; régua `---` some;
 *  - marcador de lista `*`/`+`/`-`/`•` vira `- ` (lista numerada fica);
 *  - ênfase `***x***`, `**x**`, `*x*`, `__x__`, `_x_`, `~~x~~`, `~x~` vira `x`.
 *
 * O que NÃO se toca: URL e e-mail (viram átomos antes das trocas: um `_` no
 * caminho de uma URL não é itálico), `snake_case` e `2*3` no meio de palavra,
 * quebras de linha, espaçamento e emojis.
 *
 * PURO e IDEMPOTENTE. A divisão em partes (1000 bytes no IG, 2000 caracteres no
 * Messenger) é do dispatcher (`lib/metaSend.ts`), não daqui.
 */

const ATOM = "\u0000";

const ATOMIC_PATTERNS = [
  /\bhttps?:\/\/[^\s<>()[\]]+/gi,
  /\bwww\.[^\s<>()[\]]+/gi,
  /[^\s<>()[\]@*_~]+@[^\s<>()[\],;:*_~]+\.[a-z]{2,}/gi,
];

function protectAtoms(text: string): { text: string; atoms: string[] } {
  const atoms: string[] = [];
  let out = text;
  for (const pattern of ATOMIC_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Marcador de ênfase colado no fim (`**https://x.com**`) não é da URL.
      const trailing = match.match(/[*_~]+$/)?.[0] ?? "";
      const url = trailing ? match.slice(0, -trailing.length) : match;
      atoms.push(url);
      return `${ATOM}${atoms.length - 1}${ATOM}${trailing}`;
    });
  }
  return { text: out, atoms };
}

function restoreAtoms(text: string, atoms: string[]): string {
  return text.replace(new RegExp(`${ATOM}(\\d+)${ATOM}`, "g"), (whole, index) => atoms[Number(index)] ?? whole);
}

// Letra/dígito em qualquer alfabeto: `_` e `*` colados neles não são ênfase.
const W = "\\p{L}\\p{N}";
// Nenhum par atravessa `\n` (par sem fechamento na linha fica como veio).
const BOLD_ITALIC = /\*\*\*(?=\S)([^*\n]*?\S)\*\*\*/g;
const BOLD = /\*\*(?=\S)([^*\n]*?\S)\*\*/g;
const STAR = new RegExp(`(^|[^${W}*])\\*(?=\\S)([^*\\n]*?\\S)\\*(?![${W}*])`, "gmu");
const BOLD_UNDERSCORE = new RegExp(`(^|[^${W}_])__(?=\\S)([^_\\n]*?\\S)__(?![${W}_])`, "gmu");
const UNDERSCORE = new RegExp(`(^|[^${W}_])_(?=\\S)([^_\\n]*?\\S)_(?![${W}_])`, "gmu");
const STRIKE = /~~(?=\S)([^~\n]*?\S)~~/g;
const TILDE = new RegExp(`(^|[^${W}~])~(?=\\S)([^~\\n]*?\\S)~(?![${W}~])`, "gmu");

export function toPlainChatText(text: string): string {
  if (!text) return text;
  let out = text.replace(new RegExp(ATOM, "g"), "");

  // 0. Escape do markdown (`\*isso\*`): a barra some e o marcador vira
  // ênfase comum, que o passo 5 remove — nunca sobra barra para o cliente.
  out = out.replace(/\\([!-\/:-@\[-`{-~])/g, "$1");

  // 1. Código: cerca de crases OU de tis (3+, mesmo tamanho para fechar) some
  // inteira, o conteúdo fica; crase inline some.
  out = out.replace(/(`{3,}|~{3,})[\w-]*[ \t]*\r?\n?([\s\S]*?)\1/g, "$2");
  out = out.replace(/`{3,}/g, "");
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/`/g, "");

  // 2. Link markdown ANTES de proteger as URLs.
  out = out.replace(/\[([^\]\n]*)\]\(\s*([^)\s]+)\s*\)/g, (_whole, label: string, url: string) => {
    const clean = label.trim();
    return !clean || clean === url ? url : `${clean} (${url})`;
  });

  // 3. URL/e-mail viram átomos.
  const { text: protectedText, atoms } = protectAtoms(out);
  out = protectedText;

  // 4. Estrutura de bloco: régua, título, citação, lista.
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "");
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, "$1");
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  out = out.replace(/^([ \t]*)[*+•-][ \t]+/gm, "$1- ");

  // 5. Ênfase: do marcador mais longo para o mais curto.
  out = out.replace(BOLD_ITALIC, "$1");
  out = out.replace(BOLD, "$1");
  out = out.replace(BOLD_UNDERSCORE, "$1$2");
  out = out.replace(STRIKE, "$1");
  out = out.replace(STAR, "$1$2");
  out = out.replace(UNDERSCORE, "$1$2");
  out = out.replace(TILDE, "$1$2");

  // 6. Marcador duplo órfão (`**` sem par na linha) não tem leitura possível.
  out = out.replace(/\*\*+/g, "");
  out = out.replace(/~~+/g, "");

  return restoreAtoms(out, atoms);
}
