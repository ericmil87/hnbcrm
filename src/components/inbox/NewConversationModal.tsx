import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Phone,
  Search,
  ShieldCheck,
  Smartphone,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { mutationErrorMessage } from "@/lib/errors";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Spinner } from "@/components/ui/Spinner";
import { Avatar } from "@/components/ui/Avatar";
import { formatPhoneForDisplay, looksLikePhone } from "../../../convex/lib/phone";
import { NOT_ON_WHATSAPP_ERROR, OPT_OUT_ERROR_PREFIX } from "../../../convex/lib/startConversation";

interface NewConversationModalProps {
  organizationId: Id<"organizations">;
  open: boolean;
  onClose: () => void;
  /** Abre já com este contato escolhido (ficha do contato, `?nova=<id>`). */
  initialContactId?: Id<"contacts"> | null;
  onStarted: (conversationId: Id<"conversations">) => void;
}

/** Texto que é "um número" (só dígitos e pontuação de telefone). */
function isPhoneInput(raw: string): boolean {
  const t = raw.trim();
  return /^[\d\s()+\-.]+$/.test(t) && looksLikePhone(t);
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

type ChannelOption = {
  _id: Id<"channelConfigs">;
  provider: "meta" | "bridge";
  displayName: string;
  phoneDisplay: string | null;
  connected: boolean;
  sessionState: string | null;
};

/** Resposta de `checkWhatsappNumber` (o número existe no WhatsApp?). */
type NumberCheckResult =
  | { status: "on_whatsapp"; canonicalPhone: string; phoneDisplay: string; changed: boolean }
  | { status: "not_on_whatsapp"; phone: string }
  | { status: "unverified"; reason: "meta" | "bridge_offline" | "gateway_error"; phone: string; detail?: string };

/** Estado da checagem, sempre amarrado à chave (canal + destino) que a gerou. */
type NumberCheckState = { key: string; result: NumberCheckResult | null; loading: boolean };

/** Celular BR que o WhatsApp conhece sem o 9º dígito (55 + DDD + 8). */
function isBrWithoutNinth(phone: string): boolean {
  return /^55\d{2}[6-9]\d{7}$/.test(phone);
}

const fieldClass =
  "w-full h-11 px-3 text-base md:text-sm bg-surface-sunken border border-border-strong text-text-primary rounded-lg placeholder:text-text-muted focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20";

const sectionLabel = "block text-[13px] font-medium text-text-secondary mb-1.5";

export function NewConversationModal({
  organizationId,
  open,
  onClose,
  initialContactId,
  onStarted,
}: NewConversationModalProps) {
  const [term, setTerm] = useState("");
  const [contactId, setContactId] = useState<Id<"contacts"> | null>(initialContactId ?? null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [channelId, setChannelId] = useState<Id<"channelConfigs"> | null>(null);
  const [boardId, setBoardId] = useState<Id<"boards"> | null>(null);
  const [stageId, setStageId] = useState<Id<"stages"> | null>(null);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const [content, setContent] = useState("");
  const [optOutAck, setOptOutAck] = useState(false);
  const [forceOptOut, setForceOptOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [numberCheck, setNumberCheck] = useState<NumberCheckState | null>(null);
  const checkSeq = useRef(0);
  const startConversation = useAction(api.startConversation.startConversation);
  const checkWhatsappNumber = useAction(api.startConversation.checkWhatsappNumber);

  // Cada abertura começa do zero (ou do contato pedido).
  useEffect(() => {
    if (!open) return;
    setTerm("");
    setContactId(initialContactId ?? null);
    setFirstName("");
    setLastName("");
    setChannelId(null);
    setBoardId(null);
    setStageId(null);
    setPipelineOpen(false);
    setContent("");
    setOptOutAck(false);
    setForceOptOut(false);
    setError(null);
    setSubmitting(false);
    setNumberCheck(null);
  }, [open, initialContactId]);

  const debouncedTerm = useDebounced(term.trim(), 250);
  const phoneMode = !contactId && isPhoneInput(debouncedTerm);
  const searchMode = !contactId && !phoneMode && debouncedTerm.length >= 2;

  const channels = useQuery(
    api.startConversation.listSendableWhatsappChannels,
    open ? { organizationId } : "skip"
  ) as ChannelOption[] | undefined;

  const channel = channels?.find((c) => c._id === channelId) ?? null;
  const isMeta = channel?.provider === "meta";

  // Checagem no WhatsApp (bridge): espera a digitação parar (~500 ms) e roda de
  // novo se o canal mudar. A chave amarra o resultado ao destino que o gerou —
  // resposta atrasada de um número antigo nunca vale para o novo.
  const checkTerm = useDebounced(term.trim(), 500);
  const checkPhoneMode = !contactId && isPhoneInput(checkTerm);
  const checkKey =
    open && channel && channel.provider === "bridge" && (contactId || checkPhoneMode)
      ? `${channel._id}|${contactId ? `c:${contactId}` : `p:${checkTerm}`}`
      : null;
  const currentCheck = numberCheck && checkKey && numberCheck.key === checkKey ? numberCheck : null;
  const checkResult = currentCheck?.result ?? null;
  const canonicalPhone = checkResult?.status === "on_whatsapp" ? checkResult.canonicalPhone : null;

  // Só vale para o número digitado AGORA (a prévia usa o debounce mais curto).
  const canonicalForPreview = !contactId && checkTerm === debouncedTerm ? canonicalPhone : null;
  const preview = useQuery(
    api.startConversation.previewStartConversation,
    open && (contactId || phoneMode)
      ? contactId
        ? { organizationId, contactId }
        : canonicalForPreview
          ? { organizationId, phone: canonicalForPreview, phoneIsCanonical: true }
          : { organizationId, phone: debouncedTerm }
      : "skip"
  );
  const previewPhoneValid = !!preview?.phoneValid;

  useEffect(() => {
    if (!checkKey || !channel) return;
    if (numberCheck?.key === checkKey) return; // já checado (ou em curso) para este destino
    if (!previewPhoneValid) return; // formato inválido: a prévia já mostra o erro
    const seq = ++checkSeq.current;
    setNumberCheck({ key: checkKey, result: null, loading: true });
    checkWhatsappNumber({
      organizationId,
      channelConfigId: channel._id,
      ...(contactId ? { contactId } : { phone: checkTerm }),
    })
      .then((result) => {
        if (seq !== checkSeq.current) return;
        setNumberCheck({ key: checkKey, result: result as NumberCheckResult, loading: false });
      })
      .catch(() => {
        // Erro de formato/permissão: a prévia e o envio mostram a mensagem.
        if (seq !== checkSeq.current) return;
        setNumberCheck({ key: checkKey, result: null, loading: false });
      });
  }, [checkKey, channel, contactId, checkTerm, organizationId, previewPhoneValid, numberCheck?.key, checkWhatsappNumber]);

  const searchResults = useQuery(
    api.contacts.searchContacts,
    open && searchMode ? { organizationId, searchText: debouncedTerm, limit: 8 } : "skip"
  );

  const needsPipeline = !!preview && preview.phoneValid && !preview.lead;
  const boards = useQuery(api.boards.getBoards, open && needsPipeline ? { organizationId } : "skip");
  const effectiveBoardId = boardId ?? preview?.defaultBoard?.id ?? null;
  const stages = useQuery(
    api.boards.getStages,
    open && needsPipeline && effectiveBoardId ? { boardId: effectiveBoardId } : "skip"
  );

  // Canal: um só → escolhido; se a conversa já existe por um número desta
  // lista, ele vem pré-selecionado (trocar de número é decisão consciente).
  useEffect(() => {
    if (!channels || channelId) return;
    const existing = preview?.conversation?.channelConfigId;
    if (existing && channels.some((c) => c._id === existing)) {
      setChannelId(existing);
    } else if (channels.length === 1) {
      setChannelId(channels[0]._id);
    }
  }, [channels, channelId, preview?.conversation?.channelConfigId]);

  // O aceite vale para ESTE número — trocar o destino zera.
  useEffect(() => {
    setOptOutAck(false);
    setForceOptOut(false);
    setError(null);
  }, [contactId, debouncedTerm]);

  const optedOut = !!preview?.optedOut || forceOptOut;
  const existingConversation = preview?.conversation ?? null;

  const resolvedStage = useMemo(() => {
    if (!needsPipeline) return null;
    const list = (stages ?? []) as Array<{ _id: Id<"stages">; name: string }>;
    const chosen = stageId ? list.find((s) => s._id === stageId) : undefined;
    if (chosen) return { id: chosen._id, name: chosen.name };
    if (list[0]) return { id: list[0]._id, name: list[0].name };
    const fallback = !boardId ? preview?.defaultBoard?.stages[0] : undefined;
    return fallback ? { id: fallback.id, name: fallback.name } : null;
  }, [needsPipeline, stages, stageId, boardId, preview?.defaultBoard]);
  const boardName =
    ((boards ?? []) as Array<{ _id: string; name: string }>).find((b) => b._id === effectiveBoardId)?.name ??
    preview?.defaultBoard?.name ??
    null;

  const blockers: string[] = [];
  if (preview && !preview.phoneValid && preview.phoneError) blockers.push(preview.phoneError);
  if (preview && !preview.contact && !preview.canCreateContact) blockers.push("Você não tem permissão para criar contatos");
  if (needsPipeline && !preview?.canCreateLead) blockers.push("Você não tem permissão para criar leads");
  if (needsPipeline && preview && !preview.defaultBoard) blockers.push("Nenhum funil ativo — crie um funil antes");

  const notOnWhatsapp = checkResult?.status === "not_on_whatsapp";
  const canSubmit =
    !!preview &&
    preview.phoneValid &&
    !!channel &&
    !notOnWhatsapp &&
    blockers.length === 0 &&
    (!optedOut || optOutAck) &&
    !submitting;

  const submitLabel = existingConversation
    ? content.trim() && !isMeta
      ? "Enviar e abrir conversa"
      : "Abrir conversa"
    : content.trim() && !isMeta
      ? "Enviar e abrir"
      : "Iniciar conversa";

  const handleSubmit = async () => {
    if (!canSubmit || !preview || !channel) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await startConversation({
        organizationId,
        channelConfigId: channel._id,
        // O número digitado: a action confere no WhatsApp e grava o canônico.
        ...(contactId ? { contactId } : { phone: debouncedTerm }),
        ...(!preview.contact && firstName.trim() ? { firstName: firstName.trim() } : {}),
        ...(!preview.contact && lastName.trim() ? { lastName: lastName.trim() } : {}),
        ...(needsPipeline && effectiveBoardId ? { boardId: effectiveBoardId } : {}),
        ...(needsPipeline && resolvedStage ? { stageId: resolvedStage.id } : {}),
        ...(!isMeta && content.trim() ? { content: content.trim() } : {}),
        ...(optedOut && optOutAck ? { optOutAck: true } : {}),
      });
      toast.success(
        res.createdConversation ? "Conversa iniciada" : res.messageId ? "Mensagem enviada" : "Conversa aberta",
        res.phoneChanged ? { description: `Número do contato atualizado para ${formatPhoneForDisplay(res.canonicalPhone)}` } : undefined
      );
      onStarted(res.conversationId);
    } catch (e) {
      const msg = mutationErrorMessage(e, "Não foi possível iniciar a conversa");
      if (msg.startsWith(OPT_OUT_ERROR_PREFIX)) {
        setForceOptOut(true);
        setError(null);
      } else if (msg === NOT_ON_WHATSAPP_ERROR && checkKey) {
        // O servidor checou e o número não existe: vira a linha vermelha inline.
        setNumberCheck({ key: checkKey, result: { status: "not_on_whatsapp", phone: debouncedTerm }, loading: false });
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const pickContact = (id: Id<"contacts">) => {
    setContactId(id);
    setTerm("");
  };

  const clearContact = () => {
    setContactId(null);
    setTerm("");
    setChannelId(null);
  };

  return (
    <Modal open={open} onClose={onClose} title="Nova conversa">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        {/* 1. Para quem */}
        <div>
          <span className={sectionLabel}>Para quem</span>
          {contactId ? (
            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-surface-raised border border-border">
              <Avatar name={preview?.contact?.name || "?"} size="sm" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">
                  {preview === undefined ? "Carregando…" : preview.contact?.name || "Sem nome"}
                </p>
                <p className="text-xs text-text-muted truncate">
                  {preview?.contact?.phone ?? preview?.phoneError ?? ""}
                </p>
              </div>
              <button
                type="button"
                onClick={clearContact}
                className="shrink-0 h-11 px-3 rounded-full text-sm text-brand-500 hover:bg-brand-500/10 transition-colors"
              >
                Trocar
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
                />
                <input
                  type="text"
                  inputMode="text"
                  autoFocus
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Nome ou telefone (com DDD)"
                  className={cn(fieldClass, "pl-9 pr-9")}
                  aria-label="Nome ou telefone"
                />
                {term && (
                  <button
                    type="button"
                    onClick={() => setTerm("")}
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary"
                    aria-label="Limpar"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {searchMode && (
                <div className="mt-2 max-h-56 overflow-y-auto -mx-1 px-1">
                  {searchResults === undefined ? (
                    <div className="flex justify-center py-4">
                      <Spinner size="sm" />
                    </div>
                  ) : searchResults.length === 0 ? (
                    <p className="text-sm text-text-muted py-3 text-center">
                      Nenhum contato encontrado. Digite o telefone para um contato novo.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {(searchResults as any[]).map((c) => {
                        const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "Sem nome";
                        const raw = c.whatsappNumber ?? c.phone;
                        return (
                          <li key={c._id}>
                            <button
                              type="button"
                              onClick={() => pickContact(c._id)}
                              className="w-full min-h-11 flex items-center gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-500"
                            >
                              <Avatar name={name} size="sm" />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-text-primary truncate">{name}</p>
                                <p className="text-xs text-text-muted truncate">
                                  {raw ? formatPhoneForDisplay(raw) : "sem telefone"}
                                </p>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {phoneMode && (
                <div className="mt-2 rounded-lg border border-border bg-surface-raised p-3 space-y-2.5">
                  {preview === undefined ? (
                    <div className="flex items-center gap-2 text-sm text-text-muted">
                      <Loader2 size={14} className="animate-spin" /> Verificando número…
                    </div>
                  ) : !preview.phoneValid ? (
                    <p className="text-sm text-semantic-error">{preview.phoneError}</p>
                  ) : preview.contact ? (
                    <div className="flex items-center gap-2 text-sm">
                      <UserRound size={15} className="text-brand-400 shrink-0" />
                      <span className="text-text-secondary">
                        Já é o contato{" "}
                        <strong className="text-text-primary">{preview.contact.name || "Sem nome"}</strong>{" "}
                        <span className="text-text-muted">({preview.phoneDisplay})</span>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        <Phone size={15} className="text-brand-400 shrink-0" />
                        <span className="text-text-secondary">
                          Novo contato: <strong className="text-text-primary">{preview.phoneDisplay}</strong>
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={firstName}
                          onChange={(e) => setFirstName(e.target.value)}
                          placeholder="Nome (opcional)"
                          className={fieldClass}
                          aria-label="Nome do contato"
                          autoComplete="off"
                        />
                        <input
                          type="text"
                          value={lastName}
                          onChange={(e) => setLastName(e.target.value)}
                          placeholder="Sobrenome"
                          className={fieldClass}
                          aria-label="Sobrenome do contato"
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {checkKey && previewPhoneValid && (
            <NumberCheckLine
              loading={!!currentCheck?.loading || (!currentCheck && checkKey !== null)}
              result={checkResult}
              forContact={!!contactId}
            />
          )}
          {isMeta && previewPhoneValid && (
            <p className="mt-1.5 text-xs text-text-muted">Número oficial: não dá para verificar antes de enviar.</p>
          )}
        </div>

        {/* 2. Canal */}
        <div>
          <span className={sectionLabel}>Enviar pelo número</span>
          {channels === undefined ? (
            <Spinner size="sm" />
          ) : channels.length === 0 ? (
            <p className="text-sm text-text-muted">Nenhum número de WhatsApp ativo nesta organização.</p>
          ) : (
            <div role="radiogroup" aria-label="Número de WhatsApp" className="flex flex-col gap-1.5">
              {channels.map((c) => {
                const selected = c._id === channelId;
                return (
                  <button
                    key={c._id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setChannelId(c._id)}
                    className={cn(
                      "w-full min-h-11 flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors",
                      selected
                        ? "border-brand-500 bg-brand-500/10"
                        : "border-border bg-surface-raised hover:border-border-strong"
                    )}
                  >
                    <span
                      className={cn(
                        "h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center",
                        selected ? "border-brand-500" : "border-border-strong"
                      )}
                      aria-hidden="true"
                    >
                      {selected && <span className="h-2 w-2 rounded-full bg-brand-500" />}
                    </span>
                    {c.provider === "meta" ? (
                      <ShieldCheck size={16} className="shrink-0 text-semantic-info" />
                    ) : (
                      <Smartphone size={16} className="shrink-0 text-text-muted" />
                    )}
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-text-primary truncate">{c.displayName}</span>
                      <span className="block text-xs text-text-muted truncate">
                        {c.phoneDisplay ?? ""}
                        {c.phoneDisplay ? " · " : ""}
                        {c.provider === "meta" ? "API oficial" : "WhatsApp Web"}
                      </span>
                    </span>
                    {!c.connected && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-semantic-warning/10 px-2 py-0.5 text-[11px] font-medium text-semantic-warning">
                        <AlertTriangle size={11} /> Desconectado
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {channel && !channel.connected && (
            <p className="mt-1.5 text-xs text-semantic-warning">
              Este número está desconectado: a conversa abre, mas a mensagem só sai quando ele reconectar.
            </p>
          )}
          {channel && existingConversation?.channelConfigId && existingConversation.channelConfigId !== channel._id && (
            <p className="mt-1.5 text-xs text-text-muted">
              A conversa existente passará a sair por este número.
            </p>
          )}
        </div>

        {/* 3. Lead */}
        {preview && preview.phoneValid && (
          <div className="text-sm">
            {existingConversation ? (
              <p className="flex items-start gap-2 rounded-lg bg-brand-500/10 border border-brand-500/20 px-3 py-2 text-text-secondary">
                <MessageSquarePlus size={15} className="mt-0.5 shrink-0 text-brand-400" />
                <span>
                  Já existe conversa com este número
                  {existingConversation.archived ? " (arquivada — será reaberta)" : ""}.
                  {preview.lead && (
                    <>
                      {" "}Lead «{preview.lead.title}»
                      {preview.lead.boardName ? ` (${preview.lead.boardName} › ${preview.lead.stageName ?? "—"})` : ""}.
                    </>
                  )}
                </span>
              </p>
            ) : preview.lead ? (
              <p className="text-text-secondary">
                Vai para o lead <strong className="text-text-primary">«{preview.lead.title}»</strong>
                {preview.lead.boardName && (
                  <span className="text-text-muted">
                    {" "}({preview.lead.boardName} › {preview.lead.stageName ?? "—"})
                  </span>
                )}
                {preview.lead.archived && <span className="text-semantic-warning"> · lead arquivado</span>}
              </p>
            ) : preview.defaultBoard ? (
              <div className="rounded-lg border border-border">
                <button
                  type="button"
                  onClick={() => setPipelineOpen((o) => !o)}
                  aria-expanded={pipelineOpen}
                  className="w-full min-h-11 flex items-center gap-2 px-3 py-2 text-left"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-text-secondary">
                      Funil e estágio:{" "}
                      <strong className="text-text-primary">
                        {boardName ?? "—"} › {resolvedStage?.name ?? "—"}
                      </strong>
                    </span>
                    <span className="block text-xs text-text-muted">
                      Um lead novo será criado e atribuído a você
                    </span>
                  </span>
                  <ChevronDown
                    size={16}
                    className={cn("shrink-0 text-text-muted transition-transform", pipelineOpen && "rotate-180")}
                  />
                </button>
                {pipelineOpen && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 px-3 pb-3">
                    <select
                      value={effectiveBoardId ?? ""}
                      onChange={(e) => {
                        setBoardId(e.target.value as Id<"boards">);
                        setStageId(null);
                      }}
                      className={fieldClass}
                      aria-label="Funil"
                    >
                      {((boards ?? []) as Array<{ _id: Id<"boards">; name: string }>).map((b) => (
                        <option key={b._id} value={b._id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={resolvedStage?.id ?? ""}
                      onChange={(e) => setStageId(e.target.value as Id<"stages">)}
                      className={fieldClass}
                      aria-label="Estágio"
                      disabled={stages === undefined}
                    >
                      {((stages ?? []) as Array<{ _id: Id<"stages">; name: string }>).map((s) => (
                        <option key={s._id} value={s._id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* 4. Mensagem */}
        {channel && preview?.phoneValid && (
          isMeta ? (
            <p className="text-xs text-text-muted rounded-lg bg-surface-raised border border-border px-3 py-2">
              Canal oficial: a conversa será aberta, mas a primeira mensagem precisa ser um template — envie pelo
              campo de mensagem da conversa.
            </p>
          ) : (
            <div>
              <label htmlFor="new-conv-message" className={sectionLabel}>
                Primeira mensagem (opcional)
              </label>
              <textarea
                id="new-conv-message"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                maxLength={4096}
                placeholder="Olá! Aqui é da equipe…"
                className={cn(fieldClass, "h-auto py-2.5 resize-none")}
              />
            </div>
          )
        )}

        {/* 5. Opt-out */}
        {optedOut && preview?.phoneValid && (
          <div className="rounded-lg border border-semantic-warning/30 bg-semantic-warning/10 p-3 space-y-2">
            <p className="flex items-start gap-2 text-sm text-semantic-warning">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              Este número pediu para não receber mensagens (opt-out). Enviar mesmo assim é responsabilidade da equipe.
            </p>
            <Checkbox
              id="new-conv-optout-ack"
              checked={optOutAck}
              onChange={(e) => setOptOutAck(e.target.checked)}
              label="Entendo e quero continuar"
            />
          </div>
        )}

        {blockers.length > 0 && (
          <ul className="text-sm text-semantic-error space-y-0.5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-semantic-error">{error}</p>}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} className="h-11 sm:h-10">
            Cancelar
          </Button>
          <Button type="submit" disabled={!canSubmit} className="h-11 sm:h-10">
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <MessageSquarePlus size={16} />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Linha de status da checagem do número no WhatsApp (bridge). */
function NumberCheckLine({
  loading,
  result,
  forContact,
}: {
  loading: boolean;
  result: NumberCheckResult | null;
  forContact: boolean;
}) {
  if (loading) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-text-muted" role="status">
        <Loader2 size={12} className="animate-spin" /> Verificando no WhatsApp…
      </p>
    );
  }
  if (!result) return null;
  if (result.status === "on_whatsapp") {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-semantic-success" role="status">
        <CheckCircle2 size={13} className="mt-px shrink-0" />
        <span>
          Tem WhatsApp
          {result.changed && (
            <>
              {forContact ? " — número atualizado para " : " — registrado como "}
              <strong className="font-semibold">{result.phoneDisplay}</strong>
              {isBrWithoutNinth(result.canonicalPhone) ? " (sem o 9)" : ""}
            </>
          )}
        </span>
      </p>
    );
  }
  if (result.status === "not_on_whatsapp") {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-semantic-error" role="alert">
        <X size={13} className="mt-px shrink-0" />
        {NOT_ON_WHATSAPP_ERROR}
      </p>
    );
  }
  if (result.reason === "meta") {
    return <p className="mt-1.5 text-xs text-text-muted">Número oficial: não dá para verificar antes de enviar.</p>;
  }
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-semantic-warning" role="status">
      <AlertTriangle size={13} className="mt-px shrink-0" />
      Não foi possível verificar agora — a conversa será criada sem confirmação
    </p>
  );
}
