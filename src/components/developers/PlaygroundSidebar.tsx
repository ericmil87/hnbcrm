import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";
import { ALL_ENDPOINTS, API_CATEGORIES } from "@/lib/apiRegistry";

interface PlaygroundSidebarProps {
  selectedEndpointId: string | null;
  onSelectEndpoint: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

function getShortPath(path: string): string {
  // Remove /api/v1 prefix and return the rest
  return path.replace(/^\/api\/v1/, "");
}

export function PlaygroundSidebar({
  selectedEndpointId,
  onSelectEndpoint,
  searchQuery,
  onSearchChange,
}: PlaygroundSidebarProps) {
  const filteredEndpoints = ALL_ENDPOINTS.filter((endpoint) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (
      endpoint.path.toLowerCase().includes(query) ||
      endpoint.title.toLowerCase().includes(query) ||
      endpoint.description.toLowerCase().includes(query)
    );
  });

  const endpointsByCategory = API_CATEGORIES.map((category) => ({
    category,
    endpoints: filteredEndpoints.filter((e) => e.category === category),
  })).filter((group) => group.endpoints.length > 0);

  const getMethodColor = (method: string) => {
    switch (method) {
      case "GET": return "success" as const;
      case "DELETE": return "error" as const;
      case "PUT": return "warning" as const;
      default: return "info" as const;
    }
  };

  return (
    <div className="h-full flex flex-col bg-surface-raised border-r border-border">
      <div className="p-3 border-b border-border">
        <Input
          placeholder="Buscar endpoints..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          icon={<Search size={16} />}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {endpointsByCategory.length === 0 ? (
          <div className="p-4 text-center text-text-muted text-sm">
            Nenhum endpoint encontrado
          </div>
        ) : (
          <div className="p-1.5">
            {endpointsByCategory.map(({ category, endpoints }) => (
              <div key={category} className="mb-3">
                <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
                  <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                    {category}
                  </span>
                  <Badge variant="default" className="text-[10px] px-1.5 py-0">
                    {endpoints.length}
                  </Badge>
                </div>

                <div className="space-y-0.5">
                  {endpoints.map((endpoint) => (
                    <button
                      key={endpoint.id}
                      onClick={() => onSelectEndpoint(endpoint.id)}
                      title={endpoint.path}
                      className={cn(
                        "w-full text-left px-2 py-1.5 rounded-lg transition-colors",
                        "hover:bg-surface-overlay",
                        selectedEndpointId === endpoint.id
                          ? "bg-brand-500/10 text-brand-400 border border-brand-500/30"
                          : "text-text-secondary"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant={getMethodColor(endpoint.method)} className="text-[10px] px-1.5 py-0 flex-shrink-0">
                          {endpoint.method}
                        </Badge>
                        <span className="text-[12px] font-medium truncate">
                          {endpoint.title}
                        </span>
                      </div>
                      <p className="text-[11px] text-text-muted font-mono mt-0.5 truncate pl-[42px]">
                        {getShortPath(endpoint.path)}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
