import { ConvexError } from "convex/values";
// Erros de mutation do Convex chegam com prefixo técnico ("Uncaught Error: ...")
// — extrai só a mensagem PT-BR que o backend lançou.
export function mutationErrorMessage(error: unknown, fallback: string): string {
  // ConvexError carrega a mensagem em `data` e chega inteira ao cliente mesmo
  // em produção (Error comum vira "Server Error").
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data.trim()) return data.trim();
    if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
      return (data as { message: string }).message;
    }
  }
  if (!(error instanceof Error) || !error.message) return fallback;
  const cleaned = error.message.replace(/^.*Uncaught Error: /, "").split("\n")[0].trim();
  return cleaned || fallback;
}
