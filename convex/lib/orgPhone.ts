/**
 * DDI padrão da organização (`organizations.settings.defaultCountryCode`).
 * PURO — importado pelo backend e pela UI (Configurações/onboarding).
 */
import { DEFAULT_COUNTRY_CODE, isKnownCountryCode } from "./phone";

/**
 * DDI a assumir quando um telefone chega SEM código de país. Valor válido
 * (1–3 dígitos e presente na tabela da ITU) → ele; ausente/inválido → "55".
 */
export function resolveDefaultCountry(settings?: { defaultCountryCode?: string } | null): string {
  const code = settings?.defaultCountryCode?.trim();
  if (code && /^\d{1,3}$/.test(code) && isKnownCountryCode(code)) return code;
  return DEFAULT_COUNTRY_CODE;
}

export type SupportedDefaultCountry = { dialCode: string; iso2: string; namePt: string };

/** Países oferecidos no seletor de DDI padrão (vários compartilham o "1"). */
export const SUPPORTED_DEFAULT_COUNTRIES: readonly SupportedDefaultCountry[] = [
  { dialCode: "55", iso2: "BR", namePt: "Brasil" },
  { dialCode: "1", iso2: "US", namePt: "Estados Unidos" },
  { dialCode: "1", iso2: "CA", namePt: "Canadá" },
  { dialCode: "52", iso2: "MX", namePt: "México" },
  { dialCode: "54", iso2: "AR", namePt: "Argentina" },
  { dialCode: "56", iso2: "CL", namePt: "Chile" },
  { dialCode: "57", iso2: "CO", namePt: "Colômbia" },
  { dialCode: "51", iso2: "PE", namePt: "Peru" },
  { dialCode: "598", iso2: "UY", namePt: "Uruguai" },
  { dialCode: "595", iso2: "PY", namePt: "Paraguai" },
  { dialCode: "591", iso2: "BO", namePt: "Bolívia" },
  { dialCode: "593", iso2: "EC", namePt: "Equador" },
  { dialCode: "58", iso2: "VE", namePt: "Venezuela" },
  { dialCode: "351", iso2: "PT", namePt: "Portugal" },
  { dialCode: "34", iso2: "ES", namePt: "Espanha" },
  { dialCode: "33", iso2: "FR", namePt: "França" },
  { dialCode: "49", iso2: "DE", namePt: "Alemanha" },
  { dialCode: "39", iso2: "IT", namePt: "Itália" },
  { dialCode: "44", iso2: "GB", namePt: "Reino Unido" },
  { dialCode: "353", iso2: "IE", namePt: "Irlanda" },
  { dialCode: "31", iso2: "NL", namePt: "Países Baixos" },
  { dialCode: "32", iso2: "BE", namePt: "Bélgica" },
  { dialCode: "41", iso2: "CH", namePt: "Suíça" },
  { dialCode: "61", iso2: "AU", namePt: "Austrália" },
  { dialCode: "64", iso2: "NZ", namePt: "Nova Zelândia" },
  { dialCode: "27", iso2: "ZA", namePt: "África do Sul" },
  { dialCode: "244", iso2: "AO", namePt: "Angola" },
  { dialCode: "258", iso2: "MZ", namePt: "Moçambique" },
  { dialCode: "81", iso2: "JP", namePt: "Japão" },
  { dialCode: "91", iso2: "IN", namePt: "Índia" },
  { dialCode: "971", iso2: "AE", namePt: "Emirados Árabes Unidos" },
  { dialCode: "972", iso2: "IL", namePt: "Israel" },
];
