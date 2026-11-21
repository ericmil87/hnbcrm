/**
 * Agenda v2 (B4): formulário mínimo de "Novo contato" do seletor de cliente (nome + telefone). PURO.
 *
 * Não reaproveita o `CreateContactModal` de Contatos de propósito: carregá-lo por `lazy` daqui criava chunks
 * novos (o modal e o `CustomFieldsRenderer` saíam do chunk de Contatos) e o `index` e a Entrada cresciam alguns
 * bytes (mapa de dependências). Este formulário fica no chunk da Agenda e chama a mesma `contacts.createContact`.
 * O telefone passa pela MESMA validação do servidor (`normalizeCampaignPhone`) e é gravado como o WhatsApp o
 * grava (E.164 sem "+"), então a conversa e as confirmações encontram o contato.
 */
import { normalizeCampaignPhone } from "../../convex/lib/phone";

export const NEW_CONTACT_COPY = {
  title: "Novo contato",
  hint: "Só o essencial para marcar. Você completa o cadastro depois em Contatos.",
  name: "Nome do cliente",
  phone: "Telefone com DDD (opcional)",
  phoneHelp: "Usado para o cliente receber lembretes e confirmar pelo WhatsApp.",
  create: "Criar e continuar",
  creating: "Criando…",
  back: "Voltar",
  created: "Contato criado",
  failed: "Não foi possível criar o contato.",
  errors: {
    name: "Informe o nome do cliente.",
    nameLong: "No máximo 80 caracteres.",
    phone: "Esse telefone não parece válido. Use DDD e número, ex.: (11) 99999-1234.",
  },
} as const;

export interface NewContactForm {
  name: string;
  phone: string;
}

export interface NewContactErrors {
  name?: string;
  phone?: string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function newContactErrors(f: NewContactForm, defaultCountry?: string): NewContactErrors {
  const out: NewContactErrors = {};
  const name = clean(f.name);
  if (!name) out.name = NEW_CONTACT_COPY.errors.name;
  else if (name.length > 80) out.name = NEW_CONTACT_COPY.errors.nameLong;
  if (f.phone.trim() && !normalizeCampaignPhone(f.phone, defaultCountry).ok) out.phone = NEW_CONTACT_COPY.errors.phone;
  return out;
}

export interface NewContactArgs {
  firstName: string;
  lastName?: string;
  phone?: string;
}

/** Argumentos de `contacts.createContact`; só chame com `newContactErrors` vazio. Nome: primeira palavra e o resto. */
export function newContactArgs(f: NewContactForm, defaultCountry?: string): NewContactArgs {
  const [first, ...rest] = clean(f.name).split(" ");
  const phone = f.phone.trim() ? normalizeCampaignPhone(f.phone, defaultCountry) : null;
  return {
    firstName: first,
    ...(rest.length > 0 ? { lastName: rest.join(" ") } : {}),
    ...(phone && phone.ok ? { phone: phone.phone } : {}),
  };
}

/** O que foi digitado na busca vira o nome, ou o telefone quando só há número. */
export function prefillNewContact(term: string): NewContactForm {
  const typed = term.trim();
  const looksPhone = /^[+\d\s().-]{6,}$/.test(typed);
  return looksPhone ? { name: "", phone: typed } : { name: typed, phone: "" };
}
