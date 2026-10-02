import {
  BedDouble,
  Briefcase,
  ConciergeBell,
  Headphones,
  MessageSquare,
  Phone,
  Receipt,
  ShoppingCart,
  Sparkles,
  Users,
  Utensils,
  Wallet,
  Wrench,
} from "lucide-react";

/**
 * Ícones que um setor pode usar. `departments.icon` guarda o NOME lucide;
 * nome desconhecido cai em `Users`.
 */
export const DEPARTMENT_ICONS: Record<string, { icon: React.ElementType; label: string }> = {
  Headphones: { icon: Headphones, label: "Atendimento" },
  BedDouble: { icon: BedDouble, label: "Reservas" },
  ConciergeBell: { icon: ConciergeBell, label: "Recepção" },
  Receipt: { icon: Receipt, label: "Faturamento" },
  Wallet: { icon: Wallet, label: "Financeiro" },
  ShoppingCart: { icon: ShoppingCart, label: "Compras" },
  Briefcase: { icon: Briefcase, label: "Comercial" },
  Utensils: { icon: Utensils, label: "Alimentos e bebidas" },
  Wrench: { icon: Wrench, label: "Manutenção" },
  Sparkles: { icon: Sparkles, label: "Governança" },
  Phone: { icon: Phone, label: "Telefonia" },
  MessageSquare: { icon: MessageSquare, label: "Mensagens" },
  Users: { icon: Users, label: "Equipe" },
};

export function DepartmentIcon({ name, size = 16, className }: { name?: string; size?: number; className?: string }) {
  const Icon = (name && DEPARTMENT_ICONS[name]?.icon) || Users;
  return <Icon size={size} className={className} aria-hidden="true" />;
}
