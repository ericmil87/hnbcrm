import { FEATURE_STATUS_LABEL, type FeatureStatus } from "../featuresCatalog";
import { FeatureStatusBadge } from "./FeatureStatusBadge";

const LEGEND: readonly { status: FeatureStatus; text: string }[] = [
  { status: "pronto", text: "funcionando hoje" },
  { status: "opcional", text: "pronto, mas vem desligado: o administrador liga" },
  { status: "em-liberacao", text: "funciona, aguardando aprovação de terceiros" },
  { status: "em-breve", text: "planejado, ainda não disponível" },
  { status: "no-radar", text: "em estudo, sem data" },
];

/** Legenda das cinco situações. "Pronto" aparece com o rótulo em texto, já que não tem selo nas listas. */
export function FeatureStatusLegend() {
  return (
    <dl className="grid gap-2 rounded-card border border-border bg-surface-raised p-4 sm:grid-cols-2 lg:grid-cols-5">
      {LEGEND.map(({ status, text }) => (
        <div key={status} className="flex flex-col items-start gap-1">
          <dt>
            {status === "pronto" ? (
              <span className="inline-flex items-center rounded-full bg-semantic-success/10 px-2.5 py-0.5 text-xs font-medium text-semantic-success">
                {FEATURE_STATUS_LABEL[status]}
              </span>
            ) : (
              <FeatureStatusBadge status={status} />
            )}
          </dt>
          <dd className="text-sm text-text-secondary">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
