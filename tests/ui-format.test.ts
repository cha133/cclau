// ============================================================================
// ui/format 输出原语 —— 冒烟测试
//
// 不 snapshot picocolors 输出：picocolors 在非 TTY 自动关色，
// 而且图形字符（✔ / ✖ / ℹ / ⚠）可能变。冒烟测只确保：
//   - success / info / warn 写 console.log
//   - error 写 console.error
//   - 调用不抛
//
// 防止：有人删了 `pc` import、或者错误地把 `error` 接到 console.log。
// ============================================================================

import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { success, error, info, warn } from "../src/ui/format.js";

describe("ui/format output primitives", () => {
  const logSpy = spyOn(console, "log").mockImplementation(() => {});
  const errSpy = spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    logSpy.mockClear();
    errSpy.mockClear();
  });

  test("success writes to console.log (not console.error)", () => {
    success("did thing");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("info writes to console.log", () => {
    info("fyi");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("warn writes to console.log", () => {
    warn("careful");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  test("error writes to console.error (not console.log)", () => {
    error("boom");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });
});
