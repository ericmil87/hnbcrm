import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Lock, MailCheck, MailX } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { SEO } from "@/components/SEO";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Button, buttonClassName } from "@/components/ui/Button";

export type UnsubscribePreview = { valid: false } | { valid: true; orgName: string; enabled: boolean };

export interface UnsubscribePageViewProps {
  /** `undefined` = still loading; `null` = no token in the URL. */
  preview: UnsubscribePreview | null | undefined;
  busy: boolean;
  error: boolean;
  /** `enabled` = whether the billing e-mails should be ON after the change. */
  onSet: (enabled: boolean) => void;
}

export function UnsubscribePageView({ preview, busy, error, onSet }: UnsubscribePageViewProps) {
  let body: React.ReactNode;
  if (preview === undefined) {
    body = (
      <div className="flex justify-center py-4 text-text-muted" role="status" aria-label="Carregando">
        <Loader2 size={24} className="animate-spin" aria-hidden="true" />
      </div>
    );
  } else if (preview === null || !preview.valid) {
    body = (
      <>
        <p className="text-text-primary">
          Este link não vale mais. Entre no HNBCRM e ajuste em Configurações › Notificações.
        </p>
        <Link to="/entrar" className={buttonClassName("primary", "lg", "mt-5 w-full")}>
          Entrar
        </Link>
      </>
    );
  } else if (preview.enabled) {
    body = (
      <>
        <MailX size={28} className="mx-auto mb-3 text-text-muted" aria-hidden="true" />
        <p className="text-text-primary">
          Desativar os e-mails de cobrança e recibos do HNBCRM para <strong>{preview.orgName}</strong>?
        </p>
        <Button size="lg" className="mt-5 w-full" loading={busy} disabled={busy} onClick={() => onSet(false)}>
          Desativar
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <MailCheck size={28} className="mx-auto mb-3 text-semantic-success" aria-hidden="true" />
        <p className="text-text-primary">
          Pronto. Você não vai mais receber esses e-mails. Os avisos de falha de pagamento continuam, porque
          protegem a sua conta.
        </p>
        <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-text-muted">
          <Lock size={12} aria-hidden="true" /> Organização: {preview.orgName}
        </p>
        <Button variant="secondary" size="lg" className="mt-5 w-full" loading={busy} disabled={busy} onClick={() => onSet(true)}>
          Reativar
        </Button>
      </>
    );
  }

  return (
    <div className="flex min-h-screen supports-[height:100dvh]:min-h-[100dvh] items-center justify-center overflow-y-auto bg-gradient-to-b from-surface-overlay to-surface-base px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <BrandLogo size="xl" decorative className="mx-auto mb-3" />
          <h1 className="font-display text-2xl font-bold text-text-primary">HNBCRM</h1>
        </div>
        <div className="rounded-card border border-border-subtle bg-surface-raised p-5 text-center shadow-card sm:p-6">
          <div aria-live="polite">
            {body}
            {error && (
              <p role="alert" className="mt-3 text-sm text-semantic-error">
                Não deu certo agora. Tente de novo.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Public page opened from the billing e-mails. The token comes only from `?t=` and is never stored,
 * logged or sent anywhere but the two Convex calls. Nothing is changed on load (preview query only).
 */
export function UnsubscribePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("t");
  const preview = useQuery(api.billingUnsub.previewUnsubscribe, token ? { token } : "skip");
  const setUnsubscribe = useMutation(api.billingUnsub.setUnsubscribe);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  // Keep the token-bearing URL out of the Referer of any outbound navigation.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const onSet = (enabled: boolean) => {
    if (!token || busy) return;
    setBusy(true);
    setError(false);
    setUnsubscribe({ token, enabled })
      .catch(() => setError(true))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <SEO title="Notificações de cobrança" description="Ajuste os e-mails de cobrança do HNBCRM." noindex />
      <UnsubscribePageView
        preview={token ? (preview as UnsubscribePreview | undefined) : null}
        busy={busy}
        error={error}
        onSet={onSet}
      />
    </>
  );
}
