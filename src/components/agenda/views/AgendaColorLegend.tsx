import { colorLegend, type ColorScheme } from "@/lib/agendaColors";
import { VIEWS_COPY } from "@/lib/agendaViewsCopy";
import { cn } from "@/lib/utils";

/**
 * Legenda discreta das cores dos blocos (uma linha, rola na horizontal). No esquema "por situação" só aparece no
 * computador (as situações já têm ícone); por sala, profissional ou serviço aparece sempre, porque a cor sozinha não diz nada.
 */
export function AgendaColorLegend({
  scheme,
  resources,
  services,
}: {
  scheme: ColorScheme;
  resources: ReadonlyArray<{ _id: string; name: string }>;
  services: ReadonlyArray<{ _id: string; name: string }>;
}) {
  const items = colorLegend(scheme, resources, services);
  if (items.length === 0) return null;
  return (
    <ul
      aria-label={VIEWS_COPY.dense.colors.legend}
      className={cn("flex shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap px-1 text-micro text-text-secondary", scheme === "status" && "hidden md:flex")}
    >
      {items.map((i) => (
        <li key={i.id} className="flex items-center gap-1">
          <span className={cn("h-2 w-2 rounded-full", i.dot)} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
