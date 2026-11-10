# VERSION_HISTORY.md — 版本历史

> 依据 `.rules/DOCUMENTATION.md`「文档职责」设立：记录上线（打 tag、发布 GitHub Release）、架构迁移和版本验证，不承担待办清单职责。
> 条目按时间正序排列；每条附可定位证据（提交哈希或 Release 链接）；不写会随开发增长而过期的数量。

## v0.1.6

| 日期 | 事件 | 证据 |
|---|---|---|
| 2026-08-18 | 开源基线首发：资产摆渡（AgentFerry）agent 软件个人资产迁移工具，初版为 Rust 引擎 + Tauri v2 + React 19，MIT License（提交历史经用户要求清理，仅保留基线起点） | 提交 `33abfb1` |
| 2026-09-05 | 架构迁移：Rust 引擎整体替换为 TypeScript（Electron 主进程），React 前端零改动；选型经用户当日确认 | 提交 `60f4f44` |
| 2026-09-05 | 去除 Electron 默认英文菜单，对齐 Tauri 版无菜单栏形态（截图验收通过） | 提交 `c920a06` |
| 2026-09-06 | 新增内容级合并：解包冲突文件支持「两边内容都保留」（Markdown 行并集 / JSON 深合并，逐文件勾选，JSON 冲突以旧机包为准） | 提交 `012a4ed` |
| 2026-09-06 | code review 修复：类型镜像单源化、守卫测试换岗、updater 纯函数化 | 提交 `54088db` |
| 2026-09-06 | src-tauri 移除，架构切换收尾（六项清单经用户确认执行） | 提交 `209d63d` |

## v0.2.0

| 日期 | 事件 | 证据 |
|---|---|---|
| 2026-10-13 | ZCode 档案 v2：类别 15→26（新增 9 类复刻必需配置、内嵌凭据字段点名警告、checkpoints/会话可视化入完整档、运行痕迹排除增补） | 提交 `bf42b79` |
| 2026-10-13 | 产品收窄为仅 ZCode：注册中心单档案；codex/claude 档案定义保留，旧迁移包仍可解包（目标根推导兼容） | 提交 `98a5e3c` |
| 2026-10-14 | 定位与复勘文档：README 改写、可行性研究复勘章节、功能地图档案条目同步、v1 spec 加"已替代"标注 | 提交 `24015b7` |
| 2026-10-14 | 安装包链路建立：electron-builder（NSIS x64）+ `build:installer` 一键命令，产物 `release/`（不入库）；配置契约由 electron/packaging.test.ts 锁定 | 提交 `439ab83` |
| 2026-11-09 | 程序与开源仓库更名：AgentFerry → zcode-move（窗口/界面/安装包名/appId/桌面桥名统一），安装包按新名重建，仓库同步改名 wgl2zj/zcode-move | 提交见本轮 git log |
| 2026-11-09 | 发布 v0.2.0：GitHub Release 附 Windows 安装包 zcode-move-Setup-0.2.0.exe | [Release v0.2.0](https://github.com/wgl2zj/zcode-move/releases/tag/v0.2.0) |

## v0.2.1

| 日期 | 事件 | 证据 |
|---|---|---|
| 2026-11-09 | 安装器改为向导式：oneClick=false 且允许自选安装目录（per-user 免管理员不变；静默安装 `/S /D=路径` 不受影响）；契约测试新增向导式三断言 | 提交见本轮 git log |

## v0.3.0

| 日期 | 事件 | 证据 |
|---|---|---|
| 2026-11-09 | 盘点进度反馈补齐（用户实测反馈）：scan 引擎逐类别进度回调（task=scan），盘点页显示进度条、当前类别名与耗时提示，补盘点取消按钮；此前盘点中界面仅表格占位行、无法区分卡死与慢 | 提交见本轮 git log |
| 2026-11-10 | 发布 v0.3.0：GitHub Release 附 Windows 安装包 zcode-move-Setup-0.3.0.exe | [Release v0.3.0](https://github.com/wgl2zj/zcode-move/releases/tag/v0.3.0) |
| 2026-11-09 | 审查问题全修（双通道审查 28 条）+ 路径填写改弹窗选择：后端任务锁（同一时间仅一个长任务，task_busy）与协作取消（task_cancelled，打包半成品自动删除、解包中断保留已写）、扫描断链跳过、输出覆盖确认+建议文件名精确到时分秒、解包失败重试与换包校验失效、备份一键清理、路径适配页主次纠正、成功页打开文件夹/复制路径、五个路径字段改 PathPicker 选择卡片；术语文案大白话化、选中卡对勾、长表吸底操作栏、设置页口径与错误态、确认对话框分级、favicon | 提交 `3acf703`（阶段一逻辑层）与后续展示层提交 |

## 说明

- 本仓库截至 2026-10-14 尚未打 tag、未发布 GitHub Release；上表事件均提取自 git 提交历史（`git log`）。
- 后续上线（打 tag、发布 Release）时在本文件登记新版本条目并附 Release 链接；版本号取舍按发布时用户决定执行。
