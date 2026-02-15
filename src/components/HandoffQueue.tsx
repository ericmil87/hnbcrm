import React from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { toast } from "sonner";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { SpotlightTooltip } from "@/components/onboarding/SpotlightTooltip";

interface HandoffQueueProps {
  organizationId: Id<"organizations">;
}

export function HandoffQueue({ organizationId }: HandoffQueueProps) {
  const handoffs = useQuery(api.handoffs.getHandoffs, {
    organizationId,
    status: "pending",
  });

  const acceptHandoff = useMutation(api.handoffs.acceptHandoff);
  const rejectHandoff = useMutation(api.handoffs.rejectHandoff);

  const handleAccept = async (handoffId: string) => {
    try {
      await acceptHandoff({
        handoffId: handoffId as Id<"handoffs">,
      });
      toast.success("Repasse aceito com sucesso");
    } catch (error) {
      toast.error("Falha ao aceitar repasse");
    }
  };

  const handleReject = async (handoffId: string) => {
    try {
      await rejectHandoff({
        handoffId: handoffId as Id<"handoffs">,
      });
      toast.success("Repasse rejeitado");
    } catch (error) {
      toast.error("Falha ao rejeitar repasse");
    }
  };

  if (!handoffs) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spinner size="lg" />
      </div>
    );
  }

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

                <div className="flex gap-2">
                  <Button
                    onClick={() => handleReject(handoff._id)}
                    variant="secondary"
                    size="md"
                    className="flex-1 sm:flex-none text-semantic-error border-semantic-error/30 hover:bg-semantic-error/10"
                  >
                    Rejeitar
                  </Button>
                  <Button
                    onClick={() => handleAccept(handoff._id)}
                    variant="primary"
                    size="md"
                    className="flex-1 sm:flex-none"
                  >
                    Aceitar
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
