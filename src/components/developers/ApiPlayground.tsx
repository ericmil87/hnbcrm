import { useState, useEffect } from "react";
import { PlaygroundConfig } from "./PlaygroundConfig";
import { PlaygroundSidebar } from "./PlaygroundSidebar";
import { RequestBuilder } from "./RequestBuilder";
import { ResponseViewer } from "./ResponseViewer";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { usePlaygroundConfig } from "./PlaygroundConfigProvider";
import { getEndpoint, ALL_ENDPOINTS, API_CATEGORIES } from "@/lib/apiRegistry";

interface ApiPlaygroundProps {
  initialEndpointId?: string;
  fullPage?: boolean;
}

export function ApiPlayground({ initialEndpointId, fullPage }: ApiPlaygroundProps) {
  const { baseUrl, apiKey, isConfigured } = usePlaygroundConfig();
  const [selectedEndpointId, setSelectedEndpointId] = useState<string | null>(
    initialEndpointId || null
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [response, setResponse] = useState<{
    status: number;
    data: unknown;
    time: number;
  } | null>(null);
  const [mobileTab, setMobileTab] = useState<"request" | "response">("request");

  useEffect(() => {
    if (initialEndpointId) {
      setSelectedEndpointId(initialEndpointId);
    }
  }, [initialEndpointId]);

  // Auto-switch to response tab on mobile when response arrives
  useEffect(() => {
    if (response) {
      setMobileTab("response");
    }
  }, [response]);

  const selectedEndpoint = selectedEndpointId ? getEndpoint(selectedEndpointId) : null;

  const handleResponse = (res: { status: number; data: unknown; time: number }) => {
    setResponse(res);
  };

  const containerClass = fullPage
    ? "flex flex-col h-full bg-surface-base overflow-hidden"
    : "flex flex-col h-[700px] bg-surface-base border border-border rounded-lg overflow-hidden";

  return (
    <div className={containerClass}>
      <PlaygroundConfig />

      {!isConfigured ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <Card variant="default" className="max-w-md p-6 text-center">
            <h3 className="text-lg font-semibold text-text-primary mb-2">
              Configure o Playground
            </h3>
            <p className="text-sm text-text-muted">
              Insira a Base URL do seu deployment Convex e uma API Key valida para comecar a testar
              os endpoints.
            </p>
          </Card>
        </div>
      ) : (
        <>
          {/* Mobile layout */}
          <div className="md:hidden flex-1 flex flex-col overflow-hidden">
            <div className="px-3 py-2 bg-surface-raised border-b border-border">
              <label className="block text-[13px] font-medium text-text-secondary mb-1">
                Endpoint
              </label>
              <select
                value={selectedEndpointId || ""}
                onChange={(e) => {
                  setSelectedEndpointId(e.target.value || null);
                  setResponse(null);
                  setMobileTab("request");
                }}
                className="w-full bg-surface-raised border border-border-strong rounded-field px-3 py-2 text-base text-text-primary focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              >
                <option value="">Selecione um endpoint...</option>
                {API_CATEGORIES.map((category) => {
                  const endpoints = ALL_ENDPOINTS.filter((e) => e.category === category);
                  if (endpoints.length === 0) return null;
                  return (
                    <optgroup key={category} label={category}>
                      {endpoints.map((endpoint) => (
                        <option key={endpoint.id} value={endpoint.id}>
                          {endpoint.method} {endpoint.path}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </div>

            {selectedEndpoint ? (
              <div className="flex-1 flex flex-col overflow-hidden">
                {/* Tab switcher */}
                <div className="flex border-b border-border bg-surface-raised">
                  <button
                    onClick={() => setMobileTab("request")}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                      mobileTab === "request"
                        ? "text-brand-400 border-b-2 border-brand-500"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Requisição
                  </button>
                  <button
                    onClick={() => setMobileTab("response")}
                    className={`flex-1 px-3 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                      mobileTab === "response"
                        ? "text-brand-400 border-b-2 border-brand-500"
                        : "text-text-muted hover:text-text-secondary"
                    }`}
                  >
                    Resposta
                    {response && (
                      <Badge
                        variant={response.status >= 200 && response.status < 300 ? "success" : "error"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {response.status}
                      </Badge>
                    )}
                  </button>
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-hidden">
                  {mobileTab === "request" ? (
                    <div className="h-full overflow-y-auto">
                      <RequestBuilder
                        endpoint={selectedEndpoint}
                        baseUrl={baseUrl}
                        apiKey={apiKey}
                        onSendRequest={handleResponse}
                      />
                    </div>
                  ) : (
                    <div className="h-full overflow-y-auto">
                      <ResponseViewer response={response} />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center p-6">
                <EmptyState />
              </div>
            )}
          </div>

          {/* Desktop layout */}
          <div className="hidden md:flex flex-1 overflow-hidden">
            <div className="w-56 flex-shrink-0">
              <PlaygroundSidebar
                selectedEndpointId={selectedEndpointId}
                onSelectEndpoint={(id) => {
                  setSelectedEndpointId(id);
                  setResponse(null);
                }}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
              />
            </div>

            {selectedEndpoint ? (
              <>
                <div className="w-[340px] flex-shrink-0 overflow-hidden">
                  <RequestBuilder
                    endpoint={selectedEndpoint}
                    baseUrl={baseUrl}
                    apiKey={apiKey}
                    onSendRequest={handleResponse}
                  />
                </div>
                <div className="flex-1 min-w-0 border-l border-border">
                  <ResponseViewer response={response} />
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <EmptyState />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center space-y-4">
      <p className="text-text-muted text-sm mb-3">
        Selecione um endpoint para comecar
      </p>
      <div className="flex flex-wrap items-center gap-2 justify-center">
        {API_CATEGORIES.map((cat) => {
          const count = ALL_ENDPOINTS.filter((e) => e.category === cat).length;
          return (
            <span
              key={cat}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-surface-overlay border border-border text-text-secondary"
            >
              {cat} ({count})
            </span>
          );
        })}
      </div>
      <div className="flex items-center gap-2 justify-center pt-1">
        <Badge variant="success" className="text-xs">GET</Badge>
        <Badge variant="info" className="text-xs">POST</Badge>
        <span className="text-text-muted text-xs">
          {ALL_ENDPOINTS.length} endpoints disponiveis
        </span>
      </div>
    </div>
  );
}
