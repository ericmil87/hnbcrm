import { useRouteError } from "react-router";

/**
 * `errorElement` do roteador: evita a tela branca quando uma rota falha ao
 * renderizar ou quando um chunk lazy não carrega (ex.: "Failed to fetch
 * dynamically imported module" após um deploy). Fica fora do `lazy` de
 * propósito: precisa estar disponível justamente quando um chunk falha.
 */
export function RouteErrorPage() {
  const error = useRouteError();
  if (error) console.error("Route error:", error);

  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center bg-surface-base p-8 text-center"
    >
      <h1 className="mb-2 text-lg font-semibold text-semantic-error">Algo deu errado.</h1>
      <p className="mb-4 text-text-secondary">
        Não foi possível carregar esta página. Recarregue para tentar de novo.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="min-h-[44px] rounded-full bg-brand-600 px-6 py-2.5 font-semibold text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
      >
        Recarregar
      </button>
    </div>
  );
}
