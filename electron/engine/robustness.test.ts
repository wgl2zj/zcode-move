// @vitest-environment node
// 健壮性测试：协作式取消（task_cancelled 语义、半成品清理、已写保留）与断链链接跳过。
// 取消注入采用"观察文件系统副作用"的方式（输出文件出现/目标文件写完）定位到
// 写循环中段，避免脆弱的调用计数。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { executeApplyTo, openPackage, planApply } from "./applier";
import { AppError } from "./error";
import { pack, readManifest } from "./packer";
import { applyMappings } from "./pathfix";
import type { Profile } from "./profile/types";
import { scan } from "./scanner";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zm-robust-"));
  tempDirs.push(dir);
  return dir;
}

const miniProfile: Profile = {
  id: "mini",
  display_name: "迷你档案",
  version: 1,
  categories: [
    {
      id: "texts",
      display_name: "文本",
      description: "",
      tier: "Recommended",
      strategy: { kind: "Copy" },
      rule: { type: "Dir", rel: "texts" },
      pack_warning: null,
    },
  ],
};

async function makeMiniTree(): Promise<string> {
  const root = await tempDir();
  fs.mkdirSync(path.join(root, "texts"), { recursive: true });
  fs.writeFileSync(path.join(root, "texts", "a.txt"), "内容甲\n");
  fs.writeFileSync(path.join(root, "texts", "b.txt"), "内容乙\n");
  fs.writeFileSync(path.join(root, "texts", "c.txt"), "内容丙\n");
  return root;
}

async function cancelledCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).code;
  }
  throw new Error("预期抛出 task_cancelled，实际成功");
}

it("robustness_scan_cancelled_immediately：开扫即取消 → task_cancelled", async () => {
  const root = await makeMiniTree();
  const code = await cancelledCode(scan(miniProfile, root, undefined, { cancelled: () => true }));
  expect(code).toBe("task_cancelled");
});

it("robustness_scan_reports_per_category_progress：逐类别进度回调（次数=类别数，message 为类别名）", async () => {
  const root = await makeMiniTree();
  const calls: [number, number, string][] = [];
  const report = await scan(
    miniProfile,
    root,
    (done, total, name) => calls.push([done, total, name]),
  );
  expect(report.categories).toHaveLength(1);
  expect(calls).toEqual([[1, 1, "文本"]]); // mini 档案单类别：完成即 1/1
});

it("robustness_pack_cancel_removes_partial_package：写包中途取消 → 半成品 .zam 被删除", async () => {
  const root = await makeMiniTree();
  const outPath = path.join(await tempDir(), "半路包.zam");
  // 输出文件出现（写循环开始）后再放行一次迭代，随后取消 → 在第 2 个文件前抛出
  let k = 0;
  const cancelled = (): boolean => {
    if (!fs.existsSync(outPath)) return false;
    k += 1;
    return k >= 2;
  };
  const code = await cancelledCode(
    pack(miniProfile, root, ["texts"], "Custom", outPath, [], "0.3.0-test", () => {}, { cancelled }),
  );
  expect(code).toBe("task_cancelled");
  expect(k).toBeGreaterThanOrEqual(2); // 确实写到了第 2 个文件才取消
  expect(fs.existsSync(outPath)).toBe(false); // 半成品被 finally unlink 清理
});

it("robustness_open_package_cancelled：包校验循环支持取消", async () => {
  const root = await makeMiniTree();
  const outPath = path.join(await tempDir(), "完整包.zam");
  await pack(miniProfile, root, ["texts"], "Custom", outPath, [], "0.3.0-test", () => {});
  const code = await cancelledCode(openPackage(outPath, () => {}, { cancelled: () => true }));
  expect(code).toBe("task_cancelled");
});

it("robustness_execute_cancel_keeps_written_files：执行中途取消 → 已写文件保留、后续未写", async () => {
  const root = await makeMiniTree();
  const outPath = path.join(await tempDir(), "执行取消源包.zam");
  await pack(miniProfile, root, ["texts"], "Custom", outPath, [], "0.3.0-test", () => {});
  const target = await tempDir();
  const plan = await planApply(outPath, target, "overwrite", [], () => {});
  // b.txt 写完即取消 → c.txt 检查点抛出（清单序 a → b → c）
  const cancelled = (): boolean => fs.existsSync(path.join(target, "texts", "b.txt"));
  const code = await cancelledCode(executeApplyTo(plan, target, () => {}, { cancelled }));
  expect(code).toBe("task_cancelled");
  expect(fs.existsSync(path.join(target, "texts", "a.txt"))).toBe(true); // 已写保留
  expect(fs.existsSync(path.join(target, "texts", "b.txt"))).toBe(true);
  expect(fs.existsSync(path.join(target, "texts", "c.txt"))).toBe(false); // 后续未写
});

it("robustness_apply_mappings_cancelled_before_write：替换前取消 → 目标原样", async () => {
  const root = await makeMiniTree();
  fs.writeFileSync(path.join(root, "texts", "a.txt"), String.raw`{"py":"C:\\Users\\old\\py.exe"}`);
  const outPath = path.join(await tempDir(), "替换取消源包.zam");
  await pack(miniProfile, root, ["texts"], "Custom", outPath, [], "0.3.0-test", () => {});
  const target = await tempDir();
  await executeApplyTo(await planApply(outPath, target, "overwrite", [], () => {}), target, () => {});
  const before = fs.readFileSync(path.join(target, "texts", "a.txt"), "utf8");
  const code = await cancelledCode(
    applyMappings(target, await readManifest(outPath), [["C:\\Users\\old\\", "C:\\Users\\new\\"]], true, { cancelled: () => true }),
  );
  expect(code).toBe("task_cancelled");
  expect(fs.readFileSync(path.join(target, "texts", "a.txt"), "utf8")).toBe(before); // 未被改写
});

it("robustness_scan_skips_broken_junction：断链 junction 跳过不中断（真实事故回归锁：旧机插件缓存断链）", async () => {
  if (process.platform !== "win32") return; // junction 仅 Windows
  const root = await makeMiniTree();
  // 指向不存在目标的 junction（等价本机 .codex 插件缓存里 latest → 已删版本目录）
  fs.symlinkSync(path.join(root, "gone-away"), path.join(root, "texts", "broken-link"), "junction");
  const report = await scan(miniProfile, root); // 不抛即通过
  const rels = report.categories[0].files.map((f) => f.rel_path);
  expect(rels).toContain("texts/a.txt");
  expect(rels.some((r) => r.includes("broken-link"))).toBe(false); // 断链不收集
});
