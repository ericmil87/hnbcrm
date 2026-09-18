// URL pública do app — fonte ÚNICA para todo link que sai em e-mail ou
// notificação. O fallback antigo (`https://app.hnbcrm.com.br`) estava
// espalhado por 17 call sites e aponta para um host que nem resolve DNS; o
// app de verdade vive na raiz de `hnbcrm.com` (`/entrar`, `/app/*`).
const DEFAULT_APP_URL = "https://hnbcrm.com";

export function appUrl(): string {
  const raw = process.env.APP_URL?.trim();
  if (!raw) return DEFAULT_APP_URL;
  // Barra final duplicaria em `${appUrl()}/app/...`.
  return raw.replace(/\/+$/, "");
}
