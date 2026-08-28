import { useState } from "react";
import { Loader2, ScanText, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VisionFields, VisionMeta } from "./types";

interface ImageDescriptionProps {
  vision: VisionMeta | null;
  /** Bubble background — keeps text legible on colored outbound bubbles. */
  variant: "inbound" | "outbound";
  /** True while the describe action is in flight (local optimistic state). */
  describing: boolean;
  /**
   * Leitura de imagem é paga por imagem: sem o toggle mestre de IA ligado não
   * oferecemos o CTA. Uma descrição já em cache continua aparecendo.
   */
  canDescribe: boolean;
  onDescribe: () => void;
}

const COLLAPSE_LIMIT = 160;

// Rótulos PT-BR dos campos estruturados, na ordem em que fazem sentido ler um
// comprovante. Chaves fora desta lista são ignoradas (o modelo pode inventar).
const FIELD_LABELS: Array<[string, string]> = [
  ["valor", "Valor"],
  ["data", "Data"],
  ["pagador", "Pagador"],
  ["recebedor", "Recebedor"],
  ["chave_pix", "Chave Pix"],
  ["id_transacao", "ID da transação"],
  ["banco", "Banco"],
];

// Campos só valem a pena para documentos com dados — numa foto qualquer o
// modelo devolve tudo nulo.
const FIELD_KINDS = new Set(["comprovante", "boleto", "nota_fiscal"]);

function filledFields(fields: VisionFields | undefined): Array<[string, string]> {
  if (!fields) return [];
  const out: Array<[string, string]> = [];
  for (const [key, label] of FIELD_LABELS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim().length > 0) out.push([label, value.trim()]);
  }
  return out;
}

export function ImageDescription({
  vision,
  variant,
  describing,
  canDescribe,
  onDescribe,
}: ImageDescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const outbound = variant === "outbound";
  const muted = outbound ? "text-white/70" : "text-text-muted";

  const status = vision?.status;

  // In-flight (local) or backend-reported pending → spinner.
  if (describing || status === "pending") {
    return (
      <div className={cn("flex items-center gap-1.5 text-xs italic", muted)}>
        <Loader2 size={13} className="animate-spin shrink-0" />
        Lendo imagem…
      </div>
    );
  }

  if (status === "done" && vision?.text) {
    const text = vision.text.trim();
    const isLong = text.length > COLLAPSE_LIMIT;
    const shown = !isLong || expanded ? text : `${text.slice(0, COLLAPSE_LIMIT)}…`;
    const fields =
      vision.tipo && FIELD_KINDS.has(vision.tipo) ? filledFields(vision.fields) : [];
    return (
      <div className="flex flex-col gap-0.5">
        <p
          className={cn(
            "text-xs italic whitespace-pre-wrap break-words",
            outbound ? "text-white/85" : "text-text-secondary"
          )}
        >
          {shown}
        </p>
        {fields.length > 0 && (
          <dl
            className={cn(
              "mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]",
              outbound ? "text-white/75" : "text-text-muted"
            )}
          >
            {fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-medium">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={cn(
              "flex items-center gap-0.5 self-start text-[11px] font-medium",
              outbound ? "text-white/70 hover:text-white" : "text-brand-400 hover:text-brand-500"
            )}
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? "Ver menos" : "Ver mais"}
          </button>
        )}
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex items-center gap-2">
        <span className={cn("text-xs italic", outbound ? "text-white/70" : "text-semantic-error")}>
          Não foi possível ler a imagem
        </span>
        {canDescribe && (
          <button
            type="button"
            onClick={onDescribe}
            className={cn(
              "flex items-center gap-1 text-[11px] font-medium",
              outbound ? "text-white/80 hover:text-white" : "text-brand-400 hover:text-brand-500"
            )}
          >
            <RefreshCw size={12} />
            Tentar de novo
          </button>
        )}
      </div>
    );
  }

  // "skipped" — nada a ler (figurinha, imagem minúscula); fica quieto.
  if (status === "skipped") return null;

  // Sem leitura ainda → CTA discreto, só quando a leitura de imagens está ligada.
  if (!canDescribe) return null;

  return (
    <button
      type="button"
      onClick={onDescribe}
      className={cn(
        "flex items-center gap-1 self-start text-[11px] font-medium",
        outbound ? "text-white/80 hover:text-white" : "text-brand-400 hover:text-brand-500"
      )}
    >
      <ScanText size={12} />
      Ler imagem
    </button>
  );
}
