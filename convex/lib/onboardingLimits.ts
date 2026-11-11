/**
 * Tetos de arquivo do onboarding por conversa (módulo neutro: pode ser
 * importado por código do runtime padrão e por actions "use node").
 *
 * `ONBOARDING_PDF_MAX_BYTES` é a ÚNICA fonte do teto de PDF do onboarding:
 * a validação do anexo do turno (`onboardingChat`), a extração
 * (`PDF_LIMITS.maxBytes`, que vale também para `internalFetchAndExtract` por
 * URL ou por storageId) e as mensagens usam este valor. O teto de PDF dos
 * anexos do inbox (`fileValidation.ts`, 20 MB) é outro fluxo e outra
 * constante; coincidem hoje, mas não são acoplados.
 */
export const ONBOARDING_PDF_MAX_MB = 20;
export const ONBOARDING_PDF_MAX_BYTES = ONBOARDING_PDF_MAX_MB * 1024 * 1024;
