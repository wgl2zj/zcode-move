// 解包向导 6 步：选包校验 → 内容预览 → 恢复模式 → dry-run 计划确认 → 执行与报告 → 路径适配。
// 路径适配必须在执行之后：detect/apply 作用对象是目标树，执行前目标文件尚不存在（契约时序红线）。
// 高风险动作（执行计划、路径替换）统一走居中确认对话框；进度走真实事件。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  COMMANDS,
  type AppErrorPayload,
  type ApplyMode,
  type ApplyPlan,
  type ApplyReport,
  type DetectResult,
  type Manifest,
  type PathFixReport,
  type PlanItem,
  type ProfileSummary,
  type ProgressPayload,
} from "../lib/ipc";
import { apiCall, useProgress } from "../lib/mock";
import { mergeStrategyFor } from "../../electron/engine/merge";
import { formatBytes } from "../lib/format";
import { Banner } from "../components/Banner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { WizardSteps } from "../components/WizardSteps";
import { ProgressBar } from "../components/ProgressBar";
import { StatusTag, SkipTag } from "../components/StatusTag";
import { EmptyState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { IconCheck, IconWarning } from "../components/icons";
import { PathPicker } from "../components/PathPicker";
import { addHistory } from "../components/history";
import { joinPath } from "../components/paths";
import { categoryLabel } from "../components/categoryNames";

const STEPS = ["选包并校验", "内容预览", "恢复模式", "计划确认", "执行与报告", "路径适配"];

/** 路径适配清单中的一行（映射可编辑、可勾选停用）。 */
interface MappingRow {
  old: string;
  new: string;
  total_hits: number;
  enabled: boolean;
}

function isAppError(e: unknown): e is AppErrorPayload {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function UnpackWizard(props: {
  onExit: () => void;
  /** 长任务执行中上报给 App 锁导航（可选：测试不传不受影响）。 */
  onBusyChange?: (busy: boolean) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState(0);

  // 档案清单（类别中文名与默认根目录的唯一数据源；具体跟随哪个档案由包内 profile_id 决定）
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);

  // 第 1 步：选包与校验
  const [pkgPath, setPkgPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<AppErrorPayload | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);

  // 第 3 步：恢复模式与目标根目录
  const [mode, setMode] = useState<ApplyMode>("incremental");
  const [targetRoot, setTargetRoot] = useState("");
  /** 目标根目录被手动编辑/浏览选择过后，打开新包时不再按包内档案重填。 */
  const targetDirtyRef = useRef(false);

  // 第 4 步：dry-run 计划
  const [plan, setPlan] = useState<ApplyPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<AppErrorPayload | null>(null);
  /** 冲突文件的处理选择：ov=备份后替换集合；mg=内容合并集合（merge 优先于 replace/keep）。 */
  const [conflictChoice, setConflictChoiceState] = useState<{ ov: Set<string>; mg: Set<string>}>({
    ov: new Set(),
    mg: new Set(),
  });
  const [confirmApply, setConfirmApply] = useState(false);

  // 第 5 步：执行与报告
  const [executing, setExecuting] = useState(false);
  const [report, setReport] = useState<ApplyReport | null>(null);
  const [applyError, setApplyError] = useState<AppErrorPayload | null>(null);
  /** 执行明细表展开全部开关（默认仅展示前 20 条，长表格页避免无限拉长）。 */
  const [showAllExecuted, setShowAllExecuted] = useState(false);

  // 第 6 步：路径适配（执行完成后进行，目标树此时已存在）
  const [detecting, setDetecting] = useState(false);
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [detectError, setDetectError] = useState<AppErrorPayload | null>(null);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [pathfixing, setPathfixing] = useState(false);
  const [pathfixReport, setPathfixReport] = useState<PathFixReport | null>(null);
  const [confirmPathfix, setConfirmPathfix] = useState(false);

  // 确认框与任务控制（0.3.0）
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);

  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const activeTask =
    step === 0 ? "open" : step === 3 ? "plan" : step === 4 ? "apply" : step === 5 ? "pathfix" : "";
  useProgress((p) => {
    if (p.task === activeTask) setProgress(p);
  });

  /** 执行中上报 App 锁导航；卸载时复位。 */
  const busy = opening || planning || executing || detecting || pathfixing;
  const onBusyChange = props.onBusyChange;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  /** 请求取消当前长任务（后端循环检查点抛 task_cancelled）。 */
  const doCancel = async () => {
    setConfirmCancel(false);
    try {
      await apiCall<boolean>(COMMANDS.cancelTask);
    } catch {
      // 取消请求失败不打扰（任务可能刚好已结束）
    }
  };

  // 预填包路径 + 加载档案清单
  useEffect(() => {
    let disposed = false;
    apiCall<{ default_output_dir: string }>(COMMANDS.loadSettings)
      .then((s) => {
        if (disposed) return;
        setPkgPath((prev) => prev || joinPath(s.default_output_dir, "迁移包.zam"));
      })
      .catch(() => {
        if (!disposed) toast.warning("默认输出目录加载失败，请点击选择迁移包文件。");
      });
    apiCall<ProfileSummary[]>(COMMANDS.listProfiles)
      .then((list) => {
        if (disposed) return;
        setProfiles(list);
        // 未选包前先以第一个档案根目录预填；打开包后按包内档案重填（见 openPackage）
        if (list[0]) setTargetRoot((prev) => prev || list[0].default_root);
      })
      .catch(() => {
        if (!disposed) toast.warning("档案清单加载失败，包内类别名将显示原始标识。");
      });
    return () => {
      disposed = true;
    };
  }, []);

  /** 类别名翻译用的档案：manifest 打开后按 profile_id 定位；旧包档案（codex/claude，
   *  产品收窄后不在 list_profiles）回退列表第一个——同名类别按 zcode 描述、独有类别
   *  显示原始 id（显示降级不影响解包；目标根推导已改走 resolve_target_root 命令）。 */
  const pkgProfile = useMemo(() => {
    if (!profiles || profiles.length === 0) return null;
    return profiles.find((p) => p.id === manifest?.profile_id) ?? profiles[0];
  }, [profiles, manifest]);

  /** 档案类别表（类别中文名的唯一数据源）：跟随包内档案。 */
  const categoryTable = useMemo(() => pkgProfile?.categories ?? [], [pkgProfile]);

  /** 目标根提示用的档案名：在产档案用展示名；旧包档案（不在 list_profiles，
   *  产品收窄后 codex/claude）标注"旧版"，避免误显示回退档案的名字。 */
  const pkgProfileLabel = useMemo(() => {
    if (!manifest) return "…";
    const inList = profiles?.some((p) => p.id === manifest.profile_id);
    return inList ? (pkgProfile?.display_name ?? "…") : `${manifest.profile_id}（旧版档案）`;
  }, [manifest, profiles, pkgProfile]);

  /** 选择迁移包文件（PathPicker 回调）：换包即作废已校验状态与全部后续产物
   *  （2026-11-09 审查 H4：改路径后旧"校验通过"卡片不再误导）。 */
  const pickPkgFile = (file: string) => {
    if (file === pkgPath) return;
    setPkgPath(file);
    setManifest(null);
    setPlan(null);
    setReport(null);
    setDetect(null);
    setOpenError(null);
    setApplyError(null);
  };

  const openPackage = () => {
    if (!pkgPath.trim()) return;
    setOpening(true);
    setOpenError(null);
    setProgress(null);
    apiCall<Manifest>(COMMANDS.openPackage, { path: pkgPath.trim() })
      .then((m) => {
        setManifest(m);
        // 解包目标默认按包内档案推导为本机资产根目录（如 ~/.codex）。产品收窄后
        // list_profiles 仅含 zcode，codex/claude 旧包的目标根改由后端
        // resolve_target_root 按已知档案全集推导（旧包兼容）；用户手动改过则不覆盖。
        if (!targetDirtyRef.current) {
          apiCall<string>(COMMANDS.resolveTargetRoot, { path: pkgPath.trim() })
            .then((root) => {
              setTargetRoot((prev) =>
                targetDirtyRef.current && prev.trim() ? prev : root,
              );
            })
            .catch(() => {
              // 推导失败不能静默停在错误目录（2026-11-09 审查 M5）：清空并让用户手选
              setTargetRoot((prev) =>
                targetDirtyRef.current && prev.trim() ? prev : "",
              );
              toast.warning("未能按包内档案自动定位恢复目录，请点击「选择文件夹」手动指定。");
            });
        }
      })
      .catch((e: unknown) =>
        setOpenError(isAppError(e) ? e : { code: "internal", message: "打开迁移包失败" }),
      )
      .finally(() => setOpening(false));
  };

  const runPlan = (ov: Set<string>, mg: Set<string>) => {
    setPlanning(true);
    setPlanError(null);
    apiCall<ApplyPlan>(COMMANDS.planApply, {
      path: pkgPath.trim(),
      mode,
      conflictOverrides: [...ov],
      targetRoot: targetRoot.trim(),
      mergeRelPaths: [...mg],
    })
      .then((p) => setPlan(p))
      .catch((e: unknown) =>
        setPlanError(isAppError(e) ? e : { code: "internal", message: "生成变更计划失败" }),
      )
      .finally(() => setPlanning(false));
  };

  const goPlanStep = () => {
    if (!targetRoot.trim()) {
      toast.warning("请先选择恢复目标目录（默认取包内档案的本机资产根目录）。");
      return;
    }
    setStep(3);
    runPlan(conflictChoice.ov, conflictChoice.mg);
  };

  /** 选择恢复目标目录（PathPicker 回调）；选择后视为手动指定，打开新包不再覆盖。 */
  const pickTargetRoot = (dir: string) => {
    setTargetRoot(dir);
    targetDirtyRef.current = true;
  };

  /** 冲突行三态改判：保留目标 / 备份后替换 / 内容合并（仅 .md/.json 可选合并），改判触发重新 plan。
   *  副作用（runPlan）保持在 setState updater 之外——updater 必须纯函数，
   *  StrictMode 下重复执行会双发 plan 请求（code review 2026-09-06）。 */
  const setConflictChoice = (targetRel: string, choice: "keep" | "replace" | "merge") => {
    const ov = new Set(conflictChoice.ov);
    const mg = new Set(conflictChoice.mg);
    if (choice === "replace") {
      ov.add(targetRel);
      mg.delete(targetRel);
    } else if (choice === "merge") {
      mg.add(targetRel);
      ov.delete(targetRel);
    } else {
      ov.delete(targetRel);
      mg.delete(targetRel);
    }
    setConflictChoiceState({ ov, mg });
    runPlan(ov, mg);
  };

  const setAllConflicts = (toReplace: boolean) => {
    const conflicts = (plan?.items ?? []).filter(
      (i) => i.action === "replace" || i.action === "keep",
    );
    const ov = toReplace ? new Set(conflicts.map((c) => c.target_rel)) : new Set<string>();
    const mg = new Set(conflictChoice.mg);
    for (const c of conflicts) mg.delete(c.target_rel);
    setConflictChoiceState({ ov, mg });
    runPlan(ov, mg);
  };

  const groups = useMemo(() => {
    const items = plan?.items ?? [];
    return {
      create: items.filter((i) => i.action === "create"),
      skip_same: items.filter((i) => i.action === "skip_same"),
      replace: items.filter((i) => i.action === "replace"),
      keep: items.filter((i) => i.action === "keep"),
      merge: items.filter((i) => i.action === "merge"),
    };
  }, [plan]);

  const writeBytes = useMemo(
    () => [...groups.create, ...groups.replace].reduce((s, i) => s + i.size, 0),
    [groups],
  );

  /** 执行核心（确认对话框后与失败重试共用；不再触发确认）。 */
  const executeCore = () => {
    if (!plan) return;
    setStep(4);
    setExecuting(true);
    setProgress(null);
    setApplyError(null);
    setShowAllExecuted(false);
    const confirmed: ApplyPlan = { ...plan, confirmed_overrides: [...conflictChoice.ov] };
    apiCall<ApplyReport>(COMMANDS.executeApply, { plan: confirmed })
      .then((r) => {
        setReport(r);
        addHistory({
          kind: "unpack",
          summary: `解包完成：校验 ${r.verified_files} 个文件`,
          location: r.target_root,
        });
        toast.success("解包执行完成，写入文件已逐文件校验无误。");
      })
      .catch((e: unknown) =>
        setApplyError(isAppError(e) ? e : { code: "internal", message: "执行失败" }),
      )
      .finally(() => setExecuting(false));
  };

  const executeApply = () => {
    setConfirmApply(false);
    executeCore();
  };

  /** 包内需要路径适配的文件数（来自 manifest 的逐文件标记）。 */
  const needsAdaptCount = useMemo(
    () => (manifest?.files ?? []).filter((f) => f.needs_path_adapt).length,
    [manifest],
  );

  const runDetect = () => {
    setDetecting(true);
    setDetectError(null);
    apiCall<DetectResult>(COMMANDS.detectPathMappings, {
      path: pkgPath.trim(),
      targetRoot: targetRoot.trim(),
    })
      .then((d) => {
        setDetect(d);
        setMappings(d.seeds.map((s) => ({ ...s, enabled: true })));
      })
      .catch((e: unknown) => {
        const err = isAppError(e) ? e : { code: "internal", message: "路径检出失败" };
        if (err.code === "task_cancelled") {
          toast.warning("已取消路径检出。");
        } else {
          setDetectError(err);
        }
      })
      .finally(() => setDetecting(false));
  };

  /** 进入路径适配步：执行完成后目标树已存在，此时检出才有意义。 */
  const goPathfixStep = () => {
    setStep(5);
    if (!detect) runDetect();
  };

  const enabledMappings = mappings.filter((m) => m.enabled && m.new.trim() && m.old !== m.new);

  const doPathfix = () => {
    setConfirmPathfix(false);
    setPathfixing(true);
    setProgress(null);
    // 契约：后端已移除 backup 参数，替换前必备份是后端红线
    apiCall<PathFixReport>(COMMANDS.applyPathMappings, {
      path: pkgPath.trim(),
      targetRoot: targetRoot.trim(),
      mappings: enabledMappings.map((m) => ({ old: m.old, new: m.new })),
    })
      .then((r) => {
        setPathfixReport(r);
        const n = r.replaced.reduce((s, x) => s + x.replacements, 0);
        toast.success(`路径替换完成：${r.replaced.length} 个文件、${n} 处替换，替换前已备份。`);
      })
      .catch((e: unknown) => {
        const err = isAppError(e) ? e : { code: "internal", message: "路径替换失败" };
        if (err.code === "task_cancelled") {
          toast.warning("已取消路径替换；已替换的文件保持现状。");
        } else {
          toast.error(err.message);
        }
      })
      .finally(() => setPathfixing(false));
  };

  /** 备份一键清理（2026-11-09 审查 M7）：只删最早一次时间戳备份，删除前确认。 */
  const doCleanup = async () => {
    setConfirmCleanup(false);
    if (!plan) return;
    try {
      const r = await apiCall<{ removed_dir: string; removed_files: number; remaining: number }>(
        COMMANDS.cleanupEarliestBackup,
        { targetRoot: plan.target_root },
      );
      toast.success(
        `已清理最早一次备份「${r.removed_dir}」（${r.removed_files} 个文件），剩余 ${r.remaining} 次。`,
      );
      // 重新生成计划以刷新备份超限提示
      runPlan(conflictChoice.ov, conflictChoice.mg);
    } catch (e: unknown) {
      toast.error(isAppError(e) ? e.message : "清理失败");
    }
  };

  /** 在系统资源管理器中打开备份目录。 */
  const revealBackup = async (p: string) => {
    try {
      await apiCall<boolean>(COMMANDS.revealPath, { path: p });
    } catch {
      toast.error("打开备份文件夹失败。");
    }
  };

  const manifestCategories = useMemo(() => {
    if (!manifest) return [];
    const map = new Map<string, { files: number; bytes: number; needAdapt: number }>();
    for (const f of manifest.files) {
      const cur = map.get(f.category) ?? { files: 0, bytes: 0, needAdapt: 0 };
      cur.files += 1;
      cur.bytes += f.size;
      if (f.needs_path_adapt) cur.needAdapt += 1;
      map.set(f.category, cur);
    }
    return [...map.entries()].map(([id, v]) => ({ id, ...v }));
  }, [manifest]);

  return (
    <section className="page" aria-labelledby="unpack-title">
      <header className="page-head">
        <h1 id="unpack-title">解包：把迁移包恢复到本机</h1>
        <p className="page-head-desc">
          选包并校验 → 内容预览 → 恢复模式 → 计划确认 → 执行与报告 → 路径适配。任何替换前先备份，两模式都不删目标文件。
        </p>
      </header>

      <WizardSteps steps={STEPS} current={step} />

      {/* 第 1 步：选包并校验 */}
      {step === 0 && (
        <div className="stack">
          {openError && (
            <Banner
              kind={openError.code === "task_cancelled" ? "warning" : "danger"}
              title={
                openError.code === "task_cancelled"
                  ? "已取消校验"
                  : `无法打开迁移包（${openError.code}）`
              }
              onClose={() => setOpenError(null)}
            >
              {openError.message}
            </Banner>
          )}
          <div className="card stack">
            <PathPicker
              kind="file"
              label="迁移包路径（.zam）"
              value={pkgPath}
              placeholder="点击选择要恢复的迁移包文件"
              onPick={pickPkgFile}
              hint="打开后会逐文件校验，确认包在拷贝过程中没有损坏。"
            />
            {opening && (
              <div className="stack">
                <ProgressBar progress={progress} idleText="正在打开迁移包…" />
                <div className="row">
                  <button type="button" className="btn" onClick={() => setConfirmCancel(true)}>
                    取消校验
                  </button>
                </div>
              </div>
            )}
            {!opening && (
              <div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!pkgPath.trim()}
                  onClick={openPackage}
                >
                  {manifest ? "重新校验" : "打开并校验"}
                </button>
                {manifest && (
                  <span className="muted" style={{ marginLeft: "var(--space-3)" }}>
                    已校验通过；换了文件或想再次核对时可重新校验。
                  </span>
                )}
              </div>
            )}
          </div>

          {manifest && (
            <div className="card stack">
              <div className="row">
                <h2 className="card-title" style={{ marginBottom: 0 }}>
                  包校验通过
                </h2>
                <StatusTag kind="success">完整性 OK</StatusTag>
              </div>
              <dl className="kv-grid">
                <div className="kv-item">
                  <dt>来源机器</dt>
                  <dd>
                    {manifest.source.hostname}（{manifest.source.os}/{manifest.source.arch}）
                  </dd>
                </div>
                <div className="kv-item">
                  <dt>来源用户</dt>
                  <dd className="mono">{manifest.source.username}</dd>
                </div>
                <div className="kv-item">
                  <dt>打包时间</dt>
                  <dd>{formatTime(manifest.created_at)}</dd>
                </div>
                <div className="kv-item">
                  <dt>文件数 / 体量</dt>
                  <dd>
                    {manifest.counts.files} 个 · {formatBytes(manifest.total_bytes)}
                  </dd>
                </div>
              </dl>
              {manifest.warnings.length > 0 && (
                <div>
                  <h3 className="card-sub" style={{ marginBottom: "var(--space-2)" }}>
                    打包时记录的警告（{manifest.warnings.length} 条）
                  </h3>
                  <ul className="warn-list">
                    {manifest.warnings.map((w) => (
                      <li key={w}>
                        <span className="warn-list-icon" aria-hidden="true">
                          <IconWarning size={12} />
                        </span>
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <footer className="wizard-footer">
            <button type="button" className="btn" onClick={props.onExit}>
              返回首页
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!manifest || opening}
              title={!manifest || opening ? "请先选择并校验迁移包" : undefined}
              onClick={() => setStep(1)}
            >
              下一步：预览内容
            </button>
          </footer>
        </div>
      )}

      {/* 第 2 步：内容预览 */}
      {step === 1 && manifest && (
        <div className="stack">
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>类别</th>
                  <th className="num">文件数</th>
                  <th className="num">体量</th>
                  <th className="center">路径适配</th>
                </tr>
              </thead>
              <tbody>
                {manifestCategories.map((c) => (
                  <tr key={c.id}>
                    <td>{categoryLabel(categoryTable, c.id)}</td>
                    <td className="num">{c.files}</td>
                    <td className="num">{formatBytes(c.bytes)}</td>
                    <td className="center">
                      {c.needAdapt > 0 ? (
                        <StatusTag kind="info">{c.needAdapt} 个文件需要</StatusTag>
                      ) : (
                        <SkipTag>不需要</SkipTag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="secondary">
            标记「需要路径适配」的文件内含旧电脑的完整路径；解包执行完成后，最后一步会生成逐条确认的替换建议。
          </p>
          <footer className="wizard-footer">
            <button type="button" className="btn" onClick={() => setStep(0)}>
              上一步
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
              下一步：选择恢复模式
            </button>
          </footer>
        </div>
      )}

      {/* 第 3 步：恢复模式 */}
      {step === 2 && (
        <div className="stack">
          <div className="card stack">
            <h2 className="card-title">恢复模式</h2>
            <div className="choice-grid" role="group" aria-label="恢复模式">
              <button
                type="button"
                className="choice-card"
                aria-pressed={mode === "overwrite"}
                onClick={() => setMode("overwrite")}
              >
                {mode === "overwrite" && (
                  <span className="choice-card-check" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                )}
                <span className="choice-card-title">
                  覆盖模式
                  <span className="choice-card-warn-icon" aria-hidden="true">
                    <IconWarning size={14} />
                  </span>
                </span>
                <span className="choice-card-desc">
                  目标已存在且内容不同的文件：先备份到备份文件夹（zam-backups），再用包内版本替换。
                </span>
              </button>
              <button
                type="button"
                className="choice-card"
                aria-pressed={mode === "incremental"}
                onClick={() => setMode("incremental")}
              >
                {mode === "incremental" && (
                  <span className="choice-card-check" aria-hidden="true">
                    <IconCheck size={14} />
                  </span>
                )}
                <span className="choice-card-title">增量模式（默认更稳）</span>
                <span className="choice-card-desc">
                  冲突文件默认保留目标不动，可在下一步计划里逐条改判为替换；.md/.json
                  文件还可改判为「内容合并」，两边内容都保留。
                </span>
              </button>
            </div>
            <p className="secondary">
              两种模式都不会删除目标机器上的任何文件；内容一致的一律跳过。
            </p>

            <PathPicker
              kind="dir"
              label="恢复目标目录"
              value={targetRoot}
              placeholder="点击选择恢复到哪个文件夹"
              onPick={pickTargetRoot}
              hint={`资产会恢复到这里。默认取包内档案（${pkgProfileLabel}）在本机的资产根目录，确认无误即可，一般无需修改。`}
            />
          </div>

          <footer className="wizard-footer">
            <button type="button" className="btn" onClick={() => setStep(1)}>
              上一步
            </button>
            <button type="button" className="btn btn-primary" onClick={goPlanStep}>
              下一步：生成变更计划
            </button>
          </footer>
        </div>
      )}

      {/* 第 4 步：dry-run 计划确认 */}
      {step === 3 && (
        <div className="stack">
          {plan?.backup_cleanup_hint && (
            <Banner
              kind="warning"
              title="备份目录超出保留上限"
              actions={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setConfirmCleanup(true)}
                >
                  清理最早一次备份
                </button>
              }
            >
              {plan.backup_cleanup_hint}
            </Banner>
          )}
          {planError && (
            <Banner
              kind={planError.code === "task_cancelled" ? "warning" : "danger"}
              title={planError.code === "task_cancelled" ? "已取消" : "生成变更计划失败"}
              onClose={() => setPlanError(null)}
              actions={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => runPlan(conflictChoice.ov, conflictChoice.mg)}
                >
                  重新生成计划
                </button>
              }
            >
              {planError.message}
            </Banner>
          )}
          {planning && (
            <div className="stack">
              <ProgressBar progress={progress} idleText="正在生成变更计划…" />
              <div className="row">
                <button type="button" className="btn" onClick={() => setConfirmCancel(true)}>
                  取消
                </button>
              </div>
            </div>
          )}

          {plan && !planning && (
            <div className="card stack">
              <p className="secondary">
                以下是试运行计划，<strong>尚未写入任何文件</strong>
                。确认无误后点「执行解包」才会真正改动目标目录。
              </p>

              <div>
                <div className="group-head">
                  <h3>新增文件</h3>
                  <span className="count-badge count-badge-accent">{groups.create.length}</span>
                  <StatusTag kind="success">create</StatusTag>
                </div>
                <ItemList items={groups.create} empty="没有需要新增的文件" />
              </div>

              <div>
                <div className="group-head">
                  <h3>内容一致，跳过</h3>
                  <span className="count-badge">{groups.skip_same.length}</span>
                  <StatusTag kind="neutral">skip_same</StatusTag>
                </div>
                <ItemList items={groups.skip_same} empty="没有内容一致的文件" />
              </div>

              <div>
                <div className="group-head">
                  <h3>冲突：备份后替换</h3>
                  <span className="count-badge count-badge-accent">{groups.replace.length}</span>
                  <StatusTag kind="danger">replace</StatusTag>
                  {mode === "incremental" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setAllConflicts(true)}
                    >
                      整组改判为替换
                    </button>
                  )}
                </div>
                <ConflictList
                  items={groups.replace}
                  current="replace"
                  onChange={setConflictChoice}
                  empty="没有标记为替换的冲突文件"
                />
              </div>

              <div>
                <div className="group-head">
                  <h3>冲突：内容合并（两边内容都保留）</h3>
                  <span className="count-badge count-badge-accent">{groups.merge.length}</span>
                  <StatusTag kind="info">merge</StatusTag>
                </div>
                <MergeList
                  items={groups.merge}
                  onUnmerge={(rel) => setConflictChoice(rel, "keep")}
                  empty="没有勾选内容合并的冲突文件"
                />
              </div>

              <div>
                <div className="group-head">
                  <h3>冲突：保留目标</h3>
                  <span className="count-badge">{groups.keep.length}</span>
                  <StatusTag kind="warning">keep</StatusTag>
                  {mode === "incremental" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setAllConflicts(false)}
                    >
                      整组改判为保留
                    </button>
                  )}
                </div>
                <ConflictList
                  items={groups.keep}
                  current="keep"
                  onChange={setConflictChoice}
                  empty="没有保留目标的冲突文件"
                />
              </div>
            </div>
          )}

          <footer className="wizard-footer">
            <button type="button" className="btn" onClick={() => setStep(2)}>
              上一步
            </button>
            <div className="wizard-footer-stats" aria-live="polite">
              {plan && (
                <span>
                  新增 {groups.create.length} · 跳过 {groups.skip_same.length} · 替换{" "}
                  {groups.replace.length} · 合并 {groups.merge.length} · 保留 {groups.keep.length}{" "}
                  · 写入体量 {formatBytes(writeBytes)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!plan || planning}
              title={!plan || planning ? "请等待变更计划生成" : undefined}
              onClick={() => setConfirmApply(true)}
            >
              执行解包
            </button>
          </footer>
        </div>
      )}

      {/* 第 5 步：执行与报告 */}
      {step === 4 && (
        <div className="stack">
          {applyError && (
            <Banner
              kind={applyError.code === "task_cancelled" ? "warning" : "danger"}
              title={
                applyError.code === "task_cancelled"
                  ? "已取消执行"
                  : `执行失败（${applyError.code}）`
              }
              actions={
                <>
                  <button type="button" className="btn btn-sm" onClick={executeCore}>
                    {applyError.code === "task_cancelled" ? "继续执行" : "重新执行"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setApplyError(null);
                      setStep(2);
                    }}
                  >
                    返回修改
                  </button>
                </>
              }
            >
              {applyError.message}
              {applyError.code === "task_cancelled"
                ? " 已写入的文件保持现状，未写入的不再继续。"
                : " 已写入的文件保持现状，备份目录可用于恢复。"}
            </Banner>
          )}
          {!report && (
            <div className="card stack">
              <h2 className="card-title">正在执行解包</h2>
              <ProgressBar progress={progress} idleText="正在准备执行…" />
              {executing && (
                <div className="row">
                  <button type="button" className="btn" onClick={() => setConfirmCancel(true)}>
                    取消执行
                  </button>
                  <span className="muted">取消后已写入的文件保留在目标目录。</span>
                </div>
              )}
            </div>
          )}
          {report && (
            <div className="card stack">
              <div className="row">
                <h2 className="card-title" style={{ marginBottom: 0 }}>
                  解包完成
                </h2>
                <StatusTag kind="success">校验通过</StatusTag>
              </div>
              <dl className="kv-grid">
                <div className="kv-item">
                  <dt>成功写入</dt>
                  <dd>{report.executed.filter((i) => i.status === "ok").length} 个</dd>
                </div>
                <div className="kv-item">
                  <dt>跳过</dt>
                  <dd>{report.executed.filter((i) => i.status === "skipped").length} 个</dd>
                </div>
                <div className="kv-item">
                  <dt>校验文件数</dt>
                  <dd>{report.verified_files} 个</dd>
                </div>
                <div className="kv-item">
                  <dt>备份目录</dt>
                  <dd className="mono">{report.backup_dir ?? "本次无替换，未产生备份"}</dd>
                </div>
              </dl>
              {report.backup_dir && (
                <div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void revealBackup(report.backup_dir!)}
                  >
                    打开备份文件夹
                  </button>
                </div>
              )}
              <div className="table-shell">
                <table className="data-table" aria-label="执行明细">
                  <thead>
                    <tr>
                      <th>文件</th>
                      <th className="center">动作</th>
                      <th className="center">结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAllExecuted ? report.executed : report.executed.slice(0, 20)).map((i) => (
                      <tr key={i.target_rel}>
                        <td className="mono">{i.target_rel}</td>
                        <td className="center">{actionLabel(i.action)}</td>
                        <td className="center">
                          {i.status === "ok" ? (
                            <StatusTag kind="success">成功</StatusTag>
                          ) : (
                            <SkipTag>跳过</SkipTag>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.executed.length > 20 && (
                <div className="list-more">
                  <span className="muted">
                    {showAllExecuted
                      ? `已展示全部 ${report.executed.length} 条`
                      : `仅展示前 20 条，共 ${report.executed.length} 条。`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowAllExecuted((v) => !v)}
                  >
                    {showAllExecuted ? "收起" : `展开全部 ${report.executed.length} 条`}
                  </button>
                </div>
              )}
            </div>
          )}
          <footer className="wizard-footer">
            <button type="button" className="btn" onClick={props.onExit} disabled={executing}>
              回到首页
            </button>
            {executing && (
              <button type="button" className="btn btn-primary" disabled>
                正在执行…
              </button>
            )}
            {!executing && report && (
              <button type="button" className="btn btn-primary" onClick={goPathfixStep}>
                下一步：路径适配{needsAdaptCount > 0 ? `（${needsAdaptCount} 个文件需要）` : ""}
              </button>
            )}
          </footer>
        </div>
      )}

      {/* 第 6 步：路径适配（执行完成后，目标树已存在） */}
      {step === 5 && (
        <div className="stack">
          <div className="card stack">
            <div className="row">
              <h2 className="card-title" style={{ marginBottom: 0 }}>
                路径适配（旧机完整路径 → 本机）
              </h2>
              {detecting && <StatusTag kind="info">正在检出…</StatusTag>}
            </div>
            {detecting && (
              <div className="row">
                <button type="button" className="btn" onClick={() => setConfirmCancel(true)}>
                  取消检测
                </button>
              </div>
            )}
            <p className="secondary">
              文件已写入目标目录，现在检测其中的旧电脑完整路径并逐条确认替换；只处理文本类文件，且替换前会先备份。
            </p>

            {needsAdaptCount === 0 && (
              <EmptyState
                title="本包无需路径适配"
                reason="迁移包内没有任何文件被标记为需要路径适配（不含旧电脑完整路径的文本资产）。"
                nextStep="直接回到首页，本次解包已全部完成。"
              />
            )}

            {needsAdaptCount > 0 && !detect && detectError && !detecting && (
              <Banner
                kind="danger"
                title="路径检出失败"
                actions={
                  <button type="button" className="btn btn-sm" onClick={runDetect}>
                    重新检测
                  </button>
                }
              >
                {detectError.message}
              </Banner>
            )}

            {needsAdaptCount > 0 && detect && (
              <>
                <div className="table-shell">
                  <table className="data-table" aria-label="路径替换建议清单">
                    <thead>
                      <tr>
                        <th className="center">启用</th>
                        <th>旧机路径串</th>
                        <th>替换为（可编辑）</th>
                        <th className="num">将替换处数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mappings.map((m) => (
                        <tr key={m.old}>
                          <td className="center">
                            <input
                              type="checkbox"
                              checked={m.enabled}
                              aria-label={`启用映射 ${m.old}`}
                              onChange={(e) =>
                                setMappings((prev) =>
                                  prev.map((x) =>
                                    x.old === m.old ? { ...x, enabled: e.target.checked } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="mono">{m.old}</td>
                          <td>
                            <input
                              className="inline-input"
                              value={m.new}
                              aria-label={`映射 ${m.old} 的新路径`}
                              onChange={(e) =>
                                setMappings((prev) =>
                                  prev.map((x) =>
                                    x.old === m.old ? { ...x, new: e.target.value } : x,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="num">{m.total_hits}</td>
                        </tr>
                      ))}
                      {mappings.length === 0 && (
                        <tr>
                          <td colSpan={4} className="secondary">
                            未检出旧电脑的完整路径，无需适配。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {detect.files.some((f) => f.skipped_reason) && (
                  <div className="table-shell">
                    <table className="data-table" aria-label="被跳过的文件">
                      <thead>
                        <tr>
                          <th>文件</th>
                          <th>跳过原因</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detect.files
                          .filter((f) => f.skipped_reason)
                          .map((f) => (
                            <tr key={f.target_rel}>
                              <td className="mono">{f.target_rel}</td>
                              <td>
                                {/* 界面只显示大白话结论；后端返回的原始技术原因放 title 悬浮 */}
                                <span
                                  className="field-error"
                                  style={{ color: "var(--color-warning)" }}
                                  title={f.skipped_reason ?? undefined}
                                >
                                  <IconWarning size={14} /> 特殊格式，为安全起见已跳过
                                </span>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {pathfixReport && (
                  <Banner
                    kind="success"
                    title={`路径替换完成：${pathfixReport.replaced.length} 个文件已替换`}
                    onClose={() => setPathfixReport(null)}
                  >
                    {pathfixReport.backup_dir && `替换前已备份到 ${pathfixReport.backup_dir}。`}
                    {pathfixReport.skipped.length > 0 &&
                      `另有 ${pathfixReport.skipped.length} 个文件因格式特殊跳过（见上表）。`}
                  </Banner>
                )}

                {pathfixing && (
                  <div className="stack">
                    <ProgressBar progress={progress} idleText="正在执行路径替换…" />
                    <div className="row">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setConfirmCancel(true)}
                      >
                        取消替换
                      </button>
                      <span className="muted">取消后已替换的文件保持现状。</span>
                    </div>
                  </div>
                )}

                {!pathfixReport && !pathfixing && (
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={enabledMappings.length === 0}
                      title={
                        enabledMappings.length === 0
                          ? "没有启用的路径映射，无可替换内容"
                          : undefined
                      }
                      onClick={() => setConfirmPathfix(true)}
                    >
                      确认并执行路径替换（{enabledMappings.length} 条映射）
                    </button>
                    <span className="muted">也可不做替换，直接回到首页结束。</span>
                  </div>
                )}
              </>
            )}
          </div>

          <footer className="wizard-footer">
            <button
              type="button"
              className="btn"
              onClick={() => setStep(4)}
              disabled={pathfixing}
            >
              上一步：查看执行报告
            </button>
            <button
              type="button"
              className="btn"
              disabled={pathfixing}
              onClick={() => {
                // 未执行替换（且有可执行映射）时先确认，防误点结束漏掉关键一步
                if (!pathfixReport && enabledMappings.length > 0) {
                  setConfirmFinish(true);
                  return;
                }
                props.onExit();
              }}
            >
              完成，回到首页
            </button>
          </footer>
        </div>
      )}

      {/* 路径替换确认对话框（高风险动作） */}
      <ConfirmDialog
        open={confirmPathfix}
        title="确认执行路径替换？"
        danger
        points={[
          {
            label: "对象",
            text: `${enabledMappings.length} 条路径映射，作用于已写入目标目录的文本资产`,
          },
          {
            label: "影响",
            text: `预计替换 ${enabledMappings.reduce((s, m) => s + m.total_hits, 0)} 处旧电脑的完整路径`,
          },
          { label: "后果", text: "替换写入目标文件前会先备份；特殊格式的文件为安全起见自动跳过" },
          { label: "目标状态", text: "文本资产中的旧电脑路径替换为本机路径，编码保持不变" },
        ]}
        confirmText="确认替换"
        onConfirm={doPathfix}
        onCancel={() => setConfirmPathfix(false)}
      />

      {/* 执行解包确认对话框（高风险动作） */}
      <ConfirmDialog
        open={confirmApply}
        title="确认执行解包计划？"
        danger={groups.replace.length > 0}
        points={[
          {
            label: "目标根目录",
            text: targetRoot,
          },
          {
            // 精简为四行：原「对象」行并入「影响」行首（少一行不丢信息）
            label: "影响",
            text: `迁移包共 ${plan?.items.length ?? 0} 个文件：新增 ${groups.create.length} 个、替换 ${groups.replace.length} 个（先备份）、内容合并 ${groups.merge.length} 个（先备份）、跳过 ${groups.skip_same.length} 个、保留 ${groups.keep.length} 个`,
          },
          {
            label: "后果",
            text:
              groups.replace.length > 0 || groups.merge.length > 0
                ? "被替换与被合并的目标文件会先备份到备份文件夹，可从备份恢复；本操作不删除任何目标文件"
                : "只新增文件，不改动任何已有内容",
          },
          {
            label: "目标状态",
            text:
              mode === "overwrite"
                ? "目标目录内容与迁移包一致（冲突已备份替换）"
                : "目标目录补充迁移包新增内容，冲突文件按你的逐条选择处理",
          },
        ]}
        confirmText="确认执行"
        onConfirm={executeApply}
        onCancel={() => setConfirmApply(false)}
      />

      {/* 取消当前长任务确认（校验/计划/执行/检出/替换共用） */}
      <ConfirmDialog
        open={confirmCancel}
        title="取消当前操作？"
        points={[
          { label: "影响", text: "放弃当前进行中的操作；解包已写入的文件会保留在目标目录。" },
          { label: "之后", text: "可从失败提示里的按钮重试或返回修改。" },
        ]}
        confirmText="取消操作"
        onConfirm={() => void doCancel()}
        onCancel={() => setConfirmCancel(false)}
      />

      {/* 清理最早一次备份确认（删除不可恢复，只删时间戳目录） */}
      <ConfirmDialog
        open={confirmCleanup}
        title="清理最早一次备份？"
        danger
        points={[
          {
            label: "对象",
            text: `恢复目录下备份文件夹中时间最早的一次备份（仅删除形如「年月日-时分秒」的备份目录）`,
          },
          { label: "影响", text: "该备份目录及其全部文件将被永久删除，删除后不可恢复。" },
          { label: "建议", text: "确认不再需要从该次备份还原后再清理。" },
        ]}
        confirmText="删除该备份"
        onConfirm={() => void doCleanup()}
        onCancel={() => setConfirmCleanup(false)}
      />

      {/* 未执行路径替换就结束的拦截确认 */}
      <ConfirmDialog
        open={confirmFinish}
        title="还没执行路径替换，确定结束？"
        danger
        points={[
          {
            label: "现状",
            text: `已检出 ${enabledMappings.length} 条可替换的旧机路径映射，尚未执行替换。`,
          },
          {
            label: "后果",
            text: "目标文件里保留旧电脑的路径，相关配置在新电脑上可能无法直接使用。",
          },
          { label: "建议", text: "点取消回到页面，先执行路径替换再结束。" },
        ]}
        confirmText="仍然结束"
        onConfirm={() => {
          setConfirmFinish(false);
          props.onExit();
        }}
        onCancel={() => setConfirmFinish(false)}
      />
    </section>
  );
}

function actionLabel(action: string): string {
  switch (action) {
    case "create":
      return "新增";
    case "skip_same":
      return "内容一致";
    case "replace":
      return "备份后替换";
    case "keep":
      return "保留目标";
    case "merge":
      return "内容合并";
    default:
      return action;
  }
}

/** 合并预览摘要（按策略展示统计）。 */
function mergePreviewSummary(item: PlanItem): string {
  const p = item.merge?.preview;
  if (!p) return "";
  if (p.strategy === "markdown") {
    return `追加旧机 ${p.appended} 行（两边内容都保留，重复行去重）`;
  }
  const conflicts = p.scalar_conflicts.length;
  return `新增 ${p.added_keys.length} 个字段${conflicts > 0 ? ` · ${conflicts} 处同字段冲突取旧机值` : ""}`;
}

/** 普通计划行列表（新增/跳过组）。默认仅渲染前 10 条，可展开全部/收起。 */
function ItemList(props: {
  items: { target_rel: string; size: number }[];
  empty: string;
}) {
  // useState 置于早退 return 之前，保证 Hook 调用顺序稳定
  const [expanded, setExpanded] = useState(false);
  if (props.items.length === 0) return <p className="muted">{props.empty}</p>;
  const shown = expanded ? props.items : props.items.slice(0, 10);
  return (
    <div className="table-shell">
      <table className="data-table">
        <tbody>
          {shown.map((i) => (
            <tr key={i.target_rel}>
              <td className="mono">{i.target_rel}</td>
              <td className="num">{formatBytes(i.size)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.items.length > 10 && (
        <div className="list-more">
          <span className="muted">
            {expanded
              ? `已展示全部 ${props.items.length} 条`
              : `仅展示前 10 条，共 ${props.items.length} 条。`}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "收起" : `展开全部 ${props.items.length} 条`}
          </button>
        </div>
      )}
    </div>
  );
}

/** 冲突组行列表：每行带「保留目标 / 备份后替换 / 内容合并」三态切换，改判触发重新 plan。
 *  「内容合并」仅对引擎支持的类型（.md/.json）展示（判定与引擎 mergeStrategyFor 同源）。 */
function ConflictList(props: {
  items: PlanItem[];
  current: "keep" | "replace";
  onChange: (targetRel: string, choice: "keep" | "replace" | "merge") => void;
  empty: string;
}) {
  if (props.items.length === 0) return <p className="muted">{props.empty}</p>;
  return (
    <div className="table-shell">
      <table className="data-table">
        <tbody>
          {props.items.map((i) => (
            <tr key={i.target_rel}>
              <td className="mono">{i.target_rel}</td>
              <td className="num">{formatBytes(i.size)}</td>
              <td>
                <div
                  className="segmented"
                  role="group"
                  aria-label={`冲突文件 ${i.target_rel} 的处理方式`}
                >
                  <button
                    type="button"
                    aria-pressed={props.current === "keep"}
                    onClick={() => props.onChange(i.target_rel, "keep")}
                  >
                    保留目标
                  </button>
                  <button
                    type="button"
                    aria-pressed={props.current === "replace"}
                    onClick={() => props.onChange(i.target_rel, "replace")}
                  >
                    备份后替换
                  </button>
                  {mergeStrategyFor(i.target_rel) && (
                    <button
                      type="button"
                      onClick={() => props.onChange(i.target_rel, "merge")}
                    >
                      内容合并
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 合并组行列表：展示合并预览摘要，可取消合并（回到保留目标）。 */
function MergeList(props: {
  items: PlanItem[];
  onUnmerge: (targetRel: string) => void;
  empty: string;
}) {
  if (props.items.length === 0) return <p className="muted">{props.empty}</p>;
  return (
    <div className="table-shell">
      <table className="data-table">
        <tbody>
          {props.items.map((i) => (
            <tr key={i.target_rel}>
              <td className="mono">{i.target_rel}</td>
              <td className="num">{formatBytes(i.size)}</td>
              <td>
                <span className="secondary">{mergePreviewSummary(i)}</span>
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => props.onUnmerge(i.target_rel)}
                >
                  取消合并
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
