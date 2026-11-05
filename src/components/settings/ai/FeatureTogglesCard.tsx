import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { SlidersHorizontal, AlertTriangle } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { Card } from "@/components/ui/Card";
import { VOCAB } from "@/lib/vocab";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { AiStatus } from "./aiTypes";
import {
  ModelOption,
  PROVIDER_LABEL,
  ProductKey,
  ProductRow,
  RouteNote,
  RoutingSelect,
  RoutingSelectLabeled,
  VisionModelOption,
  secondsLabel,
} from "../advanced/AiModelsPanel";

// ── Toggles por produto (Copiloto × Atendente) — sob o mestre ──

export function FeatureTogglesCard({
  organizationId,
  status,
}: {
  organizationId: Id<"organizations">;
  status: AiStatus;
}) {
  const setFeatureToggles = useMutation(api.aiSettings.setFeatureToggles);
  const setModels = useMutation(api.aiSettings.setModels);
  const setProductRouting = useMutation(api.aiSettings.setProductRouting);
  const modelOptions = useQuery(api.aiSettings.getModelOptions, { organizationId }) as
    | ModelOption[]
    | undefined;
  const visionOptions = useQuery(api.aiSettings.getVisionModelOptions, { organizationId }) as
    | VisionModelOption[]
    | undefined;
  const [busy, setBusy] = useState(false);

  const byoProvider = status.providerMode === "byo" ? (status.byo?.provider ?? "?") : null;
  const routeFor = (id: string) => modelOptions?.find((m) => m.id === id)?.route;

  const toggle = async (
    args: {
      copilotEnabled?: boolean;
      attendantEnabled?: boolean;
      visionEnabled?: boolean;
      groupAgentEnabled?: boolean;
    },
    okMessage: string,
  ) => {
    setBusy(true);
    try {
      await setFeatureToggles({ organizationId, ...args });
      toast.success(okMessage);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não foi possível alterar.");
    } finally {
      setBusy(false);
    }
  };

  // Modelo de copiloto/atendente continua morando em providerConfig.models —
  // por isso o save manda o conjunto todo com um campo trocado.
  const saveModel = async (which: "copilot" | "attendant", model: string) => {
    const route = routeFor(model);
    const nonZdr = route && !route.zdrCapable;
    if (
      nonZdr &&
      !window.confirm(
        `Atenção: a rota "${model}" retém dados (${route!.retention}, residência ${route!.dataResidency}) e sai do padrão zero-retention. Confirmar mesmo assim?`,
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

  const ModelField = ({ which, value }: { which: "copilot" | "attendant"; value: string }) => (
    <div>
      <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Modelo</label>
      <Select
        value={value}
        onValueChange={(v) => void saveModel(which, v)}
        options={[...(modelOptions ?? []).map((m) => ({ value: m.id, label: m.id }))]}
      />
      <RouteNote route={routeFor(value)} />
    </div>
  );

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 shrink-0 rounded-full bg-brand-500/10 flex items-center justify-center">
          <SlidersHorizontal size={20} className="text-brand-500" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Produtos de IA</h3>
          <p className="text-xs text-text-muted">
            Ligue só o que sua equipe for usar — cada um com o próprio modelo e rota
          </p>
        </div>
      </div>
      <div className="space-y-4">
        <ProductRow
          first
          title="Copiloto do CRM"
          description="Assistente no app para o seu time — lê e edita o CRM conforme a permissão de cada usuário."
          enabled={status.copilotEnabled}
          busy={busy}
          onToggle={() =>
            void toggle(
              { copilotEnabled: !status.copilotEnabled },
              status.copilotEnabled ? "Copiloto desativado" : "Copiloto ativado",
            )
          }
        >
          <ModelField which="copilot" value={status.models.copilot} />
          <RoutingSelect
            value={status.products.copilot.order}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => saveRouting("copilot", { order: v })}
          />
        </ProductRow>

        <ProductRow
          title={VOCAB.attendant.name}
          description="Responde clientes no WhatsApp — começa em Sugerir respostas, com revisão humana."
          enabled={status.attendantEnabled}
          busy={busy}
          onToggle={() =>
            void toggle(
              { attendantEnabled: !status.attendantEnabled },
              status.attendantEnabled ? "Atendente IA desativado" : "Atendente IA ativado",
            )
          }
        >
          <ModelField which="attendant" value={status.models.attendant} />
          <RoutingSelect
            value={status.products.attendant.order}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => saveRouting("attendant", { order: v })}
          />
        </ProductRow>

        <ProductRow
          title="Ler imagens recebidas"
          description="A IA descreve comprovantes, documentos e fotos que o cliente enviar. Cada imagem vai uma única vez ao provedor e o texto lido fica salvo — sem reenvio a cada resposta. Custo medido: cerca de US$ 0,0003 por imagem. Vem desligado."
          enabled={status.visionEnabled}
          busy={busy}
          onToggle={() =>
            void toggle(
              { visionEnabled: !status.visionEnabled },
              status.visionEnabled ? "Leitura de imagens desativada" : "Leitura de imagens ativada",
            )
          }
        >
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Modelo de visão
            </label>
            <Select
              value={status.products.vision.model}
              onValueChange={(v) => saveRouting("vision", { model: v })}
              options={[
                { value: "", label: "Automático (recomendado)" },
                ...(visionOptions ?? []).map((o) => ({ value: o.id, label: o.id })),
              ]}
            />
            {status.products.vision.model === "" ? (
              <p className="text-xs text-text-muted mt-1.5">
                Tenta os modelos validados em ordem e passa para o próximo se algum falhar.
              </p>
            ) : (
              (() => {
                const o = visionOptions?.find((x) => x.id === status.products.vision.model);
                if (!o) return null;
                return (
                  <div className="mt-1.5 space-y-0.5">
                    <p className="text-xs text-text-muted">
                      {secondsLabel(o.latencyMs)} · {o.inputTokens} tokens de imagem · acurácia{" "}
                      {o.accuracy} · {o.providers.map((p) => PROVIDER_LABEL[p] ?? p).join(" e ")}
                    </p>
                    {o.note && <p className="text-xs text-text-muted">{o.note}</p>}
                    <p className="flex items-start gap-1.5 text-xs text-semantic-warning">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      Fixar um modelo desliga o fallover: se ele sair do ar, a imagem não é lida.
                    </p>
                  </div>
                );
              })()
            )}
          </div>
          <RoutingSelect
            value={status.products.vision.order}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => saveRouting("vision", { order: v })}
          />
        </ProductRow>

        {/*
          Grupos de WhatsApp (F4). UM interruptor liga as três coisas que a IA
          faz num grupo — responder quando mencionada, resumir a sala e apontar
          oportunidades — e também libera a geração de texto das publicações
          programadas. Cada GRUPO ainda decide a própria política (responder ou
          só observar) na tela de Grupos; aqui é a chave da organização inteira.
        */}
        <ProductRow
          title="IA em grupos de WhatsApp"
          description="Responde quando mencionada no grupo, resume a conversa e aponta oportunidades — nunca manda mensagem privada sozinha. Cada grupo é configurado à parte, e vem desligado. Também libera a geração de texto das publicações programadas."
          enabled={status.groupAgentEnabled}
          busy={busy}
          onToggle={() =>
            void toggle(
              { groupAgentEnabled: !status.groupAgentEnabled },
              status.groupAgentEnabled ? "IA em grupos desativada" : "IA em grupos ativada",
            )
          }
        >
          <div className="sm:col-span-2">
            <p className="text-xs text-text-muted">
              O modelo é o mesmo do Atendente IA (o jeito de atender e o que ele sabe do negócio
              também). Só o roteamento pode ser diferente.
            </p>
          </div>
          <RoutingSelect
            value={status.products.groupAgent.order}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => saveRouting("groupAgent", { order: v })}
          />
          <RoutingSelectLabeled
            label="Roteamento das publicações programadas"
            value={status.products.groupPosts.order}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => saveRouting("groupPosts", { order: v })}
          />
        </ProductRow>

        <ProductRow
          title="Copiloto no Telegram"
          description="Modelo e rota usados quando a equipe fala com o Copiloto pelo Telegram (padrão: DeepSeek Flash via OpenRouter)."
          enabled
          busy={busy}
        >
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
              Modelo
            </label>
            <Select
              value={status.products.telegramCopilot?.model ?? ""}
              onValueChange={(v) => saveRouting("telegramCopilot", { model: v })}
              options={[
                { value: "", label: "Padrão (DeepSeek Flash via OpenRouter)" },
                ...(modelOptions ?? []).map((m) => ({ value: m.id, label: m.id })),
              ]}
            />
          </div>
          <RoutingSelect
            value={status.products.telegramCopilot?.order ?? "inherit"}
            orgOrder={status.platformOrder}
            byoProvider={byoProvider}
            onChange={(v) => saveRouting("telegramCopilot", { order: v })}
          />
        </ProductRow>
      </div>
    </Card>
  );
}
