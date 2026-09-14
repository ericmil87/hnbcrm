import { useMemo, useRef, useState } from "react";
import { useAction, useQuery, usePaginatedQuery, type PaginatedQueryReference } from "convex/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bold,
  Braces,
  Code,
  Dices,
  Italic,
  Link2,
  Plus,
  RefreshCw,
  Strikethrough,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { FileUploadButton, type UploadedFile } from "@/components/ui/FileUploadButton";
import { Spinner } from "@/components/ui/Spinner";
import { VoiceRecorder } from "@/components/inbox/VoiceRecorder";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { containsLink, countSpintaxVariations, extractVarNames } from "@/lib/whatsappFormat";
import { WhatsAppPreview, type WhatsAppPreviewAttachment } from "../WhatsAppPreview";
import type { CampaignRecipient, CampaignTemplate, TemplateParam, WhatsappTemplateItem } from "../types";
import {
  contentTypeForMime,
  resolveTemplateBody,
  templateButtonsForPreview,
  templateFooterForPreview,
  templateHeaderForPreview,
} from "../campaignUtils";
import { BUILTIN_VARS, SAMPLE_RECIPIENT_VARS, type WizardDraft } from "../wizardState";

interface StepMessageProps {
  organizationId: Id<"organizations">;
  campaignId: Id<"campaigns"> | null;
  draft: WizardDraft;
  setDraft: (updater: (prev: WizardDraft) => WizardDraft) => void;
  editable: boolean;
  businessName: string;
  recipientsTotal: number;
}

type FileMeta = { name: string; mimeType: string; size: number; url: string | null };

const BRIDGE_MIN_VARIANTS_ABOVE = 30;

export function StepMessage({ organizationId, campaignId, draft, setDraft, editable, businessName, recipientsTotal }: StepMessageProps) {
  const isMeta = draft.provider === "meta";
  const onlyOpenWindow = draft.audience.source === "segment" && draft.audience.filters.onlyOpenWindow === true;
  const canFreeText = !isMeta || onlyOpenWindow;
  const kind = draft.content.kind;

  // Amostra de destinatários reais (para o preview)
  const listRef = api.campaigns.getCampaignRecipients as unknown as PaginatedQueryReference;
  const { results: recipientResults } = usePaginatedQuery(
    listRef,
    campaignId && draft.audience.source !== "segment" ? { campaignId } : "skip",
    { initialNumItems: 3 }
  );
  const sampleRecipients = useMemo(() => {
    const rows = ((recipientResults ?? []) as CampaignRecipient[]).slice(0, 3);
    if (rows.length === 0) return [{ label: "Maria (exemplo)", vars: SAMPLE_RECIPIENT_VARS }];
    return rows.map((r) => {
      const nome = r.displayName ?? r.vars?.nome ?? "";
      const vars: Record<string, string> = { ...(r.vars ?? {}) };
      if (nome) {
        vars.nome = nome;
        vars.primeiro_nome = nome.split(/\s+/)[0];
      }
      return { label: nome || r.phone, vars: { ...SAMPLE_RECIPIENT_VARS, ...vars } };
    });
  }, [recipientResults]);

  const [sampleIndex, setSampleIndex] = useState(0);
  const [variantIndex, setVariantIndex] = useState(0);
  const [seed, setSeed] = useState(1);
  const sample = sampleRecipients[Math.min(sampleIndex, sampleRecipients.length - 1)];

  // Metadados de anexos (upload nesta sessão) — para chips e preview
  const [fileMeta, setFileMeta] = useState<Record<string, FileMeta>>({});
  const rememberFiles = (files: UploadedFile[], urls?: Record<string, string | null>) =>
    setFileMeta((prev) => {
      const next = { ...prev };
      for (const f of files) next[f.fileId] = { name: f.name, mimeType: f.mimeType, size: f.size, url: urls?.[f.fileId] ?? prev[f.fileId]?.url ?? null };
      return next;
    });

  const setKind = (next: "text" | "template") =>
    setDraft((d) => ({
      ...d,
      content: {
        ...d.content,
        kind: next,
        variants: d.content.variants.length > 0 ? d.content.variants : [{ text: "" }],
      },
    }));

  const variants = draft.content.variants;
  const activeVariant = variants[Math.min(variantIndex, variants.length - 1)] ?? { text: "" };
  const needsVariants = draft.provider === "bridge" && recipientsTotal > BRIDGE_MIN_VARIANTS_ABOVE;
  const totalVariations = variants.reduce((acc, vr) => acc + countSpintaxVariations(vr.text), 0);
  const hasVariation = variants.length >= 2 || totalVariations >= 2;
  const anyLink = variants.some((vr) => containsLink(vr.text));

  // Template
  const templates = useQuery(
    api.whatsappTemplates.listTemplates,
    isMeta && draft.channelConfigId ? { channelConfigId: draft.channelConfigId, onlyApproved: true } : "skip"
  ) as WhatsappTemplateItem[] | undefined;
  const selectedTemplate =
    templates?.find((t) => t.name === draft.content.template?.name && t.language === draft.content.template?.language) ?? null;
  const headerFile = draft.content.template?.headerFileId ? fileMeta[draft.content.template.headerFileId] : undefined;
  const headerFileDoc = useQuery(
    api.files.getFile,
    draft.content.template?.headerFileId && !headerFile ? { fileId: draft.content.template.headerFileId } : "skip"
  );
  const headerUrl = headerFile?.url ?? headerFileDoc?.url ?? null;

  const previewText =
    kind === "template"
      ? resolveTemplateBody(selectedTemplate?.bodyText ?? draft.content.template?.bodyText ?? "", draft.content.template?.bodyParams, sample.vars)
      : activeVariant.text;

  const previewAttachments: WhatsAppPreviewAttachment[] =
    kind === "text"
      ? (activeVariant.attachmentFileIds ?? []).map((id) => {
          const meta = fileMeta[id];
          return meta
            ? { name: meta.name, mimeType: meta.mimeType, url: meta.url, size: meta.size }
            : { name: "Anexo", mimeType: "application/octet-stream", url: null };
        })
      : [];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4 min-w-0">
        {isMeta && (
          <div className="flex gap-2">
            <ModeButton active={kind === "template"} onClick={() => setKind("template")} disabled={!editable}>
              Template aprovado
            </ModeButton>
            <ModeButton active={kind === "text"} onClick={() => setKind("text")} disabled={!editable || !canFreeText}>
              Texto livre {canFreeText ? "" : "(só com janela aberta)"}
            </ModeButton>
          </div>
        )}
        {isMeta && kind === "text" && !canFreeText && (
          <Warn>
            Na Cloud API só é possível enviar texto livre para quem escreveu nas últimas 24h. Para números novos, use um template ou
            filtre o público por "janela aberta".
          </Warn>
        )}

        {kind === "template" ? (
          <TemplateEditor
            channelConfigId={draft.channelConfigId}
            templates={templates}
            selected={selectedTemplate}
            template={draft.content.template}
            organizationId={organizationId}
            editable={editable}
            onSelect={(t) =>
              setDraft((d) => ({
                ...d,
                templateQuality: t.qualityScore,
                content: {
                  ...d.content,
                  kind: "template",
                  template: {
                    name: t.name,
                    language: t.language,
                    category: t.category,
                    headerFormat: t.headerFormat ?? undefined,
                    bodyText: t.bodyText ?? undefined,
                    bodyParams: Array.from({ length: t.bodyParamCount }, (_, i) => d.content.template?.bodyParams?.[i] ?? { source: "field", value: "nome" }),
                    buttonParams: t.buttons.some((b) => b.dynamic) ? t.buttons.filter((b) => b.dynamic).map(() => ({ source: "const", value: "" })) : undefined,
                  },
                },
              }))
            }
            onParamsChange={(bodyParams) =>
              setDraft((d) => ({ ...d, content: { ...d.content, template: { ...(d.content.template as CampaignTemplate), bodyParams } } }))
            }
            onButtonParamsChange={(buttonParams) =>
              setDraft((d) => ({ ...d, content: { ...d.content, template: { ...(d.content.template as CampaignTemplate), buttonParams } } }))
            }
            onHeaderFile={(file) => {
              if (file) rememberFiles([file]);
              setDraft((d) => ({
                ...d,
                content: { ...d.content, template: { ...(d.content.template as CampaignTemplate), headerFileId: file?.fileId } },
              }));
            }}
            headerFileName={headerFile?.name ?? headerFileDoc?.name ?? null}
            availableVars={collectVars(sampleRecipients.map((s) => s.vars))}
          />
        ) : (
          <>
            {/* Variantes */}
            <div className="flex items-center gap-2 flex-wrap">
              {variants.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setVariantIndex(i)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium min-h-[36px]",
                    i === variantIndex ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-border text-text-secondary"
                  )}
                >
                  Variante {i + 1}
                </button>
              ))}
              {editable && variants.length < 5 && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft((d) => ({ ...d, content: { ...d.content, variants: [...d.content.variants, { text: "" }] } }));
                    setVariantIndex(variants.length);
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary min-h-[36px]"
                >
                  <Plus size={13} /> variante
                </button>
              )}
              {editable && variants.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft((d) => ({ ...d, content: { ...d.content, variants: d.content.variants.filter((_, i) => i !== variantIndex) } }));
                    setVariantIndex(Math.max(0, variantIndex - 1));
                  }}
                  className="ml-auto h-9 w-9 flex items-center justify-center rounded-full text-text-muted hover:text-semantic-error hover:bg-semantic-error/10"
                  aria-label="Remover variante"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <VariantEditor
              key={variantIndex}
              organizationId={organizationId}
              text={activeVariant.text}
              attachmentIds={activeVariant.attachmentFileIds ?? []}
              fileMeta={fileMeta}
              editable={editable}
              availableVars={collectVars(sampleRecipients.map((s) => s.vars))}
              onText={(text) =>
                setDraft((d) => ({
                  ...d,
                  content: { ...d.content, variants: d.content.variants.map((vr, i) => (i === variantIndex ? { ...vr, text } : vr)) },
                }))
              }
              onAttachments={(files, remove) => {
                rememberFiles(files);
                setDraft((d) => {
                  const current = d.content.variants[variantIndex]?.attachmentFileIds ?? [];
                  const ids = remove ? current.filter((id) => id !== remove) : [...current, ...files.map((f) => f.fileId)];
                  const first = ids[0] ? fileMeta[ids[0]]?.mimeType ?? files[0]?.mimeType : undefined;
                  return {
                    ...d,
                    content: {
                      ...d.content,
                      contentType: first ? contentTypeForMime(first) : "text",
                      variants: d.content.variants.map((vr, i) => (i === variantIndex ? { ...vr, attachmentFileIds: ids } : vr)),
                    },
                  };
                });
              }}
            />

            {needsVariants && !hasVariation && (
              <Warn>
                No bridge, acima de {BRIDGE_MIN_VARIANTS_ABOVE} destinatários é obrigatório variar o texto: crie 2+ variantes ou use spintax{" "}
                <code className="text-text-primary">{"{oi|olá|bom dia}"}</code>. Texto idêntico em massa é o sinal de spam mais fácil de detectar.
              </Warn>
            )}
            {draft.provider === "bridge" && anyLink && (
              <div className="rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3 space-y-2">
                <p className="text-sm text-text-primary flex items-start gap-2">
                  <Link2 size={15} className="shrink-0 mt-0.5 text-semantic-warning" />
                  A mensagem contém link. Link no primeiro contato é um dos sinais que mais levam a bloqueio no protocolo não oficial.
                </p>
                <Checkbox
                  checked={draft.safety.allowLinks ?? false}
                  disabled={!editable}
                  onChange={(e) => setDraft((d) => ({ ...d, safety: { ...d.safety, allowLinks: e.target.checked } }))}
                  label="Entendo o risco e quero enviar com link mesmo assim"
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Preview */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          {sampleRecipients.length > 1 && (
            <select
              className="h-9 rounded-lg border border-border bg-surface-raised px-2 text-xs text-text-primary"
              value={sampleIndex}
              onChange={(e) => setSampleIndex(Number(e.target.value))}
              aria-label="Destinatário de amostra"
            >
              {sampleRecipients.map((s, i) => (
                <option key={i} value={i}>
                  Ver como: {s.label}
                </option>
              ))}
            </select>
          )}
          {kind === "text" && totalVariations > 1 && (
            <button
              type="button"
              onClick={() => setSeed((s) => s + 1)}
              className="inline-flex items-center gap-1 h-9 rounded-full border border-border px-3 text-xs text-text-secondary hover:text-text-primary"
            >
              <Dices size={13} /> sortear spintax
            </button>
          )}
        </div>
        <WhatsAppPreview
          text={previewText}
          vars={sample.vars}
          seed={seed}
          attachments={previewAttachments}
          header={kind === "template" ? templateHeaderForPreview(selectedTemplate, headerUrl, headerFile?.name ?? headerFileDoc?.name ?? undefined) : undefined}
          footer={kind === "template" ? templateFooterForPreview(selectedTemplate) : undefined}
          buttons={kind === "template" ? templateButtonsForPreview(selectedTemplate) : undefined}
          businessName={businessName}
          showMeta
        />
      </div>
    </div>
  );
}

function collectVars(list: Record<string, string>[]): string[] {
  const keys = new Set<string>(BUILTIN_VARS.map((v) => v.key));
  for (const vars of list) for (const k of Object.keys(vars)) keys.add(k);
  return [...keys];
}

function ModeButton({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium min-h-[44px] transition-colors",
        active ? "border-brand-500 bg-brand-500/10 text-brand-400" : "border-border text-text-secondary hover:bg-surface-overlay",
        disabled && "opacity-50 cursor-not-allowed"
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-semantic-warning/40 bg-semantic-warning/10 p-3 text-sm text-text-primary">
      <AlertTriangle size={15} className="shrink-0 mt-0.5 text-semantic-warning" />
      <span>{children}</span>
    </div>
  );
}

// ── Editor de texto livre (uma variante) ──

function VariantEditor({
  organizationId,
  text,
  attachmentIds,
  fileMeta,
  editable,
  availableVars,
  onText,
  onAttachments,
}: {
  organizationId: Id<"organizations">;
  text: string;
  attachmentIds: Id<"files">[];
  fileMeta: Record<string, FileMeta>;
  editable: boolean;
  availableVars: string[];
  onText: (text: string) => void;
  onAttachments: (files: UploadedFile[], remove?: Id<"files">) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [recorderActive, setRecorderActive] = useState(false);

  const wrap = (before: string, after = before) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const selected = text.slice(start, end) || "texto";
    const next = text.slice(0, start) + before + selected + after + text.slice(end);
    onText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };
  const insert = (snippet: string) => {
    const el = ref.current;
    const pos = el?.selectionStart ?? text.length;
    const next = text.slice(0, pos) + snippet + text.slice(pos);
    onText(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + snippet.length, pos + snippet.length);
    });
  };

  const uploaded: UploadedFile[] = attachmentIds.map((id) => ({
    fileId: id,
    name: fileMeta[id]?.name ?? "Anexo",
    mimeType: fileMeta[id]?.mimeType ?? "application/octet-stream",
    size: fileMeta[id]?.size ?? 0,
  }));
  const usedVars = extractVarNames(text);

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3 space-y-2">
      <div className="flex items-center gap-1 flex-wrap">
        <ToolBtn label="Negrito" onClick={() => wrap("*")} disabled={!editable}>
          <Bold size={14} />
        </ToolBtn>
        <ToolBtn label="Itálico" onClick={() => wrap("_")} disabled={!editable}>
          <Italic size={14} />
        </ToolBtn>
        <ToolBtn label="Riscado" onClick={() => wrap("~")} disabled={!editable}>
          <Strikethrough size={14} />
        </ToolBtn>
        <ToolBtn label="Monoespaçado" onClick={() => wrap("```")} disabled={!editable}>
          <Code size={14} />
        </ToolBtn>
        <span className="w-px h-5 bg-border mx-1" />
        <VarMenu vars={availableVars} onPick={(k) => insert(`{{${k}}}`)} disabled={!editable} />
        <ToolBtn label="Spintax" onClick={() => insert("{oi|olá|bom dia}")} disabled={!editable}>
          <Dices size={14} />
          <span className="text-xs">spintax</span>
        </ToolBtn>
      </div>
      <textarea
        ref={ref}
        value={text}
        disabled={!editable}
        onChange={(e) => onText(e.target.value)}
        rows={6}
        placeholder={"Olá {{primeiro_nome}}! {Tudo bem|Como vai}? ..."}
        className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 text-base md:text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
        style={{ fontSize: "16px" }}
      />
      <div className="flex items-center gap-2 flex-wrap">
        {editable && !recorderActive && (
          <FileUploadButton
            organizationId={organizationId}
            uploadedFiles={uploaded}
            onFilesUploaded={(files) => onAttachments(files)}
            onFilesRemoved={(fileId) => onAttachments([], fileId)}
          />
        )}
        {editable && (
          <VoiceRecorder
            organizationId={organizationId}
            onActiveChange={setRecorderActive}
            onRecorded={(file) => onAttachments([file])}
          />
        )}
        <span className="text-[11px] text-text-muted">
          Imagem, vídeo (mp4 ≤16 MB), áudio ou documento. Só o primeiro anexo vai na mensagem.
          {usedVars.length > 0 ? ` · variáveis: ${usedVars.join(", ")}` : ""}
        </span>
      </div>
    </div>
  );
}

function ToolBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1 h-9 min-w-[36px] px-2 rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function VarMenu({ vars, onPick, disabled }: { vars: string[]; onPick: (k: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <ToolBtn label="Inserir variável" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <Braces size={14} />
        <span className="text-xs">variável</span>
      </ToolBtn>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute z-20 mt-1 left-0 min-w-[200px] rounded-xl border border-border bg-surface-overlay shadow-elevated p-1 max-h-64 overflow-y-auto">
            {vars.map((k) => {
              const builtin = BUILTIN_VARS.find((b) => b.key === k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    onPick(k);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 rounded-lg text-sm text-text-primary hover:bg-surface-raised min-h-[40px]"
                >
                  <span className="font-mono text-xs text-brand-400">{`{{${k}}}`}</span>
                  {builtin && <span className="ml-2 text-xs text-text-muted">{builtin.label}</span>}
                </button>
              );
            })}
            <p className="px-3 py-1.5 text-[11px] text-text-muted">
              Fallback: <span className="font-mono">{"{{nome|cliente}}"}</span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Template Meta ──

const QUALITY_VARIANT: Record<string, "success" | "warning" | "error" | "default"> = {
  GREEN: "success",
  YELLOW: "warning",
  RED: "error",
  UNKNOWN: "default",
};

function TemplateEditor({
  channelConfigId,
  templates,
  selected,
  template,
  organizationId,
  editable,
  onSelect,
  onParamsChange,
  onButtonParamsChange,
  onHeaderFile,
  headerFileName,
  availableVars,
}: {
  channelConfigId: Id<"channelConfigs"> | null;
  templates: WhatsappTemplateItem[] | undefined;
  selected: WhatsappTemplateItem | null;
  template: CampaignTemplate | undefined;
  organizationId: Id<"organizations">;
  editable: boolean;
  onSelect: (t: WhatsappTemplateItem) => void;
  onParamsChange: (params: TemplateParam[]) => void;
  onButtonParamsChange: (params: TemplateParam[]) => void;
  onHeaderFile: (file: UploadedFile | null) => void;
  headerFileName: string | null;
  availableVars: string[];
}) {
  const sync = useAction(api.whatsappTemplates.syncMetaTemplates);
  const [syncing, setSyncing] = useState(false);
  const handleSync = async () => {
    if (!channelConfigId) return;
    setSyncing(true);
    try {
      const r = await sync({ channelConfigId });
      toast.success(`${r.approved} templates aprovados de ${r.synced} sincronizados`);
    } catch (e) {
      toast.error(mutationErrorMessage(e, "Falha ao sincronizar templates"));
    } finally {
      setSyncing(false);
    }
  };

  const headerNeedsMedia = selected?.headerFormat && ["IMAGE", "VIDEO", "DOCUMENT"].includes(selected.headerFormat);
  const dynamicButtons = selected?.buttons.filter((b) => b.dynamic) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-medium text-text-primary">
          Templates aprovados{" "}
          <span className="text-text-muted font-normal">({templates?.length ?? 0})</span>
        </p>
        <Button variant="secondary" size="sm" onClick={() => void handleSync()} disabled={syncing || !editable}>
          {syncing ? <Spinner size="sm" /> : <RefreshCw size={14} />}
          Sincronizar com a Meta
        </Button>
      </div>
      {templates === undefined ? (
        <Spinner />
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
          Nenhum template aprovado sincronizado. Crie e aprove no WhatsApp Manager da Meta e clique em "Sincronizar".
        </div>
      ) : (
        <div className="grid gap-2 max-h-72 overflow-y-auto pr-1">
          {templates.map((t) => {
            const active = selected?._id === t._id;
            return (
              <button
                key={t._id}
                type="button"
                disabled={!editable}
                onClick={() => onSelect(t)}
                className={cn(
                  "text-left rounded-lg border p-3 transition-colors",
                  active ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-sunken hover:bg-surface-overlay",
                  !editable && "opacity-60"
                )}
                aria-pressed={active}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-text-primary text-sm">{t.name}</span>
                  <Badge variant={t.category === "MARKETING" ? "brand" : "info"}>{t.category.toLowerCase()}</Badge>
                  <Badge>{t.language}</Badge>
                  {t.qualityScore && <Badge variant={QUALITY_VARIANT[t.qualityScore] ?? "default"}>qualidade {t.qualityScore.toLowerCase()}</Badge>}
                  {t.headerFormat && t.headerFormat !== "TEXT" && <Badge>{t.headerFormat.toLowerCase()}</Badge>}
                </div>
                {t.bodyText && <p className="text-xs text-text-secondary mt-1 line-clamp-2 whitespace-pre-wrap">{t.bodyText}</p>}
              </button>
            );
          })}
        </div>
      )}

      {selected && template && (
        <div className="rounded-lg border border-border bg-surface-sunken p-4 space-y-3">
          {selected.bodyParamCount > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-text-primary">Variáveis do corpo</p>
              {Array.from({ length: selected.bodyParamCount }, (_, i) => {
                const param = template.bodyParams?.[i] ?? { source: "field", value: "nome" };
                return (
                  <ParamRow
                    key={i}
                    label={`{{${i + 1}}}`}
                    param={param}
                    editable={editable}
                    availableVars={availableVars}
                    onChange={(p) => {
                      const next = [...(template.bodyParams ?? [])];
                      next[i] = p;
                      onParamsChange(next);
                    }}
                  />
                );
              })}
            </div>
          )}
          {headerNeedsMedia && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-text-primary">Mídia do cabeçalho ({selected.headerFormat?.toLowerCase()})</p>
              {template.headerFileId ? (
                <div className="flex items-center gap-2 text-sm text-text-secondary">
                  <span className="truncate">{headerFileName ?? "arquivo enviado"}</span>
                  {editable && (
                    <button type="button" onClick={() => onHeaderFile(null)} className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-surface-overlay" aria-label="Remover">
                      <X size={14} />
                    </button>
                  )}
                </div>
              ) : (
                editable && (
                  <FileUploadButton organizationId={organizationId} uploadedFiles={[]} onFilesUploaded={(files) => files[0] && onHeaderFile(files[0])} />
                )
              )}
            </div>
          )}
          {dynamicButtons.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-text-primary">Botões com URL dinâmica</p>
              {dynamicButtons.map((b, i) => (
                <ParamRow
                  key={i}
                  label={b.text}
                  param={template.buttonParams?.[i] ?? { source: "const", value: "" }}
                  editable={editable}
                  availableVars={availableVars}
                  onChange={(p) => {
                    const next = [...(template.buttonParams ?? [])];
                    next[i] = p;
                    onButtonParamsChange(next);
                  }}
                />
              ))}
            </div>
          )}
          <p className="text-[11px] text-text-muted">
            Template de marketing é cobrado por mensagem entregue; utility dentro da janela é grátis. A Meta pode segurar templates novos
            (pacing) e pausa os que caem para qualidade vermelha.
          </p>
        </div>
      )}
    </div>
  );
}

function ParamRow({
  label,
  param,
  editable,
  availableVars,
  onChange,
}: {
  label: string;
  param: TemplateParam;
  editable: boolean;
  availableVars: string[];
  onChange: (p: TemplateParam) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-mono text-xs text-brand-400 w-16 shrink-0">{label}</span>
      <select
        className="h-10 rounded-lg border border-border bg-surface-raised px-2 text-sm text-text-primary"
        value={param.source}
        disabled={!editable}
        onChange={(e) => onChange({ source: e.target.value as TemplateParam["source"], value: e.target.value === "field" ? "nome" : "" })}
      >
        <option value="field">Campo do destinatário</option>
        <option value="const">Texto fixo</option>
      </select>
      {param.source === "field" ? (
        <select
          className="h-10 flex-1 min-w-[140px] rounded-lg border border-border bg-surface-raised px-2 text-sm text-text-primary"
          value={param.value}
          disabled={!editable}
          onChange={(e) => onChange({ source: "field", value: e.target.value })}
        >
          {availableVars.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="h-10 flex-1 min-w-[140px] rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary"
          value={param.value}
          disabled={!editable}
          onChange={(e) => onChange({ source: "const", value: e.target.value })}
          placeholder="valor"
        />
      )}
    </div>
  );
}
