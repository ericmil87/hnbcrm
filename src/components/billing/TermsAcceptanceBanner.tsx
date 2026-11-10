import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { mutationErrorMessage } from "@/lib/errors";
import { needsTermsAcceptance } from "@/lib/termsAcceptance";
import { api } from "../../../convex/_generated/api";

const NO_ARGS = {} as const;

interface TermsAcceptanceBannerViewProps {
  version: string;
  accepting: boolean;
  onAccept: () => void;
  className?: string;
}

/** Aviso apresentacional: não bloqueia o uso. */
export function TermsAcceptanceBannerView({ version, accepting, onAccept, className }: TermsAcceptanceBannerViewProps) {
  return (
    <div
      role="status"
      className={`flex flex-col gap-3 rounded-card border border-semantic-info/40 bg-semantic-info/5 p-3 sm:flex-row sm:items-center ${className ?? ""}`}
    >
      <FileText size={18} className="shrink-0 text-text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">Os Termos de Uso foram atualizados</p>
        <p className="text-sm text-text-secondary">
          Leia a versão {version} e confirme o aceite. Você pode continuar usando o HNBCRM enquanto isso.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/termos"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-9 items-center rounded-full border border-border px-4 text-sm font-medium text-text-primary hover:bg-surface-overlay coarse:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Revisar e aceitar
        </Link>
        <Button size="sm" loading={accepting} onClick={onAccept}>
          Aceito os Termos
        </Button>
      </div>
    </div>
  );
}

/** Aparece para quem ainda não aceitou a versão vigente (`getMyTermsStatus`). */
export function TermsAcceptanceBanner({ className }: { className?: string }) {
  const status = useQuery(api.terms.getMyTermsStatus, NO_ARGS);
  const acceptTerms = useMutation(api.terms.acceptTerms);
  const [accepting, setAccepting] = useState(false);

  if (!status || !needsTermsAcceptance(status)) return null;

  return (
    <TermsAcceptanceBannerView
      version={status.currentVersion}
      accepting={accepting}
      className={className}
      onAccept={() => {
        setAccepting(true);
        acceptTerms({ version: status.currentVersion, userAgent: navigator.userAgent.slice(0, 200) })
          .then(() => toast.success("Termos aceitos"))
          .catch((e: unknown) => toast.error(mutationErrorMessage(e, "Não foi possível registrar o aceite.")))
          .finally(() => setAccepting(false));
      }}
    />
  );
}
