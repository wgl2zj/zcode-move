// 主进程任务锁与取消标记（单任务模型）：同一时间仅允许一个长任务命令执行，
// 防止"执行中离开页面再重进向导"后对同一输出路径/目标根并发发起第二次任务
// （两次打包同时写同一 .zam、两次解包交错写同一目标树的真实竞态，2026-11-09 审查 H2）。
// 纯逻辑模块（不 import Electron），vitest 可直测；装配在 main.ts 的 handleTask 包装器。

import { AppError } from "./engine/error";

/** 当前占用锁的任务名（命令名）；null = 空闲。 */
let current: string | null = null;
/** 用户已请求取消当前任务。acquire 时复位。 */
let cancelRequested = false;

/** 获取任务锁；已有任务在执行时抛 task_busy（前端提示后等待或取消）。 */
export function acquireTask(name: string): void {
  if (current !== null) {
    throw new AppError("task_busy", `「${current}」仍在进行，请等待完成或先取消`);
  }
  current = name;
  cancelRequested = false;
}

/** 释放任务锁（任务结束/异常后由 finally 调用；同时清除取消标记）。 */
export function releaseTask(): void {
  current = null;
  cancelRequested = false;
}

/** 当前任务名（空闲为 null）。 */
export function currentTask(): string | null {
  return current;
}

/** 请求取消当前任务；无任务在执行返回 false（幂等，可安全重试调用）。 */
export function requestCancel(): boolean {
  if (current === null) return false;
  cancelRequested = true;
  return true;
}

/** 引擎检查点用：当前是否已请求取消。 */
export function isCancelRequested(): boolean {
  return cancelRequested;
}
