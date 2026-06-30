// cclau ls - list all profiles
//
// refactored: single profile concept, ls renders only the profile table.
// Use `cclau show <name>` for details.

import { getDefaultName, listProfiles } from "../config.js";
import { info, pc } from "../ui/format.js";
import { padEndStr, printSection } from "../utils/table.js";
import { formatModelWith1m } from "../core/model-1m.js";

export function listCmd(): void {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    info("no profiles yet. run `cclau add` to create one.");
    return;
  }

  const defaultName = getDefaultName();
  const nameW = Math.max(...profiles.map((p) => p.name.length));
  const modeW = Math.max(...profiles.map((p) => p.mode.length));

  const rows = profiles.map((p) => {
    const modelStr = formatModelWith1m(p.model, p.supports1m);
    const isDefault = defaultName === p.name;
    const def = isDefault ? `${pc.green("★")} ` : "  ";
    return `${def}${pc.bold(padEndStr(p.name, nameW))}  ${pc.dim(padEndStr(p.mode, modeW))}  ${modelStr}`;
  });

  printSection("Profiles", rows);
}
