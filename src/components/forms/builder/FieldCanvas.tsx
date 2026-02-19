import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { LayoutList } from "lucide-react";
import { FieldCard } from "./FieldCard";
import type { FormField } from "./types";

interface FieldCanvasProps {
  fields: FormField[];
  selectedFieldId: string | null;
  onSelectField: (id: string | null) => void;
  onDeleteField: (id: string) => void;
  onReorderFields: (fields: FormField[]) => void;
}

export function FieldCanvas({
  fields,
  selectedFieldId,
  onSelectField,
  onDeleteField,
  onReorderFields,
}: FieldCanvasProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = fields.findIndex((f) => f.id === active.id);
    const newIndex = fields.findIndex((f) => f.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    onReorderFields(arrayMove(fields, oldIndex, newIndex));
  }

  if (fields.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 px-4 rounded-lg border-2 border-dashed border-border text-center">
        <div className="w-12 h-12 rounded-full bg-surface-overlay flex items-center justify-center">
          <LayoutList size={22} className="text-text-muted" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-medium text-text-secondary">Nenhum campo adicionado</p>
          <p className="text-[13px] text-text-muted mt-0.5">
            Adicione campos usando a paleta acima
          </p>
        </div>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {fields.map((field) => (
            <FieldCard
              key={field.id}
              field={field}
              isSelected={selectedFieldId === field.id}
              onSelect={() =>
                onSelectField(selectedFieldId === field.id ? null : field.id)
              }
              onDelete={() => onDeleteField(field.id)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
