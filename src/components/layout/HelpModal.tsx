import { useState } from "react";
import { ExternalLink, GraduationCap, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { OnboardingTutorialModal } from "@/components/onboarding-chat/tutorial/OnboardingTutorial";
import { communityUrl } from "@/lib/communityLink";

const ITEM_CLASS =
  "flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500";

export interface HelpModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Menu "Ajuda" do app: "Tutorial do atendente" (abre `OnboardingTutorialModal`) e,
 * só com `VITE_COMMUNITY_URL` válida, "Comunidade HNBCRM" (nova aba). O tutorial
 * fica montado aqui para continuar aberto depois que o menu fecha.
 */
export function HelpModal({ open, onClose }: HelpModalProps) {
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const community = communityUrl();
  return (
    <>
      <Modal open={open} onClose={onClose} title="Ajuda">
        <ul className="space-y-1">
          <li>
            <button
              type="button"
              className={ITEM_CLASS}
              onClick={() => {
                onClose();
                setTutorialOpen(true);
              }}
            >
              <GraduationCap size={18} className="shrink-0 text-brand-500" aria-hidden="true" />
              <span className="flex-1">Tutorial do atendente</span>
            </button>
          </li>
          {community && (
            <li>
              <a href={community} target="_blank" rel="noopener noreferrer" className={ITEM_CLASS} onClick={onClose}>
                <Users size={18} className="shrink-0 text-brand-500" aria-hidden="true" />
                <span className="flex-1">Comunidade HNBCRM</span>
                <ExternalLink size={14} className="shrink-0" aria-hidden="true" />
                <span className="sr-only">(abre em nova aba)</span>
              </a>
            </li>
          )}
        </ul>
      </Modal>
      <OnboardingTutorialModal open={tutorialOpen} onClose={() => setTutorialOpen(false)} />
    </>
  );
}
