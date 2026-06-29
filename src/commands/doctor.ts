// cclau doctor <name> - 诊断订阅配置 + 上游连通性
//
// 三阶段：
//   1. 打印订阅快照 + 真实请求 URL（不发请求）
//   2. pre-flight 配置校验（不发请求）：apiKey / model / URL 合法性
//   3. 连通测试：
//      - Upstream 直连测试（所有 mode）：发请求到 buildUpstreamUrl(endpoint, type)
//      - 端到端测试（仅 rectify/convert）：起 sidecar，模拟 claude code 发请求
//        —— 反映"如果我现在跑 cclau <name> 会不会成功"
//
// 设计原则：
// - preflight 阶段失败 = 配置问题，不浪费一次请求
// - 失败必须给出"下一步该跑哪条命令"，而不是只贴错误码
// - 两个测试分开报告，方便定位是 upstream 挂了还是 cclau 整流钩子问题

import * as p from "@clack/prompts";
import { getSubscription, listProviderNames, loadAppConfig } from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { pc } from "../utils/logger.js";
import { findFreePort } from "../port.js";
import { startServer } from "../server/index.js";
import { buildRegistry } from "../server/registry.js";
import type { Subscription } from "../types.js";

const REQUEST_TIMEOUT_MS = 10_000;

// claude code 实际发请求时用的 model 名（被黑名单约束，必须是 claude-*）
// doctor 用这个跑端到端测试，模拟真实使用
const CLAUDE_CODE_PROBE_MODEL = "claude-3-5-sonnet-20241022";

interface CheckResult {
  ok: boolean;
  message: string;
}

interface HttpResult {
  status: number;
  body: string;
  elapsedMs: number;
}

function maskKey(key: string | undefined): string {
  if (!key) return pc.dim("(未设置)");
  if (key.length <= 11) return pc.dim(`${key.slice(0, 3)}...`);
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

function printSnapshot(sub: Subscription, realUrl: string): void {
  const modeColor = sub.mode === "direct" ? pc.green : sub.mode === "rectify" ? pc.yellow : pc.cyan;
  console.log(pc.bold(`Provider ${sub.name}:`));
  console.log(`  ${pc.dim("mode    :")} ${modeColor(sub.mode)}`);
  console.log(`  ${pc.dim("type    :")} ${sub.type}`);
  console.log(`  ${pc.dim("endpoint:")} ${sub.endpoint}`);
  console.log(`  ${pc.dim("→ 请求 URL :")} ${pc.cyan(realUrl)}`);
  const firstModel = sub.models[0]?.id;
  console.log(`  ${pc.dim("model   :")} ${firstModel ? firstModel : pc.red("(空)")}`);
  console.log(`  ${pc.dim("models  :")} ${sub.models.length} 个${sub.models.some((m) => m.supports_1m) ? "（含 [1m]）" : ""}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(sub.apiKey)}`);
  console.log("");
}

function preflight(sub: Subscription, realUrl: string): CheckResult[] {
  const checks: CheckResult[] = [];

  if (!sub.apiKey) {
    checks.push({ ok: false, message: "apiKey 为空" });
  } else {
    checks.push({ ok: true, message: "apiKey 已设置" });
  }

  if (sub.models.length === 0) {
    checks.push({
      ok: false,
      message: `models 列表为空 — 运行 ${pc.cyan(`\`cclau rm ${sub.name} && cclau add\``)} 重建 provider`,
    });
  } else {
    const first = sub.models[0]!.id;
    checks.push({ ok: true, message: `models = ${sub.models.length} 个（probe 用 ${first}${sub.models[0]!.supports_1m ? " [1m]" : ""}）` });
  }

  try {
    const u = new URL(realUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      checks.push({ ok: false, message: `请求 URL 协议不是 http(s): ${u.protocol}` });
    } else {
      checks.push({ ok: true, message: "请求 URL 合法" });
    }
  } catch {
    checks.push({ ok: false, message: `请求 URL 无法解析: ${realUrl}` });
  }

  return checks;
}

interface Diagnosis {
  ok: boolean;
  summary: string;
  hint?: string;
}

/**
 * 根据 status + body 给出诊断 + 补救建议
 * 顺序：body 关键词优先于裸状态码（401 + "Model not supported" 是 model 问题，不是鉴权）
 */
function diagnose(status: number, bodyText: string, sub: Subscription, ctx: "raw" | "e2e"): Diagnosis {
  const lower = bodyText.toLowerCase();
  const fix = (cmd: string) => pc.cyan(cmd);

  if (status === 200 || status === 201) {
    return { ok: true, summary: "连通正常" };
  }

  // ---- body 关键词优先 ----

  // model 不支持（任何状态码都可能：400 / 401 / 404 upstream 自己语义不一致）
  if (
    lower.includes("model") &&
    (lower.includes("not found") ||
      lower.includes("unknown") ||
      lower.includes("invalid") ||
      lower.includes("does not exist") ||
      lower.includes("not supported") ||
      lower.includes("is not a valid"))
  ) {
    const e2eHint = ctx === "e2e"
      ? `端到端测试用 model=${CLAUDE_CODE_PROBE_MODEL} 模拟 claude code 实际请求；sidecar 内部已用 entry.upstreamModel（=${sub.models[0]?.id}）替换后转给 upstream`
      : `运行 ${fix(`\`cclau rm ${sub.name} && cclau add\``)} 重建 provider`;
    return {
      ok: false,
      summary: "upstream 不识别该 model",
      hint: e2eHint,
    };
  }

  // 鉴权
  if (
    lower.includes("invalid api key") ||
    lower.includes("invalid x-api-key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized") ||
    lower.includes("incorrect api key")
  ) {
    return {
      ok: false,
      summary: "apiKey 校验失败",
      hint: `运行 ${fix(`\`cclau rm ${sub.name} && cclau add ${sub.name}\``)} 重新设置 apiKey`,
    };
  }

  // 配额
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("insufficient balance") || lower.includes("payment")) {
    return {
      ok: false,
      summary: "账户配额 / 余额不足",
      hint: `去 ${fix(`\`${sub.endpoint}\``)} 的控制台充值或升级套餐`,
    };
  }

  // 上下文超长
  if (lower.includes("context length") || lower.includes("too long") || lower.includes("maximum context")) {
    return {
      ok: false,
      summary: "上下文超长",
      hint: "claude code 上下文过大，重启会话或换 model",
    };
  }

  // 请求体某字段空（preflight 已校验 sub.model 非空）
  if (lower.includes("input cannot be empty") || lower.includes("empty input") || lower.includes("required field")) {
    return {
      ok: false,
      summary: `upstream 说请求体某字段为空（${status}）`,
      hint:
        ctx === "raw"
          ? `可能 type 和 upstream 实际协议不匹配（anthropic vs openai），或上游要求 system 等额外字段。看 body + 上面的请求体手 curl 调试`
          : `端到端测试走的是 cclau ${sub.mode} 链路，问题可能出在整流钩子（modelAlias/requestTransform）。看 body 定位`,
    };
  }

  // ---- 状态码 fallback ----

  if (status === 429) {
    return {
      ok: false,
      summary: "被限流 (429)",
      hint: "稍后重试，或检查上游账户配额",
    };
  }

  if (status === 404) {
    return {
      ok: false,
      summary: "endpoint 路径不存在 (404)",
      hint: `检查 endpoint 是否是 base URL（不要带 /v1/messages），或 curl ${fix(`\`${sub.endpoint}\``)} 验证上游存活`,
    };
  }

  if (status >= 500) {
    return {
      ok: false,
      summary: `upstream 服务器错误 (${status})`,
      hint: "upstream 自己挂了，不是你的问题，稍后重试",
    };
  }

  if (status >= 400) {
    return {
      ok: false,
      summary: `upstream 返回 ${status}`,
      hint: "查看 body 定位问题",
    };
  }

  return { ok: false, summary: `未预期状态 ${status}` };
}

function buildUpstreamHeaders(sub: Subscription): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sub.type === "anthropic") {
    headers["x-api-key"] = sub.apiKey!;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${sub.apiKey!}`;
  }
  return headers;
}

function buildUpstreamPingBody(sub: Subscription): string {
  // probe 用第一个 model（多 model 不会改变 upstream 期望；doctor 只能看一个）
  const model = sub.models[0]?.id ?? "";
  return JSON.stringify({
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  });
}

function buildClientProbeBody(): string {
  // 模拟 claude code 实际发的请求
  return JSON.stringify({
    model: CLAUDE_CODE_PROBE_MODEL,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  });
}

function buildClientProbeHeaders(): Record<string, string> {
  // sidecar 不验签，传任意值；真实的 apiKey 在 sidecar 内部转发时使用
  return {
    "Content-Type": "application/json",
    "x-api-key": "doctor-probe",
    "anthropic-version": "2023-06-01",
  };
}

function printHeaders(headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    const display = lower.includes("key") || lower.includes("authorization")
      ? maskKey(v.replace(/^(Bearer|x-api-key)\s+/i, ""))
      : v;
    console.log(`    ${k}: ${display}`);
  }
}

async function httpPost(url: string, headers: Record<string, string>, body: string): Promise<HttpResult> {
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  return { status: res.status, body: text, elapsedMs: Date.now() - t0 };
}

function reportFailure(label: string, url: string, result: HttpResult, diagnosis: Diagnosis): void {
  p.log.warn(`${label}: ${url} → ${result.status} ${diagnosis.summary} (${result.elapsedMs}ms)`);
  console.log(`body: ${result.body.slice(0, 400)}${result.body.length > 400 ? "..." : ""}`);
  if (diagnosis.hint) {
    console.log("");
    p.log.info(`建议: ${diagnosis.hint}`);
  }
}

export async function doctorCmd(name: string): Promise<void> {
  // fuzzy 解析（doctor 只读，不需歧义保护）
  const top = fuzzyTopN(name, listProviderNames(), 1);
  if (top.length === 0) {
    const all = listProviderNames();
    p.log.error(`provider "${name}" 不存在 — 运行 ${pc.cyan("`cclau ls`")} 查看现有 provider（现有: ${all.join(", ") || "(空)"}）`);
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`匹配到 provider "${resolved}"`));

  const sub = getSubscription(resolved);
  if (!sub) {
    // race: fuzzy 命中但 getSubscription miss
    p.log.error(`provider "${resolved}" 不存在`);
    process.exit(1);
  }

  // 1. 打印快照
  const realUrl = buildUpstreamUrl(sub.endpoint, sub.type);
  printSnapshot(sub, realUrl);

  // 2. preflight
  const checks = preflight(sub, realUrl);
  let preflightOk = true;
  for (const c of checks) {
    if (c.ok) {
      p.log.success(c.message);
    } else {
      p.log.error(c.message);
      preflightOk = false;
    }
  }

  if (!preflightOk) {
    console.log("");
    p.log.error("preflight 未通过，跳过连通测试。修好配置后再跑一次。");
    process.exit(1);
  }

  console.log("");

  // 3a. Upstream 直连测试（所有 mode 都跑）
  const upHeaders = buildUpstreamHeaders(sub);
  const upBody = buildUpstreamPingBody(sub);

  console.log(pc.bold("① Upstream 直连"));
  console.log(`POST ${realUrl}`);
  console.log("请求 header:");
  printHeaders(upHeaders);
  console.log(`请求 body: ${upBody}`);

  const s1 = p.spinner();
  s1.start(pc.cyan("等待 upstream 响应..."));

  let rawResult: HttpResult;
  try {
    rawResult = await httpPost(realUrl, upHeaders, upBody);
  } catch (err) {
    s1.stop(pc.red("连接失败"));
    const msg = (err as Error).message || String(err);
    console.log("");
    if (msg.includes("timeout") || msg.includes("Timeout") || msg.includes("aborted")) {
      p.log.error(`超时（>${REQUEST_TIMEOUT_MS / 1000}s）— 检查 endpoint 是否可达`);
    } else if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || msg.includes("fetch failed")) {
      p.log.error(`无法连接 upstream — ${msg}`);
      p.log.message(pc.dim(`检查 endpoint 是否正确：${sub.endpoint}`));
    } else {
      p.log.error(`请求异常: ${msg}`);
    }
    process.exit(1);
  }

  const rawDiag = diagnose(rawResult.status, rawResult.body, sub, "raw");
  s1.stop(
    rawDiag.ok
      ? pc.green(`${realUrl} → ${rawResult.status} OK (${rawResult.elapsedMs}ms)`)
      : pc.yellow(`${realUrl} → ${rawResult.status} ${rawDiag.summary} (${rawResult.elapsedMs}ms)`),
  );
  if (!rawDiag.ok) {
    console.log("");
    reportFailure("upstream", realUrl, rawResult, rawDiag);
  }

  // 3b. 端到端测试（仅 rectify/convert 模式）
  if (sub.mode === "direct") {
    console.log("");
    p.log.success(`✓ ${rawDiag.summary}，可用 ${pc.cyan(`\`cclau profile add\``)} 建一个 profile 指向此 provider 启动 claude code`);
    return;
  }

  console.log("");
  console.log(pc.bold(`② 端到端（${sub.mode} 模式）`));

  const port = await findFreePort(3133);
  // doctor probe 用固定的 claude-* probe model 当 body.model，但 convert/rectify
  // 要把 model 换成 provider 真 id 才能过 upstream 校验 —— 所以 registry 的
  // key (= body.model) 是 probe model，upstreamModel 是 provider 真 id。
  const probeDefaultModel = sub.models[0]?.id ?? "";
  const registry = buildRegistry([
    {
      tier: "opus",
      model: CLAUDE_CODE_PROBE_MODEL,
      upstreamModel: probeDefaultModel,
      provider: sub,
    },
  ]);
  const server = startServer(registry, port, loadAppConfig());
  const e2eUrl = `http://127.0.0.1:${port}/v1/messages`;

  let e2eOk = false;
  let e2eDiag: Diagnosis | null = null;
  let e2eResult: HttpResult | null = null;

  try {
    console.log(`sidecar 启动在 127.0.0.1:${port}，模拟 claude code 发请求到 ${e2eUrl}`);
    console.log(`请求 body: ${buildClientProbeBody()}`);

    const s2 = p.spinner();
    s2.start(pc.cyan("等待 cclau sidecar → upstream 响应..."));

    try {
      e2eResult = await httpPost(e2eUrl, buildClientProbeHeaders(), buildClientProbeBody());
      e2eDiag = diagnose(e2eResult.status, e2eResult.body, sub, "e2e");
      e2eOk = e2eDiag.ok;
      s2.stop(
        e2eOk
          ? pc.green(`${e2eUrl} → ${e2eResult.status} OK (${e2eResult.elapsedMs}ms)`)
          : pc.yellow(`${e2eUrl} → ${e2eResult.status} ${e2eDiag.summary} (${e2eResult.elapsedMs}ms)`),
      );
      if (!e2eOk) {
        console.log("");
        reportFailure("端到端", e2eUrl, e2eResult, e2eDiag!);
      }
    } catch (err) {
      s2.stop(pc.red("连接失败"));
      const msg = (err as Error).message || String(err);
      console.log("");
      p.log.error(`sidecar 调用失败: ${msg}`);
      p.log.message(pc.dim("sidecar 进程没起来？看上面的 server 启动日志"));
    }
  } finally {
    server.stop();
    console.log(`sidecar stopped (port ${port})`);
  }

  // 4. 总结
  console.log("");
  if (rawDiag.ok && e2eOk) {
    p.log.success(`✓ upstream 和 cclau ${sub.mode} 链路都通了，可用 ${pc.cyan(`\`cclau profile add\``)} 建 profile 启动`);
    return;
  }

  // 至少有一项 fail：分情况报告
  const failParts: string[] = [];
  if (!rawDiag.ok) failParts.push("upstream 直连");
  if (!e2eOk) failParts.push(`cclau ${sub.mode} 链路`);
  p.log.error(`✗ ${failParts.join(" + ")} 未通过`);

  if (!rawDiag.ok && e2eOk) {
    p.log.message(pc.dim("cclau sidecar 链路能通，但 raw 测试挂了 — 实际用 cclau 启动应该 OK，raw 报错可忽略"));
  } else if (rawDiag.ok && !e2eOk) {
    p.log.message(pc.dim(`cclau ${sub.mode} 链路挂在整流钩子上 — 调 rectifier.anthropic.modelAlias / requestTransform`));
  } else {
    p.log.message(pc.dim("两边都挂了 — 看上面 raw / e2e 的具体建议"));
  }
  process.exit(1);
}