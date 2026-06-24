import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PasswordGate from "../../src/components/Auth/PasswordGate";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("PasswordGate", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("does not render children when auth status cannot be checked", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    render(
      <PasswordGate>
        <div>Secret App</div>
      </PasswordGate>,
    );

    await screen.findByPlaceholderText("auth.placeholder");
    expect(screen.queryByText("Secret App")).not.toBeInTheDocument();
  });
});
