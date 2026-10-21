/**
 * Desliga os handlers de cron em runtime quando a env CRONS_DISABLED === "1".
 * Uso: só no deployment DEV (que consome a mesma cota de Database bandwidth do prod).
 * É em runtime porque env lida dentro de crons.ts só é reavaliada no deploy
 * (docs.convex.dev/production/environment-variables); o cron continua registrado e
 * conta como function call, mas sem I/O. Nunca setar em prod.
 */
export function cronsDisabled(): boolean {
  return process.env.CRONS_DISABLED === "1";
}
