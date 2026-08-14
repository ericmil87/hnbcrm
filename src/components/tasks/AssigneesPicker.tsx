import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { Check, Users as UsersIcon } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Gerente",
  agent: "Agente",
  ai: "IA",
};

interface AssigneesPickerProps {
  organizationId: Id<"organizations">;
  selectedIds: Id<"teamMembers">[];
  onChange: (ids: Id<"teamMembers">[]) => void;
  className?: string;
}

export function AssigneesPicker({ organizationId, selectedIds, onChange, className }: AssigneesPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const teamMembers = useQuery(api.teamMembers.getTeamMembers, { organizationId });

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
    };
  }, [open]);

  // Esc fecha só este popover — precisa ser um handler React que chama
  // stopPropagation antes do evento nativo chegar ao `document`, senão o
  // Escape também fecha o Modal/SlideOver por trás.
  const handlePopoverKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };

  const selectedSet = new Set(selectedIds);
  const allMembers = teamMembers ?? [];
  const selectedMembers = allMembers.filter((m) => selectedSet.has(m._id));
  const filtered = allMembers.filter((m) =>
    m.name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const toggle = (id: Id<"teamMembers">) => {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  return (
    <div className={cn("relative", className)} ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-raised border border-border-strong rounded-field text-left hover:border-brand-500 transition-colors min-h-[44px]"
        aria-expanded={open}
        aria-label="Selecionar responsáveis"
      >
        {selectedMembers.length === 0 ? (
          <span className="text-sm text-text-muted flex-1" style={{ fontSize: "16px" }}>
            Sem responsável
          </span>
        ) : (
          <div className="flex items-center flex-1 min-w-0">
            <div className="flex items-center -space-x-2 shrink-0">
              {selectedMembers.slice(0, 4).map((m) => (
                <Avatar
                  key={m._id}
                  name={m.name}
                  type={m.type}
                  size="sm"
                  imageUrl={m.avatarUrl}
                  className="ring-2 ring-surface-raised"
                />
              ))}
            </div>
            <span className="ml-2.5 text-sm text-text-primary truncate">
              {selectedMembers.length === 1
                ? selectedMembers[0].name
                : `${selectedMembers.length} responsáveis`}
            </span>
          </div>
        )}
        <UsersIcon size={16} className="text-text-muted shrink-0" />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-2 w-72 max-w-[85vw] bg-surface-overlay border border-border rounded-xl shadow-elevated p-2"
          onKeyDown={handlePopoverKeyDown}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome..."
            className="w-full px-2.5 py-1.5 mb-2 bg-surface-raised border border-border-strong rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
            style={{ fontSize: "16px" }}
            autoFocus
          />

          <div className="max-h-56 overflow-y-auto space-y-0.5">
            {filtered.length === 0 && (
              <p className="px-2 py-2 text-xs text-text-muted">Nenhum membro encontrado.</p>
            )}
            {filtered.map((member) => (
              <button
                key={member._id}
                type="button"
                onClick={() => toggle(member._id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-surface-sunken text-left transition-colors"
              >
                <Avatar name={member.name} type={member.type} size="sm" imageUrl={member.avatarUrl} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">{member.name}</p>
                  <p className="text-xs text-text-muted truncate">
                    {ROLE_LABELS[member.role] ?? member.role}
                  </p>
                </div>
                {selectedSet.has(member._id) && (
                  <Check size={14} className="text-brand-500 shrink-0" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
