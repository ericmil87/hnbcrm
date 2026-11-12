import { useState } from "react";
import { CheckCircle2, GraduationCap } from "lucide-react";
import { Bubble } from "@/components/landing/kit";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { BlockCard } from "../blocks/BlockCard";
import { TUTORIAL_CARDS, type TutorialBubble, type TutorialCardData } from "./tutorialCards";

const VARIANT: Record<TutorialBubble["from"], "in" | "out" | "ai"> = {
  customer: "in",
  team: "out",
  ai: "ai",
  copilot: "ai",
};

/** Cena de 2 bolhas do kit (entram em sequência; sem movimento fica parada). */
export function TutorialScene({ card }: { card: TutorialCardData }) {
  return (
    <div role="group" aria-label="Exemplo de conversa" className="space-y-1.5 rounded-card bg-chat-bg p-3">
      {card.scene.map((b, i) => (
        <Bubble
          key={`${card.id}:${i}`}
          variant={VARIANT[b.from]}
          side={b.from === "customer" ? "start" : "end"}
          label={b.label}
          tail={true}
          enter
          enterDelayMs={i * 450}
        >
          {b.text}
        </Bubble>
      ))}
    </div>
  );
}

export interface OnboardingTutorialProps {
  /** Terminou os cartões (ou pulou). Só avisa quem usa; nada é gravado aqui. */
  onDone?: () => void;
  /** Cartões a mostrar (padrão: todos). */
  cards?: readonly TutorialCardData[];
  className?: string;
}

/**
 * Tutorial guiado: um cartão por vez, cada um com a cena de 2 bolhas e o botão
 * "Entendi". Usado no fim do teste do atendente e, depois, pelo menu de ajuda
 * (`OnboardingTutorialModal`).
 */
export function OnboardingTutorial({ onDone, cards = TUTORIAL_CARDS, className }: OnboardingTutorialProps) {
  const [index, setIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const card = cards[index];

  if (finished || !card) {
    return (
      <BlockCard title="Tutorial" icon={GraduationCap} className={className}>
        <p className="flex items-center gap-1.5 text-text-primary">
          <CheckCircle2 className="size-4 text-semantic-success" aria-hidden="true" />
          Pronto. Você pode rever este tutorial quando quiser, pelo menu de ajuda.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            setIndex(0);
            setFinished(false);
          }}
        >
          Ver de novo
        </Button>
      </BlockCard>
    );
  }

  const last = index === cards.length - 1;
  const next = () => {
    if (last) {
      setFinished(true);
      onDone?.();
    } else {
      setIndex(index + 1);
    }
  };

  return (
    <BlockCard title="Como funciona no dia a dia" icon={GraduationCap} className={className}>
      <p className="text-caption text-text-muted tabular-nums" aria-live="polite">
        Cartão {index + 1} de {cards.length}
      </p>
      <h4 className="mt-1 text-sm font-semibold text-text-primary">{card.title}</h4>
      <p className="mt-1 text-text-secondary">{card.body}</p>
      <div className="mt-2">
        <TutorialScene card={card} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={next}>
          Entendi
        </Button>
        {!last && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFinished(true);
              onDone?.();
            }}
          >
            Pular tutorial
          </Button>
        )}
      </div>
    </BlockCard>
  );
}

export interface OnboardingTutorialModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Tutorial dentro de um `Modal`, para o menu de ajuda do app.
 * Entrada no menu: item "Tutorial do atendente" em "Ajuda" abre este componente.
 */
export function OnboardingTutorialModal({ open, onClose }: OnboardingTutorialModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Tutorial do atendente">
      <OnboardingTutorial onDone={onClose} className="max-w-none border-0 p-0 shadow-none" />
    </Modal>
  );
}
