import { cn } from "@/lib/utils";
import type { FormTheme } from "./types";

interface ThemePanelProps {
  theme: FormTheme;
  onChange: (theme: FormTheme) => void;
}

// ── Border-radius options ─────────────────────────────────────────────────

const RADIUS_OPTIONS: {
  value: FormTheme["borderRadius"];
  label: string;
  className: string;
}[] = [
  { value: "none", label: "Nenhum", className: "rounded-none" },
  { value: "sm", label: "Pequeno", className: "rounded-sm" },
  { value: "md", label: "Medio", className: "rounded-md" },
  { value: "lg", label: "Grande", className: "rounded-lg" },
  { value: "full", label: "Arredondado", className: "rounded-full" },
];

// ── Shared sub-components ─────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wide mb-3 pb-2 border-b border-border-subtle">
      {children}
    </h3>
  );
}

function ToggleSwitch({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200",
        "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
        checked
          ? "bg-brand-600"
          : "bg-surface-overlay border border-border-strong"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm",
          "transition-transform duration-200",
          checked ? "translate-x-4" : "translate-x-0"
        )}
        aria-hidden="true"
      />
    </button>
  );
}

// ── Color picker with swatch + hex input ──────────────────────────────────

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  function handleHexChange(raw: string) {
    // Allow partial typing — prefix with # if missing
    const prefixed = raw.startsWith("#") ? raw : `#${raw}`;
    if (/^#[0-9A-Fa-f]{0,6}$/.test(prefixed)) {
      onChange(prefixed);
    }
  }

  // The colour is valid for the native colour input only if it is a full 6-digit hex
  const isValidHex = /^#[0-9A-Fa-f]{6}$/.test(value);

  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {/* Swatch — native colour input overlaid on a coloured div */}
        <div className="relative flex-shrink-0 w-11 h-11">
          <div
            className="w-full h-full rounded-lg border-2 border-border-strong"
            style={{ backgroundColor: isValidHex ? value : "#888888" }}
            aria-hidden="true"
          />
          <input
            type="color"
            value={isValidHex ? value : "#888888"}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`${label} — seletor de cor`}
            className={cn(
              "absolute inset-0 w-full h-full opacity-0 cursor-pointer rounded-lg",
              "focus:outline-none"
            )}
          />
        </div>

        {/* Hex text input */}
        <div
          className={cn(
            "flex items-center flex-1 bg-surface-raised border border-border-strong rounded-field overflow-hidden",
            "transition-colors duration-150",
            "focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20"
          )}
        >
          <span
            className="pl-3 pr-0.5 text-text-muted text-sm select-none"
            aria-hidden="true"
          >
            #
          </span>
          <input
            type="text"
            value={value.replace(/^#/, "")}
            onChange={(e) => handleHexChange(e.target.value)}
            maxLength={6}
            spellCheck={false}
            aria-label={`${label} — valor hexadecimal`}
            placeholder="000000"
            className={cn(
              "flex-1 bg-transparent py-2.5 pr-2 text-base md:text-sm text-text-primary font-mono uppercase",
              "placeholder:text-text-muted focus:outline-none"
            )}
          />
          {/* Live preview swatch inside the text input */}
          <span
            className="mr-2 w-5 h-5 rounded border border-border flex-shrink-0 transition-colors"
            style={{ backgroundColor: isValidHex ? value : "transparent" }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}

// ── Radius preview shape ──────────────────────────────────────────────────

function RadiusPreview({ className }: { className: string }) {
  return (
    <div
      className={cn(
        "w-8 h-5 border-2 border-current opacity-60 flex-shrink-0",
        className
      )}
      aria-hidden="true"
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function ThemePanel({ theme, onChange }: ThemePanelProps) {
  function update(patch: Partial<FormTheme>) {
    onChange({ ...theme, ...patch });
  }

  const currentRadiusClass =
    RADIUS_OPTIONS.find((o) => o.value === theme.borderRadius)?.className ??
    "rounded-md";

  return (
    <div className="space-y-8 pb-6">
      {/* ── 1. Cores ──────────────────────────────────────────────── */}
      <section aria-label="Cores do tema">
        <SectionHeader>Cores</SectionHeader>
        <div className="space-y-4">
          <ColorInput
            label="Cor primaria"
            value={theme.primaryColor}
            onChange={(v) => update({ primaryColor: v })}
          />
          <ColorInput
            label="Cor de fundo"
            value={theme.backgroundColor}
            onChange={(v) => update({ backgroundColor: v })}
          />
          <ColorInput
            label="Cor do texto"
            value={theme.textColor}
            onChange={(v) => update({ textColor: v })}
          />
        </div>
      </section>

      {/* ── 2. Bordas ─────────────────────────────────────────────── */}
      <section aria-label="Arredondamento das bordas">
        <SectionHeader>Bordas</SectionHeader>
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-2">
            Arredondamento
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {RADIUS_OPTIONS.map(({ value, label, className }) => {
              const isActive = theme.borderRadius === value;
              return (
                <button
                  key={value}
                  onClick={() => update({ borderRadius: value })}
                  aria-pressed={isActive}
                  aria-label={`Borda ${label}`}
                  className={cn(
                    "flex flex-col items-center gap-1.5 px-3 py-2.5 flex-1 min-w-[56px]",
                    "border rounded-lg transition-all duration-150",
                    "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base",
                    isActive
                      ? "border-brand-500 bg-brand-500/10 text-brand-500"
                      : "border-border-strong bg-surface-raised text-text-secondary hover:border-border hover:text-text-primary"
                  )}
                >
                  <RadiusPreview className={className} />
                  <span className="text-[11px] font-medium whitespace-nowrap">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── 3. Marca ──────────────────────────────────────────────── */}
      <section aria-label="Configuracoes de marca">
        <SectionHeader>Marca</SectionHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary">
              Mostrar "Feito com HNBCRM"
            </p>
            <p className="text-[12px] text-text-muted mt-0.5">
              Exibe o logo HNBCRM no rodape do formulario
            </p>
          </div>
          <ToggleSwitch
            checked={theme.showBranding}
            onToggle={() => update({ showBranding: !theme.showBranding })}
            label='Mostrar "Feito com HNBCRM"'
          />
        </div>
      </section>

      {/* ── 4. Pre-visualizacao ───────────────────────────────────── */}
      <section aria-label="Pre-visualizacao do tema">
        <SectionHeader>Pre-visualizacao</SectionHeader>
        <div
          className="rounded-xl border border-border p-4 transition-colors"
          style={{ backgroundColor: theme.backgroundColor }}
          role="img"
          aria-label="Previa do formulario com o tema atual"
        >
          {/* Mock field */}
          <p
            className="text-sm font-semibold mb-2"
            style={{ color: theme.textColor }}
          >
            Nome completo
          </p>
          <div
            className={cn("border px-3 py-2 text-sm mb-3 w-full", currentRadiusClass)}
            style={{
              borderColor: `${theme.textColor}33`,
              color: `${theme.textColor}55`,
              backgroundColor: `${theme.backgroundColor}CC`,
            }}
            aria-hidden="true"
          >
            Ex: Joao Silva
          </div>

          {/* Mock submit button */}
          <div
            className={cn("w-full py-2.5 text-sm font-semibold text-center text-white", currentRadiusClass)}
            style={{ backgroundColor: theme.primaryColor }}
            aria-hidden="true"
          >
            Enviar
          </div>

          {/* Branding badge */}
          {theme.showBranding && (
            <p
              className="mt-3 text-center text-[11px]"
              style={{ color: `${theme.textColor}55` }}
            >
              Feito com HNBCRM
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
