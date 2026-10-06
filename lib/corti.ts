/**
 * Thin client for the Corti Models API.
 *
 * Corti Models is an OpenAI-compatible API. See:
 * https://docs.corti.ai/api-reference/corti-models
 *
 * Set your API key in your environment:
 *
 *   export CORTI_API_KEY="..."
 *
 * You can list the models available to your key and specify a model when
 * making a completion request. If no model is specified, the client uses a
 * default model.
 */

export function getBaseUrl(): string {
  return process.env.CORTI_BASE_URL ?? "https://ai.eu.corti.app/v1";
}

export function getDefaultModel(): string {
  return process.env.CORTI_DEFAULT_MODEL ?? "corti-s1";
}

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatOptions = {
  /** Override the model used for this request. Defaults to DEFAULT_MODEL. */
  model?: string;
  messages: Array<ChatMessage>;
  maxTokens?: number;
  temperature?: number;
};

export type ModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatResult = {
  id: string;
  model: string;
  content: string;
  finishReason: string | null;
  usage?: Usage;
};

export function getApiKey(): string {
  const key = process.env.CORTI_API_KEY;
  if (!key) {
    throw new Error(
      "CORTI_API_KEY is not set. Export it in your environment before calling the Corti Models API.",
    );
  }
  return key;
}

function asError(detail: unknown): string {
  if (detail == null) return "unknown error";
  if (typeof detail === "string") return detail;
  if (typeof detail === "object") {
    const anyDetail = detail as Record<string, unknown>;
    if (typeof anyDetail.message === "string") return anyDetail.message;
    if (typeof anyDetail.error === "string") return anyDetail.error;
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return String(detail);
}

async function request<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const key = getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      let detail: unknown;
      try {
        detail = await res.json();
      } catch {
        detail = await res.text().catch(() => "no response body");
      }
      throw new Error(
        `Corti Models API error: HTTP ${res.status} - ${asError(detail)}`,
      );
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(
  opts: { timeoutMs?: number } = {},
): Promise<Array<ModelInfo>> {
  const data = await request<{ object: string; data: Array<ModelInfo> }>(
    "/models",
    { method: "GET" },
    opts.timeoutMs ?? 30_000,
  );
  return data.data;
}

export async function chat(
  options: ChatOptions,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<ChatResult> {
  const selectedModel = options.model ?? getDefaultModel();

  const payload: Record<string, unknown> = {
    model: selectedModel,
    messages: options.messages,
  };
  if (options.maxTokens != null) payload.max_tokens = options.maxTokens;
  if (options.temperature != null) payload.temperature = options.temperature;

  const data = await request<{
    id: string;
    model: string;
    choices: Array<{
      message?: { content?: string | null };
      finish_reason?: string | null;
    }>;
    usage?: Usage;
  }>("/chat/completions", { method: "POST", body: JSON.stringify(payload) }, timeoutMs);

  const choice = data.choices?.[0];
  return {
    id: data.id,
    model: data.model ?? selectedModel,
    content: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? null,
    usage: data.usage,
  };
}

const corti = {
  chat,
  listModels,
  getDefaultModel,
  getApiKey,
};

export default corti;
