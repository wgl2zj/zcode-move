// PathPicker 组件测试：点击调选择框、值展示、取消不改动（2026-11-09 路径弹窗选择需求）。
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/mock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mock")>();
  return {
    ...actual,
    pickDirectory: vi.fn(actual.pickDirectory),
    pickPackage: vi.fn(actual.pickPackage),
  };
});

import { pickDirectory, pickPackage } from "../lib/mock";
import { PathPicker } from "./PathPicker";

describe("PathPicker 路径选择卡片", () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    vi.mocked(pickDirectory).mockReset();
    vi.mocked(pickDirectory).mockImplementation(async () => null);
    vi.mocked(pickPackage).mockReset();
    vi.mocked(pickPackage).mockImplementation(async () => null);
  });

  it("dir 形态：显示当前值，点击调 pickDirectory，选中回调新路径", async () => {
    vi.mocked(pickDirectory).mockImplementation(async () => "D:\\新目录");
    let picked: string | null = null;
    render(
      <PathPicker
        kind="dir"
        label="资产根目录"
        value={"C:\\旧目录"}
        onPick={(n) => (picked = n)}
      />,
    );
    const btn = screen.getByRole("button", { name: "资产根目录" });
    expect(btn).toHaveTextContent("C:\\旧目录");
    fireEvent.click(btn);
    await waitFor(() => expect(picked).toBe("D:\\新目录"));
  });

  it("file 形态：点击调 pickPackage；取消（返回 null）不回调", async () => {
    let picked = 0;
    render(
      <PathPicker kind="file" label="迁移包路径（.zam）" value="" onPick={() => (picked += 1)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "迁移包路径（.zam）" }));
    await waitFor(() => expect(pickPackage).toHaveBeenCalledTimes(1));
    expect(picked).toBe(0); // 取消不改动
  });

  it("空值时显示占位文案", () => {
    render(
      <PathPicker
        kind="dir"
        label="恢复目标目录"
        value=""
        placeholder="点击选择文件夹"
        onPick={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "恢复目标目录" })).toHaveTextContent(
      "点击选择文件夹",
    );
  });
});
