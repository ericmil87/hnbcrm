import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface CreateViewModalProps {
  organizationId: Id<"organizations">;
  entityType: "leads" | "contacts";
  onClose: () => void;
  onCreated?: (viewId: string) => void;
}

export function CreateViewModal({
  organizationId,
  entityType,
  onClose,
  onCreated,
}: CreateViewModalProps) {
  const [name, setName] = useState("");
  const [isShared, setIsShared] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<
    Id<"boards"> | undefined
  >();
  const [selectedStageIds, setSelectedStageIds] = useState<Id<"stages">[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState<
    Id<"teamMembers"> | undefined
  >();
  const [selectedPriority, setSelectedPriority] = useState<
    "low" | "medium" | "high" | "urgent" | undefined
  >();
  const [selectedTemperature, setSelectedTemperature] = useState<
    "cold" | "warm" | "hot" | undefined
  >();
  const [selectedChannel, setSelectedChannel] = useState<
    "whatsapp" | "telegram" | "email" | "webchat" | "internal" | undefined
  >();
  const [hasContact, setHasContact] = useState<boolean | undefined>();
  const [company, setCompany] = useState("");
  const [minValue, setMinValue] = useState("");
  const [maxValue, setMaxValue] = useState("");
  const [tags, setTags] = useState("");
  const [sortBy, setSortBy] = useState<string>("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch boards for pipeline filter
  const boards = useQuery(api.boards.getBoards, { organizationId });

  // Fetch stages if a board is selected
  const stages = useQuery(
    api.boards.getStages,
    selectedBoardId ? { boardId: selectedBoardId } : "skip"
  );

  // Fetch team members for assignee filter
  const teamMembers = useQuery(api.teamMembers.getTeamMembers, {
    organizationId,
  });

  const createSavedView = useMutation(api.savedViews.createSavedView);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Digite um nome para a visão");
      return;
    }

    setIsSubmitting(true);

    try {
      // Build filters object
      const filters: any = {};

      if (selectedBoardId) filters.boardId = selectedBoardId;
      if (selectedStageIds.length > 0) filters.stageIds = selectedStageIds;
      if (selectedAssignee) filters.assignedTo = selectedAssignee;
      if (selectedPriority) filters.priority = selectedPriority;
      if (selectedTemperature) filters.temperature = selectedTemperature;
      if (selectedChannel) filters.channel = selectedChannel;
      if (hasContact !== undefined) filters.hasContact = hasContact;
      if (company.trim()) filters.company = company.trim();
      if (minValue.trim()) filters.minValue = parseFloat(minValue);
      if (maxValue.trim()) filters.maxValue = parseFloat(maxValue);
      if (tags.trim()) {
        filters.tags = tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }

      const viewId = await createSavedView({
        organizationId,
        name: name.trim(),
        entityType,
        filters,
        isShared,
        sortBy,
        sortOrder,
      });

      toast.success("Visão criada com sucesso");
      onCreated?.(viewId);
    } catch (error: any) {
      toast.error(error.message || "Erro ao criar visão");
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleStage = (stageId: Id<"stages">) => {
    setSelectedStageIds((prev) =>
      prev.includes(stageId)
        ? prev.filter((id) => id !== stageId)
        : [...prev, stageId]
    );
  };

  return (
    <Modal open={true} onClose={onClose} title="Criar Nova Visão">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Name */}
        <Input
          label="Nome da Visão"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: Leads Urgentes do Pipeline A"
          required
          style={{ fontSize: "16px" }}
        />

        {/* Share Toggle */}
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-text-primary">
            Compartilhar com equipe?
          </label>
          <button
            type="button"
            onClick={() => setIsShared(!isShared)}
            className={cn(
              "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
              isShared ? "bg-brand-600" : "bg-surface-overlay"
            )}
            aria-label="Toggle compartilhamento"
          >
            <span
              className={cn(
                "inline-block h-4 w-4 rounded-full bg-white transition-transform",
                isShared ? "translate-x-6" : "translate-x-1"
              )}
            />
          </button>
        </div>

        {/* Filters Section */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">Filtros</h3>

          {/* Pipeline (Leads only) */}
          {entityType === "leads" && (
            <>
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Pipeline
                </label>
                <select
                  value={selectedBoardId || ""}
                  onChange={(e) => {
                    setSelectedBoardId(
                      e.target.value ? (e.target.value as Id<"boards">) : undefined
                    );
                    setSelectedStageIds([]); // Reset stages when board changes
                  }}
                  className={cn(
                    "w-full bg-surface-raised border border-border-strong rounded-field",
                    "px-3.5 py-2.5 text-sm text-text-primary",
                    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                    "transition-colors"
                  )}
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Todos os pipelines</option>
                  {boards?.map((board) => (
                    <option key={board._id} value={board._id}>
                      {board.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Stages (only if board selected) */}
              {selectedBoardId && stages && stages.length > 0 && (
                <div>
                  <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                    Estágios
                  </label>
                  <div className="space-y-2 max-h-40 overflow-y-auto p-2 bg-surface-raised border border-border-strong rounded-field">
                    {stages.map((stage) => (
                      <Checkbox
                        key={stage._id}
                        checked={selectedStageIds.includes(stage._id)}
                        onChange={() => toggleStage(stage._id)}
                        label={<span className="text-text-primary">{stage.name}</span>}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Assignee */}
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Atribuído a
                </label>
                <select
                  value={selectedAssignee || ""}
                  onChange={(e) =>
                    setSelectedAssignee(
                      e.target.value ? (e.target.value as Id<"teamMembers">) : undefined
                    )
                  }
                  className={cn(
                    "w-full bg-surface-raised border border-border-strong rounded-field",
                    "px-3.5 py-2.5 text-sm text-text-primary",
                    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                    "transition-colors"
                  )}
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Qualquer pessoa</option>
                  {teamMembers
                    ?.filter((m) => m.type === "human")
                    .map((member) => (
                      <option key={member._id} value={member._id}>
                        {member.name}
                      </option>
                    ))}
                </select>
              </div>

              {/* Priority */}
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Prioridade
                </label>
                <select
                  value={selectedPriority || ""}
                  onChange={(e) =>
                    setSelectedPriority(
                      e.target.value as "low" | "medium" | "high" | "urgent" | undefined
                    )
                  }
                  className={cn(
                    "w-full bg-surface-raised border border-border-strong rounded-field",
                    "px-3.5 py-2.5 text-sm text-text-primary",
                    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                    "transition-colors"
                  )}
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Qualquer prioridade</option>
                  <option value="low">Baixa</option>
                  <option value="medium">Média</option>
                  <option value="high">Alta</option>
                  <option value="urgent">Urgente</option>
                </select>
              </div>

              {/* Temperature */}
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Temperatura
                </label>
                <select
                  value={selectedTemperature || ""}
                  onChange={(e) =>
                    setSelectedTemperature(
                      e.target.value as "cold" | "warm" | "hot" | undefined
                    )
                  }
                  className={cn(
                    "w-full bg-surface-raised border border-border-strong rounded-field",
                    "px-3.5 py-2.5 text-sm text-text-primary",
                    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                    "transition-colors"
                  )}
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Qualquer temperatura</option>
                  <option value="cold">Frio</option>
                  <option value="warm">Morno</option>
                  <option value="hot">Quente</option>
                </select>
              </div>

              {/* Channel */}
              <div>
                <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                  Canal
                </label>
                <select
                  value={selectedChannel || ""}
                  onChange={(e) =>
                    setSelectedChannel(
                      e.target.value as
                        | "whatsapp"
                        | "telegram"
                        | "email"
                        | "webchat"
                        | "internal"
                        | undefined
                    )
                  }
                  className={cn(
                    "w-full bg-surface-raised border border-border-strong rounded-field",
                    "px-3.5 py-2.5 text-sm text-text-primary",
                    "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                    "transition-colors"
                  )}
                  style={{ fontSize: "16px" }}
                >
                  <option value="">Todos os canais</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="telegram">Telegram</option>
                  <option value="email">E-mail</option>
                  <option value="webchat">Chat do site</option>
                  <option value="internal">Interno</option>
                </select>
              </div>

              {/* Value Range */}
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Valor Mínimo"
                  type="number"
                  value={minValue}
                  onChange={(e) => setMinValue(e.target.value)}
                  placeholder="0"
                  style={{ fontSize: "16px" }}
                />
                <Input
                  label="Valor Máximo"
                  type="number"
                  value={maxValue}
                  onChange={(e) => setMaxValue(e.target.value)}
                  placeholder="99999"
                  style={{ fontSize: "16px" }}
                />
              </div>

              {/* Has Contact Toggle */}
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-primary">
                  Tem contato vinculado?
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setHasContact(hasContact === true ? undefined : true)
                    }
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                      hasContact === true
                        ? "bg-brand-600 text-white"
                        : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
                    )}
                  >
                    Sim
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setHasContact(hasContact === false ? undefined : false)
                    }
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                      hasContact === false
                        ? "bg-brand-600 text-white"
                        : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
                    )}
                  >
                    Não
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Company (Contacts only) */}
          {entityType === "contacts" && (
            <Input
              label="Empresa"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Nome da empresa"
              style={{ fontSize: "16px" }}
            />
          )}

          {/* Tags (both) */}
          <Input
            label="Tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tag1, Tag2, Tag3"
            style={{ fontSize: "16px" }}
          />
        </div>

        {/* Sort Options */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-text-primary">
            Ordenação
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Ordenar por
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className={cn(
                  "w-full bg-surface-raised border border-border-strong rounded-field",
                  "px-3.5 py-2.5 text-sm text-text-primary",
                  "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                  "transition-colors"
                )}
                style={{ fontSize: "16px" }}
              >
                <option value="createdAt">Data de Criação</option>
                <option value="updatedAt">Última Atualização</option>
                {entityType === "leads" && (
                  <>
                    <option value="value">Valor</option>
                    <option value="title">Título</option>
                  </>
                )}
              </select>
            </div>
            <div>
              <label className="block text-[13px] font-medium text-text-secondary mb-1.5">
                Direção
              </label>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
                className={cn(
                  "w-full bg-surface-raised border border-border-strong rounded-field",
                  "px-3.5 py-2.5 text-sm text-text-primary",
                  "focus:outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20",
                  "transition-colors"
                )}
                style={{ fontSize: "16px" }}
              >
                <option value="desc">Decrescente</option>
                <option value="asc">Crescente</option>
              </select>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1"
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={isSubmitting || !name.trim()}
            className="flex-1"
          >
            {isSubmitting ? <Spinner size="sm" /> : "Criar Visão"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
