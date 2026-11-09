// 设置页：默认输出目录（可保存到后端）+ 备份策略只读说明 + 档案管理只读表。
import { useEffect, useState } from "react";
import {
  COMMANDS,
  type AppErrorPayload,
  type ProfileSummary,
  type Settings,
} from "../lib/ipc";
import { apiCall } from "../lib/mock";
import { Banner } from "../components/Banner";
import { StatusTag } from "../components/StatusTag";
import { useToast } from "../components/Toast";
import { IconWarning } from "../components/icons";
import { PathPicker } from "../components/PathPicker";

function isAppError(e: unknown): e is AppErrorPayload {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [outputDir, setOutputDir] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  /** 档案清单加载（挂载与"重试"共用）；失败显示错误与重试入口，不再静默。 */
  const loadProfiles = () => {
    apiCall<ProfileSummary[]>(COMMANDS.listProfiles)
      .then((list) => {
        setProfiles(list);
        setProfilesError(null);
      })
      .catch((e: unknown) => {
        setProfilesError(isAppError(e) ? e.message : "档案清单加载失败");
      });
  };

  useEffect(() => {
    let disposed = false;
    apiCall<Settings>(COMMANDS.loadSettings)
      .then((s) => {
        if (disposed) return;
        setSettings(s);
        setOutputDir(s.default_output_dir);
      })
      .catch((e: unknown) => {
        if (!disposed) setLoadError(isAppError(e) ? e.message : "设置加载失败");
      });
    loadProfiles();
    apiCall<{ version: string }>(COMMANDS.appInfo)
      .then((i) => {
        if (!disposed) setVersion(i.version);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const save = () => {
    if (!outputDir.trim()) {
      setDirError("默认输出目录不能为空");
      return;
    }
    setSaving(true);
    const next: Settings = { ...(settings ?? { default_output_dir: "" }), default_output_dir: outputDir.trim() };
    apiCall<void>(COMMANDS.saveSettings, { settings: next })
      .then(() => {
        setSettings(next);
        toast.success("默认输出目录已保存。");
      })
      .catch((e: unknown) => {
        toast.error(isAppError(e) ? e.message : "保存失败");
      })
      .finally(() => setSaving(false));
  };

  /** 选择目录回调（PathPicker）；取消不改动当前值。 */
  const pickDir = (dir: string) => {
    setOutputDir(dir);
    setDirError(null);
  };

  const dirty = settings !== null && outputDir.trim() !== settings.default_output_dir;

  return (
    <section className="page" aria-labelledby="settings-title">
      <header className="page-head">
        <h1 id="settings-title">设置</h1>
        <p className="page-head-desc">迁移默认值与策略说明{version ? ` · 版本 v${version}` : ""}</p>
      </header>

      {loadError && (
        <Banner kind="danger" title="设置加载失败" onClose={() => setLoadError(null)}>
          {loadError}
        </Banner>
      )}

      <div className="card stack">
        <h2 className="card-title">默认输出目录</h2>
        <div className="field">
          <PathPicker
            kind="dir"
            label="迁移包默认保存到"
            value={outputDir}
            placeholder="点击选择文件夹"
            onPick={pickDir}
            hint="打包向导的「保存到哪个文件夹」会用这个目录预填，仍可逐次修改。"
          />
          {dirError && (
            <p className="field-error" id="default-output-dir-error" role="alert">
              <IconWarning size={14} /> {dirError}
            </p>
          )}
        </div>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "正在保存…" : "保存设置"}
          </button>
          {dirty && <span className="muted">有未保存的修改</span>}
        </div>
      </div>

      <div className="card stack">
        <h2 className="card-title">备份策略（只读）</h2>
        <p className="secondary">
          解包时凡是「替换已存在文件」，都会先把目标文件备份到
          <span className="mono"> 目标根目录\zam-backups\时间戳\ </span>
          下，可从备份手动恢复。
        </p>
        <p className="secondary">
          备份目录保留最近 5 次执行记录；超出后不会静默删除，会在下次执行前提示你手动清理。
        </p>
      </div>

      <div className="card stack">
        <h2 className="card-title">资产档案（只读）</h2>
        <p className="secondary">
          仅内置实测过的 ZCode 档案（档案格式 v2）；新软件需要实测确认路径与策略后才会入档。
        </p>
        <div className="table-shell">
          <table className="data-table">
            <thead>
              <tr>
                <th>软件</th>
                <th className="center">档案版本</th>
                <th className="num">类别数</th>
                <th>默认根目录</th>
                <th className="center">状态</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id}>
                  <td>{p.display_name}</td>
                  <td className="center">v{p.version}</td>
                  <td className="num">{p.category_count}</td>
                  <td className="mono">{p.default_root}</td>
                  <td className="center">
                    <StatusTag kind="success">可用</StatusTag>
                  </td>
                </tr>
              ))}
              {profilesError && (
                <tr>
                  <td colSpan={5} className="secondary">
                    档案清单加载失败：{profilesError}{" "}
                    <button type="button" className="btn btn-sm" onClick={loadProfiles}>
                      重试
                    </button>
                  </td>
                </tr>
              )}
              {profiles.length === 0 && !profilesError && (
                <tr>
                  <td colSpan={5} className="secondary">
                    正在加载档案…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
