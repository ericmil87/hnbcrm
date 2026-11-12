import type { MouseEvent, ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { cn } from "@/lib/utils";

/**
 * Logo dos cabeçalhos públicos: leva a `/`. Já em `/`, rola suave até o topo (instantâneo com
 * movimento reduzido) e limpa o hash da URL. Fora de /app apenas.
 */
export function HomeLogoLink({ children, className }: { children: ReactNode; className?: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (pathname !== "/") return; // navegação normal; a página nova abre no topo (publicScroll)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    // Tira o #âncora e a query sem empilhar histórico nem rolar de novo.
    if (window.location.hash || window.location.search) void navigate("/", { replace: true, preventScrollReset: true });
  };

  return (
    <Link
      to="/"
      onClick={onClick}
      aria-label="HNBCRM, início"
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
        className,
      )}
    >
      {children}
    </Link>
  );
}
