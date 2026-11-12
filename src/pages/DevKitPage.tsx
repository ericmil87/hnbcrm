import { lazy, Suspense, useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { SEO } from "@/components/SEO";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import { KitShowcase } from "@/components/landing/kit/KitShowcase";
import { isUiTheme } from "../../convex/lib/uiTheme";
import { applyTheme } from "@/lib/themeDom";

// Vitrine do onboarding (`?vitrine=onboarding&estado=`): só DEV, fora do bundle de produção.
const OnboardingShowcase = lazy(() => import("@/components/onboarding-chat/dev/OnboardingShowcase").then((m) => ({ default: m.OnboardingShowcase })));
const SHOWCASE_STATES = ["inicio", "funil", "atendente", "ativar", "email", "final", "erro"] as const;
type ShowcaseState = (typeof SHOWCASE_STATES)[number];

/**
 * Vitrine do kit de cena (`/dev/kit`). A rota só existe com
 * `import.meta.env.DEV` (ver `main.tsx`), então esta página não entra no build
 * de produção. `?tema=whatsapp-dark` aplica um tema sem gravar nada (capturas);
 * `?movimento=reduzido` mostra o estado final de todas as peças;
 * `?vitrine=onboarding&estado=inicio|funil|atendente|ativar|email|final|erro` mostra a conversa `/comecar` com dados fixos.
 */
export function DevKitPage() {
  const [params] = useSearchParams();
  const theme = params.get("tema");
  const reduced = params.get("movimento") === "reduzido";

  useEffect(() => {
    if (isUiTheme(theme)) applyTheme(theme);
  }, [theme]);

  if (params.get("vitrine") === "onboarding") {
    const raw = params.get("estado");
    const estado: ShowcaseState = (SHOWCASE_STATES as readonly string[]).includes(raw ?? "") ? (raw as ShowcaseState) : "inicio";
    return (
      <>
        <SEO title="Onboarding (vitrine DEV)" noindex />
        <Suspense fallback={null}>
          <OnboardingShowcase estado={estado} reducedMotion={reduced || undefined} />
        </Suspense>
      </>
    );
  }

  return (
    <>
      <SEO title="Kit de cena (DEV)" noindex />
      <div className="min-h-screen bg-surface-base text-text-primary">
        <header className="border-b border-border bg-surface-raised">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-2">
            <Link to="/" className="inline-flex min-h-11 items-center" aria-label="Voltar ao início">
              <BrandLogo variant="responsive" size="md" decorative />
            </Link>
            <PublicThemeButton />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">
          <h1 className="font-display text-2xl font-bold">Kit de cena</h1>
          <p className="mb-8 mt-1 text-sm text-text-secondary">
            Só em desenvolvimento. Peças de `src/components/landing/kit/` com a copy aprovada.
            {reduced ? " Movimento reduzido forçado." : ""}
          </p>
          <KitShowcase reducedMotion={reduced || undefined} />
        </main>
      </div>
    </>
  );
}
