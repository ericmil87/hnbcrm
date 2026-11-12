import { Paperclip } from "lucide-react";
import { Bubble } from "@/components/landing/kit";
import { formatTime } from "@/lib/format";
import { blockKey, blockKindOf, type TimelineItem } from "@/lib/onboardingChat";
import { ModelText } from "./ModelText";
import { ReplyAudio } from "./ReplyAudio";
import { CollapsedBlock } from "./blocks/CollapsedBlock";
import { OnboardingBlockView } from "./blocks/registry";
import type { BlockContext } from "./blocks/types";

export interface MessageItemProps {
  item: TimelineItem;
  /** Contexto dos blocos sem `isLatest` (calculado aqui). */
  blockCtx: Omit<BlockContext, "isLatest">;
  isLatest: boolean;
  /** Blocos (`blockKey`) que aparecem de novo mais abaixo: viram uma linha recolhida. */
  superseded?: ReadonlySet<string>;
}

/** Uma mensagem da conversa: bolha (texto puro), áudio da resposta e blocos ricos. */
export function MessageItem({ item, blockCtx, isLatest, superseded }: MessageItemProps) {
  const time = item.createdAt ? formatTime(item.createdAt) : undefined;

  if (item.role === "user") {
    return (
      <Bubble variant="out" time={time} ticks={item.pending ? "sent" : "delivered"}>
        {item.attachmentLabel && (
          <span className="mb-0.5 flex items-center gap-1 text-caption">
            <Paperclip className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{item.attachmentLabel}</span>
          </span>
        )}
        {/* Texto da própria pessoa: React escapa; sem linkify. */}
        {item.text && <p className="whitespace-pre-wrap break-words">{item.text}</p>}
      </Bubble>
    );
  }

  const ctx: BlockContext = { ...blockCtx, isLatest };
  const hasText = item.text.trim().length > 0;
  return (
    <div className="flex flex-col gap-1.5">
      {(hasText || item.audio) && (
        <Bubble variant="ai" side="start" label="Copiloto" time={time}>
          {hasText && <ModelText text={item.text} />}
          {item.audio && <ReplyAudio audio={item.audio} />}
        </Bubble>
      )}
      {item.blocks.length > 0 && (
        <div className="flex flex-col items-start gap-1.5 pl-2">
          {item.blocks.map((block, i) => {
            const kind = blockKindOf(block);
            const key = blockKey(item.key, i);
            return superseded?.has(key) && kind ? (
              <CollapsedBlock key={key} kind={kind} />
            ) : (
              <div key={key} data-onboarding-card={kind ?? undefined} className="flex w-full flex-col items-start">
                <OnboardingBlockView block={block} ctx={ctx} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
