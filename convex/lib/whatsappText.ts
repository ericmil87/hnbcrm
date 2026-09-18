/**
 * Markdown do LLM → formatação do WhatsApp.
 *
 * O modelo escreve `**PORTO50**` porque foi treinado em markdown; o WhatsApp
 * não conhece markdown e mostra os asteriscos crus para o cliente. Pedir no
 * prompt não resolve de forma confiável (medido: reaparece em resposta longa),
 * então a correção é DETERMINÍSTICA, na saída.
 *
 * O que o WhatsApp entende: `*negrito*`, `_itálico_`, `~riscado~`. Ou seja, o
 * conserto é quase todo "dois marcadores viram um".
 *
 * PURO e IDEMPOTENTE: aplicar duas vezes é igual a aplicar uma (depois do
 * primeiro passe não sobra `**`, `__`, `~~`, cerca nem título para converter).
 *
 * O que NÃO se toca, de propósito:
 *  - `*x*` e `_x_` simples — já são formatação válida do WhatsApp;
 *  - URL e e-mail — viram ÁTOMOS antes de qualquer troca. `https://ex.com/__a__`
 *    e `pix@milfont.net` não podem ser "consertados", eles quebrariam;
 *  - `snake_case` no meio de palavra — `__` colado em letra não é ênfase (é a
 *    mesma regra do CommonMark);
 *  - quebras de linha e espaçamento.
 */

/** Marcador dos átomos protegidos. Controle NUL nunca aparece em texto real. */
const ATOM = "\u0000";

/**
 * URL, e-mail e `www.` saem do texto antes das trocas e voltam no fim. Sem
 * isto, um `__` dentro do caminho de uma URL viraria negrito e o link quebra.
 */
const ATOMIC_PATTERNS = [
  /\bhttps?:\/\/[^\s<>()[\]]+/gi,
  /\bwww\.[^\s<>()[\]]+/gi,
  /[^\s<>()[\]@]+@[^\s<>()[\],;:]+\.[a-z]{2,}/gi,
];

function protectAtoms(text: string): { text: string; atoms: string[] } {
  const atoms: string[] = [];
  let out = text;
  for (const pattern of ATOMIC_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Asterisco no fim não é parte de URL nenhuma — é o fechamento de um
      // `**https://…**`. Devolvido ao texto, ele ainda vira negrito; engolido
      // no átomo, sobraria um `**` visível para o cliente.
      const trailing = match.match(/\*+$/)?.[0] ?? "";
      const url = trailing ? match.slice(0, -trailing.length) : match;
      atoms.push(url);
      return `${ATOM}${atoms.length - 1}${ATOM}${trailing}`;
    });
  }
  return { text: out, atoms };
}

function restoreAtoms(text: string, atoms: string[]): string {
  return text.replace(
    new RegExp(`${ATOM}(\\d+)${ATOM}`, "g"),
    (whole, index) => atoms[Number(index)] ?? whole
  );
}

/** Já está no formato do WhatsApp? (`*x*` sem outros asteriscos dentro) */
function isWhatsAppBold(text: string): boolean {
  return /^\*[^*]+\*$/.test(text);
}

/**
 * Os pares de ênfase. Todos seguem a mesma forma: abre no marcador, conteúdo
 * que começa e termina em não-espaço, fecha no marcador.
 *
 * Nenhum deles atravessa `\n`, de propósito: um `**` sem fechamento seguido de
 * outro dois parágrafos adiante colocaria meia resposta em negrito. Par que não
 * fecha na mesma linha fica como veio — pior que não converter é converter
 * errado.
 */
const BOLD_ITALIC = /\*\*\*(?=\S)([^*\n]*[^*\s\n])\*\*\*/g; // ***x*** (antes do negrito)
const BOLD = /\*\*(?=\S)([^*\n]*[^*\s\n])\*\*/g; //             **x**
const STRIKE = /~~(?=\S)([^~\n]*[^~\s\n])~~/g; //               ~~x~~
/** `__x__` só quando o `__` NÃO está colado em letra: `lead__id` é variável. */
const BOLD_UNDERSCORE = /(^|[^\w*])__(?=\S)([^_\n]*[^_\s\n])__(?!\w)/g;

export function toWhatsAppText(text: string): string {
  if (!text) return text;

  // O NUL é o nosso marcador de átomo: se viesse no texto do modelo, embaralharia
  // a restauração.
  let out = text.replace(new RegExp(ATOM, "g"), "");

  // 1. Cerca de código: some, o conteúdo fica. Três crases no WhatsApp viram
  // monoespaçado e o cliente veria o ```json do modelo.
  out = out.replace(/```[\w-]*[ \t]*\r?\n?([\s\S]*?)```/g, "$1");
  out = out.replace(/```/g, "");

  // 2. Link markdown ANTES de proteger as URLs (a URL sai de dentro dos
  // parênteses e só então vira átomo). Rótulo igual à URL não vira "url: url".
  out = out.replace(/\[([^\]\n]*)\]\(\s*([^)\s]+)\s*\)/g, (_whole, label: string, url: string) => {
    const clean = label.trim();
    return !clean || clean === url ? url : `${clean}: ${url}`;
  });

  // 3. URL/e-mail viram átomos — daqui até a restauração ninguém os toca.
  const { text: protectedText, atoms } = protectAtoms(out);
  out = protectedText;

  // 4. Marcador de lista `*`/`+` → `-`. Antes do negrito: `* item` começa com
  // asterisco e, sem isto, uma lista inteira viraria negrito quebrado. Exige
  // espaço depois do marcador, então `*negrito*` no início da linha não casa.
  out = out.replace(/^([ \t]*)[*+]([ \t]+)/gm, "$1-$2");

  // 5. Ênfase: dois marcadores viram um. `***x***` vem primeiro, senão o passo
  //    do negrito deixaria um `*` órfão. Ele vira só negrito — o WhatsApp tem
  //    negrito+itálico, mas aninhar marcador aumenta a chance de sobrar
  //    marcador solto, e negrito é o que o modelo queria dizer.
  out = out.replace(BOLD_ITALIC, "*$1*");
  out = out.replace(BOLD, "*$1*");
  out = out.replace(STRIKE, "~$1~");
  out = out.replace(BOLD_UNDERSCORE, "$1*$2*");

  // 6. Título (`# X`, `## X`…) → negrito. Depois da ênfase, para `## **X**` não
  // virar `***X***`: aqui o conteúdo já é `*X*` e a guarda não re-embrulha.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_whole, content: string) => {
    const inner = content.trim();
    return !inner || isWhatsAppBold(inner) ? inner : `*${inner}*`;
  });

  return restoreAtoms(out, atoms);
}
