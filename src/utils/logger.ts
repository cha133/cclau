// Pure picocolors re-export — line-level status/success/error output goes through
// @clack/prompts's p.log.* family (✔ / ✖ / ⚠ / ℹ / ~); no more home-grown [ ok ] / [error].
// Data display uses console.log + pc.dim inline.

import pc from "picocolors";

export { pc };