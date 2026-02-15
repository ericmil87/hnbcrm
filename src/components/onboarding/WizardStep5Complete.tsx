import { useState } from "react";
import { Check, Kanban, Users, Database } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfettiCanvas } from "./ConfettiCanvas";

interface WizardStep5CompleteProps {
  pipelineName: string;
  stageCount: number;
  inviteCount: number;
  sampleDataGenerated: boolean;
  onGoToDashboard: () => void;
}

export function WizardStep5Complete({
  pipelineName,
  stageCount,
  inviteCount,
  sampleDataGenerated,
  onGoToDashboard,
}: WizardStep5CompleteProps) {
  const [confettiActive, setConfettiActive] = useState(true);

  return (
    <div className="space-y-8">
      <ConfettiCanvas
        active={confettiActive}
        duration={3000}
        onComplete={() => setConfettiActive(false)}
      />

      <div className="flex flex-col items-center text-center space-y-6">
        <div className="w-20 h-20 bg-semantic-success/10 rounded-full flex items-center justify-center animate-bounce-in">
          <Check size={40} className="text-semantic-success" />
        </div>

        <div className="space-y-2 animate-scale-in" style={{ animationDelay: "100ms" }}>
          <h2 className="text-3xl font-bold text-text-primary">Tudo Pronto!</h2>
          <p className="text-text-secondary">
            Seu CRM está configurado e pronto para usar
          </p>
        </div>

        <div className="w-full space-y-3 mt-8">
          <div
            className="flex items-center gap-3 bg-surface-raised rounded-card p-4 border border-border animate-fade-in-up"
            style={{ animationDelay: "200ms" }}
          >
            <div className="flex-shrink-0 w-10 h-10 bg-brand-500/10 rounded-lg flex items-center justify-center">
              <Kanban size={20} className="text-brand-500" />
            </div>
            <p className="text-sm text-text-primary text-left">
              Pipeline <span className="font-semibold">"{pipelineName}"</span> com{" "}
              {stageCount} etapa{stageCount !== 1 ? "s" : ""}
            </p>
          </div>

          {inviteCount > 0 && (
            <div
              className="flex items-center gap-3 bg-surface-raised rounded-card p-4 border border-border animate-fade-in-up"
              style={{ animationDelay: "300ms" }}
            >
              <div className="flex-shrink-0 w-10 h-10 bg-brand-500/10 rounded-lg flex items-center justify-center">
                <Users size={20} className="text-brand-500" />
              </div>
              <p className="text-sm text-text-primary text-left">
                {inviteCount} membro{inviteCount !== 1 ? "s" : ""} convidado
                {inviteCount !== 1 ? "s" : ""}
              </p>
            </div>
          )}

          {sampleDataGenerated && (
            <div
              className="flex items-center gap-3 bg-surface-raised rounded-card p-4 border border-border animate-fade-in-up"
              style={{ animationDelay: "400ms" }}
            >
              <div className="flex-shrink-0 w-10 h-10 bg-brand-500/10 rounded-lg flex items-center justify-center">
                <Database size={20} className="text-brand-500" />
              </div>
              <p className="text-sm text-text-primary text-left">
                Dados de exemplo gerados
              </p>
            </div>
          )}
        </div>

        <div
          className="w-full md:w-auto mt-6 animate-fade-in-up"
          style={{ animationDelay: "500ms" }}
        >
          <Button
            variant="primary"
            size="lg"
            onClick={onGoToDashboard}
            className="w-full md:w-auto"
          >
            Ir ao Painel
          </Button>
        </div>
      </div>
    </div>
  );
}
