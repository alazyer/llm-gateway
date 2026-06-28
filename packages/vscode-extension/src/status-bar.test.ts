import { describe, expect, it, vi } from "vitest";

const item = {
  text: "",
  tooltip: "",
  command: "",
  show: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: () => item,
  },
  StatusBarAlignment: {
    Left: 1,
  },
}));

describe("StatusBarController", () => {
  it("renders status transitions", async () => {
    const { StatusBarController } = await import("./status-bar.js");
    const controller = new StatusBarController();

    expect(item.text).toContain("Copilot Proxy");
    controller.setStatus("connected");
    expect(item.text).toBe("$(check) Copilot Proxy");
    expect(item.tooltip).toContain("connected");
  });
});
