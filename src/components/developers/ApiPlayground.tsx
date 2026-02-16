import { useState, useEffect, useCallback, useRef } from "react";
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
  onEndpointChange?: (id: string | null) => void;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 320;
const SIDEBAR_DEFAULT = 240;
const REQUEST_MIN = 280;
const REQUEST_MAX = 500;
const REQUEST_DEFAULT = 340;

function getStoredWidth(key: string, defaultVal: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored) return Math.max(0, Number(stored));
  } catch {}
  return defaultVal;
}

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        onResize(moveEvent.clientX - startX);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [onResize]
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1.5 flex-shrink-0 cursor-col-resize bg-border hover:bg-brand-500/30 active:bg-brand-500/50 transition-colors"
    />
  );
}

export function ApiPlayground({ initialEndpointId, fullPage, onEndpointChange }: ApiPlaygroundProps) {
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

  // Resizable panel widths
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    getStoredWidth("hnbcrm_playground_sidebarW", SIDEBAR_DEFAULT)
  );
  const [requestWidth, setRequestWidth] = useState(() =>
    getStoredWidth("hnbcrm_playground_requestW", REQUEST_DEFAULT)
  );
  const sidebarBaseRef = useRef(sidebarWidth);
  const requestBaseRef = useRef(requestWidth);

  // Pagination state
  const [paginationCursors, setPaginationCursors] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [lastRequestInfo, setLastRequestInfo] = useState<{
    endpoint: typeof selectedEndpointId;
    formData: Record<string, unknown>;
    mode: "form" | "json";
    jsonBody: string;
  } | null>(null);

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

  // Persist widths
  useEffect(() => {
    try { localStorage.setItem("hnbcrm_playground_sidebarW", String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);
  useEffect(() => {
    try { localStorage.setItem("hnbcrm_playground_requestW", String(requestWidth)); } catch {}
  }, [requestWidth]);

  const handleSelectEndpoint = (id: string | null) => {
    setSelectedEndpointId(id);
    setResponse(null);
    setPaginationCursors([]);
    setCurrentPage(0);
    setLastRequestInfo(null);
    onEndpointChange?.(id);
  };

  const selectedEndpoint = selectedEndpointId ? getEndpoint(selectedEndpointId) : null;

  const handleResponse = (res: { status: number; data: unknown; time: number }) => {
    setResponse(res);
    // Track pagination cursor from response
    const data = res.data as any;
    if (data?.nextCursor && data?.hasMore) {
      // Only update cursors if this is a new request (not pagination)
      if (!isLoadingMore) {
        setPaginationCursors([]);
        setCurrentPage(0);
      }
    }
  };

  // Detect if response has pagination info
  const responseData = response?.data as any;
  const responseHasMore = responseData?.hasMore === true && responseData?.nextCursor;
  const responseNextCursor = responseData?.nextCursor as string | undefined;

  const handleLoadMore = async () => {
    if (!responseNextCursor || !lastRequestInfo || !selectedEndpoint) return;
    setIsLoadingMore(true);

    try {
      // Build URL with cursor
      const queryParams = selectedEndpoint.params
        .filter((p) => p.location === "query")
        .map((param) => {
          if (param.name === "cursor") return `cursor=${encodeURIComponent(responseNextCursor)}`;
          const value = lastRequestInfo.formData[param.name];
          if (value !== undefined && value !== "") {
            return `${param.name}=${encodeURIComponent(String(value))}`;
          }
          return null;
        })
        .filter(Boolean)
        .join("&");

      // Add cursor if not already in params
      let queryString = queryParams;
      if (!queryString.includes("cursor=")) {
        queryString += (queryString ? "&" : "") + `cursor=${encodeURIComponent(responseNextCursor)}`;
      }

      const url = baseUrl + selectedEndpoint.path + (queryString ? `?${queryString}` : "");
      const startTime = performance.now();

      const fetchResponse = await fetch(url, {
        method: selectedEndpoint.method,
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
      });
      const data = await fetchResponse.json();
      const endTime = performance.now();

      // Save current cursor for going back
      setPaginationCursors((prev) => [...prev, responseNextCursor]);
      setCurrentPage((prev) => prev + 1);

      setResponse({
        status: fetchResponse.status,
        data,
        time: Math.round(endTime - startTime),
      });
    } catch (error) {
      // Don't override response on error
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleGoBack = async () => {
    if (currentPage <= 0 || !lastRequestInfo || !selectedEndpoint) return;
    setIsLoadingMore(true);

    try {
      // Get the cursor for the previous page (or none for page 0)
      const prevCursor = currentPage >= 2 ? paginationCursors[currentPage - 2] : undefined;

      const queryParams = selectedEndpoint.params
        .filter((p) => p.location === "query")
        .map((param) => {
          if (param.name === "cursor") {
            return prevCursor ? `cursor=${encodeURIComponent(prevCursor)}` : null;
          }
          const value = lastRequestInfo.formData[param.name];
          if (value !== undefined && value !== "") {
            return `${param.name}=${encodeURIComponent(String(value))}`;
          }
          return null;
        })
        .filter(Boolean)
        .join("&");

      let queryString = queryParams;
      if (prevCursor && !queryString.includes("cursor=")) {
        queryString += (queryString ? "&" : "") + `cursor=${encodeURIComponent(prevCursor)}`;
      }

      const url = baseUrl + selectedEndpoint.path + (queryString ? `?${queryString}` : "");
      const startTime = performance.now();

      const fetchResponse = await fetch(url, {
        method: selectedEndpoint.method,
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
      });
      const data = await fetchResponse.json();
      const endTime = performance.now();

      setPaginationCursors((prev) => prev.slice(0, currentPage - 1));
      setCurrentPage((prev) => prev - 1);

      setResponse({
        status: fetchResponse.status,
        data,
        time: Math.round(endTime - startTime),
      });
    } catch (error) {
      // Don't override response on error
    } finally {
      setIsLoadingMore(false);
    }
  };

  const handleSidebarResize = useCallback(
    (delta: number) => {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sidebarBaseRef.current + delta)));
    },
    []
  );

  const handleRequestResize = useCallback(
    (delta: number) => {
      setRequestWidth(Math.min(REQUEST_MAX, Math.max(REQUEST_MIN, requestBaseRef.current + delta)));
    },
    []
  );

  // Update base refs on mousedown (start of drag) via effect
  useEffect(() => {
    sidebarBaseRef.current = sidebarWidth;
  }, [sidebarWidth]);
  useEffect(() => {
    requestBaseRef.current = requestWidth;
  }, [requestWidth]);

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
                  handleSelectEndpoint(e.target.value || null);
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
                        onSendRequest={(res, reqInfo) => {
                          handleResponse(res);
                          if (reqInfo) setLastRequestInfo({ ...reqInfo, endpoint: selectedEndpointId });
                        }}
                      />
                    </div>
                  ) : (
                    <div className="h-full overflow-y-auto">
                      <ResponseViewer
                        response={response}
                        hasMore={!!responseHasMore}
                        currentPage={currentPage}
                        isLoadingMore={isLoadingMore}
                        onLoadMore={handleLoadMore}
                        onGoBack={handleGoBack}
                      />
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

          {/* Desktop layout — resizable panels */}
          <div className="hidden md:flex flex-1 overflow-hidden">
            <div style={{ width: sidebarWidth }} className="flex-shrink-0">
              <PlaygroundSidebar
                selectedEndpointId={selectedEndpointId}
                onSelectEndpoint={(id) => handleSelectEndpoint(id)}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
              />
            </div>

            <ResizeHandle onResize={handleSidebarResize} />

            {selectedEndpoint ? (
              <>
                <div style={{ width: requestWidth }} className="flex-shrink-0 overflow-hidden">
                  <RequestBuilder
                    endpoint={selectedEndpoint}
                    baseUrl={baseUrl}
                    apiKey={apiKey}
                    onSendRequest={(res, reqInfo) => {
                      handleResponse(res);
                      if (reqInfo) setLastRequestInfo({ ...reqInfo, endpoint: selectedEndpointId });
                    }}
                  />
                </div>
                <ResizeHandle onResize={handleRequestResize} />
                <div className="flex-1 min-w-0">
                  <ResponseViewer
                    response={response}
                    hasMore={!!responseHasMore}
                    currentPage={currentPage}
                    isLoadingMore={isLoadingMore}
                    onLoadMore={handleLoadMore}
                    onGoBack={handleGoBack}
                  />
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
