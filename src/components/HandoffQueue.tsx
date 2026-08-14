import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext, useSearchParams } from "react-router";
import { useQuery, useMutation } from "convex/react";
import { Eye } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { TAB_ROUTES } from "@/lib/routes";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage as errorMessage } from "@/lib/errors";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";
import { HandoffPeekSlideOver, type PeekHandoff } from "@/components/handoffs/HandoffPeekSlideOver";

export function HandoffQueue() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const navigate = useNavigate();
  const { can } = usePermissions(organizationId);
  const [searchParams, setSearchParams] = useSearchParams();
  const handoffParam = searchParams.get("handoff");

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

  // Espiar a conversa antes de decidir — o repasse aberto vive na URL
  // (`?handoff=`), que é o destino do sino de notificações.
  const [peekHandoffId, setPeekHandoffId] = useState<string | null>(null);
  const [peekBusy, setPeekBusy] = useState(false);

  // Escrita nossa no `?handoff=` ainda em voo: o router aplica o
  // `setSearchParams` de forma assíncrona, então existe pelo menos um render em
  // que o peek já mudou e o param ainda é o valor antigo. `target` é o que
  // pedimos e `stale` o que estava na URL na hora — enquanto a URL mostrar
  // `stale`, o efeito URL → estado fica quieto (senão fechar o peek o reabria).
  const handoffParamSyncRef = useRef<{ target: string | null; stale: string | null } | null>(null);

  const syncHandoffParam = useCallback(
    (handoffId: string | null) => {
      handoffParamSyncRef.current = { target: handoffId, stale: handoffParam };
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (handoffId) next.set("handoff", handoffId);
          else next.delete("handoff");
          return next;
        },
        { replace: true }
      );
    },
    [handoffParam, setSearchParams]
  );

  // URL → estado. Um id que não está na fila (repasse já resolvido, inválido ou
  // de outra org) sai da URL em silêncio.
  useEffect(() => {
    const pendingWrite = handoffParamSyncRef.current;
    if (pendingWrite) {
      if (handoffParam === pendingWrite.target) {
        handoffParamSyncRef.current = null; // a URL alcançou o que pedimos
      } else if (handoffParam === pendingWrite.stale) {
        return; // ainda em voo — o param é o valor antigo, ignorar
      } else {
        handoffParamSyncRef.current = null; // mudou por fora no meio do caminho
      }
    }

    if (!handoffParam || handoffParam === peekHandoffId) return;
    if (handoffs === undefined) return;
    if (handoffs.some((h: { _id: string }) => h._id === handoffParam)) {
      setPeekHandoffId(handoffParam);
    } else {
      syncHandoffParam(null);
    }
  }, [handoffParam, handoffs, peekHandoffId, syncHandoffParam]);

  // O repasse aberto pode ser resolvido por outra pessoa enquanto está na tela.
  useEffect(() => {
    if (!peekHandoffId || handoffs === undefined) return;
    if (!handoffs.some((h: { _id: string }) => h._id === peekHandoffId)) {
      setPeekHandoffId(null);
      syncHandoffParam(null);
    }
  }, [handoffs, peekHandoffId, syncHandoffParam]);

  const openPeek = (handoffId: string) => {
    setPeekHandoffId(handoffId);
    syncHandoffParam(handoffId);
  };

  const closePeek = useCallback(() => {
    setPeekHandoffId(null);
    syncHandoffParam(null);
  }, [syncHandoffParam]);

  if (!can("inbox", "view_own")) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20">
        <p className="text-text-secondary text-sm">Voce nao tem permissao para acessar os repasses.</p>
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
        toast.success("Repasse aceito — abrindo a conversa");
        navigate(`${TAB_ROUTES.inbox}?conversation=${result.conversationId}`);
      } else {
        toast.success("Repasse aceito com sucesso");
      }
    } catch (error) {
      toast.error(errorMessage(error, "Falha ao aceitar repasse"));
    }
  };

  const handleReject = async (handoffId: string): Promise<boolean> => {
    try {
      await rejectHandoff({
        handoffId: handoffId as Id<"handoffs">,
      });
      toast.success("Repasse rejeitado — a IA volta a atender");
      return true;
    } catch (error) {
      toast.error(errorMessage(error, "Falha ao rejeitar repasse"));
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

  const handlePeekReject = async (handoffId: string) => {
    setPeekBusy(true);
    try {
      if (await handleReject(handoffId)) closePeek();
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

  return (
    <div className="space-y-6">
      <SpotlightTooltip spotlightId="handoffs" organizationId={organizationId} />

      <div className="flex items-center justify-between">
        <h2 className="text-xl md:text-2xl font-bold text-text-primary">Fila de Repasses</h2>
        <Badge variant="warning">
          <span className="tabular-nums">{handoffs.length}</span> {handoffs.length === 1 ? "pendente" : "pendentes"}
        </Badge>
      </div>

      {handoffs.length === 0 ? (
        <div className="text-center py-12">
          <h3 className="text-lg font-medium text-text-primary mb-2">Nenhum repasse pendente</h3>
          <p className="text-text-secondary">Todos os repasses foram processados.</p>
        </div>
      ) : (
        <div className="grid gap-6">
          {handoffs.map((handoff) => (
            <Card key={handoff._id}>
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
                <div className="flex-1 min-w-0">
                  <h3 className="text-base md:text-lg font-semibold text-text-primary mb-1 truncate">
                    {handoff.lead?.title}
                  </h3>
                  <p className="text-sm text-text-secondary truncate">
                    {handoff.contact?.firstName} {handoff.contact?.lastName}
                    {handoff.contact?.company && ` • ${handoff.contact?.company}`}
                  </p>
                </div>
                <Badge variant="warning" className="shrink-0 self-start sm:self-auto">
                  Pendente
                </Badge>
              </div>

              <div className="grid sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <h4 className="text-sm font-medium text-text-primary mb-2">De</h4>
                  <div className="flex items-center gap-2">
                    <Avatar
                      name={handoff.fromMember?.name || "?"}
                      type={handoff.fromMember?.type === "ai" ? "ai" : "human"}
                      size="md"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-text-primary truncate">
                        {handoff.fromMember?.name}
                      </p>
                      <p className="text-xs text-text-secondary truncate">
                        {handoff.fromMember?.role}
                      </p>
                    </div>
                  </div>
                </div>

                {handoff.toMember && (
                  <div>
                    <h4 className="text-sm font-medium text-text-primary mb-2">Para</h4>
                    <div className="flex items-center gap-2">
                      <Avatar
                        name={handoff.toMember.name || "?"}
                        type={handoff.toMember.type === "ai" ? "ai" : "human"}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-text-primary truncate">
                          {handoff.toMember.name}
                        </p>
                        <p className="text-xs text-text-secondary truncate">
                          {handoff.toMember.role}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="mb-4">
                <h4 className="text-sm font-medium text-text-primary mb-2">Motivo</h4>
                <p className="text-sm text-text-secondary">{handoff.reason}</p>
              </div>

              {handoff.summary && (
                <div className="mb-4">
                  <h4 className="text-sm font-medium text-text-primary mb-2">Resumo</h4>
                  <p className="text-sm text-text-secondary">{handoff.summary}</p>
                </div>
              )}

              {handoff.suggestedActions.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-text-primary mb-2">Ações Sugeridas</h4>
                  <ul className="space-y-1">
                    {handoff.suggestedActions.map((action, index) => (
                      <li key={index} className="text-sm text-text-secondary flex items-start gap-2">
                        <span className="text-text-muted mt-0.5">•</span>
                        <span className="flex-1">{action}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t border-border">
                <span className="text-xs text-text-muted tabular-nums">
                  Solicitado em {new Date(handoff.createdAt).toLocaleDateString("pt-BR", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </span>

                <div className="flex flex-col sm:flex-row gap-2">
                  <Button
                    onClick={() => openPeek(handoff._id)}
                    variant="ghost"
                    size="md"
                    className="w-full sm:w-auto whitespace-nowrap"
                  >
                    <Eye size={16} />
                    Espiar conversa
                  </Button>
                  <Button
                    onClick={() => void handleReject(handoff._id)}
                    variant="secondary"
                    size="md"
                    className="w-full sm:w-auto whitespace-nowrap text-semantic-error border-semantic-error/30 hover:bg-semantic-error/10"
                  >
                    Rejeitar e devolver à IA
                  </Button>
                  <Button
                    onClick={() => handleAccept(handoff._id)}
                    variant="primary"
                    size="md"
                    className="w-full sm:w-auto"
                  >
                    Aceitar
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {peekHandoff && (
        <HandoffPeekSlideOver
          organizationId={organizationId}
          handoff={peekHandoff}
          onClose={closePeek}
          onAccept={handlePeekAccept}
          onReject={handlePeekReject}
          busy={peekBusy}
        />
      )}
    </div>
  );
}
