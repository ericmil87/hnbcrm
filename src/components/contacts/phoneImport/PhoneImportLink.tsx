import { Link } from "react-router";
import { Smartphone } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";

/** Entrada do "Importar contatos do celular" no cabeçalho de Contatos (só ícone no celular). */
export function PhoneImportLink() {
  return (
    <Tooltip content="Importar contatos do celular">
      <Link
        to="/app/contatos/importar-celular"
        aria-label="Importar contatos do celular"
        className="inline-flex h-10 min-w-10 items-center justify-center gap-2 rounded-full border border-border-strong bg-surface-raised px-3 text-sm font-medium text-text-secondary transition-colors hover:border-brand-500 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base coarse:min-h-11 coarse:min-w-11"
      >
        <Smartphone size={18} aria-hidden="true" />
        <span className="hidden md:inline">Do celular</span>
      </Link>
    </Tooltip>
  );
}
