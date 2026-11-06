/**
 * Formulário do painel de contato: tipo, conversão contato -> formulário e
 * formulário -> argumentos de `updateContact`. Puro, sem Convex.
 */

export interface ContactForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  whatsappNumber: string;
  telegramUsername: string;
  tags: string;
  bio: string;
  linkedinUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  twitterUrl: string;
  city: string;
  state: string;
  country: string;
  industry: string;
  companySize: string;
  cnpj: string;
  companyWebsite: string;
  preferredContactTime: string;
  deviceType: string;
  /** Idioma preferido (tradução automática); "" = não definido. */
  preferredLanguage: string;
  utmSource: string;
  acquisitionChannel: string;
  instagramFollowers: string;
  linkedinConnections: string;
  socialInfluenceScore: string;
  customFields: Record<string, unknown>;
}

/** Contato vindo de `getContactWithLeads` (retorno `v.any()`): só lemos o que precisamos. */
type ContactLike = Record<string, any>;

const numberToText = (n: unknown): string => (n != null ? String(n) : "");

export function contactToForm(c: ContactLike): ContactForm {
  return {
    firstName: c.firstName || "",
    lastName: c.lastName || "",
    email: c.email || "",
    phone: c.phone || "",
    company: c.company || "",
    title: c.title || "",
    whatsappNumber: c.whatsappNumber || "",
    telegramUsername: c.telegramUsername || "",
    tags: (c.tags || []).join(", "),
    bio: c.bio || "",
    linkedinUrl: c.linkedinUrl || "",
    instagramUrl: c.instagramUrl || "",
    facebookUrl: c.facebookUrl || "",
    twitterUrl: c.twitterUrl || "",
    city: c.city || "",
    state: c.state || "",
    country: c.country || "",
    industry: c.industry || "",
    companySize: c.companySize || "",
    cnpj: c.cnpj || "",
    companyWebsite: c.companyWebsite || "",
    preferredContactTime: c.preferredContactTime || "",
    deviceType: c.deviceType || "",
    preferredLanguage: c.preferredLanguage || "",
    utmSource: c.utmSource || "",
    acquisitionChannel: c.acquisitionChannel || "",
    instagramFollowers: numberToText(c.instagramFollowers),
    linkedinConnections: numberToText(c.linkedinConnections),
    socialInfluenceScore: numberToText(c.socialInfluenceScore),
    customFields: c.customFields || {},
  };
}

/** "cliente, vip,, " -> ["cliente", "vip"]. */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const text = (s: string): string | undefined => s.trim() || undefined;
const count = (s: string): number | undefined => (s ? Number(s) : undefined);

/**
 * Argumentos de `updateContact` (sem o `contactId`): texto vazio vira `undefined`.
 * `preferredLanguage` só viaja quando mudou em relação a `original` (`""`
 * limpa): reenviar o mesmo valor marcaria um idioma detectado como escolha
 * manual no servidor.
 */
export function contactFormToUpdate(form: ContactForm, original?: ContactLike | null) {
  const languageChanged = form.preferredLanguage !== (original?.preferredLanguage ?? "");
  return {
    ...(languageChanged ? { preferredLanguage: form.preferredLanguage } : {}),
    firstName: text(form.firstName),
    lastName: text(form.lastName),
    email: text(form.email),
    phone: text(form.phone),
    company: text(form.company),
    title: text(form.title),
    whatsappNumber: text(form.whatsappNumber),
    telegramUsername: text(form.telegramUsername),
    tags: parseTags(form.tags),
    bio: text(form.bio),
    linkedinUrl: text(form.linkedinUrl),
    instagramUrl: text(form.instagramUrl),
    facebookUrl: text(form.facebookUrl),
    twitterUrl: text(form.twitterUrl),
    city: text(form.city),
    state: text(form.state),
    country: text(form.country),
    industry: text(form.industry),
    companySize: form.companySize || undefined,
    cnpj: text(form.cnpj),
    companyWebsite: text(form.companyWebsite),
    preferredContactTime: form.preferredContactTime || undefined,
    deviceType: form.deviceType || undefined,
    utmSource: text(form.utmSource),
    acquisitionChannel: text(form.acquisitionChannel),
    instagramFollowers: count(form.instagramFollowers),
    linkedinConnections: count(form.linkedinConnections),
    socialInfluenceScore: count(form.socialInfluenceScore),
    customFields: Object.keys(form.customFields).length > 0 ? form.customFields : undefined,
  };
}

/** Quantos valores de `fields` estão preenchidos (contador das seções). */
export function countFilled(fields: ReadonlyArray<string | null | undefined>): number {
  return fields.filter(Boolean).length;
}

export const PREFERRED_TIME_LABELS: Record<string, string> = {
  morning: "Manhã",
  afternoon: "Tarde",
  evening: "Noite",
};
