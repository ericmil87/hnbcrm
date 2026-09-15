/**
 * Motor de limites das campanhas de WhatsApp — PURO (sem Convex, sem fetch),
 * para ser testado de ponta a ponta.
 *
 * ⚠️ TODOS os números aqui são ESTIMATIVAS DE ENGENHARIA CALIBRÁVEIS, não
 * limites oficiais (ver docs/AI-WHATSAPP-LIMITS.md, addendum 2026-09-08):
 *  - Cloud API: o único número publicado é o tier de destinatários únicos por
 *    24h (250/2k/10k/100k/ilimitado, por portfólio). O default usa 80% do tier
 *    para sobrar espaço ao tráfego transacional do dia.
 *  - Bridge (não-oficial): NADA é publicado. A rampa por idade do número é o
 *    consenso conservador de mercado (Letalk/Umbler/baileys-antiban) — reduz
 *    risco, não elimina. O teto DURO (200/dia) nunca é ultrapassado, nem com
 *    override, porque o driver real do ban é denúncia de quem não pediu contato.
 *
 * Contadores diários usam o dia UTC (mesma convenção de channelPacing.dailyCount).
 */

export type CampaignProvider = "meta" | "bridge";

export interface CampaignPacing {
  minDelaySec: number;
  maxDelaySec: number;
  batchSize: number; // 0 = sem pausa de lote
  batchPauseMin: number;
  maxPerHour: number;
  maxPerDay: number;
  maxNewContactsPerDay?: number;
  respectWarmup?: boolean;
}

export interface CampaignSchedule {
  startAt?: number;
  timezone: string;
  windowStartHour: number; // 0-23
  windowEndHour: number; // 1-24 (exclusivo)
  days: number[]; // 0=Dom … 6=Sáb
}

export interface ChannelPacingCounters {
  campaignDaily?: { day: string; sent: number; newContacts: number };
  campaignHourly?: { hour: string; sent: number };
  campaignFrozenUntil?: number;
}

// ── Tabela de aquecimento do bridge (por idade do número em dias) ──
export interface BridgeWarmupRow {
  fromDay: number;
  toDay: number; // inclusivo; Infinity = aquecido
  maxPerDay: number;
  maxNewContactsPerDay: number;
  minDelaySec: number;
  maxDelaySec: number;
  maxPerHour: number;
}

export const BRIDGE_WARMUP_TABLE: readonly BridgeWarmupRow[] = [
  { fromDay: 1, toDay: 2, maxPerDay: 20, maxNewContactsPerDay: 5, minDelaySec: 45, maxDelaySec: 120, maxPerHour: 10 },
  { fromDay: 3, toDay: 4, maxPerDay: 40, maxNewContactsPerDay: 10, minDelaySec: 40, maxDelaySec: 110, maxPerHour: 15 },
  { fromDay: 5, toDay: 7, maxPerDay: 80, maxNewContactsPerDay: 20, minDelaySec: 35, maxDelaySec: 100, maxPerHour: 20 },
  { fromDay: 8, toDay: 14, maxPerDay: 120, maxNewContactsPerDay: 30, minDelaySec: 30, maxDelaySec: 90, maxPerHour: 30 },
  { fromDay: 15, toDay: Infinity, maxPerDay: 150, maxNewContactsPerDay: 50, minDelaySec: 30, maxDelaySec: 90, maxPerHour: 30 },
];

/** Pausa de lote do bridge: 20 min a cada 30 envios (consenso "≤30/hora"). */
export const BRIDGE_BATCH_SIZE = 30;
export const BRIDGE_BATCH_PAUSE_MIN = 20;

/** Teto DURO do bridge — nunca ultrapassado, nem com override. */
export const BRIDGE_HARD_CAP = {
  maxPerDay: 200,
  maxNewContactsPerDay: 80,
  minDelaySec: 15,
  maxPerHour: 40,
} as const;

/**
 * Bridge: abaixo desta idade (dias) o número é "recém-conectado" — AVISA e o
 * lançamento exige o aceite explícito `newNumberRiskAck`, mas NÃO trava: somos
 * ferramenta, a decisão é de quem opera. Até BRIDGE_WARN_AGE_DAYS, só aviso.
 */
export const BRIDGE_MIN_AGE_DAYS = 3;
export const BRIDGE_WARN_AGE_DAYS = 7;

// ── Cloud API ──
export const META_TIER_LIMITS: Record<string, number> = {
  TIER_250: 250,
  TIER_1K: 1000, // legado (extinto em 07/10/2025), mantido para leitura tolerante
  TIER_2K: 2000,
  TIER_10K: 10000,
  TIER_100K: 100000,
  TIER_UNLIMITED: Number.MAX_SAFE_INTEGER,
};
export const META_DEFAULT_TIER = "TIER_250";
export const META_SAFE_TIER_FRACTION = 0.8;

export function tierLimit(tier: string | undefined): number {
  if (!tier) return META_TIER_LIMITS[META_DEFAULT_TIER];
  const key = tier.toUpperCase();
  if (key in META_TIER_LIMITS) return META_TIER_LIMITS[key];
  // "250" / "2000" numéricos vindos de outra fonte
  const n = Number(key.replace(/\D/g, ""));
  return Number.isFinite(n) && n > 0 ? n : META_TIER_LIMITS[META_DEFAULT_TIER];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Dias desde a conexão do número (1 = conectado hoje). */
export function warmupDayFor(connectedAt: number | undefined, now: number): number {
  if (!connectedAt || connectedAt > now) return 1;
  return Math.max(1, Math.floor((now - connectedAt) / DAY_MS) + 1);
}

export function bridgeWarmupRow(warmupDay: number): BridgeWarmupRow {
  const day = Math.max(1, Math.floor(warmupDay));
  return (
    BRIDGE_WARMUP_TABLE.find((r) => day >= r.fromDay && day <= r.toDay) ??
    BRIDGE_WARMUP_TABLE[BRIDGE_WARMUP_TABLE.length - 1]
  );
}

export interface SafeDefaults {
  pacing: CampaignPacing;
  /** Bridge abaixo da idade recomendada: lançar exige aceite explícito do risco (mensagem). */
  newNumberRisk?: string;
  /** Bridge entre o mínimo e o limiar de aviso. */
  warmupWarning?: string;
  /** Meta: tier resolvido. */
  tier?: string;
}

/** Defaults SEGUROS para o provider/idade/tier informados. */
export function safeDefaultsFor(args: {
  provider: CampaignProvider;
  warmupDay?: number;
  tier?: string;
}): SafeDefaults {
  if (args.provider === "meta") {
    const limit = tierLimit(args.tier);
    const unlimited = limit >= META_TIER_LIMITS.TIER_UNLIMITED;
    const maxPerDay = unlimited ? 100000 : Math.max(1, Math.floor(limit * META_SAFE_TIER_FRACTION));
    const big = limit >= 10000;
    return {
      tier: args.tier ?? META_DEFAULT_TIER,
      pacing: {
        minDelaySec: 1,
        maxDelaySec: 3,
        batchSize: big ? 1000 : 200,
        batchPauseMin: big ? 5 : 30,
        maxPerHour: Math.max(1, Math.min(maxPerDay, big ? 5000 : 200)),
        maxPerDay,
        respectWarmup: false,
      },
    };
  }
  const day = args.warmupDay ?? 1;
  const row = bridgeWarmupRow(day);
  const pacing: CampaignPacing = {
    minDelaySec: row.minDelaySec,
    maxDelaySec: row.maxDelaySec,
    batchSize: BRIDGE_BATCH_SIZE,
    batchPauseMin: BRIDGE_BATCH_PAUSE_MIN,
    maxPerHour: row.maxPerHour,
    maxPerDay: row.maxPerDay,
    maxNewContactsPerDay: row.maxNewContactsPerDay,
    respectWarmup: true,
  };
  const result: SafeDefaults = { pacing };
  if (day < BRIDGE_MIN_AGE_DAYS) {
    result.newNumberRisk = `Número conectado há ${day} dia(s). Disparar num número recém-conectado é o padrão mais banido — o recomendado é esperar ${BRIDGE_MIN_AGE_DAYS} dias de uso normal. Dá para lançar assim mesmo: os limites de aquecimento continuam valendo (${row.maxPerDay}/dia, ${row.maxNewContactsPerDay} contatos novos/dia) e o risco precisa ser aceito na revisão.`;
  } else if (day <= BRIDGE_WARN_AGE_DAYS) {
    result.warmupWarning = `Número conectado há ${day} dias — ainda em aquecimento. Os limites seguros de hoje são ${row.maxPerDay}/dia e ${row.maxNewContactsPerDay} contatos novos/dia.`;
  }
  return result;
}

/** Trava o pacing no teto DURO (sempre aplicado no lançamento). */
export function clampToHardCap(
  pacing: CampaignPacing,
  provider: CampaignProvider,
  tier?: string
): CampaignPacing {
  const p: CampaignPacing = {
    ...pacing,
    minDelaySec: Math.max(0, Math.floor(pacing.minDelaySec)),
    maxDelaySec: Math.max(0, Math.floor(pacing.maxDelaySec)),
    batchSize: Math.max(0, Math.floor(pacing.batchSize)),
    batchPauseMin: Math.max(0, Math.floor(pacing.batchPauseMin)),
    maxPerHour: Math.max(1, Math.floor(pacing.maxPerHour)),
    maxPerDay: Math.max(1, Math.floor(pacing.maxPerDay)),
  };
  if (p.maxDelaySec < p.minDelaySec) p.maxDelaySec = p.minDelaySec;
  if (provider === "bridge") {
    p.maxPerDay = Math.min(p.maxPerDay, BRIDGE_HARD_CAP.maxPerDay);
    p.maxPerHour = Math.min(p.maxPerHour, BRIDGE_HARD_CAP.maxPerHour);
    p.minDelaySec = Math.max(p.minDelaySec, BRIDGE_HARD_CAP.minDelaySec);
    if (p.maxDelaySec < p.minDelaySec) p.maxDelaySec = p.minDelaySec;
    p.maxNewContactsPerDay = Math.min(
      p.maxNewContactsPerDay ?? BRIDGE_HARD_CAP.maxNewContactsPerDay,
      BRIDGE_HARD_CAP.maxNewContactsPerDay
    );
  } else {
    const limit = tierLimit(tier);
    if (limit < META_TIER_LIMITS.TIER_UNLIMITED) {
      p.maxPerDay = Math.min(p.maxPerDay, limit);
    }
    p.maxPerHour = Math.min(p.maxPerHour, p.maxPerDay);
  }
  return p;
}

/** O pacing está dentro da faixa SEGURA para o provider/idade/tier? */
export function isWithinSafeDefaults(
  pacing: CampaignPacing,
  safe: CampaignPacing
): boolean {
  return (
    pacing.maxPerDay <= safe.maxPerDay &&
    pacing.maxPerHour <= safe.maxPerHour &&
    pacing.minDelaySec >= safe.minDelaySec &&
    (pacing.maxNewContactsPerDay ?? Infinity) <= (safe.maxNewContactsPerDay ?? Infinity)
  );
}

/** Delay até o próximo envio (jitter uniforme entre min e max). */
export function nextSendDelayMs(pacing: CampaignPacing, rng: () => number = Math.random): number {
  const min = Math.max(0, pacing.minDelaySec);
  const max = Math.max(min, pacing.maxDelaySec);
  return Math.round((min + rng() * (max - min)) * 1000);
}

// ── Janela de envio (fuso da campanha, sem libs) ──

interface LocalParts {
  weekday: number; // 0=Dom
  hour: number;
  minute: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function safeTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "America/Sao_Paulo";
  }
}

export function localParts(ts: number, timezone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone(timezone),
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hourRaw = Number(get("hour"));
  return {
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(get("minute")) || 0,
  };
}

export function isWithinWindow(schedule: CampaignSchedule, now: number): boolean {
  const { weekday, hour } = localParts(now, schedule.timezone);
  const days = schedule.days.length > 0 ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(weekday)) return false;
  const start = Math.max(0, Math.min(23, schedule.windowStartHour));
  const end = Math.max(start + 1, Math.min(24, schedule.windowEndHour));
  return hour >= start && hour < end;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Próximo instante em que a janela abre (>= now). Avança de hora em hora
 * (alinhado à hora cheia) por até 8 dias; se a janela for impossível (dias
 * vazios é tratado como todos) devolve now + 1h para não travar o worker.
 */
export function nextWindowOpenAt(schedule: CampaignSchedule, now: number): number {
  if (isWithinWindow(schedule, now)) return now;
  let t = now - (now % HOUR_MS) + HOUR_MS;
  for (let i = 0; i < 24 * 8; i++) {
    if (isWithinWindow(schedule, t)) return t;
    t += HOUR_MS;
  }
  return now + HOUR_MS;
}

// ── Tetos por canal (contadores em channelPacing) ──

export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
export function utcHourKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 13);
}

export type CapsResult = { ok: true } | { ok: false; reason: string; retryAt: number };

export function capsExceeded(args: {
  pacing: CampaignPacing;
  counters: ChannelPacingCounters | null | undefined;
  now: number;
  isNewContact: boolean;
}): CapsResult {
  const { pacing, counters, now } = args;
  if (counters?.campaignFrozenUntil && counters.campaignFrozenUntil > now) {
    return {
      ok: false,
      reason: "Canal congelado por sinal de risco (qualidade/sessão)",
      retryAt: counters.campaignFrozenUntil,
    };
  }
  const day = utcDayKey(now);
  const hour = utcHourKey(now);
  const dailySent = counters?.campaignDaily?.day === day ? counters.campaignDaily.sent : 0;
  const dailyNew = counters?.campaignDaily?.day === day ? counters.campaignDaily.newContacts : 0;
  const hourlySent = counters?.campaignHourly?.hour === hour ? counters.campaignHourly.sent : 0;

  if (dailySent >= pacing.maxPerDay) {
    return { ok: false, reason: "Teto diário do canal atingido", retryAt: nextUtcDayStart(now) };
  }
  if (args.isNewContact && pacing.maxNewContactsPerDay !== undefined && dailyNew >= pacing.maxNewContactsPerDay) {
    return {
      ok: false,
      reason: "Teto diário de contatos NOVOS atingido",
      retryAt: nextUtcDayStart(now),
    };
  }
  if (hourlySent >= pacing.maxPerHour) {
    return { ok: false, reason: "Teto por hora do canal atingido", retryAt: nextUtcHourStart(now) };
  }
  return { ok: true };
}

export function nextUtcDayStart(now: number): number {
  return now - (now % DAY_MS) + DAY_MS;
}
export function nextUtcHourStart(now: number): number {
  return now - (now % HOUR_MS) + HOUR_MS;
}

/** Atualiza os contadores após um envio (retorna o novo objeto). */
export function bumpCounters(
  counters: ChannelPacingCounters | null | undefined,
  now: number,
  isNewContact: boolean
): Required<Pick<ChannelPacingCounters, "campaignDaily" | "campaignHourly">> {
  const day = utcDayKey(now);
  const hour = utcHourKey(now);
  const daily =
    counters?.campaignDaily?.day === day
      ? {
          day,
          sent: counters.campaignDaily.sent + 1,
          newContacts: counters.campaignDaily.newContacts + (isNewContact ? 1 : 0),
        }
      : { day, sent: 1, newContacts: isNewContact ? 1 : 0 };
  const hourly =
    counters?.campaignHourly?.hour === hour
      ? { hour, sent: counters.campaignHourly.sent + 1 }
      : { hour, sent: 1 };
  return { campaignDaily: daily, campaignHourly: hourly };
}

// ── Kill switches ──

export interface KillSwitchStats {
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  optedOut: number;
  consecutiveFailures: number;
}

export interface KillSwitchSafety {
  stopOnReplyRateBelow?: number;
  stopOnDeliveryRateBelow?: number;
  minSampleForKillSwitch?: number;
  maxConsecutiveFailures?: number;
}

export const DEFAULT_MIN_SAMPLE_REPLY = 50;
export const DEFAULT_MIN_SAMPLE_DELIVERY = 20;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * null = segue; string = motivo da pausa. "Enviados" para as taxas = sent +
 * delivered + read + replied (tudo que saiu). Taxa de resposta conta replied;
 * taxa de entrega conta delivered + read + replied (duplo-tique ou melhor).
 */
export function evaluateKillSwitches(args: {
  stats: KillSwitchStats;
  safety: KillSwitchSafety;
}): string | null {
  const { stats, safety } = args;
  const maxFail = safety.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  if (maxFail > 0 && stats.consecutiveFailures >= maxFail) {
    return `${stats.consecutiveFailures} falhas consecutivas — verifique o canal antes de continuar`;
  }
  const dispatched = stats.sent + stats.delivered + stats.read + stats.replied;
  if (safety.stopOnDeliveryRateBelow !== undefined && safety.stopOnDeliveryRateBelow > 0) {
    const sample = Math.max(1, safety.minSampleForKillSwitch ?? DEFAULT_MIN_SAMPLE_DELIVERY);
    if (dispatched >= sample) {
      const delivered = stats.delivered + stats.read + stats.replied;
      const rate = delivered / dispatched;
      if (rate < safety.stopOnDeliveryRateBelow) {
        return `Taxa de entrega em ${Math.round(rate * 100)}% (abaixo de ${Math.round(safety.stopOnDeliveryRateBelow * 100)}%) — possível restrição do número`;
      }
    }
  }
  if (safety.stopOnReplyRateBelow !== undefined && safety.stopOnReplyRateBelow > 0) {
    const sample = Math.max(1, safety.minSampleForKillSwitch ?? DEFAULT_MIN_SAMPLE_REPLY);
    if (dispatched >= sample) {
      const rate = stats.replied / dispatched;
      if (rate < safety.stopOnReplyRateBelow) {
        return `Taxa de resposta em ${Math.round(rate * 100)}% (abaixo de ${Math.round(safety.stopOnReplyRateBelow * 100)}%) — lista pouco receptiva, risco de denúncias`;
      }
    }
  }
  return null;
}

/** Pausa de lote devida? Devolve os ms de pausa (0 = não). */
export function batchPauseMs(pacing: CampaignPacing, sentSinceLastPause: number): number {
  if (pacing.batchSize <= 0 || pacing.batchPauseMin <= 0) return 0;
  return sentSinceLastPause >= pacing.batchSize ? pacing.batchPauseMin * 60 * 1000 : 0;
}
