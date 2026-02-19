import { useState, useEffect } from "react";
import { useParams, Link } from "react-router";
import { SEO } from "@/components/SEO";
import { Spinner } from "@/components/ui/Spinner";
import { FormRenderer } from "@/components/forms/renderer/FormRenderer";
import type { FormFieldDefinition } from "@/components/forms/renderer/FormField";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  borderRadius: "none" | "sm" | "md" | "lg" | "full";
  showBranding: boolean;
}

interface FormSettings {
  submitButtonText: string;
  successMessage: string;
  redirectUrl?: string;
  honeypotEnabled: boolean;
}

interface PublicFormData {
  name: string;
  description?: string;
  fields: FormFieldDefinition[];
  theme: FormTheme;
  settings: FormSettings;
}

type PageState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; form: PublicFormData; prefill: Record<string, string> };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the Convex HTTP site URL from the Convex cloud URL.
 * e.g. https://happy-dog-123.convex.cloud → https://happy-dog-123.convex.site
 */
function getSiteUrl(): string {
  const convexUrl = (import.meta.env.VITE_CONVEX_URL as string) ?? "";
  return convexUrl.replace(".cloud", ".site");
}

/**
 * Build a prefill map from URL search params.
 * We try to match params by label or by crmMapping field name.
 * Returns a map of field.id → value for any fields that match.
 */
function buildPrefillData(
  fields: FormFieldDefinition[],
  searchParams: URLSearchParams
): Record<string, string> {
  const prefill: Record<string, string> = {};

  for (const field of fields) {
    // Match by field label (lowercased, spaces → underscores)
    const labelKey = field.label.toLowerCase().replace(/\s+/g, "_");
    // Match by crmMapping field name (e.g. "email", "firstName", "phone")
    const mapping = field as { crmMapping?: { entity: string; field: string } };
    const crmKey = mapping.crmMapping?.field?.toLowerCase() ?? "";

    const value =
      searchParams.get(field.id) ??
      searchParams.get(labelKey) ??
      (crmKey ? searchParams.get(crmKey) : null) ??
      null;

    if (value !== null) {
      prefill[field.id] = value;
    }
  }

  return prefill;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PublicFormPage() {
  const { formSlug } = useParams<{ formSlug: string }>();
  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });

  const siteUrl = getSiteUrl();
  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );

  useEffect(() => {
    if (!formSlug) {
      setPageState({ kind: "not_found" });
      return;
    }

    let cancelled = false;

    async function fetchForm() {
      try {
        const res = await fetch(
          `${siteUrl}/api/v1/forms/public?slug=${encodeURIComponent(formSlug)}`
        );

        if (cancelled) return;

        if (res.status === 404) {
          setPageState({ kind: "not_found" });
          return;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          setPageState({
            kind: "error",
            message: body || `Erro ${res.status} ao carregar o formulario`,
          });
          return;
        }

        const json = await res.json();
        const form: PublicFormData = json.form;
        const prefill = buildPrefillData(form.fields, searchParams);
        setPageState({ kind: "ready", form, prefill });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Nao foi possivel carregar o formulario";
        setPageState({ kind: "error", message });
      }
    }

    fetchForm();

    return () => {
      cancelled = true;
    };
    // searchParams intentionally omitted — derived from window.location at mount time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSlug, siteUrl]);

  // ----- Submit handler -----
  async function handleSubmit(data: Record<string, string>) {
    if (pageState.kind !== "ready") return;

    const res = await fetch(
      `${siteUrl}/api/v1/forms/public/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: formSlug,
          data,
          _honeypot: undefined,
          referrer: document.referrer,
          utmSource: searchParams.get("utm_source"),
          utmMedium: searchParams.get("utm_medium"),
          utmCampaign: searchParams.get("utm_campaign"),
        }),
      }
    );

    if (!res.ok) {
      let message = "Ocorreu um erro ao enviar o formulario. Tente novamente.";
      try {
        const body = await res.json();
        if (body?.message) message = body.message;
      } catch {
        // ignore JSON parse failure
      }
      throw new Error(message);
    }
  }

  // ----- Loading -----
  if (pageState.kind === "loading") {
    return (
      <main
        className="min-h-screen bg-surface-base flex items-center justify-center p-4"
        aria-label="Carregando formulario"
      >
        <Spinner size="lg" />
      </main>
    );
  }

  // ----- Not found -----
  if (pageState.kind === "not_found") {
    return (
      <>
        <SEO
          title="Formulario nao encontrado"
          description="O formulario que voce esta procurando nao existe ou foi removido."
          noindex
        />
        <main className="min-h-screen bg-surface-base flex items-center justify-center p-4">
          <div className="w-full max-w-sm text-center space-y-4 animate-fade-in-up">
            <div className="w-16 h-16 rounded-2xl bg-surface-raised border border-border flex items-center justify-center mx-auto">
              <img
                src="/orange_icon_logo_transparent-bg-528x488.png"
                alt="HNBCRM"
                className="w-9 h-9 object-contain"
                loading="lazy"
              />
            </div>
            <h1 className="text-xl font-bold text-text-primary">
              Formulario nao encontrado
            </h1>
            <p className="text-sm text-text-secondary leading-relaxed">
              O formulario que voce esta procurando nao existe, foi removido ou o link
              esta incorreto.
            </p>
            <Link
              to="/"
              className="inline-flex items-center justify-center gap-2 h-11 px-6 rounded-full
                bg-brand-600 text-white text-sm font-semibold
                hover:bg-brand-700 active:bg-brand-800 transition-all duration-150
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            >
              Ir para a pagina inicial
            </Link>
          </div>
        </main>
      </>
    );
  }

  // ----- Fetch error -----
  if (pageState.kind === "error") {
    return (
      <>
        <SEO
          title="Erro ao carregar formulario"
          description="Ocorreu um erro ao carregar este formulario."
          noindex
        />
        <main className="min-h-screen bg-surface-base flex items-center justify-center p-4">
          <div className="w-full max-w-sm text-center space-y-4 animate-fade-in-up">
            <h1 className="text-xl font-bold text-text-primary">
              Nao foi possivel carregar o formulario
            </h1>
            <p className="text-sm text-text-secondary leading-relaxed">
              {pageState.message}
            </p>
            <button
              onClick={() => {
                setPageState({ kind: "loading" });
                // Re-trigger the effect by forcing a reload
                window.location.reload();
              }}
              className="inline-flex items-center justify-center h-11 px-6 rounded-full
                bg-surface-raised border border-border text-sm font-medium text-text-secondary
                hover:border-border-strong hover:text-text-primary transition-all duration-150
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base"
            >
              Tentar novamente
            </button>
          </div>
        </main>
      </>
    );
  }

  // ----- Ready -----
  const { form, prefill } = pageState;
  const pageStyle: React.CSSProperties = {
    backgroundColor: form.theme.backgroundColor,
    minHeight: "100vh",
  };

  return (
    <>
      <SEO
        title={form.name}
        description={
          form.description ??
          `Preencha o formulario "${form.name}" e envie sua resposta.`
        }
        noindex={false}
      />
      {/* Page background uses the form's theme background color */}
      <div style={pageStyle} className="flex items-center justify-center p-4">
        <main
          className="w-full max-w-lg animate-fade-in-up"
          aria-label={form.name}
        >
          <div
            className="rounded-xl border border-border shadow-elevated overflow-hidden"
            style={{ backgroundColor: form.theme.backgroundColor }}
          >
            <div className="p-6 md:p-8">
              <FormRenderer
                form={form}
                onSubmit={handleSubmit}
                prefillData={prefill}
              />
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
