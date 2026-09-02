import { describe, expect, it } from 'vitest';

import { sanitizeOutput } from '../lib/guardrails';
import type { AgentConfig } from '../lib/types';

const agent = {
  guardrails: { redactPii: true },
} as AgentConfig;

describe('PII redaction', () => {
  it('redacts email addresses without consuming surrounding punctuation', () => {
    expect(sanitizeOutput('Contact jane.doe+refund@example.co.uk, please.', agent))
      .toBe('Contact [email redacted], please.');
  });

  it.each([
    '415-555-2671',
    '(415) 555-2671',
    '+1 415 555 2671',
    '415-***-2671',
    '415-555-****',
  ])('redacts complete or partially obfuscated phone value %s', (phone) => {
    expect(sanitizeOutput(`Call ${phone} now`, agent)).toBe('Call [phone redacted] now');
  });

  it('does not redact short numbers or order references', () => {
    expect(sanitizeOutput('Order A-1042 totals $79 on day 8.', agent))
      .toBe('Order A-1042 totals $79 on day 8.');
  });

  it('leaves output unchanged when redaction is disabled', () => {
    const disabled = { ...agent, guardrails: { redactPii: false } };
    expect(sanitizeOutput('jane@example.com 415-555-2671', disabled))
      .toBe('jane@example.com 415-555-2671');
  });
});
