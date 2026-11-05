import { Link } from "react-router";
import { SEO } from "@/components/SEO";

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface-base p-8 text-center">
      <SEO title="Página não encontrada" description="O endereço que você abriu não existe." noindex />
      <p className="mb-2 text-sm font-medium text-text-muted">Erro 404</p>
      <h1 className="mb-2 text-2xl font-semibold text-text-primary">Página não encontrada</h1>
      <p className="mb-6 max-w-sm text-text-secondary">
        O endereço que você abriu não existe ou foi movido.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          to="/app"
          className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-brand-600 px-6 py-2.5 font-semibold text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
        >
          Ir para o app
        </Link>
        <Link
          to="/"
          className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-border px-6 py-2.5 font-semibold text-text-primary transition-colors hover:bg-surface-overlay focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
        >
          Página inicial
        </Link>
      </div>
    </div>
  );
}
