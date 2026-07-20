import { useState } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check, Monitor, MessageSquare, PanelRightClose, SidebarOpen } from "lucide-react";
import { toast } from "sonner";

// ── Types ────────────────────────────────────────────────────────────────────

type EmbedMode = "inline" | "popup" | "slidein" | "sidetab";
type TriggerType = "click" | "delay" | "scroll" | "exit_intent";

interface EmbedConfig {
  mode: EmbedMode;
  trigger: TriggerType;
  delay: number;
  scrollPercent: number;
  suppressDays: number;
  tabLabel: string;
  tabPosition: "left" | "right";
}

interface EmbedConfigPanelProps {
  slug: string;
  siteUrl: string;
}

// ── Mode cards ───────────────────────────────────────────────────────────────

const MODES: Array<{
  value: EmbedMode;
  label: string;
  description: string;
  icon: React.ElementType;
}> = [
  { value: "inline", label: "Inline", description: "Incorporado na pagina", icon: Monitor },
  { value: "popup", label: "Popup", description: "Janela centralizada", icon: MessageSquare },
  { value: "slidein", label: "Slide-in", description: "Painel lateral inferior", icon: PanelRightClose },
  { value: "sidetab", label: "Aba lateral", description: "Botao fixo na borda", icon: SidebarOpen },
];

const TRIGGERS: Array<{ value: TriggerType; label: string }> = [
  { value: "click", label: "Clique" },
  { value: "delay", label: "Tempo" },
  { value: "scroll", label: "Scroll" },
  { value: "exit_intent", label: "Intencao de saida" },
];

// ── Snippet generator ────────────────────────────────────────────────────────

function generateSnippet(config: EmbedConfig, slug: string, siteUrl: string): string {
  const attrs: string[] = [
    `data-slug="${slug}"`,
    `data-mode="${config.mode}"`,
  ];

  if (config.mode === "inline") {
    attrs.push(`data-container="hnbcrm-form"`);
  }

  if (config.mode === "popup" || config.mode === "slidein") {
    attrs.push(`data-trigger="${config.trigger}"`);

    if (config.trigger === "delay") {
      attrs.push(`data-delay="${config.delay}"`);
    }
    if (config.trigger === "scroll") {
      attrs.push(`data-scroll-percent="${config.scrollPercent}"`);
    }

    attrs.push(`data-suppress-days="${config.suppressDays}"`);
  }

  if (config.mode === "sidetab") {
    attrs.push(`data-tab-label="${config.tabLabel}"`);
    attrs.push(`data-tab-position="${config.tabPosition}"`);
    attrs.push(`data-suppress-days="${config.suppressDays}"`);
  }

  const lines: string[] = [];

  if (config.mode === "inline") {
    lines.push(`<div id="hnbcrm-form"></div>`);
  }

  if ((config.mode === "popup" || config.mode === "slidein") && config.trigger === "click") {
    lines.push(`<button data-hnbcrm-open="${slug}">Abrir formulario</button>`);
  }

  lines.push(`<script src="${siteUrl}/api/v1/embed.js"\n  ${attrs.join("\n  ")}></script>`);

  return lines.join("\n");
}

// ── Component ────────────────────────────────────────────────────────────────

export function EmbedConfigPanel({ slug, siteUrl }: EmbedConfigPanelProps) {
  const [config, setConfig] = useState<EmbedConfig>({
    mode: "inline",
    trigger: "delay",
    delay: 5,
    scrollPercent: 50,
    suppressDays: 7,
    tabLabel: "Fale Conosco",
    tabPosition: "right",
  });
  const [copied, setCopied] = useState(false);

  const snippet = generateSnippet(config, slug, siteUrl);

  function update(patch: Partial<EmbedConfig>) {
    setConfig((prev) => ({ ...prev, ...patch }));
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success("Codigo copiado!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Nao foi possivel copiar");
    }
  }

  const showTrigger = config.mode === "popup" || config.mode === "slidein";
  const showTabConfig = config.mode === "sidetab";

  return (
    <div className="space-y-5">
      {/* Mode selector */}
      <div>
        <label className="block text-[13px] font-medium text-text-secondary mb-2">
          Modo de exibicao
        </label>
        <div className="grid grid-cols-2 gap-2">
          {MODES.map(({ value, label, description, icon: Icon }) => (
            <button
              key={value}
              onClick={() => update({ mode: value })}
              className={cn(
                "flex flex-col items-center gap-1.5 p-3 rounded-lg border transition-all duration-150",
                "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
                config.mode === value
                  ? "border-brand-500 bg-brand-500/10 text-brand-400"
                  : "border-border bg-surface-raised text-text-secondary hover:border-border-strong hover:text-text-primary"
              )}
            >
              <Icon size={20} />
              <span className="text-sm font-medium">{label}</span>
              <span className="text-[11px] text-text-muted">{description}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Trigger selector (popup/slidein) */}
      {showTrigger && (
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-2">
            Gatilho
          </label>
          <div className="flex gap-1 p-1 rounded-lg bg-surface-sunken border border-border">
            {TRIGGERS.map((t) => (
              <button
                key={t.value}
                onClick={() => update({ trigger: t.value })}
                className={cn(
                  "flex-1 py-1.5 text-sm rounded-md transition-all duration-150",
                  "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1 focus:ring-offset-surface-sunken",
                  config.trigger === t.value
                    ? "bg-surface-raised text-text-primary font-medium shadow-sm"
                    : "text-text-secondary hover:text-text-primary"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Trigger-specific inputs */}
      {showTrigger && config.trigger === "delay" && (
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Tempo de espera (segundos)
          </label>
          <input
            type="number"
            min={1}
            max={120}
            value={config.delay}
            onChange={(e) => update({ delay: Math.max(1, Number(e.target.value) || 5) })}
            className={cn(
              "w-full bg-surface-raised border border-border-strong rounded-field",
              "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
              "transition-colors duration-150",
              "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            )}
          />
        </div>
      )}

      {showTrigger && config.trigger === "scroll" && (
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Porcentagem de scroll
          </label>
          <input
            type="number"
            min={10}
            max={100}
            value={config.scrollPercent}
            onChange={(e) => update({ scrollPercent: Math.max(10, Math.min(100, Number(e.target.value) || 50)) })}
            className={cn(
              "w-full bg-surface-raised border border-border-strong rounded-field",
              "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
              "transition-colors duration-150",
              "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            )}
          />
        </div>
      )}

      {/* Suppression days (popup/slidein/sidetab) */}
      {(showTrigger || showTabConfig) && (
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
            Dias de supressao
          </label>
          <input
            type="number"
            min={0}
            max={365}
            value={config.suppressDays}
            onChange={(e) => update({ suppressDays: Math.max(0, Number(e.target.value) || 7) })}
            className={cn(
              "w-full bg-surface-raised border border-border-strong rounded-field",
              "px-3.5 py-2.5 text-base md:text-sm text-text-primary",
              "transition-colors duration-150",
              "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            )}
          />
          <p className="mt-1 text-[12px] text-text-muted">
            Apos fechar ou enviar, o formulario nao reaparecera por este periodo
          </p>
        </div>
      )}

      {/* Side tab config */}
      {showTabConfig && (
        <>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Texto da aba
            </label>
            <input
              type="text"
              value={config.tabLabel}
              onChange={(e) => update({ tabLabel: e.target.value })}
              placeholder="Fale Conosco"
              className={cn(
                "w-full bg-surface-raised border border-border-strong rounded-field",
                "px-3.5 py-2.5 text-base md:text-sm text-text-primary placeholder:text-text-muted",
                "transition-colors duration-150",
                "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
              )}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-2">
              Posicao da aba
            </label>
            <div className="flex gap-1 p-1 rounded-lg bg-surface-sunken border border-border">
              {(["left", "right"] as const).map((pos) => (
                <button
                  key={pos}
                  onClick={() => update({ tabPosition: pos })}
                  className={cn(
                    "flex-1 py-1.5 text-sm rounded-md transition-all duration-150",
                    "focus:outline-none",
                    config.tabPosition === pos
                      ? "bg-surface-raised text-text-primary font-medium shadow-sm"
                      : "text-text-secondary hover:text-text-primary"
                  )}
                >
                  {pos === "left" ? "Esquerda" : "Direita"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Code snippet */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[13px] font-medium text-text-secondary">
            Codigo de incorporacao
          </label>
          <button
            onClick={handleCopy}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150",
              "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
              copied
                ? "bg-semantic-success/10 text-semantic-success border border-semantic-success/20"
                : "bg-surface-raised border border-border-strong text-text-secondary hover:text-text-primary hover:border-brand-500"
            )}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copiado!" : "Copiar"}
          </button>
        </div>
        <pre
          className={cn(
            "w-full px-3.5 py-3 rounded-lg border border-border-strong bg-surface-sunken",
            "text-[12px] font-mono text-text-secondary leading-relaxed",
            "overflow-x-auto whitespace-pre-wrap break-all"
          )}
        >
          {snippet}
        </pre>
      </div>
    </div>
  );
}
