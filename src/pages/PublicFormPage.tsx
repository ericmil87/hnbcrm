import { useState, useEffect, useRef, useCallback } from "react";
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
  successTitle?: string;
  successSubtitle?: string;
  successCta?: { label: string; url: string };
  partialCaptureEnabled?: boolean;
}

interface PublicFormData {
  name: string;
  description?: string;
  fields: FormFieldDefinition[];
  steps?: Array<{ id: string; title: string; description?: string; fieldIds: string[] }>;
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

function getSiteUrl(): string {
  const convexUrl = (import.meta.env.VITE_CONVEX_URL as string) ?? "";
  return convexUrl.replace(".cloud", ".site");
}

function buildPrefillData(
  fields: FormFieldDefinition[],
  searchParams: URLSearchParams
): Record<string, string> {
  const prefill: Record<string, string> = {};

  for (const field of fields) {
    const labelKey = field.label.toLowerCase().replace(/\s+/g, "_");
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
// PostMessage helpers
// ---------------------------------------------------------------------------

function postToParent(type: string, data?: Record<string, unknown>) {
  if (window.parent === window) return;
  window.parent.postMessage({ type, ...data }, "*");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PublicFormPage() {
  const { formSlug } = useParams<{ formSlug: string }>();
  const [pageState, setPageState] = useState<PageState>({ kind: "loading" });
  const [sessionId, setSessionId] = useState<string | null>(null);

  const siteUrl = getSiteUrl();
  const searchParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );

  // Embed mode detection
  const isEmbed = searchParams.get("embed") === "1";
  const formContainerRef = useRef<HTMLDivElement>(null);
  const prefillDataRef = useRef<Record<string, string>>({});

  // Fetch form data
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
        prefillDataRef.current = prefill;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSlug, siteUrl]);

  // PostMessage: ResizeObserver for embed mode
  useEffect(() => {
    if (!isEmbed || !formContainerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        postToParent("hnbcrm:resize", { height });
      }
    });

    observer.observe(formContainerRef.current);
    return () => observer.disconnect();
  }, [isEmbed, pageState.kind]);

  // PostMessage: signal ready on mount in embed mode
  useEffect(() => {
    if (isEmbed && pageState.kind === "ready") {
      postToParent("hnbcrm:ready");
    }
  }, [isEmbed, pageState.kind]);

  // PostMessage: listen for prefill messages from parent
  useEffect(() => {
    if (!isEmbed) return;

    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "hnbcrm:prefill" && data.data && typeof data.data === "object") {
        // Merge prefill data into current form state
        if (pageState.kind === "ready") {
          const merged = { ...prefillDataRef.current, ...data.data };
          prefillDataRef.current = merged;
          setPageState((prev) => {
            if (prev.kind !== "ready") return prev;
            return { ...prev, prefill: merged };
          });
        }
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isEmbed, pageState.kind]);

  // Handle sessionId from FormRenderer
  const handleSessionId = useCallback((id: string | null) => {
    setSessionId(id);
  }, []);

  // Submit handler
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
          sessionId: sessionId ?? undefined,
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

    // PostMessage: notify parent of successful submission
    if (isEmbed) {
      postToParent("hnbcrm:submitted");
    }
  }

  // ----- Loading -----
  if (pageState.kind === "loading") {
    return (
      <main
        className={isEmbed ? "flex items-center justify-center p-4" : "min-h-screen bg-surface-base flex items-center justify-center p-4"}
        aria-label="Carregando formulario"
      >
        <Spinner size="lg" />
      </main>
    );
  }

  // ----- Not found -----
  if (pageState.kind === "not_found") {
    if (isEmbed) {
      return (
        <main className="flex items-center justify-center p-4">
          <p className="text-sm text-text-secondary">Formulario nao encontrado</p>
        </main>
      );
    }

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
    if (isEmbed) {
      return (
        <main className="flex items-center justify-center p-4">
          <p className="text-sm text-text-secondary">{pageState.message}</p>
        </main>
      );
    }

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

  // Embed mode: minimal wrapper, transparent background option
  if (isEmbed) {
    return (
      <div ref={formContainerRef} style={{ backgroundColor: form.theme.backgroundColor }}>
        <div className="p-4">
          <FormRenderer
            form={form}
            onSubmit={handleSubmit}
            prefillData={prefill}
            formSlug={formSlug}
            siteUrl={siteUrl}
            onSessionId={handleSessionId}
          />
        </div>
      </div>
    );
  }

  // Normal (non-embed) mode
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
                formSlug={formSlug}
                siteUrl={siteUrl}
                onSessionId={handleSessionId}
              />
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
