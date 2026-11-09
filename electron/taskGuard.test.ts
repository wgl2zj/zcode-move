// @vitest-environment node
// 任务锁（taskGuard）与取消检查点（opts.throwIfCancelled）测试。
// taskGuard 为模块级单例状态，测试串行执行并在每条末尾 releaseTask 复位。

import { expect, it } from "vitest";
import { AppError } from "./engine/error";
import { throwIfCancelled } from "./engine/opts";
import { acquireTask, currentTask, isCancelRequested, releaseTask, requestCancel } from "./taskGuard";

it("taskguard_busy_rejects_second_acquire：占用期间第二个长任务被拒（task_busy）", async () => {
  acquireTask("pack_assets");
  expect(currentTask()).toBe("pack_assets");
  await expect(() => acquireTask("open_package")).toThrowError(AppError);
  try {
    acquireTask("open_package");
  } catch (e) {
    expect((e as AppError).code).toBe("task_busy");
  }
  releaseTask();
  // 释放后可再次占用
  acquireTask("open_package");
  expect(currentTask()).toBe("open_package");
  releaseTask();
  expect(currentTask()).toBeNull();
});

it("taskguard_cancel_flag_lifecycle：取消标记随 acquire 复位、随 release 清除", () => {
  expect(requestCancel()).toBe(false); // 空闲时请求取消：无任务，返回 false
  acquireTask("plan_apply");
  expect(isCancelRequested()).toBe(false);
  expect(requestCancel()).toBe(true);
  expect(isCancelRequested()).toBe(true);
  releaseTask();
  expect(isCancelRequested()).toBe(false); // 释放时清除，防残留标记影响下一任务
});

it("opts_throw_if_cancelled：无回调/未取消不抛，已取消抛 task_cancelled", () => {
  expect(() => throwIfCancelled()).not.toThrow();
  expect(() => throwIfCancelled({})).not.toThrow();
  expect(() => throwIfCancelled({ cancelled: () => false })).not.toThrow();
  expect(() => throwIfCancelled({ cancelled: () => true })).toThrowError(AppError);
  try {
    throwIfCancelled({ cancelled: () => true });
  } catch (e) {
    expect((e as AppError).code).toBe("task_cancelled");
  }
});
