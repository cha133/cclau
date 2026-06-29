// 1M context 标记处理
//
// claude-code 用 `[1m]` 后缀作为内部 hint 启用 1M context 窗口
// （cache breakpoints / max_tokens 等），发请求前会通过
// `normalizeModelStringForAPI` 剥掉（见 claude-code src/utils/model/model.ts:710）。
// 所以 `[1m]` 只该出现在写给 claude-code 的 settings JSON 里，
// 永远不能传给 sidecar / upstream / doctor 的 raw test body。
//
// 本模块纯函数都保持幂等，对空串 / undefined 透传。

/** 追加 / 移除 `[1m]` 后缀（始终输出小写）。幂等；空串透传。 */
export function apply1m(model: string, supports1m: boolean): string {
  if (!model) return model;
  const base = strip1m(model);
  return supports1m ? `${base}[1m]` : base;
}

/** 移除 `[1m]` 后缀。幂等；空串透传。与 apply1m 对偶。 */
export function strip1m(model: string): string {
  if (!model) return model;
  return model.replace(/\[1[Mm]\]$/, "");
}

/**
 * 用于 show / ls 显示：has1m=true 时返回 "name [1m]"，否则返回原 model。
 * 接受可选的 dim 回调用于包装 marker（推荐传 `pc.dim`，会自动尊重 NO_COLOR）；
 * 不传则 marker 是裸文本（便于单元测试和 pipe 场景）。
 */
export function formatModelWith1m(
  model: string,
  has1m: boolean | undefined,
  dimFn?: (s: string) => string,
): string {
  if (!model) return model;
  if (!has1m) return model;
  const marker = dimFn ? dimFn("[1m]") : "[1m]";
  return `${model} ${marker}`;
}

/** 从 ModelInfo[] 列表中按 id 找条目；找不到返回 undefined。 */
export function findModelInfo<T extends { id: string }>(models: T[], id: string): T | undefined {
  return models.find((m) => m.id === id);
}