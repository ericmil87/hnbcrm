import { ShieldCheck } from "lucide-react";
import { Select } from "@/components/ui/Select";

// Tipos e seletores compartilhados do roteamento de modelos por produto.
export type ProductKey =
  | "copilot"
  | "attendant"
  | "vision"
  | "groupPosts"
  | "groupAgent"
  | "telegramCopilot";

export type ModelOption = {
  id: string;
  route: { zdrCapable: boolean; dataResidency: string; retention: string };
};

export type VisionModelOption = {
  id: string;
  providers: string[];
  latencyMs: number;
  inputTokens: number;
  accuracy: string;
  note?: string;
};

export const PROVIDER_LABEL: Record<string, string> = {
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
};

export function secondsLabel(ms: number): string {
  return `${(ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

/** Nota de privacidade da rota escolhida — a mesma linguagem do card de baixo. */
export function RouteNote({ route }: { route: ModelOption["route"] | undefined }) {
  if (!route) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs mt-1.5">
      {route.zdrCapable ? (
        <>
          <ShieldCheck size={13} className="text-semantic-success" />
          <span className="text-text-muted">Zero-retention · residência {route.dataResidency}</span>
        </>
      ) : (
        <span className="text-semantic-warning">
          Retém dados ({route.retention}) · residência {route.dataResidency}
        </span>
      )}
    </p>
  );
}

/** Seletor de rota por produto. "inherit" mostra qual padrão da org está herdando. */
export function RoutingSelect({
  value,
  orgOrder,
  byoProvider,
  onChange,
}: {
  value: string;
  orgOrder: string;
  byoProvider: string | null;
  onChange: (v: string) => void;
}) {
  const orgLabel =
    PLATFORM_ORDER_OPTIONS.find((o) => o.value === orgOrder)?.label ?? "padrão da organização";
  if (byoProvider) {
    return (
      <div>
        <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
          Roteamento
        </label>
        <div className="rounded-field border border-border bg-surface-sunken px-3.5 py-2.5 text-sm text-text-muted">
          Chave própria da organização ({byoProvider})
        </div>
        <p className="text-xs text-text-muted mt-1.5">
          No modo BYO a rota é uma só, para todos os produtos — e sem fallback.
        </p>
      </div>
    );
  }
  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Roteamento</label>
      <Select
        value={value}
        onValueChange={onChange}
        options={[
          { value: "inherit", label: `Herdar da organização — ${orgLabel}` },
          ...PLATFORM_ORDER_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ]}
      />
    </div>
  );
}

/** O mesmo seletor de rota, com um rótulo próprio (dois num só card). */
export function RoutingSelectLabeled({
  label,
  value,
  orgOrder,
  byoProvider,
  onChange,
}: {
  label: string;
  value: string;
  orgOrder: string;
  byoProvider: string | null;
  onChange: (v: string) => void;
}) {
  const orgLabel =
    PLATFORM_ORDER_OPTIONS.find((o) => o.value === orgOrder)?.label ?? "padrão da organização";
  if (byoProvider) return null;
  return (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">{label}</label>
      <Select
        value={value}
        onValueChange={onChange}
        options={[
          { value: "inherit", label: `Herdar da organização — ${orgLabel}` },
          ...PLATFORM_ORDER_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
        ]}
      />
    </div>
  );
}

export const PLATFORM_ORDER_OPTIONS = [
  { value: "auto", label: "Auto — OpenCode Go, fallback OpenRouter (padrão)" },
  { value: "openrouter-first", label: "OpenRouter primeiro, fallback OpenCode Go" },
  { value: "openrouter-only", label: "Somente OpenRouter (sem fallback)" },
  { value: "opencode-only", label: "Somente OpenCode Go (sem fallback)" },
] as const;

