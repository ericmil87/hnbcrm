import { ArrowDown, ArrowUp, Plus, RotateCcw, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  FUNNEL_MAX_STAGES,
  FUNNEL_MIN_STAGES,
  addStage,
  canAddStage,
  canMoveStage,
  canRemoveStage,
  cycleStageColor,
  moveStage,
  removeStage,
  renameStage,
  setBoardName,
  validateFunnel,
  type FunnelValue,
} from "@/lib/funnelEditor";
import { cn } from "@/lib/utils";

interface FunnelEditorProps {
  value: FunnelValue;
  onChange: (next: FunnelValue) => void;
  /** Volta ao funil sugerido do segmento. */
  onRestore: () => void;
  disabled?: boolean;
  /** `wizard` mostra a prévia das etapas; `panel` é a versão enxuta. */
  variant?: "wizard" | "panel";
  maxStages?: number;
  minStages?: number;
}

/** Editor controlado do funil: nome, etapas (renomear, ordenar, cor, adicionar, remover). Sem Convex. */
export function FunnelEditor({
  value,
  onChange,
  onRestore,
  disabled = false,
  variant = "wizard",
  maxStages: maxProp = FUNNEL_MAX_STAGES,
  minStages: minProp = FUNNEL_MIN_STAGES,
}: FunnelEditorProps) {
  const minStages = Math.min(FUNNEL_MAX_STAGES, Math.max(FUNNEL_MIN_STAGES, minProp));
  const maxStages = Math.min(FUNNEL_MAX_STAGES, Math.max(minStages, maxProp));
  const { errors } = validateFunnel(value, { min: minStages, max: maxStages });
  const iconBtn = "shrink-0";

  return (
    <div className="space-y-4">
      <Input
        label="Nome do funil"
        value={value.boardName}
        onChange={(e) => onChange(setBoardName(value, e.target.value))}
        placeholder="Ex.: Funil de vendas"
        disabled={disabled}
        error={errors.boardName}
        className="coarse:min-h-11"
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-text-primary">Etapas</h3>
          <Button variant="ghost" size="sm" onClick={onRestore} disabled={disabled}>
            <RotateCcw size={14} />
            Restaurar sugestão
          </Button>
        </div>

        <ul className="space-y-2">
          {value.stages.map((stage, index) => {
            const error = errors.stages[stage.key];
            return (
              <li key={stage.key}>
                <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised p-2">
                  <button
                    type="button"
                    onClick={() => onChange(cycleStageColor(value, stage.key))}
                    disabled={disabled}
                    aria-label={`Mudar a cor da etapa ${index + 1}`}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 coarse:h-11 coarse:w-11"
                  >
                    <span className="h-5 w-5 rounded-full" style={{ backgroundColor: stage.color }} />
                  </button>
                  <input
                    type="text"
                    value={stage.name}
                    onChange={(e) => onChange(renameStage(value, stage.key, e.target.value))}
                    disabled={disabled}
                    aria-label={`Nome da etapa ${index + 1}`}
                    aria-invalid={error ? true : undefined}
                    placeholder="Nome da etapa"
                    className="h-10 min-w-0 flex-1 rounded-field border border-transparent bg-transparent px-2 text-sm text-text-primary focus:border-brand-500 focus:outline-none coarse:h-11"
                  />
                  {stage.isClosedWon && <Badge variant="success">Ganho</Badge>}
                  {stage.isClosedLost && <Badge variant="error">Perdido</Badge>}
                  <Button
                    iconOnly
                    variant="ghost"
                    size="sm"
                    className={iconBtn}
                    aria-label={`Subir a etapa ${index + 1}`}
                    disabled={disabled || !canMoveStage(value, stage.key, -1)}
                    onClick={() => onChange(moveStage(value, stage.key, -1))}
                  >
                    <ArrowUp size={16} />
                  </Button>
                  <Button
                    iconOnly
                    variant="ghost"
                    size="sm"
                    className={iconBtn}
                    aria-label={`Descer a etapa ${index + 1}`}
                    disabled={disabled || !canMoveStage(value, stage.key, 1)}
                    onClick={() => onChange(moveStage(value, stage.key, 1))}
                  >
                    <ArrowDown size={16} />
                  </Button>
                  <Button
                    iconOnly
                    variant="ghost"
                    size="sm"
                    className={cn(iconBtn, "text-semantic-error hover:bg-semantic-error/10")}
                    aria-label={`Remover a etapa ${index + 1}`}
                    disabled={disabled || !canRemoveStage(value, stage.key, minStages)}
                    onClick={() => onChange(removeStage(value, stage.key, minStages))}
                  >
                    <X size={16} />
                  </Button>
                </div>
                {error && (
                  <p role="alert" className="mt-1 px-1 text-xs text-semantic-error">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        {errors.form && (
          <p role="alert" className="text-xs text-semantic-error">
            {errors.form}
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => onChange(addStage(value, maxStages))}
          disabled={disabled || !canAddStage(value, maxStages)}
        >
          <Plus size={16} />
          Adicionar etapa
        </Button>
      </div>

      {variant === "wizard" && (
        <div className="space-y-2" aria-hidden="true">
          <div className="flex flex-wrap gap-2">
            {value.stages.map((stage) => (
              <div key={stage.key} className="flex min-w-[60px] flex-1 flex-col items-center gap-1">
                <div className="h-2 w-full rounded-full" style={{ backgroundColor: stage.color }} />
                <span className="w-full truncate px-1 text-center text-xs text-text-secondary">{stage.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
