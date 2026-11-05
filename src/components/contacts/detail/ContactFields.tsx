import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

// View field with optional enrichment indicator
export function ViewField({
  label,
  value,
  enrichMeta,
  link,
}: {
  label: string;
  value?: string;
  enrichMeta?: { source: string; updatedAt: number; confidence?: number };
  link?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        {enrichMeta && enrichMeta.source !== "manual" && (
          <span title={`Fonte: ${enrichMeta.source} | ${new Date(enrichMeta.updatedAt).toLocaleDateString("pt-BR")}${enrichMeta.confidence != null ? ` | Confianca: ${Math.round(enrichMeta.confidence * 100)}%` : ""}`}>
            <Bot size={12} className="text-brand-400" />
          </span>
        )}
      </div>
      {link && value ? (
        <a
          href={value.startsWith("http") ? value : `https://${value}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-brand-400 hover:underline"
        >
          {value}
        </a>
      ) : (
        <div className="text-sm text-text-primary">{value || "\u2014"}</div>
      )}
    </div>
  );
}

// Edit field input
export function EditField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const inputClass =
    "w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500";

  return (
    <div>
      <label className="block text-xs font-medium text-text-secondary mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className={cn(inputClass, "resize-none")}
          style={{ fontSize: "16px" }}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputClass}
          style={{ fontSize: "16px" }}
        />
      )}
    </div>
  );
}

