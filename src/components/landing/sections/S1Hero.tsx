import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowDown, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { buttonClassName } from "@/components/ui/Button";
import { goToOnboarding, type OnboardingNiche } from "@/lib/onboardingEntry";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { AiAvatar, Bubble, ChatWindow, ChipRow, Composer, ScenePauseButton, type Chip } from "../kit";
import { LANDING_ANCHORS, trustLine } from "./landingCopy";
import {
  HERO_ATTACH_LABEL,
  HERO_BUBBLES,
  HERO_CHAT_STATUS,
  HERO_CHAT_TITLE,
  HERO_CHIPS,
  HERO_CHIPS_LABEL,
  HERO_CHIP_MESSAGES,
  HERO_EYEBROW,
  HERO_FIELD_LABEL,
  HERO_HINT,
  HERO_MIC_LABEL,
  HERO_PAUSE_LABEL,
  HERO_PLACEHOLDERS,
  HERO_RESUME_LABEL,
  HERO_SECONDARY_CTA,
  HERO_SEND_LABEL,
  HERO_STATIC_PLACEHOLDER,
  HERO_SUBTITLE,
  HERO_TITLE,
  HERO_UPLOAD_NOTICE,
} from "./S1HeroCopy";

/**
 * Hero: título A (único `<h1>`, elemento de LCP, nunca anima), subtítulo, janela
 * de conversa com o Copiloto e o `Composer` real. Enviar ou tocar num chip guarda
 * a mensagem só no navegador e segue para o onboarding (`goToOnboarding`).
 * Anexo e microfone levam ao mesmo destino com um aviso: não há upload anônimo.
 */
export function S1Hero() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [animationPaused, setAnimationPaused] = useState(false);
  const reduced = usePrefersReducedMotion();
  const windowRef = useRef<HTMLDivElement>(null);

  function send(text: string) {
    goToOnboarding(text, null, navigate);
  }

  function pickChip(chip: Chip) {
    const niche = chip.id as OnboardingNiche;
    const message = HERO_CHIP_MESSAGES[niche];
    if (!message) {
      windowRef.current?.querySelector("textarea")?.focus();
      return;
    }
    goToOnboarding(message, niche, navigate);
  }

  function needsAccount() {
    toast.info(HERO_UPLOAD_NOTICE);
    goToOnboarding(draft, null, navigate);
  }

  return (
    <section
      id={LANDING_ANCHORS.hero}
      aria-labelledby={`${LANDING_ANCHORS.hero}-titulo`}
      className="scroll-mt-28 px-4 pb-14 pt-8 md:scroll-mt-20 md:pb-20 md:pt-16"
    >
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:items-center lg:gap-12">
        <div className="min-w-0">
          <p className="text-caption font-semibold uppercase tracking-wide text-brand-600">{HERO_EYEBROW}</p>
          <h1
            id={`${LANDING_ANCHORS.hero}-titulo`}
            className="mt-2 font-display text-3xl font-bold leading-tight text-text-primary md:text-5xl"
          >
            {HERO_TITLE}
          </h1>
          <p className="mt-4 text-base text-text-secondary md:text-lg">{HERO_SUBTITLE}</p>
          <div className="mt-6">
            <a href={`#${LANDING_ANCHORS.machine}`} className={buttonClassName("secondary", "lg")}>
              {HERO_SECONDARY_CTA}
              <ArrowDown className="size-4" aria-hidden="true" />
            </a>
          </div>
          <p className="mt-4 flex items-center gap-2 text-sm text-text-muted">
            <ShieldCheck className="size-4 shrink-0 text-brand-600" aria-hidden="true" />
            {trustLine()}
          </p>
        </div>

        <div ref={windowRef} className="min-w-0">
          <ChatWindow
            title={HERO_CHAT_TITLE}
            subtitle={HERO_CHAT_STATUS}
            avatar={<AiAvatar />}
            badge={<Badge variant="brand">IA</Badge>}
            bodyClassName="min-h-[11rem]"
            composer={
              <>
                <ChipRow
                  className="px-2 pt-2"
                  chips={HERO_CHIPS}
                  label={HERO_CHIPS_LABEL}
                  onSelect={pickChip}
                />
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={send}
                  placeholder={HERO_STATIC_PLACEHOLDER}
                  placeholders={HERO_PLACEHOLDERS}
                  label={HERO_FIELD_LABEL}
                  attachLabel={HERO_ATTACH_LABEL}
                  micLabel={HERO_MIC_LABEL}
                  sendLabel={HERO_SEND_LABEL}
                  hint={HERO_HINT}
                  maxLength={2000}
                  onAttach={needsAccount}
                  onMic={needsAccount}
                  paused={animationPaused}
                />
              </>
            }
          >
            <Bubble variant="ai" side="start" label="Copiloto" time="09:41" enter>
              {HERO_BUBBLES[0]}
            </Bubble>
            <Bubble variant="ai" side="start" label="Copiloto" time="09:41" tail={false} enter enterDelayMs={400}>
              {HERO_BUBBLES[1]}
            </Bubble>
          </ChatWindow>
          {!reduced && (
            <div className="mt-2 flex justify-end">
              <ScenePauseButton
                paused={animationPaused}
                onToggle={() => setAnimationPaused((p) => !p)}
                pauseLabel={HERO_PAUSE_LABEL}
                resumeLabel={HERO_RESUME_LABEL}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
