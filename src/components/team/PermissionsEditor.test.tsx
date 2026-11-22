import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DEFAULT_PERMISSIONS } from "../../../convex/lib/permissions";
import { PermissionsEditor } from "./PermissionsEditor";

describe("PermissionsEditor", () => {
  it("textos com acento: Permissões e Nível de acesso", () => {
    render(<PermissionsEditor value={DEFAULT_PERMISSIONS.admin} onChange={() => {}} role="admin" />);
    expect(screen.getByText("Permissões")).toBeInTheDocument();
    expect(screen.getByText("Nível de acesso")).toBeInTheDocument();
    expect(screen.queryByText(/Permissoes|Nivel de/)).toBeNull();
    expect(screen.getByText("Agenda")).toBeInTheDocument();
  });
});
