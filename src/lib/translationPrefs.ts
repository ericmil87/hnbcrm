/**
 * Preferência por visualizador da tradução: "Mostrar original junto da
 * tradução". Conveniência local (`localStorage`, sempre em try/catch): some
 * numa aba anônima sem quebrar nada. As bolhas assinam a mudança para que o
 * interruptor do chip valha na hora.
 */
import { useSyncExternalStore } from "react";

export const SHOW_ORIGINAL_KEY = "hnbcrm:translation-show-original";

const listeners = new Set<() => void>();

export function readShowOriginal(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHOW_ORIGINAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowOriginal(value: boolean): void {
  try {
    if (value) globalThis.localStorage?.setItem(SHOW_ORIGINAL_KEY, "1");
    else globalThis.localStorage?.removeItem(SHOW_ORIGINAL_KEY);
  } catch {
    /* armazenamento indisponível: vale só nesta sessão */
  }
  memo = value;
  listeners.forEach((l) => l());
}

let memo: boolean | null = null;
const snapshot = () => (memo ??= readShowOriginal());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useShowOriginalPref(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, snapshot, () => false);
  return [value, writeShowOriginal];
}

/** Aviso dispensado (sessão): uma chave por conversa e detecção. */
export function readSessionFlag(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeSessionFlag(key: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, "1");
  } catch {
    /* sem armazenamento: o aviso some só até remontar */
  }
}

/** Aviso de descoberta dispensado por org (persistente, no aparelho). */
export function readLocalFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeLocalFlag(key: string): void {
  try {
    globalThis.localStorage?.setItem(key, "1");
  } catch {
    /* idem */
  }
}
