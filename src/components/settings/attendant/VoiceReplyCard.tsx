import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { mutationErrorMessage } from "@/lib/errors";
import { TAB_ROUTES } from "@/lib/routes";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { FeatureToggleCard } from "../ai/FeatureToggleCard";

export type VoiceReplySettings = NonNullable<FunctionReturnType<typeof api.voiceReply.getVoiceReplySettings>>;

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
  /** Devolve `true` quando gravou (limpa o rascunho do aviso). */
  onSave: (patch: VoiceReplyPatch) => void | Promise<boolean | void>;
  /** Aviso de voz com texto ainda não salvo (o painel avisa ao sair). */
  onDirtyChange?: (dirty: boolean) => void;
  activationHref?: string;
}

const NOTICE_PLACEHOLDER = "Sou a assistente virtual da Loja Exemplo";

const normalizeNotice = (text: string) => text.replace(/\s+/g, " ").trim();

/** Bloco "Responder em áudio" (apresentação). Cada alteração grava na hora, sem a barra de salvar do painel. */
export function VoiceReplyCardView({
  settings,
  canManage,
  saving,
  error,
  onSave,
  onDirtyChange,
  activationHref = `${TAB_ROUTES.settings}?secao=ai`,
}: VoiceReplyCardViewProps) {
  const [notice, setNotice] = useState(settings.notice ?? "");
  const [errorHidden, setErrorHidden] = useState(false);
  const [noticeFailed, setNoticeFailed] = useState(false);
  useEffect(() => setNotice(settings.notice ?? ""), [settings.notice]);
  useEffect(() => setErrorHidden(false), [error]);

  const normalized = normalizeNotice(notice);
  const noticeDirty = normalized !== (settings.notice ?? "");
  useEffect(() => onDirtyChange?.(noticeDirty), [noticeDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const available = settings.enabled || (settings.aiActive && settings.platformReady);
  const locked = !canManage || !!saving;
  const fieldsLocked = locked || !available;
  const showError = !!error && !errorHidden;
  const voiceOptions = settings.voices.map((v) => ({
    value: v,
    label: v === settings.defaultVoice ? `${v} (padrão)` : v,
  }));

  const saveNotice = async () => {
    setNoticeFailed(true);
    setErrorHidden(false);
    const ok = await onSave({ voiceReplyNotice: normalized });
    if (ok === true) setNotice(normalized);
  };

  return (
    <FeatureToggleCard
      icon={Volume2}
      title="Responder em áudio"
      description="Quando o cliente mandar áudio, a IA pode responder em áudio. Valores, links, Pix, endereços e telefones sempre vão por escrito. Em grupos e respostas longas, a resposta vai em texto. Por enquanto, só no WhatsApp por QR code."
      available={available}
      checked={settings.enabled}
      onChange={(next) => {
        setNoticeFailed(false);
        setErrorHidden(true);
        void onSave({ voiceReplyEnabled: next });
      }}
      disabled={locked}
      warning={!settings.platformReady ? "Resposta em áudio indisponível no momento. Tente de novo mais tarde." : undefined}
    >
      {!settings.aiActive && (
        <p className="text-xs text-text-muted">
          A IA não está ativa (ligada e com o aceite da LGPD), então nada é respondido em áudio.{" "}
          <Link to={activationHref} className="font-medium text-brand-500 hover:text-brand-400">
            Ativar a IA
          </Link>
        </p>
      )}
      {!canManage && (
        <p className="text-xs text-text-muted">Só quem gerencia as configurações pode alterar a resposta em áudio.</p>
      )}
      <p className="text-xs text-text-muted">As mudanças deste bloco são salvas na hora.</p>
      <Select
        label="Voz"
        value={settings.voice}
        options={voiceOptions}
        disabled={fieldsLocked}
        onValueChange={(voiceReplyVoice) => {
          setNoticeFailed(false);
          setErrorHidden(true);
          void onSave({ voiceReplyVoice });
        }}
      />
      <div className="space-y-2">
        <Input
          label="Aviso de voz sintética (opcional)"
          type="text"
          value={notice}
          maxLength={settings.noticeMaxChars}
          placeholder={NOTICE_PLACEHOLDER}
          disabled={fieldsLocked}
          error={showError && noticeFailed ? error : undefined}
          onChange={(e) => {
            setNotice(e.target.value);
            setErrorHidden(true);
          }}
          aria-invalid={showError && noticeFailed ? true : undefined}
          aria-describedby="voice-notice-hint"
        />
        <div className="flex items-start justify-between gap-3">
          <p id="voice-notice-hint" className="text-xs text-text-muted">
            Frase dita no início do primeiro áudio de cada conversa, avisando que a voz é sintética. Sem números, links, e-mails, valores, endereços ou códigos.
          </p>
          <span className="shrink-0 text-xs text-text-muted">
            {notice.length}/{settings.noticeMaxChars}
          </span>
        </div>
        {canManage && available && noticeDirty && (
          <div className="flex gap-2">
            <Button size="sm" loading={saving} onClick={() => void saveNotice()}>
              Salvar aviso
            </Button>
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => setNotice(settings.notice ?? "")}>
              Descartar
            </Button>
          </div>
        )}
      </div>
      {showError && !noticeFailed && (
        <p role="alert" className="text-xs text-semantic-error">
          {error}
        </p>
      )}
    </FeatureToggleCard>
  );
}

/** Container: lê `voiceReply.getVoiceReplySettings` e grava por `aiSettings.setFeatureToggles`. */
export function VoiceReplyCard({
  organizationId,
  canManage,
  onDirtyChange,
}: {
  organizationId: Id<"organizations">;
  canManage: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const settings = useQuery(api.voiceReply.getVoiceReplySettings, { organizationId });
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

  const save = async (patch: VoiceReplyPatch): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await setFeatureToggles({ organizationId, ...patch });
      toast.success("Resposta em áudio atualizada");
      return true;
    } catch (e) {
      setError(mutationErrorMessage(e, "Não foi possível salvar a resposta em áudio."));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <VoiceReplyCardView settings={settings} canManage={canManage} saving={saving} error={error} onSave={save} onDirtyChange={onDirtyChange} />
  );
}
