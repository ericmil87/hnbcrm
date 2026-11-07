import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { mergeHeaderMenuItems, pageHeaderSignature } from "@/lib/pageHeader";

/**
 * Cabeçalho do AppShell no celular, com contribuição da página: botões de ícone
 * (ex.: "Nova conversa" em Conversas) e itens do menu ⋯ (ex.: "Selecionar
 * conversas"). A página chama `usePageHeader({...})`; o AppShell desenha.
 * Itens globais (o "Copiloto" do F3) entram por `globalMenuItems` no
 * `PageHeaderSlot` e vêm antes dos da página.
 */
export interface PageHeaderAction {
  id: string;
  /** Vira o `aria-label` (botão só com ícone). */
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

export type PageMenuItem = MenuItem & { id: string };

export interface PageHeaderContribution {
  actions?: PageHeaderAction[];
  menuItems?: PageMenuItem[];
  /** `aria-label` do ⋯ (padrão: "Mais ações"). */
  menuLabel?: string;
}

interface Registration {
  signature: string;
  get: () => PageHeaderContribution | null;
}

type Register = (registration: Registration | null) => void;

const PageHeaderContext = createContext<Register | null>(null);

/** Estado do AppShell: guarda a contribuição registrada pela página atual. */
export function usePageHeaderRegistry() {
  const [registration, setRegistration] = useState<Registration | null>(null);
  return { registration, register: setRegistration as Register };
}

export function PageHeaderProvider({ register, children }: { register: Register; children: ReactNode }) {
  return <PageHeaderContext.Provider value={register}>{children}</PageHeaderContext.Provider>;
}

/**
 * Registra a contribuição da página enquanto ela estiver montada. Pode ser
 * chamado a cada render com objetos novos: o AppShell só redesenha quando a
 * assinatura (ids, rótulos, disabled) muda e sempre chama o `onSelect` mais
 * recente. `null` = sem contribuição. Fora do AppShell não faz nada.
 */
export function usePageHeader(contribution: PageHeaderContribution | null) {
  const register = useContext(PageHeaderContext);
  const latest = useRef(contribution);
  latest.current = contribution;
  const signature = pageHeaderSignature(contribution);
  useEffect(() => {
    if (!register) return;
    register(signature ? { signature, get: () => latest.current } : null);
  }, [register, signature]);
  useEffect(() => () => register?.(null), [register]);
}

interface PageHeaderSlotProps {
  registration: Registration | null;
  /** Itens do AppShell que valem em toda tela (vêm antes dos da página). */
  globalMenuItems?: PageMenuItem[];
}

/** Ações e ⋯ da página no cabeçalho do AppShell (o chamador decide o breakpoint). */
export function PageHeaderSlot({ registration, globalMenuItems = [] }: PageHeaderSlotProps) {
  const contribution = registration?.get() ?? null;
  const latestById = (id: string) => {
    const current = registration?.get();
    return [...(current?.actions ?? []), ...(current?.menuItems ?? [])].find((e) => e.id === id);
  };
  const pageItems: PageMenuItem[] = (contribution?.menuItems ?? []).map((item) => ({
    ...item,
    onSelect: () => latestById(item.id)?.onSelect(),
  }));
  const menuItems = mergeHeaderMenuItems(globalMenuItems, pageItems);
  const actions = contribution?.actions ?? [];
  if (menuItems.length === 0 && actions.length === 0) return null;
  return (
    <>
      {menuItems.length > 0 && (
        <Menu
          ariaLabel={contribution?.menuLabel ?? "Mais ações"}
          align="end"
          items={menuItems}
          trigger={(props) => (
            <button
              type="button"
              {...props}
              aria-label={contribution?.menuLabel ?? "Mais ações"}
              className="shrink-0 flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <MoreHorizontal size={20} aria-hidden="true" />
            </button>
          )}
        />
      )}
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => latestById(action.id)?.onSelect()}
          aria-label={action.label}
          className="shrink-0 flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {action.icon}
        </button>
      ))}
    </>
  );
}
