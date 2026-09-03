import { describe, expect, it } from 'vitest';

import {
  assertProposalCanActivate,
  agentVersionConfigSchema,
} from '../lib/agent-version';

describe('agent versions and improvement activation', () => {
  it('strictly validates candidate configuration', () => {
    expect(() =>
      agentVersionConfigSchema.parse({
        systemPrompt: 'A sufficiently detailed system prompt.',
        provider: 'openai',
        model: 'gpt-test',
        temperature: 0.2,
        allowedTools: [],
        guardrails: {
          redactPii: true,
          blockPromptInjection: true,
          requireApprovalForWrites: true,
        },
        untrustedField: true,
      }),
    ).toThrow();
  });

  it('requires evaluation, approval, and the unchanged base version', () => {
    expect(() =>
      assertProposalCanActivate({
        status: 'approved',
        score: 95,
        minimumScore: 90,
        baseVersionId: 'v1',
        activeVersionId: 'v1',
      }),
    ).not.toThrow();
    expect(() =>
      assertProposalCanActivate({
        status: 'awaiting_approval',
        score: 95,
        minimumScore: 90,
        baseVersionId: 'v1',
        activeVersionId: 'v1',
      }),
    ).toThrow('approved');
    expect(() =>
      assertProposalCanActivate({
        status: 'approved',
        score: 80,
        minimumScore: 90,
        baseVersionId: 'v1',
        activeVersionId: 'v1',
      }),
    ).toThrow('threshold');
    expect(() =>
      assertProposalCanActivate({
        status: 'approved',
        score: 95,
        minimumScore: 90,
        baseVersionId: 'v1',
        activeVersionId: 'v2',
      }),
    ).toThrow('stale');
  });
});
