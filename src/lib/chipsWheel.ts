/**
 * Roda do mouse sobre a fileira de chips: devolve quanto rolar na horizontal,
 * ou `null` para deixar o gesto passar (a página/lista rola na vertical).
 * Só intercepta quando há overflow, o gesto é majoritariamente vertical e a
 * fileira ainda pode andar naquele sentido (na borda, a rolagem segue adiante).
 */
export function chipsWheelDelta(
  e: { deltaX: number; deltaY: number },
  el: { scrollLeft: number; scrollWidth: number; clientWidth: number }
): number | null {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0 || e.deltaY === 0) return null;
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return null;
  if (e.deltaY < 0 && el.scrollLeft <= 0) return null;
  if (e.deltaY > 0 && el.scrollLeft >= max - 1) return null;
  return e.deltaY;
}
