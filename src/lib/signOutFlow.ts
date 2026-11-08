import { safeNotificationUrl } from "./push/notificationClick";

/** Executa a saída uma vez só: um segundo toque durante o encerramento não repete o teardown. */
export function createSignOutGuard() {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    /** `false` = já estava saindo (ignorado) ou a tarefa falhou (libera para tentar de novo). */
    async run(task: () => Promise<void>): Promise<boolean> {
      if (busy) return false;
      busy = true;
      try {
        await task();
        return true;
      } catch {
        busy = false;
        return false;
      }
    },
  };
}

/** Destino guardado ao expirar a sessão (`/entrar` recebe em `state.from`). */
export function loginReturnState(pathname: string, search: string, hash: string, signingOut: boolean): { from: string } | undefined {
  if (signingOut) return undefined; // saída voluntária: a próxima pessoa não herda o destino
  return { from: `${pathname}${search}${hash}` };
}

/** Para onde ir depois de entrar: o destino guardado se for seguro (inclui `/app/abrir?...`), senão `/app`. */
export function postLoginTarget(state: unknown): string {
  const from = state && typeof state === "object" ? (state as { from?: unknown }).from : undefined;
  return safeNotificationUrl(from) ?? "/app";
}

/** Prazo do `signOut()` (offline ele pode nunca responder): estourou, o spinner de saída não pode ficar eterno. */
export const SIGN_OUT_TIMEOUT_MS = 5000;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
