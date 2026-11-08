import { foldForSearch } from "./searchFold";

// All optional string fields on a contact that participate in search.
// Gravado DOBRADO (minúsculas, sem acento: `foldForSearch`) para "antonio"
// achar "Antônio"; quem consulta `search_contacts` dobra o termo também.
export function buildSearchText(contact: {
  firstName?: string; lastName?: string; email?: string; phone?: string;
  company?: string; title?: string; city?: string; state?: string;
  country?: string; industry?: string; bio?: string;
  instagramUsername?: string;
}): string {
  return foldForSearch(
    [
      contact.firstName, contact.lastName, contact.email, contact.phone,
      contact.company, contact.title, contact.city, contact.state,
      contact.country, contact.industry, contact.bio, contact.instagramUsername,
    ].filter(Boolean).join(" ")
  );
}
