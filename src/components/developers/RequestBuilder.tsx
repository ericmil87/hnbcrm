import { useState, useEffect } from "react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Copy, Send, WrapText } from "lucide-react";
import type { ApiEndpoint, ApiParam } from "@/lib/apiRegistry";

interface RequestBuilderProps {
  endpoint: ApiEndpoint;
  baseUrl: string;
  apiKey: string;
  onSendRequest: (
    response: { status: number; data: unknown; time: number },
    requestInfo?: { formData: Record<string, unknown>; mode: "form" | "json"; jsonBody: string }
  ) => void;
}

const getMethodColor = (method: string) => {
  switch (method) {
    case "GET": return "success" as const;
    case "DELETE": return "error" as const;
    case "PUT": return "warning" as const;
    default: return "info" as const;
  }
};

export function RequestBuilder({ endpoint, baseUrl, apiKey, onSendRequest }: RequestBuilderProps) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonBody, setJsonBody] = useState(() => buildJsonTemplate(endpoint));
  const [showCopied, setShowCopied] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [shakeBtn, setShakeBtn] = useState(false);

  // Reset state when endpoint changes
  useEffect(() => {
    setFormData({});
    setErrors({});
    setJsonError(null);
    setJsonBody(buildJsonTemplate(endpoint));
    setMode("form");
  }, [endpoint]);

  const clearFieldError = (name: string) => {
    if (errors[name]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  const handleFieldChange = (name: string, value: unknown, parentKey?: string) => {
    clearFieldError(parentKey ? `${parentKey}.${name}` : name);
    setFormData((prev) => {
      if (parentKey) {
        return {
          ...prev,
          [parentKey]: {
            ...(prev[parentKey] as Record<string, unknown> || {}),
            [name]: value,
          },
        };
      }
      return { ...prev, [name]: value };
    });
  };

  const buildRequestBody = () => {
    if (mode === "json") {
      try {
        return JSON.parse(jsonBody);
      } catch {
        return {};
      }
    }

    const body: Record<string, unknown> = {};
    endpoint.params
      .filter((p) => p.location === "body")
      .forEach((param) => {
        const value = formData[param.name];
        if (value !== undefined && value !== "") {
          if (param.type === "number") {
            body[param.name] = Number(value);
          } else if (param.type === "boolean") {
            body[param.name] = Boolean(value);
          } else if (param.type === "array") {
            try {
              body[param.name] = typeof value === "string" ? JSON.parse(value) : value;
            } catch {
              body[param.name] = [];
            }
          } else if (param.type === "object") {
            body[param.name] = typeof value === "string" ? tryParseJSON(value) : value;
          } else {
            body[param.name] = value;
          }
        }
      });
    return body;
  };

  const buildUrl = () => {
    const queryParams = endpoint.params
      .filter((p) => p.location === "query")
      .map((param) => {
        const value = formData[param.name];
        if (value !== undefined && value !== "") {
          return `${param.name}=${encodeURIComponent(String(value))}`;
        }
        return null;
      })
      .filter(Boolean)
      .join("&");

    const url = baseUrl + endpoint.path;
    return queryParams ? `${url}?${queryParams}` : url;
  };

  const buildCurlCommand = () => {
    const url = buildUrl();
    const headers = [`-H "X-API-Key: ${apiKey}"`];
    const method = endpoint.method;

    if (method === "POST" || method === "PUT" || method === "DELETE") {
      headers.push(`-H "Content-Type: application/json"`);
      const body = buildRequestBody();
      const bodyStr = Object.keys(body).length > 0
        ? ` \\\n  -d '${JSON.stringify(body, null, 2)}'`
        : "";
      return `curl -X ${method} ${url} \\\n  ${headers.join(" \\\n  ")}${bodyStr}`;
    }

    return `curl -X ${method} ${url} \\\n  ${headers.join(" \\\n  ")}`;
  };

  const handleCopyCurl = async () => {
    const curl = buildCurlCommand();
    await navigator.clipboard.writeText(curl);
    setShowCopied(true);
    setTimeout(() => setShowCopied(false), 2000);
  };

  const validateFields = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (mode === "json" && endpoint.method !== "GET") {
      try {
        JSON.parse(jsonBody);
      } catch {
        setJsonError("JSON inválido");
        return false;
      }
    }

    if (mode === "form") {
      for (const param of endpoint.params) {
        const value = formData[param.name];
        const isEmpty = value === undefined || value === "" || value === null;

        if (param.required && isEmpty) {
          newErrors[param.name] = "Campo obrigatório";
          continue;
        }

        if (!isEmpty && param.type === "number") {
          if (isNaN(Number(value))) {
            newErrors[param.name] = "Valor deve ser numérico";
          }
        }

        if (!isEmpty && (param.type === "object" || param.type === "array") && !param.nested) {
          if (typeof value === "string" && value.trim()) {
            try {
              JSON.parse(value);
            } catch {
              newErrors[param.name] = "JSON inválido";
            }
          }
        }
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSend = async () => {
    if (!validateFields()) {
      setShakeBtn(true);
      setTimeout(() => setShakeBtn(false), 500);
      return;
    }

    setIsLoading(true);
    const startTime = performance.now();

    try {
      const url = buildUrl();
      const options: RequestInit = {
        method: endpoint.method,
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
      };

      if (endpoint.method !== "GET") {
        options.body = JSON.stringify(buildRequestBody());
      }

      const response = await fetch(url, options);
      const data = await response.json();
      const endTime = performance.now();

      onSendRequest(
        {
          status: response.status,
          data,
          time: Math.round(endTime - startTime),
        },
        { formData, mode, jsonBody }
      );
    } catch (error) {
      onSendRequest(
        {
          status: 0,
          data: { error: error instanceof Error ? error.message : "Erro desconhecido" },
          time: 0,
        },
        { formData, mode, jsonBody }
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleJsonBlur = () => {
    if (jsonBody.trim()) {
      try {
        JSON.parse(jsonBody);
        setJsonError(null);
      } catch {
        setJsonError("JSON inválido");
      }
    } else {
      setJsonError(null);
    }
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonBody);
      setJsonBody(JSON.stringify(parsed, null, 2));
      setJsonError(null);
    } catch {
      setJsonError("JSON inválido");
    }
  };

  const renderFormField = (param: ApiParam, parentKey?: string) => {
    const fieldKey = parentKey ? `${parentKey}.${param.name}` : param.name;
    const value = parentKey
      ? ((formData[parentKey] as Record<string, unknown>)?.[param.name] ?? "")
      : (formData[param.name] ?? "");
    const fieldError = errors[fieldKey] || errors[param.name];

    if (param.enumValues) {
      return (
        <div key={fieldKey}>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            {param.name}
            <Badge variant="default" className="ml-2 text-[10px] px-1 py-0 font-normal">{param.type}</Badge>
            {param.required && <Badge variant="error" className="ml-1 text-[10px] px-1.5">obrigatório</Badge>}
          </label>
          <select
            value={String(value)}
            onChange={(e) => handleFieldChange(param.name, e.target.value, parentKey)}
            className={`w-full bg-surface-raised border rounded-field px-3.5 py-2 text-base md:text-sm text-text-primary focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 ${
              fieldError ? "border-semantic-error" : "border-border-strong"
            }`}
          >
            <option value="">Selecione...</option>
            {param.enumValues.map((enumVal) => (
              <option key={enumVal} value={enumVal}>
                {enumVal}
              </option>
            ))}
          </select>
          {fieldError && <p className="mt-1 text-[11px] text-semantic-error">{fieldError}</p>}
          <p className="mt-1 text-[11px] text-text-muted">{param.description}</p>
        </div>
      );
    }

    if (param.type === "boolean") {
      return (
        <div key={fieldKey} className="flex items-center gap-3">
          <input
            type="checkbox"
            id={fieldKey}
            checked={Boolean(value)}
            onChange={(e) => handleFieldChange(param.name, e.target.checked, parentKey)}
            className="w-4 h-4 rounded border-border-strong bg-surface-raised text-brand-600 focus:ring-brand-500"
          />
          <label htmlFor={fieldKey} className="text-[13px] font-medium text-text-secondary">
            {param.name}
            <Badge variant="default" className="ml-2 text-[10px] px-1 py-0 font-normal">boolean</Badge>
            {param.required && <Badge variant="error" className="ml-1 text-[10px] px-1.5">obrigatório</Badge>}
          </label>
        </div>
      );
    }

    if (param.type === "object" && param.nested) {
      return (
        <div key={fieldKey} className="border border-border rounded-lg p-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text-primary">{param.name}</span>
            <Badge variant="default" className="text-[10px] px-1 py-0 font-normal">object</Badge>
            {param.required && <Badge variant="error" className="text-[10px] px-1.5">obrigatório</Badge>}
          </div>
          <p className="text-[11px] text-text-muted -mt-1">{param.description}</p>
          <div className="pl-3 space-y-3 border-l-2 border-border-subtle">
            {param.nested.map((nestedParam) => renderFormField(nestedParam, param.name))}
          </div>
        </div>
      );
    }

    if (param.type === "object" || param.type === "array") {
      return (
        <div key={fieldKey}>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">
            {param.name}
            <Badge variant="default" className="ml-2 text-[10px] px-1 py-0 font-normal">{param.type}</Badge>
            {param.required && <Badge variant="error" className="ml-1 text-[10px] px-1.5">obrigatório</Badge>}
          </label>
          <textarea
            value={String(value)}
            onChange={(e) => handleFieldChange(param.name, e.target.value, parentKey)}
            onBlur={() => {
              const v = String(value).trim();
              if (v) {
                try { JSON.parse(v); clearFieldError(param.name); } catch { setErrors((prev) => ({ ...prev, [param.name]: "JSON inválido" })); }
              }
            }}
            placeholder={param.description}
            rows={3}
            className={`w-full bg-surface-raised border rounded-field px-3.5 py-2 text-base md:text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 ${
              fieldError ? "border-semantic-error" : "border-border-strong"
            }`}
          />
          {fieldError && <p className="mt-1 text-[11px] text-semantic-error">{fieldError}</p>}
          <p className="mt-1 text-[11px] text-text-muted">JSON: {param.description}</p>
        </div>
      );
    }

    return (
      <div key={fieldKey}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[13px] font-medium text-text-secondary">{param.name}</span>
          <Badge variant="default" className="text-[10px] px-1 py-0 font-normal">{param.type}</Badge>
          {param.required && <Badge variant="error" className="text-[10px] px-1.5">obrigatório</Badge>}
        </div>
        <Input
          type={param.type === "number" ? "text" : "text"}
          value={String(value)}
          onChange={(e) => handleFieldChange(param.name, e.target.value, parentKey)}
          placeholder={param.description}
          error={fieldError}
          className="py-2"
        />
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-surface-raised">
      {/* URL bar header */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Badge variant={getMethodColor(endpoint.method)} className="flex-shrink-0">
            {endpoint.method}
          </Badge>
          <span className="text-sm font-mono text-text-primary truncate flex-1">
            {endpoint.path}
          </span>
          {endpoint.method !== "GET" && (
            <div className="flex gap-0.5 bg-surface-sunken rounded-full p-0.5 flex-shrink-0">
              <button
                onClick={() => setMode("form")}
                className={`px-2.5 py-0.5 text-xs rounded-full transition-colors ${
                  mode === "form" ? "bg-brand-500 text-white" : "text-text-muted hover:text-text-secondary"
                }`}
              >
                Form
              </button>
              <button
                onClick={() => setMode("json")}
                className={`px-2.5 py-0.5 text-xs rounded-full transition-colors ${
                  mode === "json" ? "bg-brand-500 text-white" : "text-text-muted hover:text-text-secondary"
                }`}
              >
                JSON
              </button>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={handleCopyCurl} className="flex-shrink-0">
            <Copy size={14} />
            {showCopied ? "Copiado!" : "cURL"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSend}
            disabled={isLoading}
            className={`flex-shrink-0 ${shakeBtn ? "animate-shake" : ""}`}
          >
            <Send size={14} />
            {isLoading ? "Enviando..." : "Enviar"}
          </Button>
        </div>
        <p className="text-[11px] text-text-muted mt-1">{endpoint.description}</p>
      </div>

      {/* Form fields */}
      <div className="flex-1 overflow-y-auto p-3">
        {mode === "json" && endpoint.method !== "GET" ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-[13px] font-medium text-text-secondary">
                Request Body (JSON)
              </label>
              <button
                onClick={handleFormatJson}
                className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors"
              >
                <WrapText size={12} />
                Formatar
              </button>
            </div>
            <textarea
              value={jsonBody}
              onChange={(e) => { setJsonBody(e.target.value); setJsonError(null); }}
              onBlur={handleJsonBlur}
              rows={15}
              className={`w-full bg-surface-sunken border rounded-field px-3.5 py-2 text-sm text-text-primary font-mono focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 ${
                jsonError ? "border-semantic-error" : "border-border-strong"
              }`}
            />
            {jsonError && <p className="mt-1 text-[11px] text-semantic-error">{jsonError}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            {endpoint.params.map((param) => renderFormField(param))}
          </div>
        )}
      </div>
    </div>
  );
}

function buildJsonTemplate(endpoint: ApiEndpoint): string {
  const template: Record<string, unknown> = {};
  endpoint.params
    .filter((p) => p.location === "body")
    .forEach((param) => {
      if (param.nested) {
        const nested: Record<string, unknown> = {};
        param.nested.forEach((n) => {
          nested[n.name] = n.default || getDefaultValue(n.type);
        });
        template[param.name] = nested;
      } else {
        template[param.name] = param.default || getDefaultValue(param.type);
      }
    });
  return JSON.stringify(template, null, 2);
}

function getDefaultValue(type: string): unknown {
  switch (type) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
