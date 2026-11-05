import { describe, expect, it } from "vitest";
import { contactFormToUpdate, contactToForm, countFilled, parseTags } from "./contactForm";

describe("contactForm", () => {
  it("contactToForm usa texto vazio para campos ausentes e junta etiquetas", () => {
    const form = contactToForm({ firstName: "Ana", tags: ["vip", "cliente"], instagramFollowers: 0 });
    expect(form.firstName).toBe("Ana");
    expect(form.lastName).toBe("");
    expect(form.tags).toBe("vip, cliente");
    expect(form.instagramFollowers).toBe("0");
    expect(form.linkedinConnections).toBe("");
    expect(form.customFields).toEqual({});
  });

  it("parseTags aparda e descarta vazios", () => {
    expect(parseTags(" cliente, vip,, ")).toEqual(["cliente", "vip"]);
    expect(parseTags("")).toEqual([]);
  });

  it("contactFormToUpdate troca vazio por undefined e converte números", () => {
    const form = contactToForm({ firstName: "  Ana ", email: "", instagramFollowers: 120, companySize: "1-10" });
    const args = contactFormToUpdate(form);
    expect(args.firstName).toBe("Ana");
    expect(args.email).toBeUndefined();
    expect(args.companySize).toBe("1-10");
    expect(args.instagramFollowers).toBe(120);
    expect(args.linkedinConnections).toBeUndefined();
    expect(args.tags).toEqual([]);
    expect(args.customFields).toBeUndefined();
  });

  it("contactFormToUpdate envia campos personalizados quando existem", () => {
    const form = contactToForm({ customFields: { vip: true } });
    expect(contactFormToUpdate(form).customFields).toEqual({ vip: true });
  });

  it("countFilled conta só valores preenchidos", () => {
    expect(countFilled(["a", "", null, undefined, "b"])).toBe(2);
  });
});
