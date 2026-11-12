import { useId, useState } from "react";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { TRIAL } from "../../../../convex/lib/plans";
import { LandingSection } from "./LandingSection";
import { LANDING_ANCHORS } from "./landingCopy";

export interface FaqEntry {
  question: string;
  answer: string;
}

/** Cinco perguntas da copy aprovada (o prazo do teste vem do catálogo). */
export function landingFaq(): FaqEntry[] {
  return [
    {
      question: "O que é uma pessoa atendida pela IA?",
      answer:
        "É cada pessoa com quem a IA conversou no mês, respondendo ou escrevendo um rascunho para a sua equipe. O mesmo cliente falando 20 vezes conta 1. Conversas só da equipe, grupos e campanhas não contam.",
    },
    {
      question: "A IA vai falar besteira?",
      answer:
        "Ela começa em modo sugestão: escreve, e você aprova. Tudo o que ela manda passa por um filtro antes de sair, e ela nunca confirma pagamento sozinha. Quando não sabe, chama uma pessoa. Quando confiar, você libera o automático.",
    },
    {
      question: "E se eu quiser assumir a conversa?",
      answer:
        "Toque em Assumir e a IA para naquela conversa. Depois, se quiser, devolva para ela com uma instrução, como \"o Pix é este\". Ela segue de onde parou.",
    },
    {
      question: "Preciso de cartão?",
      answer: `Não. São ${TRIAL.days} dias grátis, sem cartão. Se você não assinar, nada é apagado: a conta fica só para leitura e você exporta tudo quando quiser.`,
    },
    {
      question: "E os meus dados?",
      answer:
        "Cada empresa só vê os próprios dados. A IA só liga depois que o administrador aceita. Você exporta tudo quando quiser, e quem sai da equipe perde o acesso na hora.",
    },
  ];
}

function FaqItem({ entry }: { entry: FaqEntry }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const panelId = `${uid}-resposta`;
  return (
    <div className="border-b border-border">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center justify-between gap-3 py-4 text-left text-base font-semibold text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <span>{entry.question}</span>
          <ChevronDown
            className={cn("size-5 shrink-0 text-text-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")}
            aria-hidden="true"
          />
        </button>
      </h3>
      <div id={panelId} hidden={!open} className="pb-4 text-text-secondary">
        {entry.answer}
      </div>
    </div>
  );
}

/** S9: cinco perguntas em acordeão (cada uma abre e fecha sozinha) e o link para as perguntas de preço. */
export function S9Faq() {
  return (
    <LandingSection id={LANDING_ANCHORS.faq} title="Perguntas rápidas" tone="raised">
      <div className="max-w-3xl border-t border-border">
        {landingFaq().map((entry) => (
          <FaqItem key={entry.question} entry={entry} />
        ))}
      </div>
      <p className="mt-6">
        <Link
          to="/precos#perguntas"
          className="inline-flex min-h-11 items-center text-brand-600 underline underline-offset-2 hover:text-brand-500"
        >
          Mais perguntas sobre preço
        </Link>
      </p>
    </LandingSection>
  );
}
