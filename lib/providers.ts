import { z } from 'zod';

import type { AgentConfig } from './types';
import type { ToolDefinition } from './tools';

const responseOutputItemSchema = z.looseObject({
  type: z.string().optional(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  content: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
});

const modelResponseSchema = z.object({
  output: z.array(responseOutputItemSchema).optional(),
  output_text: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type ModelResponse = z.infer<typeof modelResponseSchema>;

export type ModelRequest = {
  agent: AgentConfig;
  input: Array<Record<string, unknown>>;
  tools: ToolDefinition[];
  requestId: string;
};

export interface ModelProvider {
  readonly name: string;
  createResponse(request: ModelRequest): Promise<ModelResponse>;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(providers: readonly ModelProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.name))
      throw new Error(`Provider already registered: ${provider.name}`);
    this.providers.set(provider.name, provider);
  }

  resolve(name: string): ModelProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Unsupported model provider: ${name}`);
    return provider;
  }
}

export type OpenAIProviderOptions = {
  apiKey?: string;
  baseUrl: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxAttempts: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai';
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async createResponse(request: ModelRequest): Promise<ModelResponse> {
    if (!this.options.apiKey) {
      throw new Error(
        'OPENAI_API_KEY is required for an agent configured with provider "openai".',
      );
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs,
      );
      try {
        const response = await this.fetchImpl(
          `${this.options.baseUrl}/responses`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': request.requestId,
            },
            body: JSON.stringify({
              model: request.agent.model,
              instructions: request.agent.systemPrompt,
              temperature: request.agent.temperature,
              input: request.input,
              store: false,
              parallel_tool_calls: false,
              tools: request.tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: tool.kind !== 'http',
              })),
            }),
            signal: controller.signal,
          },
        );

        const body = await readBoundedText(
          response,
          this.options.maxResponseBytes,
        );
        if (!response.ok) {
          const error = new Error(
            `Model provider error ${response.status}: ${body.slice(0, 240)}`,
          );
          if (
            !isRetryableStatus(response.status) ||
            attempt === this.options.maxAttempts
          )
            throw error;
          lastError = error;
        } else {
          let decoded: unknown;
          try {
            decoded = JSON.parse(body);
          } catch {
            throw new Error('Model provider returned malformed JSON.');
          }
          const parsed = modelResponseSchema.safeParse(decoded);
          if (!parsed.success)
            throw new Error(
              `Model provider returned an invalid response: ${z.prettifyError(parsed.error)}`,
            );
          return parsed.data;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          lastError = new Error(
            `Model provider timed out after ${this.options.timeoutMs}ms.`,
          );
        } else if (
          !isRetryableNetworkError(error) ||
          attempt === this.options.maxAttempts
        ) {
          throw error;
        } else {
          lastError = error;
        }
      } finally {
        clearTimeout(timer);
      }

      if (attempt < this.options.maxAttempts)
        await this.sleep(retryDelayMs(attempt));
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Model provider request failed.');
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`Model provider response exceeded ${maxBytes} bytes.`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Model provider response exceeded ${maxBytes} bytes.`);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

function retryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 2_000);
}
