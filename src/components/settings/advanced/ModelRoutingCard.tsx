import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { FormField } from "@/components/ui/FormField";
import { Select } from "@/components/ui/Select";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import type { AiStatus } from "../ai/aiTypes";
import {
  PROVIDER_LABEL,
  RouteNote,
  RoutingSelect,
  RoutingSelectLabeled,
  secondsLabel,
  type ModelOption,
  type ProductKey,
  type VisionModelOption,
} from "./ModelRoutingParts";

function Product({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-4 first:pt-0 border-t border-border first:border-t-0">
      <p className="text-sm font-medium text-text-primary mb-3">{title}</p>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </div>
  );
}

/** Modelo e rota de cada produto de IA (os interruptores ficam em Recursos da IA). */
export function ModelRoutingCard({ organizationId, status }: { organizationId: Id<"organizations">; status: AiStatus }) {
  const setModels = useMutation(api.aiSettings.setModels);
  const setProductRouting = useMutation(api.aiSettings.setProductRouting);
  const modelOptions = useQuery(api.aiSettings.getModelOptions, { organizationId }) as ModelOption[] | undefined;
  const visionOptions = useQuery(api.aiSettings.getVisionModelOptions, { organizationId }) as
    | VisionModelOption[]
    | undefined;

  const byoProvider = status.providerMode === "byo" ? (status.byo?.provider ?? "?") : null;
  const routeFor = (id: string) => modelOptions?.find((m) => m.id === id)?.route;

  // Modelo de copiloto/atendente mora em providerConfig.models: o save manda o conjunto com um campo trocado.
  const saveModel = async (which: "copilot" | "attendant", model: string) => {
    const route = routeFor(model);
    const nonZdr = route && !route.zdrCapable;
    if (
      nonZdr &&
      !window.confirm(
        `Atenção: a rota "${model}" retém dados (${route.retention}, residência ${route.dataResidency}) e sai do padrão zero-retention. Confirmar mesmo assim?`,
      )
    ) {
      return;
    }
    try {
      await setModels({
        organizationId,
        models: {
          copilot: which === "copilot" ? model : status.models.copilot,
          attendant: which === "attendant" ? model : status.models.attendant,
          classify: which === "attendant" ? model : status.models.attendant,
          complex: status.models.complex,
        },
        ...(nonZdr ? { nonZdrAck: true } : {}),
      });
      toast.success("Modelo atualizado");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível salvar.");
    }
  };

  const saveRouting = (product: ProductKey, patch: { order?: string; model?: string }) =>
    toast.promise(
      setProductRouting({
        organizationId,
        product,
        ...(patch.order !== undefined ? { order: patch.order as never } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
      }),
      { loading: "Salvando…", success: "Configuração salva", error: "Não foi possível salvar." },
    );

  const modelField = (which: "copilot" | "attendant", value: string) => (
    <FormField label="Modelo">
      {(aria) => (
        <>
          <Select
            {...aria}
            value={value}
            onValueChange={(v) => void saveModel(which, v)}
            options={(modelOptions ?? []).map((m) => ({ value: m.id, label: m.id }))}
          />
          <RouteNote route={routeFor(value)} />
        </>
      )}
    </FormField>
  );

  const route = (product: ProductKey, order: string) => (
    <RoutingSelect
      value={order}
      orgOrder={status.platformOrder}
      byoProvider={byoProvider}
      onChange={(v) => void saveRouting(product, { order: v })}
    />
  );

  const visionModel = status.products.vision.model;
  const visionInfo = visionOptions?.find((x) => x.id === visionModel);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <SlidersHorizontal size={20} className="text-brand-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Modelo e rota por produto</h3>
          <p className="text-xs text-text-muted">
            Cada produto tem o próprio modelo e a própria rota. Para ligar ou desligar, use Recursos da IA.
          </p>
        </div>
      </div>
      <div className="space-y-4">
        <Product title="Copiloto do CRM">
          {modelField("copilot", status.models.copilot)}
          {route("copilot", status.products.copilot.order)}
        </Product>
        <Product title={VOCAB.attendant.name}>
          {modelField("attendant", status.models.attendant)}
          {route("attendant", status.products.attendant.order)}
        </Product>
        <Product title="Ler imagens recebidas">
          <FormField label="Modelo de visão">
            {(aria) => (
              <>
                <Select
                  {...aria}
                  value={visionModel}
                  onValueChange={(v) => void saveRouting("vision", { model: v })}
                  options={[
                    { value: "", label: "Automático (recomendado)" },
                    ...(visionOptions ?? []).map((o) => ({ value: o.id, label: o.id })),
                  ]}
                />
                {visionModel === "" ? (
                  <p className="text-xs text-text-muted mt-1.5">
                    Tenta os modelos validados em ordem e passa para o próximo se algum falhar.
                  </p>
                ) : (
                  visionInfo && (
                    <div className="mt-1.5 space-y-0.5">
                      <p className="text-xs text-text-muted">
                        {secondsLabel(visionInfo.latencyMs)} · {visionInfo.inputTokens} tokens de imagem · acurácia{" "}
                        {visionInfo.accuracy} · {visionInfo.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(" e ")}
                      </p>
                      {visionInfo.note && <p className="text-xs text-text-muted">{visionInfo.note}</p>}
                      <p className="flex items-start gap-1.5 text-xs text-semantic-warning">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        Fixar um modelo desliga o fallover: se ele sair do ar, a imagem não é lida.
                      </p>
                    </div>
                  )
                )}
              </>
            )}
          </FormField>
          {route("vision", status.products.vision.order)}
        </Product>
        <Product title="IA em grupos de WhatsApp">
          <p className="text-xs text-text-muted sm:col-span-2">
            O modelo é o mesmo do Atendente IA. Só o roteamento pode ser diferente.
          </p>
          {route("groupAgent", status.products.groupAgent.order)}
          <RoutingSelectLabeled
            label="Roteamento das publicações programadas"
            value={status.products.groupPosts.order}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => void saveRouting("groupPosts", { order: v })}
          />
        </Product>
        <Product title="Copiloto no Telegram">
          <FormField label="Modelo">
            {(aria) => (
              <Select
                {...aria}
                value={status.products.telegramCopilot?.model ?? ""}
                onValueChange={(v) => void saveRouting("telegramCopilot", { model: v })}
                options={[
                  { value: "", label: "Padrão (DeepSeek Flash via OpenRouter)" },
                  ...(modelOptions ?? []).map((m) => ({ value: m.id, label: m.id })),
                ]}
              />
            )}
          </FormField>
          {route("telegramCopilot", status.products.telegramCopilot?.order ?? "inherit")}
        </Product>
        <Product title="Tradução automática (reserva por IA)">
          <p className="text-xs text-text-muted sm:col-span-2">
            Usado só quando o servidor de tradução próprio não responde (ou quando o painel de tradução pede só IA).
          </p>
          <FormField label="Modelo">
            {(aria) => (
              <Select
                {...aria}
                value={status.products.translation?.model ?? ""}
                onValueChange={(v) => void saveRouting("translation", { model: v })}
                options={[
                  { value: "", label: "Padrão (DeepSeek Flash via OpenRouter)" },
                  ...(modelOptions ?? []).map((m) => ({ value: m.id, label: m.id })),
                ]}
              />
            )}
          </FormField>
          {route("translation", status.products.translation?.order ?? "inherit")}
        </Product>
      </div>
    </Card>
  );
}
