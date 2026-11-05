/** Fusos horários oferecidos na interface, com nomes em português. O `value` é o id IANA persistido e nunca muda. */
export interface TimezoneOption {
  value: string;
  label: string;
}

export const TIMEZONES: readonly TimezoneOption[] = [
  { value: "America/Sao_Paulo", label: "São Paulo (Brasília)" },
  { value: "America/Manaus", label: "Manaus" },
  { value: "America/Fortaleza", label: "Fortaleza" },
  { value: "America/New_York", label: "Nova York" },
  { value: "America/Chicago", label: "Chicago" },
  { value: "America/Denver", label: "Denver" },
  { value: "America/Los_Angeles", label: "Los Angeles" },
  { value: "Europe/London", label: "Londres" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlim" },
  { value: "Asia/Tokyo", label: "Tóquio" },
  { value: "UTC", label: "Horário universal (UTC)" },
];

/** Nome em português do fuso, ou o próprio id quando não está na lista. */
export function timezoneLabel(value: string): string {
  return TIMEZONES.find((tz) => tz.value === value)?.label ?? value;
}

/**
 * Opções para um `Select`. Se o fuso salvo na organização não está na lista
 * (dado antigo), ele é mantido como opção para não ser trocado sem querer.
 */
export function timezoneOptions(current?: string): TimezoneOption[] {
  if (current && !TIMEZONES.some((tz) => tz.value === current)) {
    return [{ value: current, label: current }, ...TIMEZONES];
  }
  return [...TIMEZONES];
}
