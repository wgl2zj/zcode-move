// @vitest-environment node
// 新增辅助命令测试：path_exists（打包输出查重）与 cleanup_earliest_backup（备份一键清理）。
// 独立成文件避免撑大 commands.test.ts；命名沿用 模块_场景 风格。

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { cleanupEarliestBackup, pathExists } from "./commands";
import { AppError } from "./engine/error";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "zm-cmdx-"));
  tempDirs.push(dir);
  return dir;
}

async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as AppError).code;
  }
  throw new Error("预期抛出，实际成功");
}

it("commands_path_exists：存在返回 true、不存在返回 false（不区分文件/目录）", async () => {
  const dir = await tempDir();
  fs.writeFileSync(path.join(dir, "a.zam"), "x");
  await expect(pathExists(path.join(dir, "a.zam"))).resolves.toBe(true);
  await expect(pathExists(dir)).resolves.toBe(true);
  await expect(pathExists(path.join(dir, "不存在.zam"))).resolves.toBe(false);
});

it("commands_cleanup_earliest_backup：只删时间戳形态的最早目录，杂名目录不动", async () => {
  const target = await tempDir();
  const backupRoot = path.join(target, "zam-backups");
  for (const [stamp, file] of [
    ["20260101-000000", "a.txt"],
    ["20260202-000000", "b.txt"],
    ["20260303-000000", "c.txt"],
  ] as const) {
    fs.mkdirSync(path.join(backupRoot, stamp), { recursive: true });
    fs.writeFileSync(path.join(backupRoot, stamp, file), "备份");
  }
  fs.mkdirSync(path.join(backupRoot, "not-a-stamp"), { recursive: true });
  fs.writeFileSync(path.join(backupRoot, "not-a-stamp", "keep.txt"), "杂名内容");

  const result = await cleanupEarliestBackup(target);
  expect(result.removed_dir).toBe("20260101-000000");
  expect(result.removed_files).toBe(1);
  expect(result.remaining).toBe(2);
  expect(fs.existsSync(path.join(backupRoot, "20260101-000000"))).toBe(false);
  expect(fs.existsSync(path.join(backupRoot, "20260202-000000"))).toBe(true);
  expect(fs.existsSync(path.join(backupRoot, "not-a-stamp", "keep.txt"))).toBe(true); // 非时间戳名不动
});

it("commands_cleanup_earliest_backup_no_stamps：无时间戳目录时拒绝（path_setup）", async () => {
  const target = await tempDir();
  fs.mkdirSync(path.join(target, "zam-backups"), { recursive: true });
  expect(await errCode(cleanupEarliestBackup(target))).toBe("path_setup");
});

it("commands_cleanup_earliest_backup_missing_root：备份根不存在时拒绝（path_setup）", async () => {
  const target = await tempDir();
  expect(await errCode(cleanupEarliestBackup(target))).toBe("path_setup");
});
