/**
 * Thread do Copiloto guardada no navegador. A chave inclui o USUÁRIO: duas
 * contas da mesma org no mesmo aparelho não podem herdar a thread uma da outra
 * (o servidor recusa thread alheia).
 */
export const COPILOT_THREAD_PREFIX = "hnbcrm_copilot_thread_";

export function copilotThreadKey(userId: string, organizationId: string, purpose?: string): string {
  return `${COPILOT_THREAD_PREFIX}${userId}_${purpose ? `${purpose}_` : ""}${organizationId}`;
}

/** Chaves antigas (sem usuário): ignoradas e apagadas. */
export function legacyCopilotThreadKeys(organizationId: string): string[] {
  return [`${COPILOT_THREAD_PREFIX}${organizationId}`, `${COPILOT_THREAD_PREFIX}setup_${organizationId}`];
}

export function removeLegacyCopilotThreads(organizationId: string): void {
  try {
    for (const key of legacyCopilotThreadKeys(organizationId)) localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

export function readCopilotThread(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeCopilotThread(key: string, threadId: string): void {
  try {
    localStorage.setItem(key, threadId);
  } catch {
    // storage unavailable
  }
}

export function removeCopilotThread(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/** 409 `thread_not_owned` na 1ª tentativa: descarta a thread e reenvia UMA vez sem ela. */
export function shouldRetryWithoutThread(status: number, code: string | undefined, attempt: number): boolean {
  return status === 409 && code === "thread_not_owned" && attempt === 0;
}

/** Sair da conta: nenhuma thread do Copiloto fica para o próximo usuário do aparelho. */
export function clearStoredCopilotThreads(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(COPILOT_THREAD_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}
