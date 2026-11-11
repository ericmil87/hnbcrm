import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { TAB_ROUTES } from "@/lib/routes";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { FeatureToggleCard } from "../ai/FeatureToggleCard";

export interface VoiceReplySettings {
  enabled: boolean;
  voice: string;
  configuredVoice: string | null;
  defaultVoice: string;
  voices: string[];
  notice: string | null;
  noticeMaxChars: number;
  model: string;
  platformReady: boolean;
  aiActive: boolean;
}

export interface VoiceReplyPatch {
  voiceReplyEnabled?: boolean;
  voiceReplyVoice?: string;
  voiceReplyNotice?: string;
}

export interface VoiceReplyCardViewProps {
  settings: VoiceReplySettings;
  canManage: boolean;
  saving?: boolean;
  /** Mensagem do servidor da última tentativa de salvar. */
  error?: string | null;
  onSave: (patch: VoiceReplyPatch) => void;
  activationHref?: string;
}

const NOTICE_PLACEHOLDER = "Sou a assistente virtual da {empresa}";

/** Bloco "Responder em áudio" (apresentação). Cada alteração grava na hora, sem a barra de salvar do painel. */
export function VoiceReplyCardView({
  settings,
  canManage,
  saving,
  error,
  onSave,
  activationHref = `${TAB_ROUTES.settings}?secao=ai`,
}: VoiceReplyCardViewProps) {
  const [notice, setNotice] = useState(settings.notice ?? "");
  useEffect(() => setNotice(settings.notice ?? ""), [settings.notice]);

  const locked = !canManage || !!saving;
  const noticeDirty = notice.trim() !== (settings.notice ?? "");
  const available = settings.aiActive && (settings.platformReady || settings.enabled);
  const voiceOptions = settings.voices.map((v) => ({
    value: v,
    label: v === settings.defaultVoice ? `${v} (padrão)` : v,
  }));

  return (
    <FeatureToggleCard
      icon={Volume2}
      title="Responder em áudio"
      description="Quando o cliente mandar áudio, a IA pode responder em áudio. Valores, links, Pix, endereços e telefones sempre vão por escrito. Em grupos e respostas longas, a resposta vai em texto. Por enquanto, só no WhatsApp por QR code."
      available={available}
      checked={settings.enabled}
      onChange={(next) => onSave({ voiceReplyEnabled: next })}
      disabled={locked}
      warning={!settings.platformReady ? "Resposta em áudio indisponível no momento. Tente de novo mais tarde." : undefined}
    >
      {!settings.aiActive && (
        <p className="text-xs text-text-muted">
          A IA está desligada, então nada é respondido em áudio.{" "}
          <Link to={activationHref} className="font-medium text-brand-500 hover:text-brand-400">
            Ativar a IA
          </Link>
        </p>
      )}
      {!canManage && (
        <p className="text-xs text-text-muted">Só quem gerencia as configurações pode alterar a resposta em áudio.</p>
      )}
      <Select
        label="Voz"
        value={settings.voice}
        options={voiceOptions}
        disabled={locked}
        onValueChange={(voiceReplyVoice) => onSave({ voiceReplyVoice })}
      />
      <div className="space-y-2">
        <Input
          label="Aviso de voz sintética (opcional)"
          type="text"
          value={notice}
          maxLength={settings.noticeMaxChars}
          placeholder={NOTICE_PLACEHOLDER}
          disabled={locked}
          onChange={(e) => setNotice(e.target.value)}
          aria-describedby="voice-notice-hint"
        />
        <div className="flex items-start justify-between gap-3">
          <p id="voice-notice-hint" className="text-xs text-text-muted">
            Frase dita no começo do áudio avisando que a voz é sintética. Sem números nem dados de contato.
          </p>
          <span className="shrink-0 text-xs text-text-muted" aria-live="polite">
            {notice.length}/{settings.noticeMaxChars}
          </span>
        </div>
        {canManage && noticeDirty && (
          <div className="flex gap-2">
            <Button size="sm" loading={saving} onClick={() => onSave({ voiceReplyNotice: notice.trim() })}>
              Salvar aviso
            </Button>
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => setNotice(settings.notice ?? "")}>
              Descartar
            </Button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-semantic-error">
          {error}
        </p>
      )}
    </FeatureToggleCard>
  );
}

/** Container: lê `voiceReply.getVoiceReplySettings` e grava por `aiSettings.setFeatureToggles`. */
export function VoiceReplyCard({ organizationId, canManage }: { organizationId: Id<"organizations">; canManage: boolean }) {
  const settings = useQuery(api.voiceReply.getVoiceReplySettings, { organizationId }) as VoiceReplySettings | null | undefined;
  const setFeatureToggles = useMutation(api.aiSettings.setFeatureToggles);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (settings === undefined) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if (settings === null) return null;

  const save = async (patch: VoiceReplyPatch) => {
    setSaving(true);
    setError(null);
    try {
      await setFeatureToggles({ organizationId, ...patch });
      toast.success("Resposta em áudio atualizada.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <VoiceReplyCardView settings={settings} canManage={canManage} saving={saving} error={error} onSave={(p) => void save(p)} />
  );
}
