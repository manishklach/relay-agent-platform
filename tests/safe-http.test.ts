import { describe, expect, it, vi } from 'vitest';

import { assertPublicHttpsUrl, isPublicIpAddress, safeHttpRequest } from '../lib/safe-http';

const noDns = async () => {
  throw new Error('DNS should not be used for IP literals.');
};

describe('HTTP tool SSRF protection', () => {
  it.each([
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://0x7f000001/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
  ])('rejects non-public endpoint %s', async (rawUrl) => {
    await expect(assertPublicHttpsUrl(new URL(rawUrl), noDns)).rejects.toThrow(/private or non-routable/);
  });

  it('rejects IPv4-mapped IPv6 and accepts public addresses', () => {
    expect(isPublicIpAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('1.1.1.1')).toBe(true);
  });

  it('validates every DNS result', async () => {
    await expect(assertPublicHttpsUrl(
      new URL('https://example.test/'),
      async () => ['8.8.8.8', '10.0.0.5'],
    )).rejects.toThrow(/private or non-routable/);
  });

  it('blocks a redirect to a private IP before issuing the second request', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, {
      status: 302,
      headers: { Location: 'https://127.0.0.1/admin' },
    }));

    await expect(safeHttpRequest(
      new URL('https://public.example/start'),
      { method: 'GET' },
      { fetchImpl, resolveHostname: async () => ['93.184.216.34'] },
    )).rejects.toThrow(/private or non-routable/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('enforces the response size cap while streaming', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('123456', { status: 200 }));
    await expect(safeHttpRequest(
      new URL('https://public.example/data'),
      { method: 'GET' },
      { fetchImpl, resolveHostname: async () => ['93.184.216.34'], maxResponseBytes: 5 },
    )).rejects.toThrow(/exceeded 5 bytes/);
  });

  it('aborts a request that exceeds the timeout', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    await expect(safeHttpRequest(
      new URL('https://public.example/slow'),
      { method: 'GET' },
      { fetchImpl, resolveHostname: async () => ['93.184.216.34'], timeoutMs: 5 },
    )).rejects.toThrow(/timed out/);
  });
});
