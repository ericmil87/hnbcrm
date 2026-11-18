import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { MessagesSquare, Play, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { AttendantSimulator } from "@/components/ai/AttendantSimulator";
import { AudioPlayer } from "@/components/inbox/AudioPlayer";
import { useOrgModules } from "@/hooks/useOrgModules";
import { mutationErrorMessage } from "@/lib/errors";
import { previewNotice } from "@/lib/voiceTest";
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

/** Resultado da amostra de voz (`voiceReply.previewVoiceSample`). */
export type VoicePreviewOutcome = { ok: true; url: string; durationSec: number } | { ok: false; message: string };

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
  /** "Ouvir amostra": fala o aviso digitado (salvo ou não) + uma saudação com a voz escolhida. */
  onPreview?: (input: { voice: string; notice?: string }) => Promise<VoicePreviewOutcome>;
  /** "Testar conversa com voz": abre o simulador já no modo áudio. */
  onTestConversation?: () => void;
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string; durationSec: number }
  | { status: "error"; message: string };

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
  onPreview,
  onTestConversation,
}: VoiceReplyCardViewProps) {
  const [notice, setNotice] = useState(settings.notice ?? "");
  const [errorHidden, setErrorHidden] = useState(false);
  const [noticeFailed, setNoticeFailed] = useState(false);
  useEffect(() => setNotice(settings.notice ?? ""), [settings.notice]);
  useEffect(() => setErrorHidden(false), [error]);

  const normalized = normalizeNotice(notice);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  // A amostra vale para a voz e o aviso de quando foi gerada: mudou, some.
  useEffect(() => setPreview({ status: "idle" }), [settings.voice, normalized]);
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

  const testReady = settings.aiActive && settings.platformReady;
  const runPreview = async () => {
    if (!onPreview) return;
    setPreview({ status: "loading" });
    try {
      const result = await onPreview({ voice: settings.voice, notice: previewNotice(notice) });
      setPreview(result.ok ? { status: "ready", url: result.url, durationSec: result.durationSec } : { status: "error", message: result.message });
    } catch (e) {
      setPreview({ status: "error", message: mutationErrorMessage(e, "Não foi possível gerar a amostra.") });
    }
  };

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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
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
        </div>
        {onPreview && (
          <Button
            variant="secondary"
            className="min-h-11 shrink-0"
            loading={preview.status === "loading"}
            disabled={!testReady}
            onClick={() => void runPreview()}
          >
            <Play size={15} aria-hidden="true" />
            Ouvir amostra
          </Button>
        )}
      </div>
      {onPreview && preview.status === "ready" && (
        <div className="space-y-1 rounded-field bg-surface-sunken p-2.5" data-testid="voice-preview">
          <p className="text-caption text-text-muted">
            Amostra com a voz {settings.voice}: {normalized ? "o aviso de voz sintética e uma saudação" : "uma saudação"}.
          </p>
          <AudioPlayer src={preview.url} isVoiceNote />
        </div>
      )}
      {onPreview && preview.status === "error" && (
        <p role="alert" className="text-xs text-semantic-error">
          {preview.message}
        </p>
      )}
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
            Frase dita no início do primeiro áudio de cada conversa, avisando que a voz é sintética. Sem números, links, e-mails, valores, endereços ou códigos. Em Ouvir amostra, o aviso digitado é falado mesmo antes de salvar.
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
      {onTestConversation && (
        <div className="space-y-2 border-t border-border-subtle pt-3">
          <Button variant="secondary" className="min-h-11" disabled={!settings.aiActive} onClick={onTestConversation}>
            <MessagesSquare size={15} aria-hidden="true" />
            Testar conversa com voz
          </Button>
          <p className="text-xs text-text-muted">
            Abre o teste do atendente: escreva como se fosse o cliente (como nota de voz) e veja a resposta em texto e em
            áudio, ou por que ela iria em texto. Nada chega a um cliente nem fica salvo no CRM.
          </p>
        </div>
      )}
      {showError && !noticeFailed && (
        <p role="alert" className="text-xs text-semantic-error">
          {error}
        </p>
      )}
    </FeatureToggleCard>
  );
}

/**
 * Container: lê `voiceReply.getVoiceReplySettings`, grava por `aiSettings.setFeatureToggles`,
 * toca a amostra por `voiceReply.previewVoiceSample` e abre o simulador em modo áudio.
 */
export function VoiceReplyCard({
  organizationId,
  canManage,
  onDirtyChange,
  agentMemberId,
}: {
  organizationId: Id<"organizations">;
  canManage: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** Atendente do painel: habilita "Testar conversa com voz" (simulador em modo áudio). */
  agentMemberId?: Id<"teamMembers">;
}) {
  const settings = useQuery(api.voiceReply.getVoiceReplySettings, { organizationId });
  const setFeatureToggles = useMutation(api.aiSettings.setFeatureToggles);
  const previewVoiceSample = useAction(api.voiceReply.previewVoiceSample);
  const { modules } = useOrgModules(organizationId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

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
    <>
      <VoiceReplyCardView
        settings={settings}
        canManage={canManage}
        saving={saving}
        error={error}
        onSave={save}
        onDirtyChange={onDirtyChange}
        onPreview={(input) => previewVoiceSample({ organizationId, ...input })}
        onTestConversation={agentMemberId ? () => setTesting(true) : undefined}
      />
      {testing && agentMemberId && (
        <AttendantSimulator
          variant="modal"
          voiceMode
          metaEnabled={modules.metaMessaging}
          organizationId={organizationId}
          agentMemberId={agentMemberId}
          onClose={() => setTesting(false)}
        />
      )}
    </>
  );
}
