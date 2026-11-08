import { Share, SquarePlus, Smartphone, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

const STEPS: ReadonlyArray<{ icon: LucideIcon; title: string; hint: string }> = [
  { icon: Share, title: "Toque em Compartilhar", hint: "Na barra de baixo do Safari." },
  { icon: SquarePlus, title: "Escolha Adicionar à Tela de Início", hint: "Role a lista se não aparecer." },
  { icon: Smartphone, title: "Abra o HNBCRM pelo ícone", hint: "Use sempre o ícone novo da tela de início." },
];

/** The 3 manual steps of installing on iPhone/iPad; reused by the sheet and by Settings. */
export function InstallIosSteps() {
  return (
    <ol className="space-y-3">
      {STEPS.map(({ icon: Icon, title, hint }, i) => (
        <li key={title} className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-brand-500">
            <Icon size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              <span className="tabular-nums">{i + 1}.</span> {title}
            </p>
            <p className="text-caption text-text-muted">{hint}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function InstallIosSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Instalar no iPhone ou iPad">
      <div className="space-y-4">
        <InstallIosSteps />
        <Button variant="secondary" size="lg" className="w-full" onClick={onClose}>
          Entendi
        </Button>
      </div>
    </Modal>
  );
}
