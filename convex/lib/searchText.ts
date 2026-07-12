// All optional string fields on a contact that participate in search
export function buildSearchText(contact: {
  firstName?: string; lastName?: string; email?: string; phone?: string;
  company?: string; title?: string; city?: string; state?: string;
  country?: string; industry?: string; bio?: string;
}): string {
  return [
    contact.firstName, contact.lastName, contact.email, contact.phone,
    contact.company, contact.title, contact.city, contact.state,
    contact.country, contact.industry, contact.bio,
  ].filter(Boolean).join(" ");
}
