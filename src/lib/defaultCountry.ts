/** Helpers de apresentação do "país padrão dos telefones" (DDI assumido). */

/** Bandeira (emoji) a partir do ISO-3166 alpha-2, via indicadores regionais. */
export function countryFlag(iso2: string): string {
  const up = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return "";
  return String.fromCodePoint(...[...up].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** País proposto ao trocar a moeda no assistente (DDI). EUR é ambíguo: sem proposta. */
const CURRENCY_COUNTRY: Record<string, string> = {
  BRL: "55",
  USD: "1",
  CAD: "1",
  AUD: "61",
  GBP: "44",
  MXN: "52",
  ARS: "54",
  CLP: "56",
  COP: "57",
};

/**
 * DDI sugerido para a moeda escolhida. Moeda ambígua (EUR) ou desconhecida
 * mantém o país atual; só o padrão "55" ainda não escolhido é trocado.
 */
export function proposeCountryForCurrency(currency: string, current: string, userPicked: boolean): string {
  const proposed = CURRENCY_COUNTRY[currency];
  if (!proposed) return current;
  if (userPicked && current !== "55") return current;
  return proposed;
}

export function countryLabel(c: { dialCode: string; iso2: string; namePt: string }): string {
  return `${countryFlag(c.iso2)} ${c.namePt} (+${c.dialCode})`;
}
