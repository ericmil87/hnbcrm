/**
 * Identificação do fornecedor: fonte única para rodapé, Termos e Privacidade
 * (Decreto 7.962/2013, art. 2º: nome, CPF/CNPJ, endereço físico e eletrônico).
 *
 * Fornecedor: INOVAWAY LTDA (definido pelo Eric em 10/11/2026), a mesma PJ
 * que emite a NFS-e, recebe pelo Asaas e será a licenciante. `legalEntity.test.ts`
 * falha se `LEGAL_ENTITY_COMPLETE` e os campos divergirem.
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
  name: "INOVAWAY LTDA",
  document: "18.652.375/0001-00",
  address: "Rua do Apolo, 161, CXPST 136, Bairro do Recife, Recife-PE, CEP 50030-220",
  email: "contato@hnbcrm.com",
  dpoEmail: "privacidade@hnbcrm.com",
};

/** `true` só depois de preencher CPF/CNPJ e endereço acima. */
export const LEGAL_ENTITY_COMPLETE = true;

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
