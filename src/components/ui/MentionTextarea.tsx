import React, { useState, useRef, useCallback, useEffect } from "react";
import { cn } from "@/lib/utils";
import { getMentionQuery, insertMention, filterMembers } from "@/lib/mentions";
import { Badge } from "@/components/ui/Badge";

interface TeamMember {
  _id: string;
  name: string;
  type: "human" | "ai";
  role: string;
  email?: string;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  teamMembers: TeamMember[];
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  mentionEnabled?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  ai: "IA",
  admin: "Admin",
  manager: "Gerente",
  agent: "Agente",
};

function getRoleLabel(member: TeamMember): string {
  if (member.type === "ai") return "IA";
  return ROLE_LABELS[member.role] || member.role;
}

export function MentionTextarea({
  value,
  onChange,
  onKeyDown,
  teamMembers,
  placeholder,
  rows = 2,
  disabled,
  className,
  mentionEnabled = false,
}: MentionTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [mentionState, setMentionState] = useState<{
    query: string;
    triggerIndex: number;
  } | null>(null);

  const filteredMembers = mentionState
    ? filterMembers(teamMembers, mentionState.query)
    : [];

  const showDropdown = mentionEnabled && mentionState !== null && filteredMembers.length > 0;

  // Update mention state when value or cursor position changes
  const updateMentionState = useCallback(() => {
    if (!mentionEnabled || !textareaRef.current) {
      setMentionState(null);
      return;
    }
    const cursorPos = textareaRef.current.selectionStart;
    const result = getMentionQuery(value, cursorPos);
    setMentionState(result);
    if (result) {
      setActiveIndex(0);
    }
  }, [value, mentionEnabled]);

  // Scroll active item into view
  useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const activeEl = dropdownRef.current.querySelector(`[data-index="${activeIndex}"]`);
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, showDropdown]);

  const handleSelect = useCallback(
    (member: TeamMember) => {
      if (!mentionState || !textareaRef.current) return;
      const cursorPos = textareaRef.current.selectionStart;
      const { newText, newCursorPosition } = insertMention(
        value,
        mentionState.triggerIndex,
        cursorPos,
        member.name,
        member._id,
      );
      onChange(newText);
      setMentionState(null);

      // Restore cursor position after React re-render
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = newCursorPosition;
          textareaRef.current.selectionEnd = newCursorPosition;
          textareaRef.current.focus();
        }
      });
    },
    [mentionState, value, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showDropdown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filteredMembers.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + filteredMembers.length) % filteredMembers.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handleSelect(filteredMembers[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionState(null);
        return;
      }
    }

    // Forward to parent handler (e.g., Enter-to-send)
    onKeyDown?.(e);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  // Re-evaluate mention state after each input change
  const handleInput = () => {
    // Use setTimeout to let the DOM update cursor position first
    setTimeout(updateMentionState, 0);
  };

  // Also check on click/arrow navigation within textarea
  const handleSelect2 = () => {
    setTimeout(updateMentionState, 0);
  };

  return (
    <div className="relative flex-1">
      {/* Dropdown — positioned above textarea */}
      {showDropdown && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMentionState(null)}
          />
          <div
            ref={dropdownRef}
            className="absolute bottom-full mb-1 left-0 right-0 z-50 bg-surface-overlay border border-border rounded-xl shadow-elevated max-h-48 overflow-y-auto"
            role="listbox"
            id="mention-listbox"
          >
            {filteredMembers.map((member, index) => (
              <button
                key={member._id}
                data-index={index}
                role="option"
                aria-selected={index === activeIndex}
                id={`mention-option-${index}`}
                onClick={(e) => {
                  e.preventDefault();
                  handleSelect(member);
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
                  index === activeIndex
                    ? "bg-brand-500/10"
                    : "hover:bg-surface-raised",
                )}
              >
                {/* Avatar */}
                <div
                  className={cn(
                    "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold",
                    member.type === "ai"
                      ? "bg-purple-600 text-white"
                      : "bg-brand-600 text-white",
                  )}
                >
                  {member.name
                    .split(" ")
                    .map((n) => n[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </div>

                {/* Name + email */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">
                      {member.name}
                    </span>
                    <Badge variant={member.type === "ai" ? "info" : "default"} className="text-[10px] shrink-0">
                      {getRoleLabel(member)}
                    </Badge>
                  </div>
                  {member.email && (
                    <div className="text-xs text-text-muted truncate">
                      {member.email}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onClick={handleSelect2}
        onSelect={handleSelect2}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={cn(
          "w-full px-3 py-2 bg-surface-raised border border-border-strong text-text-primary rounded-field text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 placeholder:text-text-muted",
          className,
        )}
        style={{ fontSize: "16px" }}
        aria-expanded={showDropdown}
        aria-autocomplete={mentionEnabled ? "list" : undefined}
        aria-controls={showDropdown ? "mention-listbox" : undefined}
        aria-activedescendant={
          showDropdown ? `mention-option-${activeIndex}` : undefined
        }
      />
    </div>
  );
}
