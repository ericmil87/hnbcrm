import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  /** Dono (id do componente que registrou): só ele pode limpar. */
  owner: string;
  signature: string;
  get: () => PageHeaderContribution | null;
}

interface Registry {
  register: (registration: Registration) => void;
  /** Limpa só se o registro atual ainda for deste dono. */
  unregister: (owner: string) => void;
}

const PageHeaderContext = createContext<Registry | null>(null);

/** Estado do AppShell: guarda a contribuição registrada pela página atual. */
export function usePageHeaderRegistry() {
  const [registration, setRegistration] = useState<Registration | null>(null);
  const registry = useMemo<Registry>(
    () => ({
      register: setRegistration,
      unregister: (owner) => setRegistration((current) => (current?.owner === owner ? null : current)),
    }),
    []
  );
  return { registration, registry };
}

export function PageHeaderProvider({ registry, children }: { registry: Registry; children: ReactNode }) {
  return <PageHeaderContext.Provider value={registry}>{children}</PageHeaderContext.Provider>;
}

/**
 * Registra a contribuição da página enquanto ela estiver montada. Pode ser
 * chamado a cada render com objetos novos: o AppShell só redesenha quando a
 * assinatura (ids, rótulos, disabled) muda e sempre chama o `onSelect` mais
 * recente. `null` = sem contribuição. Fora do AppShell não faz nada.
 */
export function usePageHeader(contribution: PageHeaderContribution | null) {
  const registry = useContext(PageHeaderContext);
  const owner = useId();
  const latest = useRef(contribution);
  // Depois do commit (nunca durante o render): o AppShell lê a versão mais recente.
  useLayoutEffect(() => {
    latest.current = contribution;
  });
  const signature = pageHeaderSignature(contribution);
  useEffect(() => {
    if (!registry) return;
    if (signature) registry.register({ owner, signature, get: () => latest.current });
    else registry.unregister(owner);
  }, [registry, owner, signature]);
  useEffect(() => () => registry?.unregister(owner), [registry, owner]);
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
