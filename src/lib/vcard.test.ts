import { describe, expect, it } from "vitest";
import { decodeQuotedPrintable, parseVcf, unfoldVcfLines } from "./vcard";

// Formato do "Exportar" do Google Contatos (vCard 3.0, CRLF).
const GOOGLE_EXPORT = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:João da Silva",
  "N:da Silva;João;;;",
  "EMAIL;TYPE=INTERNET;TYPE=HOME:joao@exemplo.com",
  "TEL;TYPE=CELL:+55 81 98888-7777",
  "TEL;TYPE=WORK:(81) 3222-1111",
  "ORG:Padaria Pão Quente",
  "TITLE:Gerente",
  "NOTE:Conheci na feira\\, gente boa",
  "CATEGORIES:myContacts",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Mãe",
  "N:;Mãe;;;",
  "TEL;TYPE=CELL:81999887766",
  "CATEGORIES:myContacts,Família",
  "END:VCARD",
  "",
].join("\r\n");

// Formato do iPhone/iCloud: grupos itemN., type repetido, foto em base64 dobrada.
const IPHONE_EXPORT = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "PRODID:-//Apple Inc.//iPhone OS 17.5//EN",
  "N:Moreira;Ana;Paula;;",
  "FN:Ana Paula Moreira",
  "ORG:Clínica Sorriso;",
  "item1.TEL;type=pref:+55 (11) 91234-5678",
  "item1.X-ABLabel:_$!<Mobile>!$_",
  "TEL;type=CELL;type=VOICE;type=pref:11 91234-5678",
  "TEL;type=HOME;type=VOICE:+1 212 555 1234",
  "item2.EMAIL;type=INTERNET;type=pref:Ana.Moreira@Exemplo.COM",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4n",
  " ICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIy",
  "END:VCARD",
].join("\n");

// Android antigo (vCard 2.1): quoted-printable com quebra suave e parâmetros sem nome.
const ANDROID_21 = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Concei=C3=A7=C3=A3o;Jos=C3=A9;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jos=C3=A9 Concei=C3=A7=C3=A3o da Assun=C3=A7=C3=A3o Fi=",
  "lho",
  "TEL;CELL;PREF:+5581977776666",
  "TEL;HOME:3222-0000",
  "EMAIL;HOME:jose@exemplo.com",
  "END:VCARD",
].join("\r\n");

const VCARD_40 = [
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Tio Zé",
  'TEL;VALUE=uri;TYPE="cell,voice":tel:+55-81-96666-5555',
  "EMAIL:mailto:ze@exemplo.com",
  "END:VCARD",
].join("\n");

describe("unfoldVcfLines", () => {
  it("junta linha dobrada (espaço ou tab) e tira o BOM", () => {
    expect(unfoldVcfLines("﻿FN:Maria\r\n  da Silva\r\nNOTE:a\r\n\tb")).toEqual(["FN:Maria da Silva", "NOTE:ab"]);
  });
  it("junta a continuação do quoted-printable", () => {
    expect(unfoldVcfLines("FN;ENCODING=QUOTED-PRINTABLE:Jo=\nao\nTEL:1")).toEqual([
      "FN;ENCODING=QUOTED-PRINTABLE:Joao",
      "TEL:1",
    ]);
  });
});

describe("decodeQuotedPrintable", () => {
  it("UTF-8 e Latin-1", () => {
    expect(decodeQuotedPrintable("Jo=C3=A3o")).toBe("João");
    expect(decodeQuotedPrintable("Jo=E3o", "iso-8859-1")).toBe("João");
  });
});

describe("parseVcf", () => {
  it("exportação do Google: vários contatos, tipos, ORG, TITLE, acentos", () => {
    const [joao, mae] = parseVcf(GOOGLE_EXPORT);
    expect(joao).toEqual({
      fullName: "João da Silva",
      firstName: "João",
      lastName: "da Silva",
      phones: [
        { value: "+55 81 98888-7777", types: ["cell"] },
        { value: "(81) 3222-1111", types: ["work"] },
      ],
      emails: [{ value: "joao@exemplo.com", types: ["home"] }],
      org: "Padaria Pão Quente",
      title: "Gerente",
    });
    expect(mae.fullName).toBe("Mãe");
    expect(mae.firstName).toBe("Mãe");
    expect(mae.lastName).toBeUndefined();
    expect(mae.phones).toEqual([{ value: "81999887766", types: ["cell"] }]);
  });

  it("exportação do iPhone: grupos itemN, type repetido, foto ignorada", () => {
    const [ana] = parseVcf(IPHONE_EXPORT);
    expect(ana.firstName).toBe("Ana Paula");
    expect(ana.lastName).toBe("Moreira");
    expect(ana.org).toBe("Clínica Sorriso");
    expect(ana.phones.map((p) => p.value)).toEqual(["+55 (11) 91234-5678", "11 91234-5678", "+1 212 555 1234"]);
    expect(ana.phones[1].types).toEqual(["cell", "voice", "pref"]);
    expect(ana.emails[0].value).toBe("Ana.Moreira@Exemplo.COM");
  });

  it("vCard 2.1 com quoted-printable, quebra suave e parâmetros sem nome", () => {
    const [jose] = parseVcf(ANDROID_21);
    expect(jose.fullName).toBe("José Conceição da Assunção Filho");
    expect(jose.firstName).toBe("José");
    expect(jose.lastName).toBe("Conceição");
    expect(jose.phones).toEqual([
      { value: "+5581977776666", types: ["cell", "pref"] },
      { value: "3222-0000", types: ["home"] },
    ]);
    expect(jose.emails[0]).toEqual({ value: "jose@exemplo.com", types: ["home"] });
  });

  it("vCard 4.0 com tel: e mailto:", () => {
    const [ze] = parseVcf(VCARD_40);
    expect(ze.phones).toEqual([{ value: "+55-81-96666-5555", types: ["cell", "voice"] }]);
    expect(ze.emails[0].value).toBe("ze@exemplo.com");
  });

  it("caixa misturada, último contato sem END e lixo fora do cartão", () => {
    const out = parseVcf("lixo\nbegin:vcard\nfn:Primeiro\nend:vcard\nBEGIN:VCARD\nFN:Sem fim\nTEL:81988887777");
    expect(out.map((c) => c.fullName)).toEqual(["Primeiro", "Sem fim"]);
  });

  it("valores escapados", () => {
    const [c] = parseVcf("BEGIN:VCARD\nN:Silva\\, Jr;Pedro;;;\nORG:A\\;B;Depto\nEND:VCARD");
    expect(c.lastName).toBe("Silva, Jr");
    expect(c.org).toBe("A;B");
  });

  it("arquivo vazio ou sem cartão", () => {
    expect(parseVcf("")).toEqual([]);
    expect(parseVcf("nome,telefone\nAna,123")).toEqual([]);
  });
});
