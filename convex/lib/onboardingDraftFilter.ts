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
  | "pagamento";

export const SUSPICION_LABELS: Record<SuspicionCode, string> = {
  instrucao_ao_modelo: "parece uma instrução para a IA",
  marcacao_de_modelo: "contém marcação técnica de modelo ou ferramenta",
  url_fora_da_origem: "tem link que não aparece na fonte",
  telefone_fora_da_origem: "tem telefone que não aparece na fonte",
  dado_sensivel: "pede ou contém dado sensível (senha, cartão, CPF)",
  pagamento: "tem chave ou link de pagamento",
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
];

const ROLE_TAG_RE = /<\/?\s*(system|assistant|user|developer|im_start|im_end|crm_data)\b[^>]*>/i;

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(senha|password|contrasena|passcode)\b/,
  /\b(cvv|cvc|codigo de seguranca do cartao|codigo de seguranca)\b/,
  /\b(numero|dados|n[ºo°]?) (do|de|da) (seu )?(cartao|tarjeta)\b/,
  /\b(credit card|card number|numero de tarjeta)\b/,
  /\bcpf\b/,
  /\b(codigo de verificacao|codigo de confirmacao|verification code|token de acesso)\b/,
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
];

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
  if (PAYMENT_PATTERNS.some((re) => re.test(folded) || re.test(cleaned))) codes.add("pagamento");

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
 *   `by`/`at` e entra em `releases` (audit). No modo `ai` é sempre zerada.
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

  // Origem: no caminho da IA nunca "usuario"/"template".
  const draft: OnboardingDraft = isAi
    ? { ...input, knowledge: input.knowledge.map((k) => ({ ...k, origin: externalOriginFor(k.origin) })) }
    : input;
  // "Própria fonte" vale só para quem digitou: a pessoa (modo user).
  const ownKind: KnowledgeOriginKind | undefined = isAi ? undefined : "usuario";

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
  ): T => {
    let r = result;
    if (!r.suspicious && previousItem?.suspicious) {
      r = { suspicious: true, codes: [], reason: previousItem.suspicionReason ?? "marcado para revisão antes" };
    }
    const out = flag(item, r);
    delete out.verifiedInSource;
    if (verifiedNow || (!isAi && previousItem?.verifiedInSource === true)) out.verifiedInSource = true;
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
    scanDraftText(businessText, { originKind: ownKind }),
    prevBusiness,
  );

  const greeting = draft.greeting
    ? finish(
        "greeting",
        draft.greeting,
        scanDraftText(draft.greeting.text, { originKind: ownKind }),
        prev?.greeting && prev.greeting.text === draft.greeting.text ? prev.greeting : undefined,
      )
    : undefined;

  const kKey = (k: OnboardingDraft["knowledge"][number]) => `${k.origin.kind}|${k.origin.reference ?? ""}|${k.text}`;
  const prevKnowledge = new Map((prev?.knowledge ?? []).map((k) => [kKey(k), k]));
  const knowledge = draft.knowledge.map((k, i) => {
    const previousItem = prevKnowledge.get(kKey(k));
    let sourceText = k.origin.reference ? sources.get(cleanDraftText(k.origin.reference)) : undefined;
    // Já conferido na fonte numa gravação anterior e inalterado: o próprio
    // texto conta como fonte (a pessoa regrava sem reenviar o material).
    if (!isAi && sourceText === undefined && previousItem?.verifiedInSource) sourceText = k.text;
    const result = scanDraftText(k.text, { originKind: k.origin.kind, sourceText });
    const offSource = result.codes.some((c) => c === "url_fora_da_origem" || c === "telefone_fora_da_origem");
    const verifiedNow = isAi && sourceText !== undefined && !offSource;
    return finish(`knowledge[${i}]`, k, result, previousItem, verifiedNow);
  });

  const prevReplies = new Map((prev?.quickReplies ?? []).map((q) => [`${q.shortcut}|${q.text}`, q]));
  const quickReplies = draft.quickReplies.map((q, i) =>
    finish(
      `quickReplies[${i}]`,
      q,
      scanDraftText(q.text, { originKind: ownKind }),
      prevReplies.get(`${q.shortcut}|${q.text}`),
    ),
  );

  const prevRules = new Map((prev?.handoffRules ?? []).map((r) => [`${r.kind}|${r.note ?? ""}`, r]));
  const handoffRules = draft.handoffRules.map((r, i) =>
    finish(
      `handoffRules[${i}]`,
      r,
      r.note ? scanDraftText(r.note, { originKind: ownKind }) : { suspicious: false, codes: [] },
      prevRules.get(`${r.kind}|${r.note ?? ""}`),
    ),
  );

  // Textos estruturais (entram no prompt FORA do envelope: nomes de etapa e
  // campos de captura, nome do atendente). Sem fonte própria: link/telefone
  // também bloqueia. Sem liberação: a pessoa corrige editando.
  const blocked: Array<{ field: string; label: string; reason: string }> = [];
  const check = (field: string, label: string, text: string) => {
    const r = scanDraftText(text);
    if (r.suspicious && blocked.length < DRAFT_LIMITS.blockedMax) {
      blocked.push({ field, label, reason: (r.reason ?? "").slice(0, DRAFT_LIMITS.suspicionReason) });
    }
  };
  check("funnel.name", "Nome do funil", draft.funnel.name);
  draft.funnel.stages.forEach((st, i) => check(`funnel.stages[${i}].name`, `Etapa ${i + 1}`, st.name));
  draft.customFields.forEach((f, i) => {
    check(`customFields[${i}].name`, `Campo ${i + 1}`, f.name);
    (f.options ?? []).forEach((o, j) => check(`customFields[${i}].options[${j}]`, `Opção ${j + 1} do campo ${i + 1}`, o));
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
