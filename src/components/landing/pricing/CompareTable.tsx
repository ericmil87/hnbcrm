import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { compareRows } from "./pricingCompare";
import { cn } from "@/lib/utils";
import { PLAN_KEYS, PLANS } from "../../../../convex/lib/plans";
import { COMPARE_NOTE } from "./pricingCopy";

const PANEL_ID = "compare-plans-panel";

/** "Compare os planos": tabela recolhível; no celular a primeira coluna fica fixa e a tabela rola dentro do quadro. */
export function CompareTable() {
  const [open, setOpen] = useState(false);
  const rows = compareRows();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);

  // A dica só aparece quando a tabela realmente rola (largura do quadro menor que a da tabela).
  useEffect(() => {
    const el = scroller.current;
    if (!open || !el) return;
    const measure = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  return (
    <div className="text-center">
      <Button
        variant="secondary"
        size="lg"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Fechar comparação" : "Compare os planos"}
        <ChevronDown size={18} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
      </Button>

      <div id={PANEL_ID} className="mt-4 text-left">
        {open && (
          <>
            {scrolls && <p className="mb-2 text-caption text-text-muted">Deslize para ver todos os planos</p>}
            <div ref={scroller} className="overflow-x-auto rounded-card border border-border bg-surface-raised">
              <table className="w-full min-w-[44rem] border-collapse text-sm">
                <caption className="sr-only">Comparação dos planos</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 w-32 md:w-40 bg-surface-raised px-3 py-3 text-left text-caption font-medium text-text-muted"
                    >
                      <span className="sr-only">Item</span>
                    </th>
                    {PLAN_KEYS.map((k) => (
                      <th key={k} scope="col" className="px-3 py-3 text-left font-semibold text-text-primary">
                        {PLANS[k].label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label} className="border-b border-border-subtle last:border-b-0">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 w-32 md:w-40 bg-surface-raised px-3 py-3 text-left font-semibold text-text-primary"
                      >
                        {r.label}
                      </th>
                      {r.cells.map((c, i) => (
                        <td
                          key={PLAN_KEYS[i]}
                          className={cn(
                            "px-3 py-3 align-top tabular-nums",
                            c === "Não incluído" || c === "Não disponível" ? "text-text-muted" : "text-text-secondary",
                          )}
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-caption text-text-muted">{COMPARE_NOTE}</p>
          </>
        )}
      </div>
    </div>
  );
}
