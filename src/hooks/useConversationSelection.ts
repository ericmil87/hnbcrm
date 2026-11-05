import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Id } from "../../convex/_generated/dataModel";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import {
  decideConversationParamAction,
  linkedMatchesView,
  type ConversationKindFilter,
} from "@/lib/inboxState";
import { stringParam } from "@/lib/searchParamState";

type ConversationDoc = Record<string, any>;

interface UseConversationSelectionArgs {
  /** Conversas já carregadas na lista (sem nulos). */
  validConversations: readonly ConversationDoc[];
  /** O primeiro lote da lista já chegou. */
  listLoaded: boolean;
  showArchived: boolean;
  setShowArchived: (archived: boolean) => void;
  kindFilter: ConversationKindFilter;
  /** Toda troca de conversa (clique, link, voltar): limpa compositor, digitação, leitura. */
  onSelectionChange: () => void;
  /** Rascunho vindo de outra tela em `location.state` (só preenche o compositor). */
  onDraft: (draft: string) => void;
}

/** Id de contato no `?nova=<contactId>`; `?nova=1` abre o modal vazio. */
const CONTACT_ID_PATTERN = /^[a-z0-9]{25,40}$/;

/**
 * A conversa aberta, a URL (`?conversation=`) e o fluxo "Nova conversa"
 * (`?nova=`). A URL é a fonte da verdade (deep-link de outras telas, voltar do
 * navegador); o estado local existe porque a abertura passa pelo
 * resolver quando o id está fora da lista carregada.
 *
 * Abrir uma conversa é `push` (o "voltar" fecha/reabre); fechar e limpar um
 * id inválido são `replace`. A sequência de efeitos é a mesma de sempre:
 * guarda de escrita em voo → máquina `decideConversationParamAction`.
 */
export function useConversationSelection({
  validConversations,
  listLoaded,
  showArchived,
  setShowArchived,
  kindFilter,
  onSelectionChange,
  onDraft,
}: UseConversationSelectionArgs) {
  const navigate = useNavigate();
  const location = useLocation();
  const conversationParam = useSearchParamState("conversation", stringParam, { history: "push" });
  const novaParam = useSearchParamState("nova", stringParam);
  const param = conversationParam.value;

  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(false);
  // Conversa alcançada por deep-link que não está na lista carregada — o
  // resolver mantém este estado em dia (o documento continua reativo).
  const [linkedConversation, setLinkedConversation] = useState<ConversationDoc | null>(null);

  // Callbacks lidos "na hora" pelos efeitos (sem entrar nas dependências).
  const latest = useRef({ onSelectionChange, onDraft, setShowArchived });
  latest.current = { onSelectionChange, onDraft, setShowArchived };

  const conversationInList = param !== null && validConversations.some((c) => c._id === param);

  // A conversa do deep-link entra no topo da lista enquanto estiver aberta e
  // fora da lista carregada (fora do lote carregado, ou arquivada ainda
  // carregando), mas só se ela PERTENCE à aba/filtro em tela.
  const pinnedConversation =
    linkedConversation &&
    linkedMatchesView(linkedConversation, showArchived, kindFilter) &&
    linkedConversation._id === selectedConversation &&
    !validConversations.some((c) => c._id === linkedConversation._id)
      ? linkedConversation
      : null;
  const currentConversation: ConversationDoc | undefined =
    validConversations.find((c) => c._id === selectedConversation) ??
    (linkedConversation?._id === selectedConversation ? linkedConversation : undefined);

  const applySelection = useCallback((conversationId: string) => {
    setSelectedConversation(conversationId);
    setShowMessages(true);
    latest.current.onSelectionChange();
  }, []);

  // A entrada de histórico criada por um push NOSSO leva este marcador no
  // `location.state`: fechar a conversa (ou o modal) então volta
  // (`navigate(-1)`) em vez de deixar uma entrada morta por abertura.
  const ownsEntry = (location.state as { inboxPushed?: boolean } | null)?.inboxPushed === true;
  const OWN_ENTRY = { inboxPushed: true };

  // Estado VIVO da URL, lido na hora da chamada: `close` costuma rodar depois
  // de um `await` (arquivar, sair do grupo, excluir lead), com a closure de um
  // render velho; se a pessoa já voltou pelo navegador, um `navigate(-1)` com
  // dados velhos sairia da tela.
  const liveRef = useRef({ ownsEntry, conversation: conversationParam.raw, nova: novaParam.raw, key: location.key });
  // `navigate(-1)` já pedido a partir desta entrada: um segundo fechar não pode voltar 2.
  const backPendingKey = useRef<string | null>(null);
  // Voltar/avançar reaproveita a `key` da entrada: ao mudar de entrada a marca expira.
  if (backPendingKey.current !== null && backPendingKey.current !== location.key) backPendingKey.current = null;
  liveRef.current = { ownsEntry, conversation: conversationParam.raw, nova: novaParam.raw, key: location.key };

  /** Volta uma entrada, uma única vez por entrada de origem. */
  const goBackOnce = (param: { expectWrite: (target: string | null) => void }) => {
    const live = liveRef.current;
    if (backPendingKey.current === live.key) return;
    backPendingKey.current = live.key;
    param.expectWrite(null);
    navigate(-1);
  };

  /**
   * Clique do usuário: abre e escreve `?conversation=`, limpando `?nova=` na
   * mesma escrita. Push só quando a tela estava sem conversa e sem modal
   * "Nova conversa"; trocar de conversa (ou abrir a partir do modal, que já é
   * uma entrada nossa) substitui a entrada preservando a marca, para o
   * "voltar" cair na lista. Reabrir a que já está aberta não cria entrada.
   */
  const select = useCallback(
    (conversationId: string, extra?: Readonly<Record<string, string | null>>) => {
      applySelection(conversationId);
      if (conversationParam.raw === conversationId && !extra) return;
      const push = conversationParam.raw === null && novaParam.raw === null;
      conversationParam.set(conversationId, {
        also: { nova: null, ...extra },
        history: push ? "push" : "replace",
        ...(push || ownsEntry ? { state: OWN_ENTRY } : {}),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applySelection, conversationParam, novaParam.raw, ownsEntry]
  );

  /**
   * Fecha a conversa (botão Voltar, arquivar, lead excluído, sair da sala).
   * Entrada criada por nós: `navigate(-1)`; senão (deep link, recarga): `replace`.
   */
  const close = useCallback(() => {
    latest.current.onSelectionChange();
    setShowMessages(false);
    setSelectedConversation(null);
    const live = liveRef.current;
    if (live.ownsEntry && live.conversation !== null) {
      goBackOnce(conversationParam);
    } else if (live.conversation !== null) {
      conversationParam.set(null, { history: "replace" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationParam, navigate]);

  // URL → estado. Quando o id está na lista carregada, abre direto. Fora dela
  // (arquivada ou além do lote carregado), o resolver busca o documento avulso:
  // arquivada troca a aba da lista, ativa entra fixada no topo e um id
  // inexistente sai da URL em silêncio.
  const { isInFlight } = conversationParam;
  useEffect(() => {
    // Antes de qualquer coisa: o param em mãos pode ser o eco velho de uma
    // escrita nossa que o router ainda não aplicou (escrita em voo).
    if (isInFlight()) return;
    const action = decideConversationParamAction({
      param,
      selected: selectedConversation,
      listLoaded,
      inList: conversationInList,
      linked: linkedConversation as { _id: string; archivedAt?: number | null } | null,
      showArchived,
    });
    if (action.type === "close") {
      // "Voltar" do navegador para uma URL sem conversa.
      latest.current.onSelectionChange();
      setShowMessages(false);
      setSelectedConversation(null);
    } else if (action.type === "select") {
      // A aba da lista acompanha a conversa que chegou por link — só nesta
      // abertura, para não arrastar o filtro do usuário depois.
      if (action.archivedTab !== undefined) latest.current.setShowArchived(action.archivedTab);
      applySelection(action.id);
    }
  }, [
    param,
    selectedConversation,
    listLoaded,
    conversationInList,
    linkedConversation,
    showArchived,
    isInFlight,
    applySelection,
  ]);

  // O resolver responde para o id que está na URL agora; um `null` significa
  // conversa inexistente (ou apagada) — o param sai da URL.
  const clearParam = conversationParam.set;
  const handleResolveLinkedConversation = useCallback(
    (conversation: ConversationDoc | null) => {
      if (!conversation) {
        setLinkedConversation(null);
        clearParam(null, { history: "replace" });
        return;
      }
      setLinkedConversation(conversation);
    },
    [clearParam]
  );

  // Rascunho vindo de outra tela (F4: "Criar lead + abrir no privado" do sino).
  // Chega em `location.state` e NÃO é enviado por ninguém automaticamente — só
  // preenche o compositor. Consumido uma vez: o state é limpo em seguida, para
  // o rascunho não voltar sozinho a cada re-render ou ao usar o back.
  const consumedDraftRef = useRef<string | null>(null);
  useEffect(() => {
    const draft = (location.state as { draftMessage?: string } | null)?.draftMessage;
    if (!draft || consumedDraftRef.current === draft) return;
    consumedDraftRef.current = draft;
    latest.current.onDraft(draft);
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);

  // "Nova conversa": `?nova=1` abre o modal vazio, `?nova=<contactId>` já com
  // o contato. A URL é a fonte da verdade (fechar o modal limpa o param).
  const novaRaw = novaParam.raw;
  const novaContactId =
    novaRaw && novaRaw !== "1" && CONTACT_ID_PATTERN.test(novaRaw) ? (novaRaw as Id<"contacts">) : null;
  // Abrir o modal a partir da lista é um push marcado (voltar/fechar caem na
  // lista); com conversa aberta ou modal já aberto, só substitui. `?nova=` vindo
  // de outra tela não é nosso: fechar substitui.
  const openNewConversation = () => {
    const push = conversationParam.raw === null && novaParam.raw === null;
    novaParam.set("1", push ? { history: "push", state: OWN_ENTRY } : ownsEntry ? { state: OWN_ENTRY } : {});
  };
  const closeNewConversation = () => {
    const live = liveRef.current;
    if (live.ownsEntry && live.nova !== null && live.conversation === null) goBackOnce(novaParam);
    else if (live.nova !== null) novaParam.set(null);
  };

  return {
    selectedConversation,
    showMessages,
    setShowMessages,
    select,
    close,
    currentConversation,
    pinnedConversation,
    conversationInList,
    /** Id do `?conversation=` fora da lista: o resolver deve montar para ele. */
    deepLinkId: param !== null && !conversationInList ? param : null,
    handleResolveLinkedConversation,
    novaOpen: novaRaw !== null,
    novaContactId,
    openNewConversation,
    closeNewConversation,
  };
}
