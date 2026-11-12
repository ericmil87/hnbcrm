import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateOrganizationForm } from "./OrgSwitcher";

const createOrganization = vi.fn(async (_args: Record<string, unknown>) => "org1");
vi.mock("convex/react", () => ({ useMutation: () => createOrganization }));

describe("CreateOrganizationForm", () => {
  it("só pede o nome e o aceite; não há campo de identificador", async () => {
    const onCreated = vi.fn();
    render(<CreateOrganizationForm onCreated={onCreated} onCancel={() => {}} />);
    expect(screen.queryByLabelText(/identificador/i)).toBeNull();
    const submit = screen.getByRole("button", { name: "Criar" });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Nome da organização"), "Minha Empresa");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("org1"));
    const args = createOrganization.mock.calls[0][0];
    expect(args.name).toBe("Minha Empresa");
    expect("slug" in args).toBe(false);
  });
});
