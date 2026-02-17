import { Link, useSearchParams } from "react-router";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PlaygroundConfigProvider } from "@/components/developers/PlaygroundConfigProvider";
import { ApiPlayground } from "@/components/developers/ApiPlayground";
import { SEO } from "@/components/SEO";

export function PlaygroundPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const endpointId = searchParams.get("endpoint") || undefined;

  const handleEndpointChange = (id: string | null) => {
    if (id) {
      setSearchParams({ endpoint: id });
    } else {
      setSearchParams({});
    }
  };

  return (
    <>
      <SEO
        title="API Playground"
        description="Teste a API REST do HNBCRM interativamente. 44 endpoints para leads, contatos, conversas, atividades e webhooks."
        keywords="api playground, rest api, testing, developer tools"
      />
      <PlaygroundConfigProvider>
        <div className="h-screen flex flex-col bg-surface-base text-text-primary">
          {/* Compact header */}
        <header className="flex-shrink-0 bg-surface-base border-b border-border">
          <div className="px-4 py-2.5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <Link to="/" className="flex items-center gap-1.5 flex-shrink-0">
                <img
                  src="/orange_icon_logo_transparent-bg-528x488.png"
                  alt="HNBCRM"
                  className="h-6 w-6 object-contain"
                />
                <span className="text-sm font-bold text-text-primary hidden sm:inline">HNBCRM</span>
              </Link>
              <span className="text-text-muted text-xs">/</span>
              <Link to="/developers" className="text-xs text-text-secondary hover:text-text-primary transition-colors">
                Developers
              </Link>
              <span className="text-text-muted text-xs">/</span>
              <span className="text-xs font-medium text-text-primary">Playground</span>
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              <a href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer">
                <Button variant="ghost" size="sm">
                  <Download size={14} />
                  <span className="hidden sm:inline">OpenAPI Spec</span>
                </Button>
              </a>
              <Link to="/developers">
                <Button variant="ghost" size="sm">
                  <ArrowLeft size={14} />
                  Voltar
                </Button>
              </Link>
            </div>
          </div>
        </header>

        {/* Full-height playground */}
        <div className="flex-1 min-h-0">
          <ApiPlayground initialEndpointId={endpointId} fullPage onEndpointChange={handleEndpointChange} />
        </div>
      </div>
    </PlaygroundConfigProvider>
    </>
  );
}
