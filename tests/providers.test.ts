import { describe, expect, it, vi } from 'vitest';

import {
  OpenAICompatibleProvider,
  ProviderRegistry,
  type ModelRequest,
} from '../lib/providers';

const request: ModelRequest = {
  requestId: 'model_test_123',
  agent: {
    id: 'agent_1',
    workspaceId: 'ws_1',
    name: 'Agent',
    description: 'Test agent',
    systemPrompt: 'Be helpful.',
    provider: 'openai',
    model: 'gpt-test',
    temperature: 0,
    status: 'live',
    allowedTools: [],
    guardrails: {},
  },
  input: [{ role: 'user', content: 'hello' }],
  tools: [],
};

function provider(
  fetchImpl: typeof fetch,
  overrides: Partial<
    ConstructorParameters<typeof OpenAICompatibleProvider>[0]
  > = {},
) {
  return new OpenAICompatibleProvider({
    apiKey: 'test-key',
    baseUrl: 'https://provider.test/v1',
    timeoutMs: 100,
    maxResponseBytes: 1024,
    maxAttempts: 3,
    fetchImpl,
    sleep: async () => undefined,
    ...overrides,
  });
}

describe('model provider boundary', () => {
  it('fails closed when credentials are missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      provider(fetchImpl, { apiKey: undefined }).createResponse(request),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries transient responses with one stable idempotency key', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: 'ok',
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      );

    await expect(
      provider(fetchImpl).createResponse(request),
    ).resolves.toMatchObject({ output_text: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe(request.requestId);
    expect(
      new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('Idempotency-Key'),
    ).toBe(request.requestId);
  });

  it('does not retry permanent client failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('bad request', { status: 400 }));
    await expect(provider(fetchImpl).createResponse(request)).rejects.toThrow(
      /provider error 400/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces a response size cap', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('123456', { status: 200 }));
    await expect(
      provider(fetchImpl, { maxResponseBytes: 5 }).createResponse(request),
    ).rejects.toThrow(/exceeded 5 bytes/);
  });

  it('aborts a provider request at its deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    await expect(
      provider(fetchImpl, { timeoutMs: 5, maxAttempts: 1 }).createResponse(
        request,
      ),
    ).rejects.toThrow(/timed out after 5ms/);
  });

  it('rejects malformed and structurally invalid responses', async () => {
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{', { status: 200 }));
    await expect(provider(malformed).createResponse(request)).rejects.toThrow(
      /malformed JSON/,
    );

    const invalid = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ output: 'wrong' }), { status: 200 }),
      );
    await expect(provider(invalid).createResponse(request)).rejects.toThrow(
      /invalid response/,
    );
  });

  it('requires explicit provider registration', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.resolve('unknown')).toThrow(
      /Unsupported model provider/,
    );
  });
});
