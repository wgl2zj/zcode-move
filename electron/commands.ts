// 命令层：前端 IPC ↔ 引擎的桥接（对应 Rust 版 commands.rs）。
// 本模块不 import Electron——保持 vitest 可直测；Electron 侧装配（ipcMain.handle、
// 进度事件桥、错误信封）在 main.ts 完成。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  BACKUP_DIR,
  executeApply,
  openPackage,
  planApply,
  type ApplyPlan,
  type ApplyMode,
  type ApplyReport,
} from "./engine/applier";
import { AppError } from "./engine/error";
import type { EngineOpts } from "./engine/opts";
import { pack, readManifest, type PackResult } from "./engine/packer";
import {
  applyMappings,
  detect,
  type DetectResult,
  type PathFixReport,
} from "./engine/pathfix";
import {
  builtinProfiles,
  defaultRoot,
  homeDir,
  legacyProfileById,
  profileById,
} from "./engine/profile";
import { strategyStr, tierStr, type Profile } from "./engine/profile/types";
import type { ProgressFn } from "./engine/progress";
import { scan, type ScanReport } from "./engine/scanner";
import type { ProfileSummary, Settings } from "./protocol";

/** 列出内置档案（UI 档案选择与档位判定的唯一数据源）。 */
export function listProfiles(): ProfileSummary[] {
  return builtinProfiles().map((p) => ({
    id: p.id,
    display_name: p.display_name,
    version: p.version,
    category_count: p.categories.length,
    default_root: defaultRoot(p),
    categories: p.categories.map((c) => ({
      id: c.id,
      display_name: c.display_name,
      description: c.description,
      tier: tierStr(c.tier, c.strategy),
      strategy: strategyStr(c.strategy),
      pack_warning: c.pack_warning,
    })),
  }));
}

function requireProfile(profileId: string): Profile {
  const p = profileById(profileId);
  if (!p) throw new AppError("path_setup", `未知档案：${profileId}`);
  return p;
}

/** 扫描盘点（完整档含数百 MB 库的全量哈希；root 缺省用档案默认根）。 */
export async function scanAssets(profileId: string, root?: string, opts?: EngineOpts): Promise<ScanReport> {
  const profile = requireProfile(profileId);
  return scan(profile, root && root.length > 0 ? root : defaultRoot(profile), opts);
}

/** 打包参数（pack_assets）。 */
export interface PackAssetsArgs {
  profileId: string;
  root: string;
  categories: string[];
  presetKind: string;
  outputPath: string;
  warnings: string[];
  appVersion: string;
}

export function packAssets(args: PackAssetsArgs, progress: ProgressFn, opts?: EngineOpts): Promise<PackResult> {
  const profile = requireProfile(args.profileId);
  return pack(
    profile,
    args.root,
    args.categories,
    args.presetKind,
    args.outputPath,
    args.warnings,
    args.appVersion,
    progress,
    opts,
  );
}

/** 打开并校验包（逐文件哈希校验）。 */
export function openPackageCmd(packagePath: string, progress: ProgressFn, opts?: EngineOpts) {
  return openPackage(packagePath, progress, opts);
}

/** 解包目标根目录解析：显式传入（非空）优先；否则读包内档案推导该软件的本机资产目录
 *  （如 ZCode → `~/.zcode`）。档案查找走已知档案全集（含仅旧包兼容的 codex/claude，
 *  spec 决策 1：旧迁移包不作废，目标根按包内档案正确推导）。真实试用事故修复：此前
 *  目标固定为包旁 `-restored` 目录，导致"解包成功但 ZCode 无变化"。 */
export async function resolveTargetRoot(packagePath: string, targetRoot?: string): Promise<string> {
  if (targetRoot !== undefined && targetRoot.trim().length > 0) {
    return targetRoot.trim();
  }
  const manifest = await readManifest(packagePath);
  const profile = legacyProfileById(manifest.profile_id);
  if (!profile) {
    throw new AppError("invalid_package", `未知档案：${manifest.profile_id}`);
  }
  return defaultRoot(profile);
}

/** 生成 dry-run 计划（纯只读；增量模式的冲突改判经 conflictOverrides 传入；
 *  mergeRelPaths 为用户勾选"内容级合并"的冲突文件清单，仅 .md/.json 生效）。 */
export async function planApplyCmd(
  args: {
    path: string;
    mode: ApplyMode;
    conflictOverrides?: string[];
    targetRoot?: string;
    mergeRelPaths?: string[];
  },
  progress: ProgressFn,
  opts?: EngineOpts,
): Promise<ApplyPlan> {
  const target = await resolveTargetRoot(args.path, args.targetRoot);
  return planApply(args.path, target, args.mode, args.conflictOverrides ?? [], progress, args.mergeRelPaths ?? [], opts);
}

/** 执行已确认计划（令牌双道校验在引擎内完成）。 */
export function executeApplyCmd(plan: ApplyPlan, progress: ProgressFn, opts?: EngineOpts): Promise<ApplyReport> {
  return executeApply(plan, progress, opts);
}

/** 检出旧机路径映射建议（读已解包目标树，纯只读）。 */
export async function detectPathMappingsCmd(
  packagePath: string,
  targetRoot?: string,
  opts?: EngineOpts,
): Promise<DetectResult> {
  const manifest = await readManifest(packagePath);
  const target = await resolveTargetRoot(packagePath, targetRoot);
  return detect(target, manifest, opts);
}

/** 路径映射入参。 */
export interface PathMappingIn {
  old: string;
  new: string;
}

/** 应用路径映射（用户确认后的旧→新列表；替换前必备份——红线不可关闭）。 */
export async function applyPathMappingsCmd(
  packagePath: string,
  mappings: PathMappingIn[],
  targetRoot?: string,
  opts?: EngineOpts,
): Promise<PathFixReport> {
  const manifest = await readManifest(packagePath);
  const target = await resolveTargetRoot(packagePath, targetRoot);
  const pairs = mappings.map((m) => [m.old, m.new] as [string, string]);
  // 备份固定开启：任何替换前必备份是决策红线，命令层不留关闭口子
  return applyMappings(target, manifest, pairs, true, opts);
}

/** 探测路径是否存在（打包输出查重用；不区分文件/目录）。 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 备份清理结果摘要。 */
export interface BackupCleanupResult {
  /** 被删除的备份目录名（时间戳）。 */
  removed_dir: string;
  /** 删除的文件数（递归计数）。 */
  removed_files: number;
  /** 清理后剩余的合格备份数。 */
  remaining: number;
}

/** 备份目录名的合法形态（与 applier.localStamp 的 YYYYMMDD-HHMMSS 对齐；
 *  只认这个形态，任何其他名字都不动——防误删非备份内容）。 */
const BACKUP_STAMP_RE = /^\d{8}-\d{6}$/;

async function countFilesRecursive(dir: string): Promise<number> {
  let n = 0;
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) n += await countFilesRecursive(full);
    else if (ent.isFile()) n += 1;
  }
  return n;
}

/** 清理最早一次历史备份（备份超限警告的"一键清理"后端；只删 targetRoot/zam-backups
 *  下目录名形如 YYYYMMDD-HHMMSS 的字典序最早一个目录，删除不可恢复）。 */
export async function cleanupEarliestBackup(targetRoot: string): Promise<BackupCleanupResult> {
  const backupRoot = path.join(targetRoot, BACKUP_DIR);
  let stamps: string[] = [];
  try {
    const entries = await fsp.readdir(backupRoot, { withFileTypes: true });
    stamps = entries.filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => BACKUP_STAMP_RE.test(n));
  } catch {
    throw new AppError("path_setup", `备份目录不存在：${backupRoot}`);
  }
  if (stamps.length === 0) {
    throw new AppError("path_setup", "备份目录下没有可自动清理的历史备份");
  }
  stamps.sort(); // 定长格式，字典序 = 时间序
  const earliest = stamps[0];
  const earliestAbs = path.join(backupRoot, earliest);
  const removedFiles = await countFilesRecursive(earliestAbs);
  await fsp.rm(earliestAbs, { recursive: true, force: true });
  return { removed_dir: earliest, removed_files: removedFiles, remaining: stamps.length - 1 };
}

/** 设置文件路径（userData 目录下；由 main.ts 提供 userData）。 */
export function settingsPathIn(userDataDir: string): string {
  return path.join(userDataDir, "settings.json");
}

/** 读取设置（无文件时按首用默认值：家目录下存在 Downloads 目录则作为默认输出目录）。 */
export async function loadSettingsFrom(settingsPath: string): Promise<Settings> {
  if (!fs.existsSync(settingsPath) || !fs.statSync(settingsPath).isFile()) {
    return { default_output_dir: defaultOutputDirIn(homeDir()) };
  }
  const text = await fsp.readFile(settingsPath, "utf8");
  try {
    return JSON.parse(text) as Settings;
  } catch (e) {
    throw new AppError("internal", `设置解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 首用默认输出目录推导（纯函数便于测试）：home 下有 Downloads 目录则采用，否则空。 */
export function defaultOutputDirIn(home: string): string {
  const dir = path.join(home, "Downloads");
  try {
    return fs.statSync(dir).isDirectory() ? dir : "";
  } catch {
    return "";
  }
}

/** 保存设置。 */
export async function saveSettingsTo(settingsPath: string, settings: Settings): Promise<void> {
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}
