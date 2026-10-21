// Keep engine allocation, provider metadata and request limits in agreement.
// Larger contexts consume extra RAM; retain the smaller profile below 16 GB.
export function inferenceLimits(machine = {}) {
  return machine.ramGB >= 16
    ? { contextWindow: 16384, maxTokens: 4096 }
    : { contextWindow: 8192, maxTokens: 2048 }
}

export function prepareCompletion(body, machine) {
  const { maxTokens } = inferenceLimits(machine)
  const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? maxTokens)
  body.max_tokens = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), maxTokens)
    : maxTokens
  delete body.max_completion_tokens
  body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: false }
  return body
}
