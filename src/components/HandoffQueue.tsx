import { usePageTitle } from "@/hooks/usePageTitle";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { CheckCircle2 } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { TAB_ROUTES } from "@/lib/routes";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage as errorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { PageHeader } from "@/components/ui/PageHeader";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { EmptyState } from "@/components/ui/EmptyState";
import { VOCAB } from "@/lib/vocab";
import { useOpenEntityParam } from "@/hooks/useOpenEntityParam";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import { HandoffPeekSlideOver, type PeekHandoff } from "@/components/handoffs/HandoffPeekSlideOver";
import { AttentionRow, type AttentionItem } from "@/components/handoffs/AttentionRow";
import { AttentionListItem } from "@/components/handoffs/AttentionListItem";
import { useCloseGoneHandoff } from "@/components/handoffs/useCloseGoneHandoff";
import { AssumeFromPushDialog } from "@/components/handoffs/AssumeFromPushDialog";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { attentionSummaryLine, pendingCountLabel } from "@/lib/attentionList";
import {
  parseAttentionDensity,
  readAttentionDensity,
  writeAttentionDensity,
  type AttentionDensity,
} from "@/lib/attentionPrefs";
import { AiInstructionPopover } from "@/components/inbox/AiDraftCard";

export function HandoffQueue() {
  usePageTitle(VOCAB.attention.title);
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can } = usePermissions(organizationId);
  // Celular: lista de duas linhas estilo Conversas, sem densidade nem dica;
  // o título já está no cabeçalho do AppShell.
  const isMobile = useMediaQuery("(max-width: 767px)");
  // O repasse aberto vive na URL (`?handoff=`, destino do sino de notificações):
  // abrir é push com a entrada marcada como nossa, então o gesto de voltar do
  // iPhone fecha a espiada em vez de sair da página; fechar pelo app volta a
  // essa entrada (ou faz replace num deep link).
  const handoffParam = useOpenEntityParam("handoff", { alsoClear: ["acao"] });
  const peekHandoffId = handoffParam.id;
  const { open: openPeek, close: closePeek } = handoffParam;
  const location = useLocation();
  const acaoParam = new URLSearchParams(location.search).get("acao");

  // getHandoffs agora exige inbox:view_own no servidor — sem o skip, um membro
  // sem permissão que cole a URL derrubaria a página no ErrorBoundary genérico
  // em vez de ver a tela de acesso negado abaixo.
  const canView = can("inbox", "view_own");
  const handoffs = useQuery(
    api.handoffs.getHandoffs,
    canView ? { organizationId, status: "pending" } : "skip"
  );

  const acceptHandoff = useMutation(api.handoffs.acceptHandoff);
  const rejectHandoff = useMutation(api.handoffs.rejectHandoff);

  const [peekBusy, setPeekBusy] = useState(false);

  // Popover "Devolver à IA" aberto em qual card (um por vez).
  const [returnPopoverFor, setReturnPopoverFor] = useState<string | null>(null);

  // Preferência pessoal de densidade (localStorage) e detalhes abertos (locais).
  const [density, setDensity] = useState<AttentionDensity>(readAttentionDensity);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const changeDensity = (v: string) => {
    const next = parseAttentionDensity(v);
    setDensity(next);
    writeAttentionDensity(next);
  };
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // A espiada é derivada da URL (sumiu o param = fechou). Um id que não está
  // na fila (resolvido por outra pessoa, inválido ou de outra org) fecha sozinho.
  useCloseGoneHandoff({ handoffId: peekHandoffId, handoffs, acao: acaoParam, close: closePeek });

  if (!can("inbox", "view_own")) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <p className="text-text-secondary text-sm">Você não tem permissão para ver o que requer atenção.</p>
      </div>
    );
  }

  const handleAccept = async (handoffId: string) => {
    try {
      // Tipagem defensiva: o retorno com conversationId é novo no backend.
      const result = (await acceptHandoff({
        handoffId: handoffId as Id<"handoffs">,
      })) as { conversationId?: string | null } | null;

      if (result?.conversationId) {
        toast.success("Conversa assumida — abrindo");
        navigate(`${TAB_ROUTES.inbox}?conversation=${result.conversationId}`);
      } else {
        toast.success("Conversa assumida");
      }
    } catch (error) {
      toast.error(errorMessage(error, "Não foi possível assumir a conversa. Tente de novo."));
    }
  };

  const handleReject = async (
    handoffId: string,
    instruction?: string,
    isGroup?: boolean
  ): Promise<boolean> => {
    try {
      await rejectHandoff({
        handoffId: handoffId as Id<"handoffs">,
        ...(instruction ? { instruction } : {}),
      });
      // Num GRUPO a IA não responde na hora: o gatilho dela é a menção. A
      // instrução vira nota da equipe e entra no próximo turno da sala. Dizer
      // "ela vai responder o cliente" ali seria mentira (review de correção
      // nº 14).
      toast.success(
        instruction
          ? isGroup
            ? "Devolvido à IA. Sua orientação vale a partir da próxima menção na sala"
            : "Devolvido à IA. Ela vai responder o cliente com a sua orientação"
          : "Devolvido à IA. Ela volta a atender"
      );
      return true;
    } catch (error) {
      toast.error(errorMessage(error, "Não foi possível devolver à IA. Tente de novo."));
      return false;
    }
  };

  const handlePeekAccept = async (handoffId: string) => {
    setPeekBusy(true);
    try {
      await handleAccept(handoffId);
    } finally {
      setPeekBusy(false);
    }
  };

  const handlePeekReject = async (handoffId: string, instruction?: string) => {
    setPeekBusy(true);
    try {
      const isGroup = handoffs?.find((h) => h._id === handoffId)?.isGroup === true;
      if (await handleReject(handoffId, instruction, isGroup)) closePeek();
    } finally {
      setPeekBusy(false);
    }
  };

  if (!handoffs) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

  const peekHandoff = peekHandoffId
    ? (handoffs.find((h: PeekHandoff) => h._id === peekHandoffId) as PeekHandoff | undefined)
    : undefined;

  const peek = peekHandoff ? (
    <HandoffPeekSlideOver
      organizationId={organizationId}
      handoff={peekHandoff}
      onClose={closePeek}
      onAccept={handlePeekAccept}
      onReject={handlePeekReject}
      busy={peekBusy}
    />
  ) : null;

  // A espiada fica fora dos dois layouts (mesma posição na árvore): cruzar os
  // 768 px com ela aberta não a remonta (rascunho de instrução e rolagem ficam).
  return (
    <>
      <AssumeFromPushDialog handoffId={peekHandoffId} handoffs={handoffs} onAccept={handleAccept} />
      {isMobile ? (
        <div className="min-w-0 pb-safe">
          {/* O AppShell mostra "Requer atenção" num <p>: o <h1> fica para leitores de tela. */}
          <h1 className="sr-only">{VOCAB.attention.title}</h1>
          {handoffs.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={VOCAB.attention.emptyTitle}
              description={VOCAB.attention.emptyHint}
            />
          ) : (
            <>
              <p className="-mt-1 pb-2 text-caption text-text-muted tabular-nums">
                {attentionSummaryLine(handoffs, now)}
              </p>
              <ul
                aria-label={VOCAB.attention.title}
                className="-mx-4 divide-y divide-border-subtle border-y border-border-subtle"
              >
                {handoffs.map((handoff) => (
                  <AttentionListItem
                    key={handoff._id}
                    handoff={handoff as AttentionItem}
                    now={now}
                    selected={peekHandoffId === handoff._id}
                    onOpen={() => openPeek(handoff._id)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="min-w-0 space-y-4 pb-safe md:space-y-6">
          <SpotlightTooltip spotlightId="handoffs" organizationId={organizationId} />

          <PageHeader
            title={VOCAB.attention.title}
            subtitle={VOCAB.attention.subtitle}
            badge={
              // Um único texto: o Badge é inline-flex e engolia o espaço entre os nós.
              <Badge variant="warning" className="tabular-nums">
                {pendingCountLabel(handoffs.length)}
              </Badge>
            }
            actions={
              <SegmentedControl
                ariaLabel="Densidade da lista"
                size="sm"
                value={density}
                onValueChange={changeDensity}
                options={[
                  { value: "compact", label: "Compacto" },
                  { value: "comfortable", label: "Completo" },
                ]}
              />
            }
          />

          {handoffs.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={VOCAB.attention.emptyTitle}
              description={VOCAB.attention.emptyHint}
            />
          ) : (
            <div className={density === "compact" ? "grid min-w-0 gap-2" : "grid min-w-0 gap-6"}>
              {handoffs.map((handoff) => (
                <AttentionRow
                  key={handoff._id}
                  handoff={handoff as AttentionItem}
                  density={density}
                  now={now}
                  expanded={expandedIds.has(handoff._id)}
                  onToggleExpanded={() => toggleExpanded(handoff._id)}
                  onView={() => openPeek(handoff._id)}
                  onAccept={() => handleAccept(handoff._id)}
                  onToggleGiveBack={() =>
                    setReturnPopoverFor((v) => (v === handoff._id ? null : handoff._id))
                  }
                  giveBackOpen={returnPopoverFor === handoff._id}
                  renderGiveBackPopover={(anchor) => (
                    <AiInstructionPopover
                      open={returnPopoverFor === handoff._id}
                      anchor={anchor}
                      title={
                        handoff.isGroup
                          ? `${VOCAB.attention.giveBack}: o que ela precisa saber (opcional)`
                          : `${VOCAB.attention.giveBack}: responda o que ela precisa (opcional)`
                      }
                      placeholder={
                        handoff.isGroup
                          ? 'Ex.: "o preço do plano é R$ 150" — vale a partir da próxima menção na sala. Vazio = só devolver.'
                          : 'Ex.: "o Pix é financeiro@empresa.com e o valor é R$ 150 — pode passar ao cliente". Vazio = só devolver.'
                      }
                      submitLabel="Devolver"
                      onSubmit={(instruction) => {
                        setReturnPopoverFor(null);
                        void handleReject(handoff._id, instruction, handoff.isGroup);
                      }}
                      onClose={() => setReturnPopoverFor(null)}
                    />
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {peek}
    </>
  );
}
