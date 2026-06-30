// ============================================================================
// cclau 输出格式原语
//
// success / error / info / warn —— 状态行日志，带颜色的图形前缀。
// error 走 console.error，其余走 console.log；都不调 process.exit，
// 由调用方决定是否退出。
//
// Windows Terminal 对 Unicode 字符的宽度渲染不一致，所以 win32 下
// 在图形和文字之间多塞一个空格。picocolors 在非 TTY 自动关色，所以
// snapshot 测试会 flaky，不要做。
//
// 数据（profile 表格 / 字段详情）保留在命令文件各自的打印函数里，
// 这里只管状态行。
// ============================================================================

import pc from "picocolors";

const GAP = process.platform === "win32" ? "  " : " ";

export function success(msg: string): void {
  console.log(`${pc.green("✔")}${GAP}${msg}`);
}

export function error(msg: string): void {
  console.error(`${pc.red("✖")}${GAP}${msg}`);
}

export function info(msg: string): void {
  console.log(`${pc.cyan("ℹ")}${GAP}${msg}`);
}

export function warn(msg: string): void {
  console.log(`${pc.yellow("⚠")}${GAP}${msg}`);
}

export { pc };
