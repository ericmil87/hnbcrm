/**
 * Carimbo legível de uma mensagem do histórico enviado à IA nos grupos
 * ("dom 22/11 22:29"), em vez de epoch em ms (o modelo não converte epoch: o
 * "amanhã" escrito na véspera parecia atual).
 *
 * É `formatLocalShort` mais o ANO quando a mensagem é de outro ano ou tem mais
 * de 180 dias: sem ano, "sex 20/11" de um ano atrás parece a próxima sexta.
 * Puro (sem ctx, sem `Date.now()`): `now` vem de quem pode ler o relógio.
 * `formatLocalShort` não muda (tem outros usos). Usado nos grupos (turno, resumo,
 * notas da equipe) e no contexto do Copiloto no Telegram.
 */
import { formatLocalShort } from "./agentSchedule";
import { safeTimezone } from "./promptDateTime";

const STALE_MS = 180 * 24 * 60 * 60 * 1000;

function yearIn(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, year: "numeric" }).format(
    new Date(epoch)
  );
}

export function historyStamp(epoch: number, timezone: string, now?: number): string {
  const base = formatLocalShort(epoch, timezone);
  if (now === undefined) return base;
  const tz = safeTimezone(timezone);
  const year = yearIn(epoch, tz);
  if (year !== yearIn(now, tz) || now - epoch > STALE_MS) return `${base} ${year}`;
  return base;
}
