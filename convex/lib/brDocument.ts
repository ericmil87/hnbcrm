/**
 * CPF/CNPJ (puro; o front pode importar). Valida os dígitos verificadores: o Asaas
 * recusa documento inválido e a NFS-e sai errada, então falhamos antes de qualquer
 * chamada externa. Nunca logar o documento.
 */

export function onlyDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

function allSame(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

export function isValidCpf(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 11 || allSame(d)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const check = ((sum * 10) % 11) % 10;
    if (check !== Number(d[len])) return false;
  }
  return true;
}

export function isValidCnpj(raw: string): boolean {
  const d = onlyDigits(raw);
  if (d.length !== 14 || allSame(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/** CPF (11 dígitos) ou CNPJ (14) válido? */
export function isValidCpfCnpj(raw: string): boolean {
  const d = onlyDigits(raw);
  return d.length === 11 ? isValidCpf(d) : d.length === 14 ? isValidCnpj(d) : false;
}

/** "•••.•••.•••-12" / "••.•••.•••/••••-12": para qualquer saída que precise confirmar sem expor. */
export function maskCpfCnpj(raw: string): string {
  const d = onlyDigits(raw);
  return d.length >= 2 ? `•••${d.slice(-2)}` : "•••";
}
