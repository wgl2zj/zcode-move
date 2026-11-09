// 应用根组件：左侧导航边栏 + 右侧内容区的全局骨架，状态路由四个页面。
import { useState } from "react";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import { ToastProvider } from "./components/Toast";
import { IconHome, IconPack, IconSettings, IconUnpack } from "./components/icons";
import { HomePage } from "./pages/HomePage";
import { PackWizard } from "./pages/PackWizard";
import { UnpackWizard } from "./pages/UnpackWizard";
import { SettingsPage } from "./pages/SettingsPage";

export type Route = "home" | "pack" | "unpack" | "settings";

const NAV: { id: Route; label: string; icon: (p: { size?: number }) => React.ReactNode }[] = [
  { id: "home", label: "首页", icon: (p) => <IconHome {...p} /> },
  { id: "pack", label: "打包", icon: (p) => <IconPack {...p} /> },
  { id: "unpack", label: "解包", icon: (p) => <IconUnpack {...p} /> },
  { id: "settings", label: "设置", icon: (p) => <IconSettings {...p} /> },
];

function App() {
  const [route, setRoute] = useState<Route>("home");
  // 向导从首页/导航重新进入时重置内部状态（key 变化触发重挂载）
  const [wizardEpoch, setWizardEpoch] = useState(0);
  // 长任务执行中锁定导航（2026-11-09 审查 H2）：离开会让任务失去界面跟踪，
  // 且重进向导可对同一目标重复发起任务；出口是进度区的「取消」按钮
  const [taskBusy, setTaskBusy] = useState(false);
  const navigate = (r: Route) => {
    if (taskBusy) return;
    if (r === route) return;
    setWizardEpoch((n) => n + 1);
    setRoute(r);
  };

  return (
    <ToastProvider>
      <div className="app-shell">
        <nav className="sidebar" aria-label="主导航">
          <div className="brand">
            <span className="brand-name">zcode-move</span>
            <span className="brand-sub">ZCode 配置备份与转移工具</span>
          </div>
          <ul className="nav-list">
            {NAV.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={route === item.id ? "page" : undefined}
                  disabled={taskBusy}
                  title={taskBusy ? "任务执行中，暂不能切换页面（可先取消任务）" : undefined}
                  onClick={() => navigate(item.id)}
                >
                  {item.icon({ size: 18 })}
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="content">
          {route === "home" && <HomePage onNavigate={navigate} />}
          {route === "pack" && (
            <PackWizard
              key={`pack-${wizardEpoch}`}
              onExit={() => navigate("home")}
              onBusyChange={setTaskBusy}
            />
          )}
          {route === "unpack" && (
            <UnpackWizard
              key={`unpack-${wizardEpoch}`}
              onExit={() => navigate("home")}
              onBusyChange={setTaskBusy}
            />
          )}
          {route === "settings" && <SettingsPage />}
        </main>
      </div>
    </ToastProvider>
  );
}

export default App;
