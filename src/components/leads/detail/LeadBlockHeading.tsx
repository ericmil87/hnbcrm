import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../../convex/_generated/api";

/** Lead carregado (`getLead` sem o `null`), entregue aos blocos da aba Detalhes. */
export type LeadDoc = NonNullable<FunctionReturnType<typeof api.leads.getLead>>;

/** Título de bloco da aba Detalhes. */
export function LeadBlockHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-[13px] font-semibold text-text-secondary uppercase tracking-wide mb-3">{children}</h3>;
}
