/**
 * Velocidade do player de áudio: ciclo, rótulo PT-BR e preferência do
 * aparelho (`localStorage` sempre em try/catch; valor inválido cai em 1×).
 */
import { useSyncExternalStore } from "react";

export const AUDIO_SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const;
export type AudioSpeed = (typeof AUDIO_SPEEDS)[number];

export const AUDIO_SPEED_KEY = "hnbcrm:audio-speed";
export const DEFAULT_AUDIO_SPEED: AudioSpeed = 1;

/** 1 → 1,25 → 1,5 → 1,75 → 2 → 1. Velocidade desconhecida volta a 1×. */
export function nextAudioSpeed(current: number): AudioSpeed {
  const index = AUDIO_SPEEDS.indexOf(current as AudioSpeed);
  if (index === -1) return DEFAULT_AUDIO_SPEED;
  return AUDIO_SPEEDS[(index + 1) % AUDIO_SPEEDS.length];
}

/** "1,25×" (vírgula decimal, sinal de multiplicação). */
export function formatAudioSpeed(speed: number): string {
  return `${String(speed).replace(".", ",")}×`;
}

/** Aceita só as velocidades do ciclo; o resto (nulo, lixo, 3) vira 1×. */
export function parseAudioSpeed(raw: string | null | undefined): AudioSpeed {
  if (raw == null) return DEFAULT_AUDIO_SPEED;
  const value = Number(raw);
  return (AUDIO_SPEEDS as readonly number[]).includes(value) ? (value as AudioSpeed) : DEFAULT_AUDIO_SPEED;
}

export function readAudioSpeed(): AudioSpeed {
  try {
    return parseAudioSpeed(globalThis.localStorage?.getItem(AUDIO_SPEED_KEY));
  } catch {
    return DEFAULT_AUDIO_SPEED;
  }
}

const listeners = new Set<() => void>();
// Valor de sessão: vale mesmo quando o armazenamento está indisponível.
let memo: AudioSpeed | null = null;

export function writeAudioSpeed(speed: AudioSpeed): void {
  memo = speed;
  try {
    if (speed === DEFAULT_AUDIO_SPEED) globalThis.localStorage?.removeItem(AUDIO_SPEED_KEY);
    else globalThis.localStorage?.setItem(AUDIO_SPEED_KEY, String(speed));
  } catch {
    /* armazenamento indisponível: vale só nesta sessão */
  }
  listeners.forEach((l) => l());
}

function snapshot(): AudioSpeed {
  return memo ?? readAudioSpeed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Velocidade escolhida, compartilhada por todos os players da tela. */
export function useAudioSpeed(): [AudioSpeed, () => void] {
  const speed = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_AUDIO_SPEED);
  return [speed, () => writeAudioSpeed(nextAudioSpeed(snapshot()))];
}

/** Só para testes: esquece o valor de sessão. */
export function resetAudioSpeedMemo(): void {
  memo = null;
}
