/**
 * Rolagem ao trocar de página pública (fora de /app, onde o AuthLayout tem o seu ScrollRestoration).
 * `decidePublicScroll` é pura; `installPublicScroll` assina o roteador (só no navegador, em main.tsx),
 * então o prerender e a hidratação não mudam. Voltar/avançar (POP) fica com o navegador.
 */
export interface ScrollLocation {
  pathname: string;
  hash: string;
}

export type ScrollDecision = { kind: "none" } | { kind: "top" } | { kind: "hash"; id: string };

export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

export function decidePublicScroll(
  prev: ScrollLocation,
  next: ScrollLocation,
  action: "PUSH" | "REPLACE" | "POP",
): ScrollDecision {
  if (action === "POP") return { kind: "none" };
  if (isAppPath(next.pathname)) return { kind: "none" };
  if (next.hash.length > 1) {
    let id = next.hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* mantém o id cru */
    }
    return { kind: "hash", id };
  }
  if (prev.pathname !== next.pathname) return { kind: "top" };
  return { kind: "none" };
}

interface RouterLike {
  state: { location: ScrollLocation; historyAction: "PUSH" | "REPLACE" | "POP" };
  subscribe(fn: (state: RouterLike["state"]) => void): () => void;
}

const HASH_RETRY_FRAMES = 40;

function scrollToHash(id: string, frames = HASH_RETRY_FRAMES) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView();
    return;
  }
  // A página nova pode ainda não ter montado a âncora.
  if (frames > 0) requestAnimationFrame(() => scrollToHash(id, frames - 1));
  else window.scrollTo(0, 0);
}

export function installPublicScroll(router: RouterLike): () => void {
  let prev: ScrollLocation = { pathname: router.state.location.pathname, hash: router.state.location.hash };
  return router.subscribe((state) => {
    const next = { pathname: state.location.pathname, hash: state.location.hash };
    const decision = decidePublicScroll(prev, next, state.historyAction);
    prev = next;
    if (decision.kind === "top") window.scrollTo(0, 0);
    else if (decision.kind === "hash") scrollToHash(decision.id);
  });
}
