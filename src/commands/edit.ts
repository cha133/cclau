// cclau edit <name> - edit a profile (6 fields)
//
// Editable fields: endpoint / apiKey / mode / model / supports1m / default
//
// Flow:
//   1. Fuzzy-resolve profile name (edit is non-destructive, silent top-1 ok)
//   2. Render current profile
//   3. Loop: pick field to edit (done to exit)
//   4. When setting default, clear other profiles' default flag
//   5. Write to disk

import * as p from "@clack/prompts";
import {
  getProfile,
  listProfiles,
  listProfileNames,
  upsertProfile,
} from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import type { Mode, Profile } from "../types.js";
import { pc } from "../utils/logger.js";

function maskKey(key: string): string {
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

export async function editCmd(name: string): Promise<void> {
  // 1. Fuzzy resolve
  const top = fuzzyTopN(name, listProfileNames(), 1);
  if (top.length === 0) {
    const all = listProfileNames();
    p.log.error(`profile "${name}" does not exist. existing: ${all.join(", ") || "(empty)"}`);
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`matched profile "${resolved}"`));

  const original = getProfile(resolved);
  if (!original) {
    p.log.error(`profile "${resolved}" does not exist`);
    process.exit(1);
  }

  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau edit ")));

  // 2. Render current
  printProfile(original);

  // 3. Field menu loop
  let current: Profile = { ...original };

  while (true) {
    const field = await p.select({
      message: "Edit which field? (done to exit)",
      options: [
        { value: "endpoint", label: "endpoint", hint: current.endpoint },
        { value: "apiKey", label: "apiKey", hint: maskKey(current.apiKey) },
        { value: "mode", label: "mode", hint: current.mode },
        { value: "model", label: "model", hint: current.model },
        {
          value: "supports1m",
          label: "supports1m",
          hint: String(current.supports1m),
        },
        {
          value: "default",
          label: "default",
          hint: current.default ? "true" : "false",
        },
        { value: "done", label: "done", hint: "exit edit" },
      ],
    });
    if (p.isCancel(field)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    if (field === "done") break;

    current = await editField(current, field);
    p.log.success(`updated ${field}`);
    console.log();
  }

  // 4. Any change?
  const changed = isChanged(original, current);
  if (!changed) {
    p.outro(pc.dim("no changes"));
    return;
  }

  // 5. Default cascade: clear other profiles' default flag
  if (current.default === true) {
    for (const prof of listProfiles()) {
      if (prof.name !== current.name && prof.default === true) {
        const updated: Profile = { ...prof };
        delete updated.default;
        updated.updatedAt = Date.now();
        await upsertProfile(updated);
      }
    }
  }

  current.updatedAt = Date.now();
  await upsertProfile(current);

  p.outro(pc.green(`✓ saved profile "${current.name}"`));
}

function printProfile(profile: Profile): void {
  const modeColor =
    profile.mode === "direct"
      ? pc.green
      : profile.mode === "rectify"
        ? pc.yellow
        : pc.cyan;
  console.log(pc.bold(`Profile: ${profile.name}`));
  console.log(`  ${pc.dim("endpoint:")} ${profile.endpoint}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(profile.apiKey)}`);
  console.log(`  ${pc.dim("mode    :")} ${modeColor(profile.mode)}`);
  console.log(`  ${pc.dim("model   :")} ${profile.model}`);
  console.log(`  ${pc.dim("1m      :")} ${profile.supports1m}`);
  console.log(`  ${pc.dim("default :")} ${profile.default ? "true" : "false"}`);
}

type Field = "endpoint" | "apiKey" | "mode" | "model" | "supports1m" | "default";

async function editField(profile: Profile, field: Field): Promise<Profile> {
  switch (field) {
    case "endpoint": {
      const v = await p.text({
        message: "endpoint:",
        initialValue: profile.endpoint,
        validate: (s) => (s ? undefined : "required"),
      });
      if (p.isCancel(v)) {
        p.cancel("cancelled");
        process.exit(0);
      }
      return { ...profile, endpoint: v };
    }
    case "apiKey": {
      const v = await p.password({
        message: "apiKey:",
        validate: (s) => (s ? undefined : "required"),
      });
      if (p.isCancel(v)) {
        p.cancel("cancelled");
        process.exit(0);
      }
      return { ...profile, apiKey: v };
    }
    case "mode": {
      const v = await p.select<Mode>({
        message: "mode:",
        initialValue: profile.mode,
        options: [
          { value: "direct" as const, label: "direct", hint: "anthropic direct" },
          {
            value: "rectify" as const,
            label: "rectify",
            hint: "anthropic with rectifier",
          },
          {
            value: "openai" as const,
            label: "openai",
            hint: "openai → anthropic conversion",
          },
        ],
      });
      if (p.isCancel(v)) {
        p.cancel("cancelled");
        process.exit(0);
      }
      return { ...profile, mode: v };
    }
    case "model": {
      const v = await p.text({
        message: "model:",
        initialValue: profile.model,
        validate: (s) => (s ? undefined : "required"),
      });
      if (p.isCancel(v)) {
        p.cancel("cancelled");
        process.exit(0);
      }
      return { ...profile, model: v };
    }
    case "supports1m": {
      const v = await p.confirm({
        message: "supports1m:",
        initialValue: profile.supports1m,
      });
      if (p.isCancel(v)) {
        p.cancel("cancelled");
        process.exit(0);
      }
      return { ...profile, supports1m: v };
    }
    case "default": {
      const v = await p.confirm({
        message: "default:",
        initialValue: profile.default === true,
      });
      if (p.isCancel(v)) {
        p.cancel("cancelled");
        process.exit(0);
      }
      const updated: Profile = { ...profile };
      if (v) updated.default = true;
      else delete updated.default;
      return updated;
    }
  }
}

function isChanged(a: Profile, b: Profile): boolean {
  return (
    a.endpoint !== b.endpoint ||
    a.apiKey !== b.apiKey ||
    a.mode !== b.mode ||
    a.model !== b.model ||
    a.supports1m !== b.supports1m ||
    (a.default === true) !== (b.default === true)
  );
}