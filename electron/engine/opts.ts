// 引擎可选参数（当前仅取消检查）：主进程任务锁把"是否已请求取消"以回调注入引擎，
// 引擎在长循环迭代头检查并抛 task_cancelled（协作式取消，不中断单文件内的 IO）。

import { AppError } from "./error";

/** 引擎可选参数：`cancelled` 返回 true 表示用户已请求取消当前任务。 */
export interface EngineOpts {
  cancelled?: () => boolean;
}

/** 取消检查点：已请求取消则抛 task_cancelled（AppError code 稳定，前端据此分支）。 */
export function throwIfCancelled(opts?: EngineOpts): void {
  if (opts?.cancelled?.()) {
    throw new AppError("task_cancelled", "正在进行的操作已被取消");
  }
}
