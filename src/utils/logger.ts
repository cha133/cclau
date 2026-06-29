// 纯 picocolors re-export —— 状态/成功/错误等"行级"输出统一走 @clack/prompts 的
// p.log.* 家族（✔ / ✖ / ⚠ / ℹ / ~），不再保留 [ ok ] / [error] 这种自造风格。
// 数据展示用 console.log + pc.dim 等内联即可。

import pc from "picocolors";

export { pc };