/** O servidor de conexão confirmou o ajuste do histórico (senão a preferência fica salva e é reenviada depois). */
export function historyApplied(result: { gatewayApplied: boolean }): boolean {
  return result.gatewayApplied;
}
