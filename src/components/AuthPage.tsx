import { Link, Navigate } from "react-router";
import { useConvexAuth } from "convex/react";
import { SignInForm } from "@/SignInForm";
import { Spinner } from "@/components/ui/Spinner";
import { ArrowLeft } from "lucide-react";
import { SEO } from "@/components/SEO";

export function AuthPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-screen bg-surface-base">
        <Spinner size="lg" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/app" replace />;
  }

  return (
    <>
      <SEO
        title="Entrar"
        description="Acesse sua conta HNBCRM"
        noindex={true}
      />
      <div className="flex items-center justify-center min-h-screen px-4 bg-gradient-to-b from-surface-overlay to-surface-base">
        <div className="w-full max-w-md">
        <div className="text-center mb-8 animate-fade-in-up">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors mb-6"
          >
            <ArrowLeft size={16} />
            Voltar ao inicio
          </Link>
          <img
            src="/orange_icon_logo_transparent-bg-528x488.png"
            alt="HNBCRM"
            className="h-16 w-16 mx-auto mb-4 object-contain"
          />
          <h1 className="text-3xl md:text-4xl font-bold text-text-primary mb-2">
            HNBCRM
          </h1>
          <p className="text-lg md:text-xl text-text-secondary">
            CRM multi-tenant com colaboração humano-IA
          </p>
        </div>
        <div className="animate-fade-in-up">
          <SignInForm />
        </div>
      </div>
    </div>
    </>
  );
}
