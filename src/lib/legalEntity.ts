/**
 * Identificação do fornecedor: fonte única para rodapé, Termos e Privacidade
 * (Decreto 7.962/2013, art. 2º: nome, CPF/CNPJ, endereço físico e eletrônico).
 *
 * TODO(Eric): preencher `document` (CPF ou CNPJ) e `address` e mudar
 * `LEGAL_ENTITY_COMPLETE` para `true`. BLOQUEIO DO MERGE: a landing com preço
 * não pode ir ao ar com "em atualização". `legalEntity.test.ts` falha se a
 * flag e os campos divergirem.
 */
export interface LegalEntity {
  name: string;
  /** CPF ou CNPJ. */
  document: string;
  /** Endereço físico completo. */
  address: string;
  /** Contato comercial e dos Termos. */
  email: string;
  /** Encarregado pelo tratamento de dados (LGPD). */
  dpoEmail: string;
}

export const LEGAL_ENTITY: LegalEntity = {
  name: "Eric Milfont de Oliveira",
  document: "",
  address: "",
  email: "contato@hnbcrm.com",
  dpoEmail: "privacidade@hnbcrm.com",
};

/** `true` só depois de preencher CPF/CNPJ e endereço acima. */
export const LEGAL_ENTITY_COMPLETE = false;

/** Texto de identificação; vazio vira "em atualização" (nunca inventa dado). */
export function legalIdentification(entity: LegalEntity = LEGAL_ENTITY): {
  name: string;
  document: string;
  address: string;
  incomplete: boolean;
} {
  const document = entity.document.trim();
  const address = entity.address.trim();
  return {
    name: entity.name,
    document,
    address,
    incomplete: document === "" || address === "",
  };
}
