/**
 * Filtro anti-instrução do Rascunho de Operação (plano v2, 6.1 item 5). PURO.
 *
 * Heurística determinística que MARCA (não apaga) itens que parecem tentar
 * mandar no modelo ou que carregam dado perigoso. Item marcado aparece para
 * revisão e NÃO entra na aplicação por padrão (`lib/onboardingApply.ts`).
 * Falso positivo custa só uma revisão humana; falso negativo vira instrução
 * persistente do atendente — por isso o viés é marcar.
 *
 * Sinais:
 *  - instrução ao modelo (PT/EN/ES): "ignore as instruções", "system prompt",
 *    "você agora é", role-play de sistema (`system:`, `[INST]`, `<system>`…);
 *  - marcação de ferramenta/modelo (`detectLeakedModelMarkup` + tags de papel);
 *  - URL ou telefone que não aparece no texto de origem informado;
 *  - pedido de dado sensível (senha, cartão, CVV, CPF);
 *  - pagamento: Pix copia-e-cola (EMV `000201…br.gov.bcb.pix`), "chave Pix",
 *    links de cobrança conhecidos.
 *
 * Antes de casar, o texto passa por NFKC, remoção de invisíveis, dobra de
 * homóglifos básicos (cirílico/grego → latim), leet simples e remoção de
 * acentos: "іgnоre" (cirílico) e "ig\u200Bnore" caem no mesmo padrão.
 */
import { detectLeakedModelMarkup } from "./llmOutputGuard";
import type { Id } from "../_generated/dataModel";
import {
  DRAFT_LIMITS,
  cleanDraftText,
  type KnowledgeOriginKind,
  type OnboardingDraft,
} from "./onboardingDraft";

export type SuspicionCode =
  | "instrucao_ao_modelo"
  | "marcacao_de_modelo"
  | "url_fora_da_origem"
  | "telefone_fora_da_origem"
  | "dado_sensivel"
  | "pagamento"
  | "link_interno";

export const SUSPICION_LABELS: Record<SuspicionCode, string> = {
  instrucao_ao_modelo: "parece uma instrução para a IA",
  marcacao_de_modelo: "contém marcação técnica de modelo ou ferramenta",
  url_fora_da_origem: "tem link que não aparece na fonte",
  telefone_fora_da_origem: "tem telefone que não aparece na fonte",
  dado_sensivel: "pede ou contém dado sensível (senha, cartão, CPF)",
  pagamento: "tem chave ou link de pagamento",
  link_interno: "tem link para endereço interno ou IP",
};

// Cirílico e grego que se passam por latim (os casos comuns de spoofing).
const HOMOGLYPHS: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y",
  х: "x", і: "i", ї: "i", ј: "j", ѕ: "s", ԁ: "d", ԛ: "q", ԝ: "w", ү: "y", һ: "h", ӏ: "l",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  ѵ: "v", ɡ: "g", ı: "i",
};
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/** Texto dobrado para casar padrões: minúsculo, sem acento, homóglifos e leet trocados. */
export function foldForMatching(raw: string, opts: { leet?: boolean } = {}): string {
  let s = cleanDraftText(raw, true).toLowerCase();
  s = Array.from(s)
    .map((ch) => HOMOGLYPHS[ch] ?? ch)
    .join("");
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (opts.leet) s = s.replace(/[013457@$]/g, (ch) => LEET[ch] ?? ch);
  // Letras separadas por espaço/ponto ("i g n o r e", "i.g.n.o.r.e") viram palavra.
  s = s.replace(/\b(?:[a-z][ ._-]){3,}[a-z]\b/g, (m) => m.replace(/[ ._-]/g, ""));
  return s;
}

const INJECTION_PATTERNS: RegExp[] = [
  // PT
  /\b(ignore|ignora|ignorar|desconsidere|desconsiderar|esqueca|esquecer|descarte)\b[^.\n]{0,40}\b(instruc|regra|orientac|prompt|comando|diretriz|tudo o que)/,
  /\bnovas? (instrucoes|regras|diretrizes)\b/,
  /\b(a partir de agora|de agora em diante)\b[^.\n]{0,30}\b(voce|vc|tu)\b/,
  /\bvoce (agora )?(e|sera|deve agir como) (um|uma|o|a)? ?(ia|assistente|bot|modelo|sistema|admin|desenvolvedor)\b/,
  /\b(finja|fingir|aja como|atue como|comporte-se como|faca de conta)\b/,
  /\b(prompt|instrucoes?|mensagem) (do|de) sistema\b/,
  /\b(revele|mostre|repita|imprima)\b[^.\n]{0,30}\b(prompt|instrucoes|regras internas)\b/,
  /\bmodo (desenvolvedor|dev|deus|irrestrito|sem restric)/,
  // EN
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(instruction|rule|prompt|guideline|directive|above|previous|prior)/,
  /\bsystem ?prompt\b/,
  /\bsystem (message|instruction)s?\b/,
  /\byou are now\b/,
  /\b(act as|pretend (to be|you are)|roleplay as|role-play as)\b/,
  /\b(jailbreak|developer mode|dan mode|do anything now)\b/,
  /\bnew instructions?\b/,
  /\b(reveal|print|repeat|show)\b[^.\n]{0,30}\b(prompt|instructions|system)\b/,
  // ES
  /\b(ignora|ignore|olvida|olvide|omite|descarta)\b[^.\n]{0,40}\b(instrucciones|reglas|indicaciones|prompt)/,
  /\bnuevas instrucciones\b/,
  /\b(a partir de ahora|desde ahora)\b[^.\n]{0,30}\b(eres|seras|debes|actua)/,
  /\b(actua|actue|finge|haz de cuenta) como\b/,
  /\b(prompt|instrucciones|mensaje) del sistema\b/,
  // Role-play de sistema / marcadores de papel
  /(^|\n)\s*(system|assistant|developer|sistema|assistente|asistente)\s*:/,
  /\[\/?(inst|system|sys)\]/,
  /<<\s*\/?sys\s*>>/,
  /#{2,}\s*(instruction|instrucao|instruccion|system|sistema)/,
  // Red team P2.5 — identidade: mandar negar que é IA / dizer que é humano.
  /\b(diga|digam|dizer|fale|falar|afirme|afirmar|responda|garanta|confirme|minta|mentir|se apresente|apresente-se)\b[^.\n]{0,40}\b(humano|humana|pessoa (real|de verdade|fisica)|gente de verdade|carne e osso|nao (e|sou|eh) (uma? )?(ia|robo|bot|maquina|assistente virtual|inteligencia artificial))/,
  /\b(nunca|nao|jamais)\b[^.\n]{0,15}\b(diga|dizer|admita|admitir|revele|revelar|conte|contar|informe|informar|mencione|mencionar|confesse|assuma|assumir)\b[^.\n]{0,30}\b(ia|inteligencia artificial|robo|bot|assistente virtual|virtual|automatizad\w*)\b/,
  /\b(desligue|desligar|desative|desativar|desabilite|remova|remover|tire|oculte|esconda|disable|turn off|remove)\b[^.\n]{0,30}\b(apresentacao|divulgacao|identificacao|aviso de ia|disclosure|presentsasai)\b/,
  /\b(tell|say|claim)\b[^.\n]{0,30}\b(you are|you're|you re|it is) (a )?(human|real person)\b/,
  /\bnever (say|admit|reveal|disclose)\b[^.\n]{0,30}\b(ai|bot|robot|assistant)\b/,
  // Configuração que só a pessoa liga: piloto automático, aplicar o rascunho.
  /\b(ligue|ligar|ative|ativar|habilite|habilitar|coloque|colocar|enable|turn on|switch to|activate)\b[^.\n]{0,30}\b(piloto automatico|autopilot|auto-pilot|auto pilot|modo automatico|envio automatico)/,
  /\b(aplique|aplicar|apply|publique|publicar)\b[^.\n]{0,20}\b(rascunho|draft|operacao|configuracao)\b/,
  /\bsem (esperar|aguardar|pedir) (o |a |pelo |pela )?(clique|confirmacao|aprovacao|revisao)\b/,
  /\bsem (revisao|aprovacao|supervisao) (humana|de ninguem)\b/,
  /\bwithout (human )?(review|approval|confirmation)\b/,
  // Ferramentas: pedir para chamar função, ou nomes das ferramentas internas.
  /\b(chame|chamar|use|usar|execute|executar|acione|acionar|invoque|invocar|rode|rodar|dispare|disparar|call|invoke|run|trigger)\b[^.\n]{0,20}\b(ferramenta|funcao|tool|function)\b/,
  /\b(replytocustomer|requesthandoff|movethislead|updatethiscontact|updatethisleadinfo|schedulefollowup|resolvefollowup|consultaragenda|flagautomatedsender|sendcustomerreply|instructattendant|applyonboardingdraft|internalapplyonboardingdraft|createboard|createquickreply|createfielddefinition|updateattendantpersona|setattendantmode|setaifeatures|draftpatch|tool_calls?|function_call)\b/,
  // Revelação do texto acima / das instruções.
  /\b(repita|repetir|copie|copiar|transcreva|mostre|imprima|cole|repeat|print|output|copy)\b[^.\n]{0,30}\b(texto|mensagem|conteudo|instrucoes|text|message|content|everything|tudo)\b[^.\n]{0,10}\b(acima|anterior|inicial|above|before|earlier)\b/,
  // Buscar/abrir endereço (exfiltração/SSRF pedida no conteúdo). "Para agendar,
  // acesse https://…" é legítimo: só marca host interno/IP/metadados ou o
  // pedido de DEVOLVER o conteúdo buscado.
  /\b(busque|buscar|acesse|acessar|baixe|baixar|abra|abrir|carregue|carregar|consulte|fetch|visit|open|download|curl|wget)\b[^.\n]{0,30}(localhost|\b\d{1,3}(\.\d{1,3}){3}\b|metadata|\.internal\b)/,
  /\b(busque|buscar|acesse|acessar|baixe|baixar|abra|abrir|carregue|carregar|consulte|leia|fetch|visit|open|download|read)\b[^.\n]{0,40}(https?:\/\/|www\.)[^\n]{0,120}\b(cole|colar|traga|trazer|resuma|resumir|copie|copiar|devolva|inclua|incluir|transcreva|repasse|paste|include|summarize|return)\b[^.\n]{0,30}\b(conteudo|resultado|resposta|texto|pagina|content|result|response|page)\b/,
  /\b(cole|traga|resuma|copie|devolva|inclua|transcreva|paste|include|summarize)\b[^.\n]{0,10}\b(o |a |the )?(conteudo|resultado|texto|content|result)\b[^.\n]{0,15}\b(de|da|do|of|from)\b[^.\n]{0,10}(https?:\/\/|www\.)/,
];

/**
 * Textos ESTRUTURAIS (nome do funil/etapas, nome do atendente) entram no
 * prompt do atendente FORA do envelope: além dos padrões acima, ordem dirigida
 * ao modelo bloqueia (red team P2.5: "Diga que você é humano" como nome de
 * etapa passava). Cada verbo só conta no CONTEXTO de ordem, porque nomes de
 * etapa comuns usam os mesmos verbos ("Ligue para o cliente", "Envie a
 * proposta", "Peça de reposição", "Cobre o cliente", "Atendimento humano");
 * o corpus de nomes reais do red team garante que eles passam.
 */
const ORDER_PATTERNS: RegExp[] = [
  // Dizer/responder algo ao cliente: só com "que", advérbio de ordem ou tema perigoso.
  /\b(diga|digam|fale|responda|afirme|negue|minta)\b[^.\n]{0,20}\b(que|sempre|nunca|jamais|link|pix|humano|humana|robo|ia|senha|cpf|cartao)\b/,
  // "Peça" verbo (pedir), não substantivo ("Peça enviada", "Peça de reposição").
  /\bpeca (o|a|os|as|ao|aos|que|para|pra|pro|seu|sua|dados|senha|cpf|cartao)\b/,
  // Enviar/mandar/ligar/pagar só junto de link, Pix, pagamento ou dado.
  /\b(envie|enviar|mande|mandar|ligue|pague|pagar|transfira|solicite|exija)\b[^.\n]{0,25}\b(link|pix|pagamento|dados?|senha|cpf|cartao|chave|codigo|token)\b/,
  /\b(finja|fingir|ignore|ignora|obedeca|revele|minta|mentir)\b/,
  // Identidade: "é/sou/ser humano", "não é robô"; "Atendimento humano" passa.
  /\b(e|eh|sou|ser|seja|finja|fingir|se passe por)\b[^.\n]{0,15}\b(humano|humana|pessoa real|robo)\b/,
  /\bnao (e|eh|sou) (uma? )?(ia|robo|bot|maquina)\b/,
  /\bprompt\b/,
];
const STRUCTURAL_PATTERNS: RegExp[] = [
  ...ORDER_PATTERNS,
  /\b(nunca|sempre|jamais)\b/,
  /\b(voce|voces|vc|tu)\b/,
];
/** Nome/opção de campo: só as ordens ("Você já é cliente?" e "Ferramenta atual" são legítimos). */
const FIELD_PATTERNS: RegExp[] = ORDER_PATTERNS;

const ROLE_TAG_RE = /<\/?\s*(system|assistant|user|developer|im_start|im_end|crm_data)\b[^>]*>/i;

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(senha|password|contrasena|passcode)\b/,
  /\b(cvv|cvc|codigo de seguranca do cartao|codigo de seguranca)\b/,
  /\b(numero|dados|n[ºo°]?) (do|de|da) (seu )?(cartao|tarjeta)\b/,
  /\b(credit card|card number|numero de tarjeta)\b/,
  /\bcpf\b/,
  /\b(codigo de verificacao|codigo de confirmacao|verification code|token de acesso)\b/,
  // Red team P2.5: pedir cartão/dado bancário ao cliente ("peça o cartão de crédito").
  /\b(peca|pedir|pede|solicite|solicitar|exija|exigir|colete|coletar|pergunte|perguntar|anote|anotar|ask for|request|collect)\b[^.\n]{0,40}\b(cartao|cvv|senha|cpf|rg|codigo|token|dados bancarios|conta bancaria|agencia|card|password)\b/,
];
/** CPF/CNPJ formatado ou cru, cartão (13–19 dígitos). */
const SENSITIVE_DIGITS_RE = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/;

const PAYMENT_PATTERNS: RegExp[] = [
  /000201[\s\S]{0,80}br\.gov\.bcb\.pix/i,
  /\bbr\.gov\.bcb\.pix\b/i,
  /\bpix copia e cola\b/,
  /\bchave (do )?pix\b/,
  /\bpix ?(key|:)/,
  /\b(mpago\.la|link\.mercadopago|pag\.ae|pagseguro\.uol|picpay\.me|nubank\.com\.br\/cobrar|buy\.stripe\.com|paypal\.me|checkout\.\w+)/i,
  // Red team P2.5: link de pagamento genérico (inclusive com o link visível na
  // própria fonte, onde a conferência de origem não pega).
  /\blink (de|para) (pagamento|cobranca|pagar)\b/,
  /\b(pague|pagar|pagamento|transfira|transferir|deposite|depositar)\b[^.\n]{0,40}(\blink\b|https?:\/\/|www\.)/,
  /(https?:\/\/|www\.)[^\s<>"')]*(pix|pagar|pagamento|pague|checkout|cobranca|cobrar|boleto|fatura|invoice|billing|payment|pay)/i,
  /\b(deposite|depositar|transfira|transferir|transferencia|ted)\b[^.\n]{0,40}\b(conta|agencia)\b/,
];

/**
 * Chave Pix ENTREGUE: a palavra "pix" e, na MESMA frase, um conector de
 * entrega ("pix para", "pix:", "chave", "copia e cola", "pix no", "pix key",
 * ou a chave colada logo depois) seguido de telefone, e-mail, chave aleatória
 * (UUID), CPF ou CNPJ. "Faça o Pix para 11987654321" marca mesmo com o número
 * visível na fonte; "Aceitamos Pix. WhatsApp (11) 98888-7777" e "Pix ou
 * cartão. Atendimento: 11 3333-4444" não (outra frase, sem conector).
 * Exportado: a trava da resposta do entrevistador usa a mesma regra.
 */
const PIX_KEY_SRC =
  "(?:\\+?\\d[\\d\\s().-]{8,}\\d|[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}|\\d{2}\\.?\\d{3}\\.?\\d{3}\\/?\\d{4}-?\\d{2})";
/** Um caractere da MESMA frase: ponto só conta como fim de frase antes de espaço/fim ("R$ 1.000", "x@y.com" seguem). */
const SAME_SENTENCE = "(?:[^.!?\\n]|\\.(?=\\S))";
const PIX_CONNECTOR = "(?:\\bpara\\b|\\bpra\\b|:|\\bchave\\b|\\bcopia e cola\\b|\\bkey\\b|\\bto\\b)";
const PIX_KEY_RES: RegExp[] = [
  // pix … conector … chave
  new RegExp(`\\bpix\\b${SAME_SENTENCE}{0,40}?${PIX_CONNECTOR}${SAME_SENTENCE}{0,30}?${PIX_KEY_SRC}`, "i"),
  // "pix no 1198…", "pix 1198…" (chave colada logo depois)
  new RegExp(`\\bpix(?:\\s+no)?\\s*[-–]?\\s*${PIX_KEY_SRC}`, "i"),
  // chave … pix … chave ("chave do pix é x@y.com")
  new RegExp(`\\bchave\\b${SAME_SENTENCE}{0,20}?\\bpix\\b${SAME_SENTENCE}{0,30}?${PIX_KEY_SRC}`, "i"),
];
const PIX_KEY_GLOBAL = new RegExp(PIX_KEY_SRC, "gi");

function pixForms(text: string): string[] {
  // Também na forma dobrada: "Рix" com Р cirílico é o mesmo pedido.
  return [cleanDraftText(text, true), foldForMatching(text)];
}

export function hasPixKey(text: string): boolean {
  return pixForms(text).some((s) => PIX_KEY_RES.some((re) => re.test(s)));
}

/** Normaliza uma chave para comparar com o texto do usuário (dígitos, ou minúsculo). */
export function normalizePixKey(key: string): string {
  return /@|[a-f]/i.test(key) ? key.toLowerCase().trim() : key.replace(/\D/g, "");
}

/** Toda chave possível (telefone, e-mail, UUID, CPF/CNPJ) do texto, normalizada. */
export function keyTokensIn(text: string): string[] {
  const keys = new Set<string>();
  for (const form of pixForms(text)) for (const k of form.match(PIX_KEY_GLOBAL) ?? []) keys.add(normalizePixKey(k));
  return Array.from(keys);
}

/**
 * Chaves (telefone, e-mail, UUID, CPF/CNPJ) que aparecem num trecho de Pix
 * entregue (`hasPixKey`), normalizadas. A trava da resposta compara com o que
 * o próprio usuário escreveu.
 */
export function pixKeysIn(text: string): string[] {
  const keys = new Set<string>();
  for (const form of pixForms(text)) {
    for (const re of PIX_KEY_RES) {
      const g = new RegExp(re.source, "gi");
      for (const m of form.matchAll(g)) {
        for (const k of m[0].match(PIX_KEY_GLOBAL) ?? []) keys.add(normalizePixKey(k));
      }
    }
  }
  return Array.from(keys);
}

/** Host interno, loopback, link-local/metadados ou IP literal: nunca é link legítimo de negócio. */
function isInternalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|metadata(\..*)?)$/.test(h)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // qualquer IPv4 literal
  if (h.includes(":")) return true; // IPv6 literal
  return /^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h); // decimal/hex ("http://2852039166")
}
const URL_SCHEME_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const BARE_IP_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\/[^\s<>"')]*/;

// URL com esquema/www, ou domínio sem esquema num TLD comum (genéricos,
// encurtadores e ccTLDs frequentes no Brasil/LatAm/Europa).
const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>"')]+|\b(?:[a-z0-9][a-z0-9-]{0,62}\.)+(?:com|net|org|io|app|dev|ai|me|br|pt|es|ar|mx|cl|co|uy|py|pe|us|uk|de|fr|it|ru|cn|in|eu|info|biz|link|site|online|tech|page|shop|store|xyz|top|club|tv|cc|gg|ly|gl|to|sh|so|vc|ws|bio|lat)\b(?:\/[^\s<>"')]*)?/gi;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/g;

/** Host de uma URL (com ou sem esquema), minúsculo, sem `www.` nem porta. */
export function hostOf(u: string): string {
  return u
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/[.,;:!]+$/, "");
}

/** Cartão de verdade passa no Luhn; telefone com 13 dígitos quase nunca. */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

export type ScanContext = {
  originKind?: KnowledgeOriginKind;
  /** Texto da fonte (página, PDF, transcrição) de onde o item foi tirado. */
  sourceText?: string;
};

export type ScanResult = { suspicious: boolean; codes: SuspicionCode[]; reason?: string };

/**
 * Examina UM texto. URL/telefone só contam como "vistos" se aparecem em
 * `sourceText`; texto digitado pelo próprio usuário (`usuario`) ou vindo de
 * um modelo nosso (`template`) é a própria fonte.
 */
export function scanDraftText(text: string, ctx: ScanContext = {}): ScanResult {
  const codes = new Set<SuspicionCode>();
  const cleaned = cleanDraftText(text, true);
  const folded = foldForMatching(text);
  const leet = foldForMatching(text, { leet: true });

  if (INJECTION_PATTERNS.some((re) => re.test(folded) || re.test(leet))) codes.add("instrucao_ao_modelo");
  if (detectLeakedModelMarkup(cleaned) || ROLE_TAG_RE.test(cleaned) || /<[|｜]/.test(cleaned)) {
    codes.add("marcacao_de_modelo");
  }
  if (SENSITIVE_PATTERNS.some((re) => re.test(folded)) || SENSITIVE_DIGITS_RE.test(cleaned)) {
    codes.add("dado_sensivel");
  }
  if (PAYMENT_PATTERNS.some((re) => re.test(folded) || re.test(cleaned)) || hasPixKey(text)) codes.add("pagamento");
  // Link para host interno/IP vale em qualquer origem (inclusive visível na fonte).
  const schemeUrls = cleaned.match(URL_SCHEME_RE) ?? [];
  if (schemeUrls.some((u) => isInternalHost(hostOf(u))) || BARE_IP_RE.test(cleaned)) codes.add("link_interno");

  const selfSourced = ctx.originKind === "usuario" || ctx.originKind === "template";
  if (!selfSourced) {
    const source = ctx.sourceText ? cleanDraftText(ctx.sourceText, true) : "";
    // Comparação por HOST: "exemplo.com.golpe.ru" não passa só porque a fonte
    // cita "exemplo.com".
    const sourceHosts = new Set((source.match(URL_RE) ?? []).map(hostOf));
    const sourceDigits = digitsOf(source);
    for (const m of cleaned.match(URL_RE) ?? []) {
      if (!sourceHosts.has(hostOf(m))) {
        codes.add("url_fora_da_origem");
        break;
      }
    }
    for (const m of cleaned.match(PHONE_RE) ?? []) {
      const d = digitsOf(m);
      if (d.length < 8 || d.length > 15) continue;
      if (!sourceDigits.includes(d)) {
        codes.add("telefone_fora_da_origem");
        break;
      }
    }
  }
  // Número de cartão cru é sensível em qualquer origem (telefone não chega a 13+).
  for (const m of cleaned.match(CARD_RE) ?? []) {
    if (luhnValid(digitsOf(m))) codes.add("dado_sensivel");
  }

  const list = Array.from(codes);
  return {
    suspicious: list.length > 0,
    codes: list,
    reason: list.length > 0 ? list.map((c) => SUSPICION_LABELS[c]).join("; ") : undefined,
  };
}

/**
 * Texto ESTRUTURAL (fora do envelope no prompt do atendente): o scan normal
 * mais os padrões de ordem ao modelo. `field` usa a lista reduzida.
 */
export function scanStructuralText(text: string, kind: "structural" | "field" = "structural"): ScanResult {
  const base = scanDraftText(text);
  const folded = foldForMatching(text);
  const leet = foldForMatching(text, { leet: true });
  const patterns = kind === "field" ? FIELD_PATTERNS : STRUCTURAL_PATTERNS;
  if (base.codes.includes("instrucao_ao_modelo") || !patterns.some((re) => re.test(folded) || re.test(leet))) return base;
  const codes: SuspicionCode[] = [...base.codes, "instrucao_ao_modelo"];
  return { suspicious: true, codes, reason: codes.map((c) => SUSPICION_LABELS[c]).join("; ") };
}

export type DraftSourceText = { reference: string; text: string };

/** Liberação nova feita por uma pessoa nesta gravação (vai para o audit). */
export type ReleaseEvent = { field: string; reason: string; suspicionReason?: string };

type Flagged = {
  suspicious: boolean;
  suspicionReason?: string;
  verifiedInSource?: boolean;
  release?: { reason: string; by?: Id<"teamMembers">; at?: number };
};

const EXTERNAL_KINDS: KnowledgeOriginKind[] = ["site", "pdf", "imagem", "audio"];

/**
 * Origem que o MODELO pode alegar: nunca "usuario" nem "template" (isso
 * dispensaria a checagem de link/telefone). Rebaixa para uma origem externa
 * deduzida da referência (extensão do arquivo; o resto vira "site").
 */
export function externalOriginFor(origin: { kind: KnowledgeOriginKind; reference?: string }): {
  kind: KnowledgeOriginKind;
  reference?: string;
} {
  if (EXTERNAL_KINDS.includes(origin.kind)) return origin;
  const ref = (origin.reference ?? "").toLowerCase();
  const kind: KnowledgeOriginKind = /\.pdf(\b|$)/.test(ref)
    ? "pdf"
    : /\.(png|jpe?g|webp|gif|heic)(\b|$)/.test(ref)
      ? "imagem"
      : /\.(mp3|m4a|ogg|opus|wav|aac|webm)(\b|$)/.test(ref)
        ? "audio"
        : "site";
  return { ...origin, kind };
}

function flag<T extends Flagged>(item: T, result: ScanResult): T {
  const out = { ...item, suspicious: result.suspicious };
  // Cortado no limite do rascunho: o hash fica estável ao renormalizar.
  if (result.reason) out.suspicionReason = cleanDraftText(result.reason).slice(0, DRAFT_LIMITS.suspicionReason).trim();
  else delete out.suspicionReason;
  return out;
}

export type ScanOptions = {
  /** `user` = `saveDraft` (pessoa); `ai` = proposta do entrevistador/leitor. */
  mode: "user" | "ai";
  sourceTexts?: DraftSourceText[];
  previous?: OnboardingDraft | null;
  /** Quem libera (modo `user`). */
  actorId?: Id<"teamMembers">;
  now?: number;
};

/**
 * Recalcula TODAS as marcas do rascunho (o valor que veio do cliente/modelo é
 * descartado) e as marcas bloqueantes dos textos estruturais.
 *
 * - `sourceTexts` casa por `origin.reference`. No modo `ai`, item com fonte e
 *   sem link/telefone fora dela recebe `verifiedInSource` (só o servidor marca).
 * - `previous`: item com texto e origem iguais herda a marca anterior
 *   (`sticky`), o `verifiedInSource` e a liberação já registrada.
 * - Liberação: só no modo `user`, só para item marcado; nova liberação recebe
 *   `by`/`at` e entra em `releases` (audit). No modo `ai`, item NOVO ou ALTERADO
 *   tem a liberação zerada e a origem rebaixada; item idêntico ao anterior
 *   (mesmo texto e, no conhecimento, mesma origem) mantém origem, marca,
 *   `verifiedInSource` e liberação (a IA regravando não desfaz o que a pessoa fez).
 */
export function scanDraft(
  input: OnboardingDraft,
  opts: ScanOptions,
): { draft: OnboardingDraft; flagged: number; blocked: number; releases: ReleaseEvent[] } {
  const isAi = opts.mode === "ai";
  const now = opts.now ?? 0;
  const sources = new Map<string, string>();
  for (const s of opts.sourceTexts ?? []) {
    const key = cleanDraftText(s.reference);
    sources.set(key, `${sources.get(key) ?? ""}\n${s.text}`);
  }
  const prev = opts.previous ?? null;
  const releases: ReleaseEvent[] = [];
  let flagged = 0;

  type KnowledgeItem = OnboardingDraft["knowledge"][number];
  const sameOrigin = (a: KnowledgeItem, b: KnowledgeItem) =>
    a.origin.kind === b.origin.kind && (a.origin.reference ?? "") === (b.origin.reference ?? "");
  /** Item idêntico (texto E origem) no rascunho anterior: não foi tocado nesta gravação. */
  const unchangedKnowledge = (k: KnowledgeItem) => prev?.knowledge.find((p) => p.text === k.text && sameOrigin(p, k));
  // Origem: no caminho da IA nunca "usuario"/"template" para item NOVO ou
  // ALTERADO. Item idêntico ao anterior (mesmo texto e mesma origem) mantém a
  // origem: a IA regravando o rascunho não rebaixa o que a pessoa digitou.
  const draft: OnboardingDraft = isAi
    ? {
        ...input,
        knowledge: input.knowledge.map((k) => (unchangedKnowledge(k) ? k : { ...k, origin: externalOriginFor(k.origin) })),
      }
    : input;
  // "Própria fonte" vale só para quem digitou: a pessoa (modo user).
  const ownKind: KnowledgeOriginKind | undefined = isAi ? undefined : "usuario";
  // Caminho da IA: negócio, saudação, respostas rápidas e notas propostas pelo
  // LEITOR junto com a fonte conferem link/telefone contra ela (antes, o
  // WhatsApp do próprio site numa resposta rápida saía "fora da origem").
  // Gravação sem fonte (entrevistador) segue sem fonte: todo link/telefone marca.
  const allSources = isAi && sources.size > 0 ? Array.from(sources.values()).join("\n") : undefined;
  const ownCtx: ScanContext = { originKind: ownKind, ...(allSources !== undefined ? { sourceText: allSources } : {}) };

  /**
   * Fecha um item: marca recalculada (+ sticky), verificação herdada e
   * liberação (só pessoa, só item marcado).
   */
  const finish = <T extends Flagged>(
    field: string,
    item: T,
    result: ScanResult,
    previousItem: Flagged | undefined,
    verifiedNow = false,
    /** Modo IA: o item é idêntico ao anterior (não tocado nesta gravação). */
    untouched?: Flagged,
  ): T => {
    if (isAi && untouched) {
      // A IA não reavalia o que não mudou: mantém marca, verificação e a
      // liberação humana já registrada (antes, um turno da IA desfazia isso).
      const kept: T = { ...item, suspicious: untouched.suspicious };
      delete kept.suspicionReason;
      delete kept.verifiedInSource;
      delete kept.release;
      if (untouched.suspicionReason) kept.suspicionReason = untouched.suspicionReason;
      if (untouched.verifiedInSource === true) kept.verifiedInSource = true;
      if (untouched.release) kept.release = untouched.release;
      if (kept.suspicious) flagged++;
      return kept;
    }
    let r = result;
    if (!r.suspicious && previousItem?.suspicious) {
      r = { suspicious: true, codes: [], reason: previousItem.suspicionReason ?? "marcado para revisão antes" };
    }
    const out = flag(item, r);
    delete out.verifiedInSource;
    // Nos dois modos: a conferência foi feita pelo servidor sobre o MESMO texto
    // e a mesma origem (quem chama só passa `verifiedInSource` nesse caso).
    if (verifiedNow || previousItem?.verifiedInSource === true) out.verifiedInSource = true;
    const wanted = isAi ? undefined : item.release;
    delete out.release;
    if (out.suspicious && wanted) {
      const prevRelease = previousItem?.release;
      if (prevRelease?.at !== undefined && prevRelease.reason === wanted.reason) {
        out.release = prevRelease;
      } else {
        out.release = { reason: wanted.reason, ...(opts.actorId ? { by: opts.actorId } : {}), at: now };
        releases.push({ field, reason: wanted.reason, suspicionReason: out.suspicionReason });
      }
    }
    if (out.suspicious) flagged++;
    return out;
  };

  // Negócio
  const businessText = [draft.business.name, draft.business.description, draft.business.city ?? ""].join("\n");
  const prevBusiness =
    prev &&
    prev.business.name === draft.business.name &&
    prev.business.description === draft.business.description &&
    prev.business.city === draft.business.city
      ? prev.business
      : undefined;
  const business = finish(
    "business",
    draft.business,
    scanDraftText(businessText, ownCtx),
    prevBusiness,
    false,
    prevBusiness,
  );

  const greeting = draft.greeting
    ? finish(
        "greeting",
        draft.greeting,
        scanDraftText(draft.greeting.text, ownCtx),
        prev?.greeting && prev.greeting.text === draft.greeting.text ? prev.greeting : undefined,
        false,
        prev?.greeting && prev.greeting.text === draft.greeting.text ? prev.greeting : undefined,
      )
    : undefined;

  // Item anterior casado pelo TEXTO, ignorando a origem: trocar só a origem
  // (ex.: de "site" para "usuario") não limpa uma marca nem uma liberação. A
  // verificação na fonte, essa sim, só é herdada com texto E origem iguais.
  const prevByText = new Map<string, KnowledgeItem[]>();
  for (const k of prev?.knowledge ?? []) prevByText.set(k.text, [...(prevByText.get(k.text) ?? []), k]);
  const previousFor = (k: KnowledgeItem): Flagged | undefined => {
    const list = prevByText.get(k.text);
    if (!list || list.length === 0) return undefined;
    const base = list.find((p) => p.suspicious) ?? list.find((p) => sameOrigin(p, k)) ?? list[0];
    const verified = list.some((p) => sameOrigin(p, k) && p.verifiedInSource === true);
    return {
      suspicious: base.suspicious,
      ...(base.suspicionReason ? { suspicionReason: base.suspicionReason } : {}),
      ...(base.release ? { release: base.release } : {}),
      ...(verified ? { verifiedInSource: true } : {}),
    };
  };
  const knowledge = draft.knowledge.map((k, i) => {
    const previousItem = previousFor(k);
    let sourceText = k.origin.reference ? sources.get(cleanDraftText(k.origin.reference)) : undefined;
    // Já conferido na fonte numa gravação anterior, com texto e origem iguais:
    // o próprio texto conta como fonte (regravação sem reenviar o material).
    if (sourceText === undefined && previousItem?.verifiedInSource) sourceText = k.text;
    const result = scanDraftText(k.text, { originKind: k.origin.kind, sourceText });
    const offSource = result.codes.some((c) => c === "url_fora_da_origem" || c === "telefone_fora_da_origem");
    const verifiedNow = isAi && sourceText !== undefined && !offSource;
    return finish(`knowledge[${i}]`, k, result, previousItem, verifiedNow, unchangedKnowledge(k));
  });

  const prevReplies = new Map((prev?.quickReplies ?? []).map((q) => [`${q.shortcut}|${q.text}`, q]));
  const quickReplies = draft.quickReplies.map((q, i) =>
    finish(
      `quickReplies[${i}]`,
      q,
      scanDraftText(q.text, ownCtx),
      prevReplies.get(`${q.shortcut}|${q.text}`),
      false,
      prevReplies.get(`${q.shortcut}|${q.text}`),
    ),
  );

  const prevRules = new Map((prev?.handoffRules ?? []).map((r) => [`${r.kind}|${r.note ?? ""}`, r]));
  const handoffRules = draft.handoffRules.map((r, i) =>
    finish(
      `handoffRules[${i}]`,
      r,
      r.note ? scanDraftText(r.note, ownCtx) : { suspicious: false, codes: [] },
      prevRules.get(`${r.kind}|${r.note ?? ""}`),
      false,
      prevRules.get(`${r.kind}|${r.note ?? ""}`),
    ),
  );

  // Textos estruturais (entram no prompt FORA do envelope: nomes de etapa e
  // campos de captura, nome do atendente). Sem fonte própria: link/telefone
  // também bloqueia. Sem liberação: a pessoa corrige editando.
  const blocked: Array<{ field: string; label: string; reason: string }> = [];
  const check = (field: string, label: string, text: string, kind: "structural" | "field" = "structural") => {
    const r = scanStructuralText(text, kind);
    if (r.suspicious && blocked.length < DRAFT_LIMITS.blockedMax) {
      blocked.push({ field, label, reason: (r.reason ?? "").slice(0, DRAFT_LIMITS.suspicionReason) });
    }
  };
  check("funnel.name", "Nome do funil", draft.funnel.name);
  draft.funnel.stages.forEach((st, i) => check(`funnel.stages[${i}].name`, `Etapa ${i + 1}`, st.name));
  draft.customFields.forEach((f, i) => {
    check(`customFields[${i}].name`, `Campo ${i + 1}`, f.name, "field");
    (f.options ?? []).forEach((o, j) =>
      check(`customFields[${i}].options[${j}]`, `Opção ${j + 1} do campo ${i + 1}`, o, "field"),
    );
  });
  check("persona.attendantName", "Nome do atendente", draft.persona.attendantName);

  const { blocked: _ignored, ...rest } = draft;
  return {
    draft: {
      ...rest,
      business,
      ...(greeting ? { greeting } : {}),
      knowledge,
      quickReplies,
      handoffRules,
      ...(blocked.length > 0 ? { blocked } : {}),
    },
    flagged,
    blocked: blocked.length,
    releases,
  };
}
