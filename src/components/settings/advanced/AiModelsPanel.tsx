import { useState } from "react";
import { useMutation, useAction } from "convex/react";
import { toast } from "sonner";
import { ShieldCheck, ChevronDown, AlertTriangle, Check } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/utils";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { AiStatus, SELECT_CLS } from "../ai/aiTypes";

// ── Produtos de IA ──────────────────────────────────────────────────────────
//
// Cada produto carrega a PRÓPRIA configuração: o interruptor, o modelo e a
// rota. Antes o interruptor ficava aqui e o modelo num card lá embaixo, e a
// leitura de imagens ainda exigia um segundo interruptor em Configurações →
// Canais — três lugares para configurar duas coisas. O card de baixo agora
// guarda só o que é mesmo da organização inteira: rota padrão, chave própria e
// privacidade.

export type ProductKey = "copilot" | "attendant" | "vision" | "groupPosts" | "groupAgent" | "telegramCopilot";

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
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLS}>
        <option value="inherit">Herdar da organização — {orgLabel}</option>
        {PLATFORM_ORDER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
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
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLS}>
        <option value="inherit">Herdar da organização — {orgLabel}</option>
        {PLATFORM_ORDER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Linha de um produto: interruptor + painel de configuração recolhível. */
export function ProductRow({
  title,
  description,
  enabled,
  busy,
  onToggle,
  first,
  children,
}: {
  title: string;
  description: string;
  enabled: boolean;
  busy: boolean;
  /** Sem onToggle o produto não tem interruptor próprio (ex.: liga pelo módulo). */
  onToggle?: () => void;
  first?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={first ? "" : "pt-4 border-t border-border"}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-primary">{title}</p>
          <p className="text-xs text-text-muted mt-0.5">{description}</p>
        </div>
        {onToggle && <Switch checked={enabled} onCheckedChange={() => onToggle()} label={title} hideLabel disabled={busy} />}
      </div>
      {enabled && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-500 hover:text-brand-400"
          >
            <ChevronDown
              size={13}
              className={cn("transition-transform", open && "rotate-180")}
            />
            {open ? "Ocultar modelo e roteamento" : "Modelo e roteamento"}
          </button>
          {open && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2 rounded-lg border border-border bg-surface-sunken p-3.5">
              {children}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Provider, modelos e privacidade (roteamento + BYO + selo ZDR) ──

export const PLATFORM_ORDER_OPTIONS = [
  { value: "auto", label: "Auto — OpenCode Go, fallback OpenRouter (padrão)" },
  { value: "openrouter-first", label: "OpenRouter primeiro, fallback OpenCode Go" },
  { value: "openrouter-only", label: "Somente OpenRouter (sem fallback)" },
  { value: "opencode-only", label: "Somente OpenCode Go (sem fallback)" },
] as const;

export const BYO_PROVIDERS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "openai", label: "OpenAI" },
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
] as const;

export type ConnectionHop = {
  provider: string;
  model: string;
  ok: boolean;
  toolCallWorked: boolean;
  error: string | null;
};

export function PrivacyCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const setStrictZdr = useMutation(api.aiSettings.setStrictZdr);
  const setPlatformOrder = useMutation(api.aiSettings.setPlatformOrder);
  const setProviderMode = useMutation(api.aiSettings.setProviderMode);
  const createOrgSecret = useAction(api.orgSecrets.createOrgSecret);
  const testOrgConnection = useAction(api.aiDiagnostics.testOrgConnection);
  const [byoOpen, setByoOpen] = useState(false);
  const [byoForm, setByoForm] = useState({ provider: "openrouter", baseUrl: "", apiKey: "" });
  const [byoSaving, setByoSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<{ role: string; hops: ConnectionHop[] }[] | null>(
    null
  );

  const handleSaveByo = async () => {
    if (byoForm.apiKey.trim().length < 8) {
      toast.error("Cole uma chave de API válida");
      return;
    }
    if (byoForm.provider === "custom" && !byoForm.baseUrl.trim()) {
      toast.error("Informe a base URL do provider custom");
      return;
    }
    setByoSaving(true);
    try {
      const orgSecretId = await createOrgSecret({
        organizationId,
        name: `BYO ${byoForm.provider}`,
        provider: byoForm.provider,
        value: byoForm.apiKey,
      });
      const byo = {
        provider: byoForm.provider as "openrouter" | "openai" | "opencode-go" | "custom",
        ...(byoForm.provider === "custom" ? { baseUrl: byoForm.baseUrl.trim() } : {}),
        orgSecretId,
      };
      try {
        await setProviderMode({ organizationId, mode: "byo", byo });
      } catch (e) {
        // Aviso ZDR → aceite explícito e retry (mesmo padrão do salvar modelos).
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("confirme o aceite") && window.confirm(`${msg}. Confirmar mesmo assim?`)) {
          await setProviderMode({ organizationId, mode: "byo", byo, nonZdrAck: true });
        } else {
          throw e;
        }
      }
      toast.success("Provider próprio (BYO) ativado");
      setByoOpen(false);
      setByoForm({ provider: "openrouter", baseUrl: "", apiKey: "" });
      setTestResults(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar o provedor.");
    } finally {
      setByoSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResults(null);
    try {
      const attendant = await testOrgConnection({ organizationId, role: "attendant" });
      const copilot = await testOrgConnection({ organizationId, role: "copilot" });
      setTestResults([
        { role: "Atendente", hops: attendant },
        { role: "Copiloto", hops: copilot },
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Falha no teste de conexão");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <ShieldCheck size={20} className="text-brand-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Provider e privacidade</h3>
          <p className="text-xs text-text-muted">
            {status.providerMode === "byo"
              ? `Chave própria da org (BYO: ${status.byo?.provider ?? "?"}) — sem fallback da plataforma`
              : (PLATFORM_ORDER_OPTIONS.find((o) => o.value === status.platformOrder)?.label ??
                "Keys da plataforma")}
          </p>
        </div>
      </div>

      {/* Roteamento de provider: cadeia da plataforma OU chave própria (BYO) */}
      <div className="mb-4 pb-4 border-b border-border space-y-3 max-w-xl">
        {status.providerMode === "platform" ? (
          <>
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Roteamento padrão (keys da plataforma)
              </label>
              <select
                value={status.platformOrder}
                onChange={(e) =>
                  toast.promise(
                    setPlatformOrder({
                      organizationId,
                      platformOrder: e.target.value as
                        | "auto"
                        | "openrouter-first"
                        | "opencode-only"
                        | "openrouter-only",
                    }),
                    { loading: "Salvando…", success: "Roteamento atualizado", error: "Não foi possível salvar." }
                  )
                }
                className={SELECT_CLS}
              >
                {PLATFORM_ORDER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-text-muted mt-1.5">
                Vale para todos os produtos de IA; cada um pode sobrescrever em "Produtos de IA",
                acima. O fallback assume automaticamente em caso de quota esgotada ou
                instabilidade do provider primário.
              </p>
            </div>
            {!byoOpen && (
              <button
                type="button"
                onClick={() => setByoOpen(true)}
                className="text-xs text-brand-500 hover:text-brand-400"
              >
                Usar minha própria chave de API (BYO)
              </button>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Badge variant="brand">BYO: {status.byo?.provider ?? "?"}</Badge>
            {status.byo?.keyLast4 && (
              <span className="text-xs text-text-muted">chave ····{status.byo.keyLast4}</span>
            )}
            {status.byo?.baseUrl && (
              <span className="text-xs text-text-muted font-mono break-all">
                {status.byo.baseUrl}
              </span>
            )}
            <button
              type="button"
              onClick={() => setByoOpen(true)}
              className="text-xs text-brand-500 hover:text-brand-400"
            >
              Trocar chave
            </button>
            <button
              type="button"
              onClick={() =>
                toast.promise(setProviderMode({ organizationId, mode: "platform" }), {
                  loading: "Voltando…",
                  success: "De volta às keys da plataforma",
                  error: "Não foi possível trocar.",
                })
              }
              className="text-xs text-brand-500 hover:text-brand-400"
            >
              Voltar ao padrão da plataforma
            </button>
          </div>
        )}

        {byoOpen && (
          <div className="space-y-3 rounded-lg border border-border bg-surface-sunken p-3.5">
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Provider
              </label>
              <select
                value={byoForm.provider}
                onChange={(e) => setByoForm({ ...byoForm, provider: e.target.value })}
                className={SELECT_CLS}
              >
                {BYO_PROVIDERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            {byoForm.provider === "custom" && (
              <Input
                label="Base URL"
                type="text"
                value={byoForm.baseUrl}
                onChange={(e) => setByoForm({ ...byoForm, baseUrl: e.target.value })}
                placeholder="ex: https://llm.suaempresa.com/v1"
              />
            )}
            <Input
              label="Chave de API"
              type="password"
              value={byoForm.apiKey}
              onChange={(e) => setByoForm({ ...byoForm, apiKey: e.target.value })}
              placeholder="Cole a chave do provider"
            />
            <p className="text-xs text-text-muted">
              A chave é cifrada e nunca sai do servidor. No modo BYO não há fallback para as keys
              da plataforma — a org paga a própria conta.
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setByoOpen(false);
                  setByoForm({ provider: "openrouter", baseUrl: "", apiKey: "" });
                }}
              >
                Cancelar
              </Button>
              <Button size="sm" onClick={() => void handleSaveByo()} disabled={byoSaving}>
                {byoSaving ? "Salvando…" : "Salvar e ativar"}
              </Button>
            </div>
          </div>
        )}

        {/* Teste de conexão: pinga cada rota efetiva (sem fallback) e mostra o erro real */}
        <div className="space-y-2">
          <Button variant="secondary" size="sm" onClick={() => void handleTest()} disabled={testing}>
            {testing ? "Testando conexão..." : "Testar conexão"}
          </Button>
          {testResults && (
            <div className="space-y-2">
              {testResults.map((group) => (
                <div key={group.role}>
                  <p className="text-xs font-medium text-text-secondary mb-1">{group.role}</p>
                  <ul className="space-y-1">
                    {group.hops.map((hop, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        {hop.ok ? (
                          <Check size={14} className="text-semantic-success mt-0.5 shrink-0" />
                        ) : (
                          <AlertTriangle
                            size={14}
                            className="text-semantic-warning mt-0.5 shrink-0"
                          />
                        )}
                        <span className="text-text-secondary break-words min-w-0">
                          <span className="font-medium text-text-primary">{hop.provider}</span> ·{" "}
                          {hop.model}{" "}
                          {hop.ok
                            ? hop.toolCallWorked
                              ? "— OK (tool-call ✓)"
                              : "— OK"
                            : `— ${hop.error}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Checkbox
        checked={status.strictZdr}
        onChange={(e) =>
          toast.promise(setStrictZdr({ organizationId, strictZdr: e.target.checked }), {
            loading: "Salvando…",
            success: "Preferência salva",
            error: "Não foi possível salvar.",
          })
        }
        label="Modo estrito: recusar qualquer rota que retenha dados (compliance rígida)"
      />
    </Card>
  );
}
