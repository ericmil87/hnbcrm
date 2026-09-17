/**
 * Carimbo de hora das bolhas do inbox.
 *
 * Só a hora ("15:24") deixava ambíguo de que dia era a mensagem quando a
 * conversa atravessa dias. Regra pedida pelo Eric (17/09/2026): mensagem de
 * hoje = "Hoje 15:24"; de ontem para trás = "16/09/26 15:24".
 */
function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatMessageTimestamp(createdAt: number, now: Date = new Date()): string {
  const d = new Date(createdAt);
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (sameLocalDay(d, now)) return `Hoje ${time}`;
  const date = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
  return `${date} ${time}`;
}
