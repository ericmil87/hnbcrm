import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { goToOnboarding, type OnboardingNiche } from "@/lib/onboardingEntry";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { AiAvatar, Bubble, ChatWindow, ChipRow, Composer, ScenePauseButton, type Chip } from "../kit";
import {
  HERO_CHAT_LABELS,
  type HeroChatVariant,
  HERO_BUBBLES,
  HERO_CHAT_STATUS,
  HERO_CHAT_TITLE,
  HERO_CHIPS,
  HERO_CHIP_MESSAGES,
  HERO_HINT,
  HERO_PLACEHOLDERS,
  HERO_STATIC_PLACEHOLDER,
  HERO_UPLOAD_NOTICE,
} from "./S1HeroCopy";

/**
 * Janela de conversa com o Copiloto e o `Composer` real, compartilhada pelo hero
 * e pelo CTA final. Enviar, tocar num chip, anexar ou gravar guarda a mensagem só
 * no navegador e segue para o onboarding (`goToOnboarding`, a mesma porta nos dois).
 * Anexo e microfone levam ao mesmo destino com um aviso: não há upload anônimo.
 */
export function HeroChat({ variant = "hero" }: { variant?: HeroChatVariant }) {
  const labels = HERO_CHAT_LABELS[variant];
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
    <div ref={windowRef} className="min-w-0">
      <ChatWindow
        title={HERO_CHAT_TITLE}
        label={labels.region}
        subtitle={HERO_CHAT_STATUS}
        avatar={<AiAvatar />}
        badge={<Badge variant="brand">IA</Badge>}
        bodyClassName="min-h-[11rem]"
        composer={
          <>
            <ChipRow
              className="px-2 pt-2"
              chips={HERO_CHIPS}
              label={labels.chips}
              onSelect={pickChip}
            />
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={send}
              placeholder={HERO_STATIC_PLACEHOLDER}
              placeholders={HERO_PLACEHOLDERS}
              label={labels.field}
              attachLabel={labels.attach}
              micLabel={labels.mic}
              sendLabel={labels.send}
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
            pauseLabel={labels.pause}
            resumeLabel={labels.resume}
          />
        </div>
      )}
    </div>
  );
}
