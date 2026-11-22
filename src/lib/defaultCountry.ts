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

type CountryRow = { dialCode: string; iso2: string; namePt: string };

/**
 * Valor de cada opção do seletor de país: o ISO do país (único). O DDI não serve de chave porque vários países o
 * dividem ("+1": Estados Unidos e Canadá), o que duplicava a `key` do React.
 */
export function countryOptions(countries: readonly CountryRow[]): Array<{ value: string; label: string }> {
  return countries.map((c) => ({ value: c.iso2, label: countryLabel(c) }));
}

/** ISO do país a mostrar para o DDI gravado: o primeiro da lista com esse DDI (o gravado não distingue EUA de Canadá). */
export function countryIsoForDial(countries: readonly CountryRow[], dialCode: string): string {
  return (countries.find((c) => c.dialCode === dialCode) ?? countries[0])?.iso2 ?? "";
}

/** DDI que vai para a org ao escolher o país `iso2`; ISO desconhecido devolve o DDI atual. */
export function dialCodeForCountryIso(countries: readonly CountryRow[], iso2: string, fallback: string): string {
  return countries.find((c) => c.iso2 === iso2)?.dialCode ?? fallback;
}
