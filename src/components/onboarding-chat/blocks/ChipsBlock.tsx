import { ChipRow } from "@/components/landing/kit";
import { plainModelText } from "@/lib/onboardingChat";
import { ModelText } from "../ModelText";
import type { BlockProps } from "./types";

/** `chips`: respostas sugeridas dentro da conversa; tocar envia o texto (só na última resposta). */
export function ChipsBlock({ block, ctx }: BlockProps<"chips">) {
  const chips = (Array.isArray(block.options) ? block.options : [])
    .map((o) => plainModelText(o))
    .filter(Boolean)
    .slice(0, 6)
    .map((label, i) => ({ id: `${i}:${label}`, label }));
  if (chips.length === 0) return null;
  return (
    <div className="w-full max-w-md">
      {block.note && <ModelText text={block.note} className="mb-1 text-caption text-text-secondary" />}
      <ChipRow
        label="Respostas sugeridas"
        chips={chips}
        wrap
        disabled={ctx.busy || !ctx.isLatest}
        onSelect={(chip) => ctx.sendText(chip.label)}
      />
    </div>
  );
}
