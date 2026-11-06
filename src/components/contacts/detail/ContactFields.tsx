import { Bot } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { Tooltip } from "@/components/ui/Tooltip";
import { EMPTY, formatDate } from "@/lib/format";

export interface EnrichMeta {
  source: string;
  updatedAt: number;
  confidence?: number;
}

/** Texto de origem de um dado enriquecido: "Fonte: x | 09/03/2025 | Confiança: 80%". */
export function enrichmentLabel(meta: EnrichMeta): string {
  const confidence = meta.confidence != null ? ` | Confiança: ${Math.round(meta.confidence * 100)}%` : "";
  return `Fonte: ${meta.source} | ${formatDate(meta.updatedAt)}${confidence}`;
}

/** Campo somente leitura; um ícone indica dado preenchido por enriquecimento (não manual). */
export function ViewField({
  label,
  value,
  enrichMeta,
  link,
}: {
  label: string;
  value?: string;
  enrichMeta?: EnrichMeta;
  link?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-xs font-medium text-text-secondary">{label}</span>
        {enrichMeta && enrichMeta.source !== "manual" && (
          <Tooltip content={enrichmentLabel(enrichMeta)} asInfo>
            <span tabIndex={0} role="img" aria-label={enrichmentLabel(enrichMeta)} className="inline-flex">
              <Bot size={12} className="text-brand-400" aria-hidden="true" />
            </span>
          </Tooltip>
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
        <div className="text-sm text-text-primary">{value || EMPTY}</div>
      )}
    </div>
  );
}

/** Campo de edição (texto, número ou área de texto) com rótulo ligado ao controle. */
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
  if (multiline) {
    return (
      <Textarea
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
      />
    );
  }
  return (
    <Input
      label={label}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

/** Lista suspensa de edição com a opção vazia "Selecionar…". */
export function EditSelect({
  label,
  value,
  onChange,
  options,
  emptyLabel = "Selecionar…",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  /** Rótulo da opção vazia. */
  emptyLabel?: string;
}) {
  return (
    <Select
      label={label}
      value={value}
      onValueChange={onChange}
      options={[{ value: "", label: emptyLabel }, ...options]}
    />
  );
}
