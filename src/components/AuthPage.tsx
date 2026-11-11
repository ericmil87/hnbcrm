import { useEffect } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { useConvexAuth } from "convex/react";
import { SignInForm } from "@/SignInForm";
import { Spinner } from "@/components/ui/Spinner";
import { ArrowLeft } from "lucide-react";
import { SEO } from "@/components/SEO";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { PublicThemeButton } from "@/components/landing/PublicThemeButton";
import { postLoginTarget } from "@/lib/signOutFlow";
import { parseAuthFlow, parsePlanKey, storePlanIntent } from "@/lib/authEntry";

export function AuthPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const initialFlow = parseAuthFlow(searchParams.get("modo"));
  const planIntent = parsePlanKey(searchParams.get("plano"));

  // Preserva o plano de interesse até a criação da organização.
  useEffect(() => {
    storePlanIntent(planIntent);
  }, [planIntent]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen bg-surface-base">
        <Spinner size="lg" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to={postLoginTarget(location.state)} replace />;
  }

  return (
    <>
      <SEO
        title="Entrar"
        description="Acesse sua conta HNBCRM"
        noindex={true}
      />
      <div className="relative flex items-center justify-center min-h-screen supports-[height:100dvh]:min-h-[100dvh] px-4 py-8 bg-gradient-to-b from-surface-overlay to-surface-base">
        <div className="absolute right-2 top-2 sm:right-4 sm:top-4">
          <PublicThemeButton />
        </div>
        <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in-up">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-6"
          >
            <ArrowLeft size={16} />
            Voltar ao início
          </Link>
          <BrandLogo size="xl" decorative className="mx-auto mb-4" />
          <h1 className="font-display text-3xl md:text-4xl font-bold text-text-primary mb-2">
            HNBCRM
          </h1>
          <p className="text-lg md:text-xl text-text-secondary">
            CRM multi-tenant com colaboração humano-IA
          </p>
        </div>
        <div className="animate-fade-in-up rounded-card border border-border-subtle bg-surface-raised p-5 shadow-card sm:p-6">
          <SignInForm initialFlow={initialFlow} />
        </div>
      </div>
    </div>
    </>
  );
}
