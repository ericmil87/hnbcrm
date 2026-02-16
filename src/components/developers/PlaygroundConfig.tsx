import { useState } from "react";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Settings, ChevronUp, Pencil } from "lucide-react";
import { usePlaygroundConfig } from "./PlaygroundConfigProvider";

export function PlaygroundConfig() {
  const { baseUrl, setBaseUrl, apiKey, setApiKey, isConfigured } = usePlaygroundConfig();
  const [expanded, setExpanded] = useState(!isConfigured);

  const maskedKey = apiKey ? `${apiKey.slice(0, 6)}...${"*".repeat(8)}` : "";
  const displayUrl = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();

  // Compact bar when configured and collapsed
  if (isConfigured && !expanded) {
    return (
      <div className="bg-surface-raised border-b border-border px-4 py-2 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Settings size={16} className="text-brand-500 flex-shrink-0" />
          <Badge variant="success" className="flex-shrink-0">Configurado</Badge>
          <span className="text-xs text-text-muted font-mono truncate">
            {displayUrl}
          </span>
          <span className="text-xs text-text-muted hidden sm:inline">|</span>
          <span className="text-xs text-text-muted font-mono truncate hidden sm:inline">
            {maskedKey}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          <Pencil size={14} />
          Editar
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-surface-raised border-b border-border p-3">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start gap-4 flex-col md:flex-row md:items-end">
          <div className="flex items-center gap-2 mb-2 md:mb-0">
            <Settings size={20} className="text-brand-500" />
            <h2 className="text-sm font-semibold text-text-primary">Configuracao</h2>
            <Badge variant={isConfigured ? "success" : "warning"}>
              {isConfigured ? "Configurado" : "Pendente"}
            </Badge>
          </div>

          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2 w-full">
            <Input
              label="Base URL"
              placeholder="https://seu-deployment.convex.site"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="font-mono text-sm"
            />
            <Input
              label="API Key"
              type="password"
              placeholder="sua_chave_aqui"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          {isConfigured && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(false)}
              className="flex-shrink-0"
            >
              <ChevronUp size={14} />
              Recolher
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
