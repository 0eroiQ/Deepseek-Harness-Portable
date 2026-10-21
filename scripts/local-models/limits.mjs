// Keep engine allocation, provider metadata and request limits in agreement.
// Larger contexts consume extra RAM; retain the smaller profile below 16 GB.
export function inferenceLimits(machine = {}) {
  return machine.ramGB >= 16
    ? { contextWindow: 16384, maxTokens: 4096 }
    : { contextWindow: 8192, maxTokens: 2048 }
}

export function prepareCompletion(body, machine, model = {}) {
  const { maxTokens } = inferenceLimits(machine)
  const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? maxTokens)
  body.max_tokens = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(Math.floor(requested), maxTokens))
    : maxTokens
  // Qwen's non-thinking guidance recommends sampling rather than greedy decoding.
  // Apply only to the original Qwen3 family; other architectures retain caller settings.
  if (/qwen3(?:[-_ /]|$)/i.test([model.repo,model.file,model.name].filter(Boolean).join(' '))) {
    if (!Number.isFinite(Number(body.temperature)) || body.temperature == null || Number(body.temperature) <= 0) body.temperature = 0.7
    body.top_p ??= 0.8
    body.top_k ??= 20
    body.min_p ??= 0
  }
  delete body.max_completion_tokens
  body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: false }
  return body
}
