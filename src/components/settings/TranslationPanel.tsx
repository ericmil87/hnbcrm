import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Languages, ShieldCheck, Wifi } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import { TAB_ROUTES } from "@/lib/routes";
import { languageSelectOptions } from "@/lib/translationRules";
import { VOCAB } from "@/lib/vocab";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { SectionCard } from "@/components/ui/SectionCard";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Textarea";

export const MAX_GLOSSARY_TERMS = 100;

export type TranslationProvider = "auto" | "libretranslate" | "llm";
export type TranslationTone = "neutral" | "formal" | "informal";

export interface TranslationSettingsValue {
  provider: TranslationProvider;
  teamLanguage: string;
  inboundMode: "auto" | "ask";
  outboundMode: "direct" | "quick_review" | "strict_review";
  skipWhenSameLanguage: boolean;
  tone: TranslationTone;
  glossary: string[];
}

export type TranslationSettingsPatch = Partial<Omit<TranslationSettingsValue, "skipWhenSameLanguage">>;

export interface PingResult {
  engine: "libretranslate" | "llm";
  ok: boolean;
  latencyMs: number;
  error?: string;
}

const ENGINE_LABEL: Record<PingResult["engine"], string> = {
  libretranslate: "Servidor próprio",
  llm: "IA da organização",
};

const PROVIDER_OPTIONS = [
  { value: "auto", label: "Automático (servidor próprio, IA como reserva)" },
  { value: "libretranslate", label: "Só o servidor próprio" },
  { value: "llm", label: "Só a IA da organização" },
];

const OUTBOUND_OPTIONS = [
  { value: "quick_review", label: "Revisar rápido (recomendado)" },
  { value: "direct", label: "Enviar direto" },
  { value: "strict_review", label: "Revisar antes de enviar (confirmar 2 vezes)" },
];

const OUTBOUND_HINT: Record<TranslationSettingsValue["outboundMode"], string> = {
  quick_review: "A tradução aparece embaixo do campo enquanto você escreve. Enter envia a versão traduzida.",
  direct: "Sem prévia: sua resposta é traduzida ao apertar Enter e sai no idioma do lead.",
  strict_review: "O primeiro Enter mostra a tradução para revisar; o segundo Enter envia.",
};

const TONE_OPTIONS = [
  { value: "neutral", label: "Neutro" },
  { value: "formal", label: "Formal" },
  { value: "informal", label: "Informal" },
];

/** Uma linha por termo, sem vazios nem repetidos, no máximo `MAX_GLOSSARY_TERMS`. */
export function parseGlossary(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const term = line.trim();
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

export interface TranslationPanelViewProps {
  moduleEnabled: boolean;
  settings: TranslationSettingsValue;
  providers: { libretranslate: boolean; llm: boolean };
  canManage: boolean;
  /** Liga/desliga o módulo (ligar só depois do aceite de privacidade). */
  onToggleModule: (next: boolean) => void | Promise<void>;
  onPatch: (patch: TranslationSettingsPatch) => void | Promise<void>;
  onPing: () => void;
  pinging?: boolean;
  pingResults?: PingResult[] | null;
  /** Link para o modelo e a rota (Avançado). */
  advancedHref: string;
}

/** Painel "Tradução automática", apresentacional (o container liga o Convex). */
export function TranslationPanelView({
  moduleEnabled,
  settings,
  providers,
  canManage,
  onToggleModule,
  onPatch,
  onPing,
  pinging = false,
  pingResults,
  advancedHref,
}: TranslationPanelViewProps) {
  const [ackOpen, setAckOpen] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const savedGlossary = settings.glossary.join("\n");
  const [glossary, setGlossary] = useState(savedGlossary);
  useEffect(() => setGlossary(savedGlossary), [savedGlossary]);
  const glossaryTerms = parseGlossary(glossary);
  const glossaryDirty = glossaryTerms.join("\n") !== savedGlossary;
  const glossaryOver = glossaryTerms.length > MAX_GLOSSARY_TERMS;
  const disabled = !canManage;

  return (
    <div className="space-y-4">
      <SectionCard
        title={VOCAB.translation.name}
        description="Mostra as mensagens dos clientes no idioma da equipe e envia as respostas no idioma deles."
        icon={<Languages size={20} />}
        actions={
          <Switch
            checked={moduleEnabled}
            onCheckedChange={(next) => {
              if (next) {
                setAckChecked(false);
                setAckOpen(true);
              } else void onToggleModule(false);
            }}
            label="Tradução automática"
            hideLabel
            disabled={disabled}
          />
        }
      >
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-semantic-success" aria-hidden />
          Primeiro tentamos o servidor de tradução próprio do HNBCRM. A IA só entra como reserva, e só quando a IA da
          organização está ativa. Notas internas e grupos nunca são traduzidos.
        </p>
        {!canManage && (
          <p className="mt-2 text-xs text-text-muted">Só quem administra as configurações pode mudar este painel.</p>
        )}
      </SectionCard>

      {moduleEnabled && (
        <>
          <SectionCard title="Idiomas" description="Como a equipe lê e responde.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                label="Idioma da equipe"
                value={settings.teamLanguage}
                onValueChange={(v) => void onPatch({ teamLanguage: v })}
                options={languageSelectOptions()}
                disabled={disabled}
              />
              <Select
                label="Tom da tradução"
                hint="Só a tradução por IA segue o tom."
                value={settings.tone}
                onValueChange={(v) => void onPatch({ tone: v as TranslationTone })}
                options={TONE_OPTIONS}
                disabled={disabled}
              />
            </div>
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium text-text-primary">Ao receber outro idioma</p>
              <SegmentedControl
                ariaLabel="Ao receber outro idioma"
                value={settings.inboundMode}
                onValueChange={(v) => !disabled && void onPatch({ inboundMode: v as "auto" | "ask" })}
                options={[
                  { value: "auto", label: "Traduzir automaticamente" },
                  { value: "ask", label: "Perguntar antes" },
                ]}
              />
            </div>
            <div className="mt-4 space-y-2">
              <p className="text-sm font-medium text-text-primary">Ao responder</p>
              <SegmentedControl
                ariaLabel="Ao responder"
                value={settings.outboundMode}
                onValueChange={(v) =>
                  !disabled && void onPatch({ outboundMode: v as TranslationSettingsValue["outboundMode"] })
                }
                options={OUTBOUND_OPTIONS}
              />
              <p className="text-sm text-text-secondary">{OUTBOUND_HINT[settings.outboundMode]}</p>
              <p className="text-xs text-text-muted">
                Se a tradução falhar, nada é enviado sozinho: a conversa mostra Tentar de novo e Enviar sem traduzir.
              </p>
            </div>
          </SectionCard>

          <SectionCard title="Glossário" description="Termos que nunca são traduzidos, como nomes de empreendimentos e da sua empresa.">
            <Textarea
              label="Um termo por linha"
              value={glossary}
              onChange={(e) => setGlossary(e.target.value)}
              rows={5}
              disabled={disabled}
              error={glossaryOver ? `Use no máximo ${MAX_GLOSSARY_TERMS} termos.` : undefined}
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs tabular-nums text-text-muted">
                {glossaryTerms.length} de {MAX_GLOSSARY_TERMS} termos
              </span>
              {glossaryDirty && (
                <Button
                  size="sm"
                  disabled={disabled || glossaryOver}
                  onClick={() => void onPatch({ glossary: glossaryTerms })}
                >
                  Salvar glossário
                </Button>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Provedor" description="Quem traduz as mensagens desta organização.">
            <Select
              label="Provedor de tradução"
              value={settings.provider}
              onValueChange={(v) => void onPatch({ provider: v as TranslationProvider })}
              options={PROVIDER_OPTIONS}
              disabled={disabled}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={providers.libretranslate ? "success" : "default"}>
                Servidor próprio: {providers.libretranslate ? "disponível" : "indisponível"}
              </Badge>
              <Badge variant={providers.llm ? "success" : "default"}>
                IA da organização: {providers.llm ? "ativa" : "desligada"}
              </Badge>
            </div>
            {!providers.libretranslate && !providers.llm && (
              <p className="mt-2 text-xs text-semantic-warning">
                Nenhum provedor disponível agora: as mensagens chegam sem tradução até um deles voltar.
              </p>
            )}
            <div className="mt-4 flex flex-col gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={onPing}
                loading={pinging}
                disabled={disabled}
              >
                <Wifi size={14} aria-hidden />
                Testar conexão
              </Button>
              {pingResults && (
                <ul className="space-y-1 text-sm" aria-live="polite">
                  {pingResults.length === 0 && <li className="text-text-muted">Nenhum provedor para testar.</li>}
                  {pingResults.map((r) => (
                    <li key={r.engine} className="flex flex-wrap items-center gap-2">
                      <Badge variant={r.ok ? "success" : "error"}>{r.ok ? "OK" : "Falhou"}</Badge>
                      <span className="text-text-primary">{ENGINE_LABEL[r.engine]}</span>
                      <span className="tabular-nums text-text-muted">{r.latencyMs} ms</span>
                      {r.error && <span className="text-xs text-semantic-error">{r.error}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="mt-4 text-xs text-text-muted">
              O modelo e a rota da tradução por IA ficam em{" "}
              <Link to={advancedHref} className="text-brand-500 hover:underline">
                Configurações › Avançado
              </Link>
              .
            </p>
          </SectionCard>
        </>
      )}

      <Modal open={ackOpen} onClose={() => setAckOpen(false)} title="Ativar tradução automática">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Privacidade: as mensagens traduzidas são enviadas ao provedor de tradução. Primeiro o servidor de tradução
            próprio do HNBCRM; a IA só é usada como reserva quando a IA da organização está ativa.
          </p>
          <Checkbox
            id="translation-privacy-ack"
            checked={ackChecked}
            onChange={(e) => setAckChecked(e.target.checked)}
            label="Li e aceito"
          />
          <div className="flex gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAckOpen(false)} className="flex-1">
              Cancelar
            </Button>
            <Button
              disabled={!ackChecked}
              onClick={() => {
                setAckOpen(false);
                void onToggleModule(true);
              }}
              className="flex-1"
            >
              Ativar tradução
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Container do painel: lê `translation.getSettings`, grava módulo e ajustes. */
export function TranslationPanel({ organizationId }: { organizationId: Id<"organizations"> }) {
  const data = useQuery(api.translation.getSettings, { organizationId });
  const setOrgModules = useMutation(api.orgModules.setOrgModules);
  const updateSettings = useMutation(api.translation.updateSettings);
  const pingProviders = useAction(api.translation.pingProviders);
  const { can } = usePermissions(organizationId);
  const [pinging, setPinging] = useState(false);
  const [pingResults, setPingResults] = useState<PingResult[] | null>(null);

  if (data === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const toggleModule = async (next: boolean) => {
    try {
      await setOrgModules({ organizationId, modules: { translation: next } });
      toast.success(next ? "Tradução automática ligada" : "Tradução automática desligada");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
    }
  };

  const patch = async (p: TranslationSettingsPatch) => {
    try {
      await updateSettings({ organizationId, patch: p });
      toast.success("Configuração salva");
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível salvar."));
    }
  };

  const ping = async () => {
    setPinging(true);
    try {
      setPingResults(await pingProviders({ organizationId }));
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Não foi possível testar a conexão."));
    } finally {
      setPinging(false);
    }
  };

  return (
    <TranslationPanelView
      moduleEnabled={data.moduleEnabled}
      settings={data.settings as TranslationSettingsValue}
      providers={data.providers}
      canManage={can("settings", "manage")}
      onToggleModule={toggleModule}
      onPatch={patch}
      onPing={() => void ping()}
      pinging={pinging}
      pingResults={pingResults}
      advancedHref={`${TAB_ROUTES.settings}?secao=ai-models`}
    />
  );
}
