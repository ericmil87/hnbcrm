// Erros de mutation do Convex chegam com prefixo técnico ("Uncaught Error: ...")
// — extrai só a mensagem PT-BR que o backend lançou.
export function mutationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  const cleaned = error.message.replace(/^.*Uncaught Error: /, "").split("\n")[0].trim();
  return cleaned || fallback;
}
