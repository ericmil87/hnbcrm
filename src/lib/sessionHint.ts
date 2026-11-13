/**
 * Marca LOCAL e não sensível de "há sessão neste navegador", para as páginas
 * públicas (que montam sem Convex de propósito) trocarem "Entrar / Testar
 * grátis" por "Abrir o meu CRM". Não guarda token, id nem e-mail: só "1".
 *
 * Quem grava é o `SessionHintSync`, dentro do `ConvexRoot` (rotas com Convex),
 * pelo estado real do Convex Auth: entra = grava; sai, sessão vencida ou conta
 * removida = apaga. É uma dica: pode ficar velha (token vencido sem visita ao
 * app); aí "Abrir o meu CRM" cai no `/app`, que manda para o login como antes.
 */
export const SESSION_HINT_KEY = "hnbcrm:tem-sessao";

export function readSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSessionHint(signedIn: boolean): void {
  try {
    if (signedIn) localStorage.setItem(SESSION_HINT_KEY, "1");
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Armazenamento bloqueado: a landing mostra "Entrar" (o comportamento de antes).
  }
}
