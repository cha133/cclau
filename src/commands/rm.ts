// cclau rm <name> - remove a profile
//
// fuzzy + ambiguity protection: rm is irreversible, reject on top-1/top-2 score gap < threshold.

import * as p from "@clack/prompts";
import { listProfileNames, removeProfile } from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { pc } from "../utils/logger.js";

export async function rmCmd(name: string): Promise<void> {
  const all = listProfileNames();
  const top = fuzzyTopN(name, all, 2);
  if (top.length === 0) {
    p.log.error(`profile "${name}" does not exist. existing: ${all.join(", ") || "(empty)"}`);
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. rm is irreversible, please use a more specific name.`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`matched profile "${resolved}"`));

  const ok = await removeProfile(resolved);
  if (!ok) {
    p.log.error(`profile "${resolved}" does not exist`);
    process.exit(1);
  }

  p.log.success(`✓ removed profile "${resolved}"`);
}