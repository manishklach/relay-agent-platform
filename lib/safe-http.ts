import ipaddr from 'ipaddr.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const DNS_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

export type DnsResolver = (hostname: string) => Promise<string[]>;
export type FetchImplementation = typeof fetch;

export type SafeHttpOptions = {
  fetchImpl?: FetchImplementation;
  resolveHostname?: DnsResolver;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
};

export type SafeHttpResponse = {
  status: number;
  ok: boolean;
  contentType: string;
  bodyText: string;
};

export async function safeHttpRequest(
  input: URL,
  init: RequestInit,
  options: SafeHttpOptions = {},
): Promise<SafeHttpResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolver = options.resolveHostname ?? ((hostname) => resolvePublicDns(hostname, fetchImpl));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + timeoutMs;
  let currentUrl = new URL(input);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;

  for (let redirectCount = 0; ; redirectCount += 1) {
    await assertPublicHttpsUrl(currentUrl, resolver);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('HTTP tool request timed out.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        ...init,
        method,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (isRedirect(response.status)) {
        if (redirectCount >= maxRedirects) throw new Error('HTTP tool exceeded the redirect limit.');
        const location = response.headers.get('location');
        if (!location) throw new Error('HTTP tool returned a redirect without a Location header.');
        currentUrl = new URL(location, currentUrl);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      const bodyText = await readBoundedBody(response, maxBytes);
      return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') ?? '',
        bodyText,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('HTTP tool request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function assertPublicHttpsUrl(url: URL, resolver: DnsResolver): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('HTTP tools must use a public HTTPS endpoint without embedded credentials.');
  }

  const hostname = stripIpv6Brackets(url.hostname);
  const literal = parseIp(hostname);
  const addresses = literal ? [hostname] : await resolver(hostname);
  if (!addresses.length) throw new Error('HTTP tool hostname did not resolve.');

  for (const address of addresses) {
    if (!isPublicIpAddress(address)) {
      throw new Error('HTTP tool resolved to a private or non-routable IP address.');
    }
  }
}

export function isPublicIpAddress(value: string): boolean {
  const parsed = parseIp(stripIpv6Brackets(value));
  if (!parsed) return false;
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() === 'unicast';
  }
  return parsed.range() === 'unicast';
}

async function resolvePublicDns(hostname: string, fetchImpl: FetchImplementation): Promise<string[]> {
  const answers = await Promise.all([1, 28].map(async (type) => {
    const query = new URL(DNS_ENDPOINT);
    query.searchParams.set('name', hostname);
    query.searchParams.set('type', String(type));
    const response = await fetchImpl(query, {
      headers: { Accept: 'application/dns-json' },
      redirect: 'error',
    });
    if (!response.ok) throw new Error('DNS resolution failed for HTTP tool endpoint.');
    const payload = await response.json() as { Answer?: Array<{ type?: number; data?: string }> };
    return (payload.Answer ?? [])
      .filter((answer) => answer.type === type && typeof answer.data === 'string')
      .map((answer) => answer.data as string);
  }));
  return [...new Set(answers.flat())];
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`HTTP tool response exceeded ${maxBytes} bytes.`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`HTTP tool response exceeded ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseIp(value: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    return ipaddr.parse(value);
  } catch {
    return null;
  }
}

function stripIpv6Brackets(value: string) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isRedirect(status: number) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
