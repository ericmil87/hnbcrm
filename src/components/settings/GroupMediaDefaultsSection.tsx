import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { ChevronDown, HardDrive } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/Button";
import { GroupMediaModeSelector } from "@/components/groups/GroupMediaModeSelector";
import {
  GROUP_MEDIA_KINDS,
  GROUP_MEDIA_KIND_LABELS,
  GROUP_MEDIA_MODE_LABELS,
  matchingPreset,
  normalizeGroupMedia,
  presetGroupMedia,
  summarizeGroupMedia,
  type GroupMediaKind,
  type GroupMediaMode,
  type GroupMediaPolicy,
} from "@/lib/groupMedia";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";

const MODE_OPTIONS: { id: GroupMediaMode; label: string; recommended?: boolean }[] = [
  { id: "all", label: GROUP_MEDIA_MODE_LABELS.all },
  { id: "mentions", label: GROUP_MEDIA_MODE_LABELS.mentions, recommended: true },
  { id: "off", label: GROUP_MEDIA_MODE_LABELS.off },
];

/**
 * "Mídia dos grupos" — padrão do NÚMERO para baixar foto/áudio/vídeo/documento
 * das salas acompanhadas (v0.62). Cada grupo pode sobrescrever em /app/grupos.
 *
 * Salva a cada clique, como os outros interruptores do painel: não há um
 * "Salvar" para esquecer. Quem não tem `settings:manage` vê o resumo e só.
 */
export function GroupMediaDefaultsSection({
  organizationId,
  channelConfigId,
  groupMedia,
  canManage,
}: {
  organizationId: Id<"organizations">;
  channelConfigId: Id<"channelConfigs">;
  /** `listChannelGroupSettings[].groupMedia` — já resolvido pelo servidor. */
  groupMedia: Partial<GroupMediaPolicy> | undefined;
  canManage: boolean;
}) {
  const setGroupMediaDefaults = useMutation(api.groupChats.setGroupMediaDefaults);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Valor otimista enquanto a mutation voa — sem ele o segmento "pula de volta"
  // até a query reativa confirmar.
  const [draft, setDraft] = useState<GroupMediaPolicy | null>(null);

  const current = draft ?? normalizeGroupMedia(groupMedia);
  const preset = matchingPreset(current);

  const save = async (next: GroupMediaPolicy) => {
    setDraft(next);
    setSaving(true);
    try {
      await setGroupMediaDefaults({ organizationId, channelConfigId, policy: next });
    } catch (error) {
      toast.error(mutationErrorMessage(error, "Falha ao salvar a mídia dos grupos"));
    } finally {
      setDraft(null);
      setSaving(false);
    }
  };

  const setKind = (kind: GroupMediaKind, mode: GroupMediaMode) =>
    void save({ ...current, [kind]: mode });

  return (
    <div className="rounded-lg border border-border bg-surface-sunken">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg p-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <HardDrive size={15} className="shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-text-primary">Mídia dos grupos</span>
          <span className="block text-xs text-text-muted">{summarizeGroupMedia(current)}</span>
        </span>
        <ChevronDown
          size={14}
          className={cn("shrink-0 text-text-muted transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border-subtle p-2.5">
          <p className="text-xs leading-relaxed text-text-secondary">
            Quais arquivos das salas acompanhadas o CRM baixa sozinho.{" "}
            <strong className="font-medium text-text-primary">"Com a gente"</strong> = a
            mensagem menciona o número, responde a uma mensagem nossa, usa uma
            palavra-chave da IA do grupo, ou fomos nós que mandamos.
          </p>

          {canManage && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant={preset === "mentions" ? "primary" : "secondary"}
                size="sm"
                disabled={saving || preset === "mentions"}
                onClick={() => void save(presetGroupMedia("mentions"))}
              >
                Economizar espaço
              </Button>
              <Button
                variant={preset === "all" ? "primary" : "secondary"}
                size="sm"
                disabled={saving || preset === "all"}
                onClick={() => void save(presetGroupMedia("all"))}
              >
                Baixar tudo
              </Button>
            </div>
          )}

          <div className="space-y-3">
            {GROUP_MEDIA_KINDS.map((kind) => (
              <GroupMediaModeSelector
                key={kind}
                name={`group-media-${channelConfigId}-${kind}`}
                legend={GROUP_MEDIA_KIND_LABELS[kind]}
                value={current[kind]}
                options={MODE_OPTIONS}
                disabled={!canManage || saving}
                onChange={(mode) => setKind(kind, mode)}
              />
            ))}
          </div>

          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-text-muted">
            <li>
              Mídia não baixada não ocupa espaço e pode ser baixada depois, na
              própria conversa, por até 14 dias.
            </li>
            <li>Figurinhas de grupo nunca são baixadas automaticamente.</li>
            <li>
              Áudios e imagens baixados são lidos pela IA conforme as opções de
              transcrição e de leitura de imagem.
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
