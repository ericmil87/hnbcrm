/**
 * Catálogo de idiomas da tradução automática (F1). Compartilhado front/back:
 * PURO, sem `ctx` e sem dependência de runtime (o front importa daqui).
 *
 * Códigos BCP-47 curtos. Só português carrega região (pt-BR × pt-PT), porque é
 * a única variante que muda o texto que a equipe escreve. Comparar "mesma
 * língua" ignora a região (`sameLanguage`). O LibreTranslate fala ISO-639-1
 * (`pt`, `es`, `zh`…): `toLibreTranslateCode`/`fromLibreTranslateCode`.
 */
import { v } from "convex/values";
import { splitCountryCode } from "./phone";

export type LanguageInfo = { code: string; namePt: string; nativeName: string };

export const LANGUAGES: readonly LanguageInfo[] = [
  { code: "pt-BR", namePt: "Português (Brasil)", nativeName: "Português (Brasil)" },
  { code: "pt-PT", namePt: "Português (Portugal)", nativeName: "Português (Portugal)" },
  { code: "es", namePt: "Espanhol", nativeName: "Español" },
  { code: "en", namePt: "Inglês", nativeName: "English" },
  { code: "fr", namePt: "Francês", nativeName: "Français" },
  { code: "it", namePt: "Italiano", nativeName: "Italiano" },
  { code: "de", namePt: "Alemão", nativeName: "Deutsch" },
  { code: "nl", namePt: "Holandês", nativeName: "Nederlands" },
  { code: "ja", namePt: "Japonês", nativeName: "日本語" },
  { code: "zh", namePt: "Chinês", nativeName: "中文" },
  { code: "ar", namePt: "Árabe", nativeName: "العربية" },
  { code: "ru", namePt: "Russo", nativeName: "Русский" },
  { code: "ko", namePt: "Coreano", nativeName: "한국어" },
  { code: "tr", namePt: "Turco", nativeName: "Türkçe" },
  { code: "pl", namePt: "Polonês", nativeName: "Polski" },
  { code: "hi", namePt: "Hindi", nativeName: "हिन्दी" },
];

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((l) => l.code);

export const DEFAULT_TEAM_LANGUAGE = "pt-BR";

/** Validador de um código do catálogo (args de funções públicas). */
export const languageCodeValidator = v.union(
  v.literal("pt-BR"),
  v.literal("pt-PT"),
  v.literal("es"),
  v.literal("en"),
  v.literal("fr"),
  v.literal("it"),
  v.literal("de"),
  v.literal("nl"),
  v.literal("ja"),
  v.literal("zh"),
  v.literal("ar"),
  v.literal("ru"),
  v.literal("ko"),
  v.literal("tr"),
  v.literal("pl"),
  v.literal("hi")
);

/** Raiz sem região, minúscula: "pt-BR" → "pt", "ES" → "es", "zh-Hans" → "zh". */
export function baseLanguage(code: string | undefined | null): string {
  return String(code ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
}

/** Mesma língua, ignorando região (pt-BR ≈ pt-PT ≈ pt). Vazio nunca é igual. */
export function sameLanguage(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = baseLanguage(a);
  const y = baseLanguage(b);
  return x !== "" && x === y;
}

/**
 * Normaliza qualquer grafia para um código do catálogo, ou `undefined` quando
 * a língua não é suportada. "pt" sem região vira "pt-BR" (padrão do produto).
 */
export function normalizeLanguageCode(raw: string | undefined | null): string | undefined {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return undefined;
  const exact = LANGUAGE_CODES.find((c) => c.toLowerCase() === trimmed.toLowerCase().replace("_", "-"));
  if (exact) return exact;
  const base = baseLanguage(trimmed);
  if (base === "pt") return /-(pt)$/i.test(trimmed) ? "pt-PT" : "pt-BR";
  return LANGUAGE_CODES.find((c) => c === base);
}

export function isSupportedLanguage(raw: string | undefined | null): boolean {
  return normalizeLanguageCode(raw) !== undefined;
}

export function languageName(code: string | undefined | null): string {
  const norm = normalizeLanguageCode(code);
  return LANGUAGES.find((l) => l.code === norm)?.namePt ?? String(code ?? "");
}

/** Código do LibreTranslate (ISO-639-1). Variante regional some. */
export function toLibreTranslateCode(code: string): string {
  return baseLanguage(code);
}

/** Código do LibreTranslate → catálogo. Fora do catálogo = `undefined`. */
export function fromLibreTranslateCode(code: string | undefined | null): string | undefined {
  const base = baseLanguage(code);
  if (!base) return undefined;
  if (base === "pt") return "pt-BR";
  return LANGUAGE_CODES.find((c) => c === base);
}

/**
 * DDI → idioma PROVÁVEL. Só dica (pré-seleção na UI, "Sugerido pelo número"),
 * nunca decisão: expatriados e turistas existem. Usa a tabela ITU de
 * `lib/phone.ts` para separar o DDI.
 */
const DIAL_CODE_LANGUAGE: Record<string, string> = {
  "55": "pt-BR",
  "351": "pt-PT",
  "244": "pt-PT", // Angola
  "258": "pt-PT", // Moçambique
  "238": "pt-PT", // Cabo Verde
  // Hispanofonia
  "34": "es", "52": "es", "54": "es", "56": "es", "57": "es", "51": "es", "58": "es",
  "591": "es", "593": "es", "595": "es", "598": "es", "502": "es", "503": "es",
  "504": "es", "505": "es", "506": "es", "507": "es", "53": "es",
  // Anglofonia (1 = NANP: EUA/Canadá; Canadá francófono fica como dica errada aceitável)
  "1": "en", "44": "en", "61": "en", "64": "en", "353": "en", "27": "en",
  "33": "fr", "32": "fr", "41": "de", "49": "de", "43": "de",
  "39": "it", "31": "nl", "81": "ja", "86": "zh", "7": "ru", "82": "ko",
  "90": "tr", "48": "pl", "91": "hi",
  "966": "ar", "971": "ar", "20": "ar", "212": "ar", "962": "ar", "974": "ar", "965": "ar",
};

export function languageHintFromDialCode(phone: string | undefined | null): string | undefined {
  if (!phone) return undefined;
  const digits = String(phone).replace(/\D+/g, "");
  if (digits.length < 8) return undefined;
  const split = splitCountryCode(digits);
  if (!split) return undefined;
  return DIAL_CODE_LANGUAGE[split.country];
}

/**
 * `agentProfile.language` pode ser `"auto"` (o atendente 1 a 1 responde no
 * idioma do cliente). Superfícies sem cliente único (grupos, publicações)
 * precisam de um idioma FIXO: `"auto"`/ausente vira pt-BR.
 */
export function fixedAgentLanguage(language: string | undefined | null): string {
  const l = String(language ?? "").trim();
  return !l || l.toLowerCase() === "auto" ? DEFAULT_TEAM_LANGUAGE : l;
}
