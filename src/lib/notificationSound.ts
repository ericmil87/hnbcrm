const KEY = "hnbcrm.notifySound";

/** Som de aviso: preferência local do aparelho, padrão DESLIGADO. */
export function getSoundPref(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setSoundPref(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // localStorage indisponível: vale só até recarregar
  }
}

let ctx: AudioContext | null = null;

/** Dois toques curtos gerados no WebAudio (sem arquivo externo). Falha em silêncio. */
export function playNotificationSound(): void {
  try {
    const Ctor: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return;
    const audio = (ctx ??= new Ctor());
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
    const start = audio.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const t = start + i * 0.14;
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    });
  } catch {
    // sem áudio: o toast já avisou
  }
}
