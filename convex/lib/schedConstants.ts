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

/** Janela (min) em que uma marcação recém-feita ainda pode ser DESFEITA (`undoBooking`). */
export const UNDO_BOOKING_WINDOW_MIN = 10;

export const DEFAULT_MIN_NOTICE_MIN = 120;
export const DEFAULT_MAX_ADVANCE_DAYS = 60;
export const DEFAULT_GRID_MIN = 30;

/** Pendência "sem desfecho" (A4): folga após o fim, hora local do aviso diário, janela de leitura e tetos. */
export const DEFAULT_OUTCOME_GRACE_MIN = 120;
export const DEFAULT_OUTCOME_NOTICE_HOUR = 8;
/** Limites da folga configurável (min). */
export const OUTCOME_GRACE_MIN_LIMITS = { min: 30, max: 720 } as const;
/** O job só olha agendamentos que começaram nos últimos N dias (o mais antigo já foi marcado quando estava na janela). */
export const OUTCOME_LOOKBACK_DAYS = 14;
/** Linhas lidas por página do job, e teto da contagem do aviso diário. */
export const OUTCOME_SCAN_PAGE = 100;
export const OUTCOME_NOTICE_CAP = 200;
export const OUTCOME_ORG_PAGE = 100;
/** Destinatários do aviso diário (mesmo teto das demais notificações da agenda). */
export const OUTCOME_NOTICE_RECIPIENTS_CAP = 25;

/** Passos de grade aceitos em `schedSettings.gridMinutes`. */
export const GRID_MINUTES_OPTIONS = [5, 10, 15, 20, 30, 60] as const;
