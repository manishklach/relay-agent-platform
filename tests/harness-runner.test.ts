import { describe, expect, it } from 'vitest';

import { applyContextPolicy, createWeakSeed } from '../lib/harness-dev';

describe('HarnessDev context compiler', () => {
  it('fails closed when full context exceeds its declared byte budget', () => {
    const artifact = createWeakSeed(['suite']);
    expect(() => applyContextPolicy('x'.repeat(2_000), artifact)).toThrow(
      'byte budget',
    );
  });

  it('applies sliding-window and summary policies to actual runtime input', () => {
    const seed = createWeakSeed(['suite']);
    const long = `${'a'.repeat(1_500)}END`;
    const sliding = {
      ...seed,
      context: { ...seed.context, strategy: 'sliding_window' as const },
    };
    expect(applyContextPolicy(long, sliding)).toHaveLength(1_024);
    expect(applyContextPolicy(long, sliding)).toMatch(/END$/);
    const summary = {
      ...seed,
      context: { ...seed.context, strategy: 'summary' as const },
    };
    expect(applyContextPolicy(long, summary)).toContain('[compressed]');
  });

  it('keeps multi-byte context within the declared UTF-8 byte budget', () => {
    const seed = createWeakSeed(['suite']);
    const artifact = {
      ...seed,
      context: { ...seed.context, strategy: 'summary' as const },
    };
    const output = applyContextPolicy('🧠'.repeat(1_000), artifact);
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(1_024);
  });
});
