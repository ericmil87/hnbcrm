import { describe, it, expect } from "vitest";
import {
  suggestMapping,
  coerceAndValidateRow,
  listImportTargets,
  filterFieldDefs,
  normalizeLabel,
  normalizePhone,
  parseNumberValue,
  parseBooleanValue,
  parseDateValue,
  splitList,
  IGNORE_FIELD,
  type ImportFieldDef,
} from "./importMapping";

const fieldDefs: ImportFieldDef[] = [
  { key: "budget", name: "Orçamento", type: "number", entityType: "lead", isRequired: false },
  {
    key: "segmento",
    name: "Segmento",
    type: "select",
    options: ["Varejo", "Serviços", "Indústria"],
    entityType: "lead",
    isRequired: false,
  },
  {
    key: "interesses",
    name: "Interesses",
    type: "multiselect",
    options: ["Curso", "Mentoria", "Evento"],
    entityType: "contact",
    isRequired: false,
  },
  { key: "aniversario", name: "Aniversário", type: "date", entityType: "contact", isRequired: false },
  { key: "vip", name: "VIP", type: "boolean", entityType: "contact", isRequired: false },
  { key: "apelido", name: "Apelido", type: "text", isRequired: true }, // sem entityType = vale p/ os dois
];

// ===== suggestMapping =====

describe("suggestMapping", () => {
  it("sugere campos de contato a partir de cabeçalhos PT-BR", () => {
    const mapping = suggestMapping(
      ["Nome", "Sobrenome", "E-mail", "Telefone", "Empresa", "Cargo", "Cidade", "Etiquetas"],
      "contacts"
    );
    expect(mapping).toEqual({
      Nome: "firstName",
      Sobrenome: "lastName",
      "E-mail": "email",
      Telefone: "phone",
      Empresa: "company",
      Cargo: "title",
      Cidade: "city",
      Etiquetas: "tags",
    });
  });

  it("ignora acentos, caixa e espaços ao casar aliases", () => {
    const mapping = suggestMapping(["  E-MAIL  ", "PAÍS", "Razão Social"], "contacts");
    expect(mapping).toEqual({
      "  E-MAIL  ": "email",
      "PAÍS": "country",
      "Razão Social": "company",
    });
  });

  it("casa cabeçalhos em inglês", () => {
    const mapping = suggestMapping(["First Name", "last name", "Email Address", "Mobile"], "contacts");
    expect(mapping).toEqual({
      "First Name": "firstName",
      "last name": "lastName",
      "Email Address": "email",
      Mobile: "phone",
    });
  });

  it("não repete destino: o segundo cabeçalho cai no próximo candidato", () => {
    const mapping = suggestMapping(["Telefone", "WhatsApp"], "contacts");
    expect(mapping).toEqual({ Telefone: "phone", WhatsApp: "whatsappNumber" });
  });

  it("marca cabeçalho desconhecido como __ignore__", () => {
    const mapping = suggestMapping(["Nome", "Coluna Maluca 42"], "contacts");
    expect(mapping["Coluna Maluca 42"]).toBe(IGNORE_FIELD);
  });

  it("sugere custom field pelo nome e pela chave", () => {
    const mapping = suggestMapping(["Interesses", "vip"], "contacts", fieldDefs);
    expect(mapping).toEqual({ Interesses: "cf:interesses", vip: "cf:vip" });
  });

  it("aceita o prefixo explícito cf_<key> no cabeçalho", () => {
    const mapping = suggestMapping(["cf_aniversario", "cf:vip"], "contacts", fieldDefs);
    expect(mapping).toEqual({ cf_aniversario: "cf:aniversario", "cf:vip": "cf:vip" });
  });

  it("só considera custom fields da entidade (entityType)", () => {
    expect(filterFieldDefs(fieldDefs, "contacts").map((d) => d.key)).toEqual([
      "interesses",
      "aniversario",
      "vip",
      "apelido",
    ]);
    expect(suggestMapping(["Orçamento"], "contacts", fieldDefs)["Orçamento"]).toBe(IGNORE_FIELD);
    expect(suggestMapping(["Orçamento"], "leads", fieldDefs)["Orçamento"]).toBe("cf:budget");
  });

  it("sugere campos de lead (funil, estágio, responsável, valor)", () => {
    const mapping = suggestMapping(
      ["Título", "Valor", "Funil", "Etapa", "Origem", "Responsável", "E-mail do contato", "Telefone"],
      "leads"
    );
    expect(mapping).toEqual({
      "Título": "title",
      Valor: "value",
      Funil: "boardName",
      Etapa: "stageName",
      Origem: "sourceName",
      "Responsável": "assigneeEmail",
      "E-mail do contato": "contactEmail",
      Telefone: "contactPhone",
    });
  });

  it("expõe os destinos disponíveis para a UI de mapeamento", () => {
    const alvos = listImportTargets("contacts");
    expect(alvos.find((a) => a.field === "email")).toEqual({
      field: "email",
      label: "E-mail",
      type: "email",
    });
    expect(listImportTargets("leads").some((a) => a.field === "boardName")).toBe(true);
  });
});

// ===== coerceAndValidateRow — contatos =====

describe("coerceAndValidateRow (contatos)", () => {
  const mapping = {
    Nome: "firstName",
    Sobrenome: "lastName",
    "E-mail": "email",
    Telefone: "phone",
    Etiquetas: "tags",
    Interno: IGNORE_FIELD,
  };

  it("monta contato com e-mail em minúsculas e telefone só com dígitos", () => {
    const result = coerceAndValidateRow(
      {
        Nome: " Ana ",
        Sobrenome: "Álvares",
        "E-mail": "ANA@Exemplo.com",
        Telefone: "+55 (11) 99999-1234",
        Etiquetas: "vip; quente ;",
        Interno: "não importar",
      },
      mapping,
      "contacts"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      firstName: "Ana",
      lastName: "Álvares",
      email: "ana@exemplo.com",
      phone: "5511999991234",
      tags: ["vip", "quente"],
      customFields: {},
    });
  });

  it("divide nome completo em nome e sobrenome", () => {
    const result = coerceAndValidateRow(
      { "Nome completo": "Ana Maria Álvares" },
      { "Nome completo": "fullName" },
      "contacts"
    );
    expect(result.ok && result.value.firstName).toBe("Ana");
    expect(result.ok && result.value.lastName).toBe("Maria Álvares");
  });

  it("coluna dedicada tem prioridade sobre o nome completo", () => {
    const result = coerceAndValidateRow(
      { Nome: "Bia", "Nome completo": "Ana Álvares" },
      { Nome: "firstName", "Nome completo": "fullName" },
      "contacts"
    );
    expect(result.ok && result.value.firstName).toBe("Bia");
    expect(result.ok && result.value.lastName).toBe("Álvares");
  });

  it("rejeita e-mail inválido", () => {
    const result = coerceAndValidateRow({ "E-mail": "ana(at)ex.com" }, mapping, "contacts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe("E-mail");
    expect(result.errors[0].message).toContain("e-mail válido");
  });

  it("rejeita telefone sem dígitos suficientes", () => {
    const result = coerceAndValidateRow({ Nome: "Ana", Telefone: "n/d" }, mapping, "contacts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("telefone válido");
  });

  it("rejeita linha sem nome, e-mail ou telefone", () => {
    const result = coerceAndValidateRow({ Etiquetas: "vip" }, mapping, "contacts");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("nada para importar");
  });

  it("sempre devolve customFields, mesmo vazio", () => {
    const result = coerceAndValidateRow({ Nome: "Ana" }, mapping, "contacts");
    expect(result.ok && result.value.customFields).toEqual({});
  });

  it("acusa campo inexistente no mapeamento", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Foo: "bar" },
      { Nome: "firstName", Foo: "naoExiste" },
      "contacts"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain('Campo "naoExiste"');
  });

  it("desfaz o escape de fórmula do export (inverso do escapeFormulas de lib/csv.ts)", () => {
    const result = coerceAndValidateRow(
      { Nome: "'=SOMA(A1)" },
      { Nome: "firstName" },
      "contacts"
    );
    expect(result.ok && result.value.firstName).toBe("=SOMA(A1)");
  });

  it("preserva apóstrofo legítimo que não é escape de fórmula", () => {
    const result = coerceAndValidateRow(
      { Nome: "'texto normal" },
      { Nome: "firstName" },
      "contacts"
    );
    expect(result.ok && result.value.firstName).toBe("'texto normal");
  });

  it("preserva apóstrofo legítimo em nome próprio ('s-Hertogenbosch)", () => {
    const result = coerceAndValidateRow(
      { Nome: "'s-Hertogenbosch" },
      { Nome: "firstName" },
      "contacts"
    );
    expect(result.ok && result.value.firstName).toBe("'s-Hertogenbosch");
  });
});

// ===== coerceAndValidateRow — custom fields =====

describe("coerceAndValidateRow (campos personalizados)", () => {
  it("casa opção de select ignorando acento e caixa e devolve o valor canônico", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Segmento: "servicos" },
      { Nome: "contactFirstName", Segmento: "cf:segmento" },
      "leads",
      fieldDefs
    );
    expect(result.ok && result.value.customFields).toEqual({ segmento: "Serviços" });
  });

  it("rejeita opção fora da lista do select", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Segmento: "Agro" },
      { Nome: "contactFirstName", Segmento: "cf:segmento" },
      "leads",
      fieldDefs
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("Varejo, Serviços, Indústria");
  });

  it("converte multiselect separado por ponto e vírgula", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Interesses: "Curso; Evento" },
      { Nome: "firstName", Interesses: "cf:interesses" },
      "contacts",
      fieldDefs
    );
    expect(result.ok && result.value.customFields).toEqual({ interesses: ["Curso", "Evento"] });
  });

  it("converte número com vírgula decimal, booleano PT-BR e data dd/mm/aaaa", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", VIP: "sim", "Aniversário": "23/08/1990" },
      { Nome: "firstName", VIP: "cf:vip", "Aniversário": "cf:aniversario" },
      "contacts",
      fieldDefs
    );
    expect(result.ok && result.value.customFields).toEqual({
      vip: true,
      aniversario: Date.UTC(1990, 7, 23),
    });

    const lead = coerceAndValidateRow(
      { "Título": "Negócio", "Orçamento": "R$ 12.500,75" },
      { "Título": "title", "Orçamento": "cf:budget" },
      "leads",
      fieldDefs
    );
    expect(lead.ok && lead.value.customFields).toEqual({ budget: 12500.75 });
  });

  it("acusa data inválida em custom field de data", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", "Aniversário": "31/02/2026" },
      { Nome: "firstName", "Aniversário": "cf:aniversario" },
      "contacts",
      fieldDefs
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("data válida");
  });

  it("acusa campo personalizado obrigatório vazio", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Apelido: "" },
      { Nome: "firstName", Apelido: "cf:apelido" },
      "contacts",
      fieldDefs
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("obrigatório");
  });

  it("acusa custom field que não existe na organização", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Foo: "x" },
      { Nome: "firstName", Foo: "cf:inexistente" },
      "contacts",
      fieldDefs
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("não existe nesta organização");
  });
});

// ===== coerceAndValidateRow — leads =====

describe("coerceAndValidateRow (leads)", () => {
  const mapping = {
    "Título": "title",
    Valor: "value",
    Prioridade: "priority",
    Temperatura: "temperature",
    Funil: "boardName",
    Etapa: "stageName",
    "Responsável": "assigneeEmail",
    "E-mail do contato": "contactEmail",
    Telefone: "contactPhone",
  };

  it("monta lead com valor em reais, prioridade e temperatura em PT-BR", () => {
    const result = coerceAndValidateRow(
      {
        "Título": "Projeto Acme",
        Valor: "R$ 2.500,00",
        Prioridade: "Alta",
        Temperatura: "Quente",
        Funil: "Vendas",
        Etapa: "Qualificação",
        "Responsável": "Vendedor@Acme.com",
        "E-mail do contato": "cliente@acme.com",
        Telefone: "(11) 98888-7777",
      },
      mapping,
      "leads"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      title: "Projeto Acme",
      value: 2500,
      priority: "high",
      temperature: "hot",
      boardName: "Vendas",
      stageName: "Qualificação",
      assigneeEmail: "vendedor@acme.com",
      contactEmail: "cliente@acme.com",
      contactPhone: "11988887777",
      customFields: {},
    });
  });

  it("rejeita prioridade fora do vocabulário", () => {
    const result = coerceAndValidateRow(
      { "Título": "X", Prioridade: "altíssima" },
      mapping,
      "leads"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("low, medium, high, urgent");
  });

  it("rejeita valor negativo", () => {
    const result = coerceAndValidateRow({ "Título": "X", Valor: "-10" }, mapping, "leads");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("negativo");
  });

  it("deriva o título do contato quando não há coluna de título", () => {
    const result = coerceAndValidateRow(
      { Nome: "Ana", Sobrenome: "Álvares", Empresa: "Acme" },
      { Nome: "contactFirstName", Sobrenome: "contactLastName", Empresa: "contactCompany" },
      "leads"
    );
    expect(result.ok && result.value.title).toBe("Ana Álvares");
  });

  it("exige título quando não há nada de onde derivar", () => {
    const result = coerceAndValidateRow({ Funil: "Vendas" }, mapping, "leads");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain("Título é obrigatório");
  });
});

// ===== helpers de coerção =====

describe("helpers de coerção", () => {
  it("normaliza rótulos removendo acento, caixa e pontuação", () => {
    expect(normalizeLabel("  Razão   Social  ")).toBe("razao social");
    expect(normalizeLabel("E-MAIL")).toBe("email");
    expect(normalizeLabel("e mail")).toBe("email");
  });

  it("normaliza telefone para só dígitos", () => {
    expect(normalizePhone("+55 (11) 99999-1234")).toBe("5511999991234");
    expect(normalizePhone("")).toBe("");
  });

  it("lê números pt-BR e en-US", () => {
    expect(parseNumberValue("1.234,56")).toBe(1234.56);
    expect(parseNumberValue("1,5")).toBe(1.5);
    expect(parseNumberValue("2.500")).toBe(2500);
    expect(parseNumberValue("1,234,567")).toBe(1234567);
    expect(parseNumberValue("1234.56")).toBe(1234.56);
    expect(parseNumberValue("R$ 99")).toBe(99);
    expect(parseNumberValue("-42")).toBe(-42);
    expect(parseNumberValue("abc")).toBe(null);
    expect(parseNumberValue("")).toBe(null);
  });

  it("lê booleanos em PT-BR e EN", () => {
    expect(parseBooleanValue("Sim")).toBe(true);
    expect(parseBooleanValue("TRUE")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("Não")).toBe(false);
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("talvez")).toBe(null);
  });

  it("lê datas ISO e dd/mm/aaaa", () => {
    expect(parseDateValue("2026-08-23")).toBe(Date.UTC(2026, 7, 23));
    expect(parseDateValue("23/08/2026")).toBe(Date.UTC(2026, 7, 23));
    expect(parseDateValue("23-08-2026")).toBe(Date.UTC(2026, 7, 23));
    expect(parseDateValue("23/08/26")).toBe(Date.UTC(2026, 7, 23));
    expect(parseDateValue("23/08/2026 14:30")).toBe(Date.UTC(2026, 7, 23, 14, 30));
    expect(parseDateValue("2026-08-23T10:00:00.000Z")).toBe(Date.UTC(2026, 7, 23, 10));
    expect(parseDateValue("31/02/2026")).toBe(null);
    expect(parseDateValue("ontem")).toBe(null);
  });

  it("quebra listas separadas por ponto e vírgula", () => {
    expect(splitList("vip; quente ;;")).toEqual(["vip", "quente"]);
    expect(splitList("")).toEqual([]);
  });
});
