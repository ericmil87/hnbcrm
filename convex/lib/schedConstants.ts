/**
 * Agenda v2 (módulo `scheduling`): constantes únicas do motor. Puro, sem imports de servidor.
 * Docs: docs/architecture/agenda.md.
 */

/** Teto fixo (min) de duração + folgas de um agendamento: janela `L` da busca por sobreposição. */
export const MAX_BLOCK_MIN = 480;
export const MAX_RESOURCES_PER_ORG = 100;
export const MAX_SERVICES_PER_ORG = 100;
/** Janela máxima de uma busca de horários. */
export const MAX_SEARCH_DAYS = 7;
/** Horários oferecidos por vez ao cliente. */
export const MAX_OFFERS = 3;
/** Validade de uma oferta (`h1`, `h2`…) por conversa. */
export const OFFER_TTL_MS = 30 * 60 * 1000;
/** Só as N últimas ofertas da conversa continuam válidas. */
export const OFFERS_KEPT = 9;

export const DEFAULT_MIN_NOTICE_MIN = 120;
export const DEFAULT_MAX_ADVANCE_DAYS = 60;
export const DEFAULT_GRID_MIN = 30;

/** Passos de grade aceitos em `schedSettings.gridMinutes`. */
export const GRID_MINUTES_OPTIONS = [5, 10, 15, 20, 30, 60] as const;
