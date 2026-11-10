import { describe, expect, test } from "vitest";
import { isValidCnpj, isValidCpf, isValidCpfCnpj, maskCpfCnpj, onlyDigits } from "./brDocument";

describe("CPF", () => {
  test("válidos (com e sem máscara)", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("52998224725")).toBe(true);
  });
  test("dígito verificador errado, tamanho errado e repetidos", () => {
    expect(isValidCpf("529.982.247-24")).toBe(false);
    expect(isValidCpf("123")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("")).toBe(false);
  });
});

describe("CNPJ", () => {
  test("válidos", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11222333000181")).toBe(true);
  });
  test("inválidos", () => {
    expect(isValidCnpj("11.222.333/0001-80")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("1122233300018")).toBe(false);
  });
});

describe("isValidCpfCnpj / máscara", () => {
  test("decide pelo tamanho", () => {
    expect(isValidCpfCnpj("529.982.247-25")).toBe(true);
    expect(isValidCpfCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCpfCnpj("1234567890")).toBe(false);
    expect(isValidCpfCnpj("abc")).toBe(false);
  });
  test("mask só deixa os 2 últimos dígitos", () => {
    expect(maskCpfCnpj("529.982.247-25")).toBe("•••25");
    expect(onlyDigits("11.222.333/0001-81")).toBe("11222333000181");
  });
});
