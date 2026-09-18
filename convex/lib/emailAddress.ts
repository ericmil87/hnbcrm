// Helpers PUROS de endereço de e-mail (sem ctx) — a porta de saída de todo
// envio transacional passa por aqui antes de tocar no Resend.

// Domínios que nunca recebem nada: os reservados pela RFC 2606/6761 e os que os
// nossos seeds usam. `demo.com` é um domínio REAL de terceiro — 80 membros-semente
// apontam para ele, e cada envio viraria bounce na reputação de `mail.hnbcrm.com`.
const UNDELIVERABLE_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "demo.com",
]);
const UNDELIVERABLE_TLDS = new Set(["test", "example", "invalid", "localhost", "local"]);

// Deliberadamente simples: local@dominio.tld, sem espaço, TLD alfabético de 2+
// letras. O banco tem "toni", "fdgfdg@gdffdgf" e "oli@milfont.netdd" gravados —
// o objetivo é barrar isso, não validar a RFC 5322 inteira.
const EMAIL_SHAPE = /^[^\s@<>(),;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}$/;

export function normalizeEmail(raw: string | undefined | null): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** Só o formato — para validar entrada de usuário (convite) sem vetar domínio. */
export function hasEmailShape(raw: string | undefined | null): boolean {
  const email = normalizeEmail(raw);
  return email.length >= 6 && email.length <= 254 && EMAIL_SHAPE.test(email);
}

export function isDeliverableEmail(raw: string | undefined | null): boolean {
  const email = normalizeEmail(raw);
  if (!hasEmailShape(email)) return false;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (UNDELIVERABLE_DOMAINS.has(domain)) return false;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (UNDELIVERABLE_TLDS.has(tld)) return false;
  return true;
}

/** Para log: nunca o endereço inteiro, só o domínio. */
export function maskEmailForLog(raw: string | undefined | null): string {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  return at === -1 ? "***" : `***@${email.slice(at + 1)}`;
}
