import { describe, expect, it } from 'vitest';

import {
  assertOfficialCandidate,
  auditHarnessArtifact,
  calculateHarnessMetrics,
  createWeakSeed,
  harnessArtifactSchema,
} from '../lib/harness-dev';

describe('HarnessDev contracts', () => {
  it('creates a weak runnable seed with all six control surfaces but no task policy', () => {
    const seed = createWeakSeed(['suite_dev']);
    expect(seed.kind).toBe('seed');
    expect(seed.execution.mode).toBe('seed');
    expect(seed.tools.maxCalls).toBe(0);
    expect(seed.state.checkpoint).toBe('each_step');
    expect(seed.verification.recordTrajectory).toBe(true);
  });

  it('requires a developed harness to contain executable graph control', () => {
    expect(() =>
      harnessArtifactSchema.parse({
        ...createWeakSeed(['suite_dev']),
        kind: 'developed',
      }),
    ).toThrow('graph execution');
  });

  it('rejects instance identifiers embedded in a frozen artifact', () => {
    const seed = createWeakSeed(['suite_dev']);
    expect(auditHarnessArtifact(seed, ['hidden-case-42'])).toEqual({
      compliant: true,
      violations: [],
    });
    expect(
      auditHarnessArtifact(
        {
          ...seed,
          verification: { ...seed.verification, suiteIds: ['hidden-case-42'] },
        },
        ['hidden-case-42'],
      ),
    ).toEqual({
      compliant: false,
      violations: ['instance_identifier:hidden-case-42'],
    });
  });

  it('reports capability and executor tokens as separate metrics', () => {
    const metrics = calculateHarnessMetrics([
      {
        caseId: 'one',
        benchmark: 'writing',
        nativeScore: 80,
        passed: true,
        executorInputTokens: 100,
        executorOutputTokens: 50,
        status: 'completed',
      },
      {
        caseId: 'two',
        benchmark: 'writing',
        nativeScore: 40,
        passed: false,
        executorInputTokens: 200,
        executorOutputTokens: 50,
        status: 'completed',
      },
    ]);
    expect(metrics.capabilityScore).toBe(60);
    expect(metrics.executorTokensTotal).toBe(400);
    expect(metrics.executorTokensMean).toBe(200);
    expect(metrics).not.toHaveProperty('combinedScore');
  });

  it('requires every paired feedback benchmark and constraint compliance', () => {
    const candidate = {
      harnessVersionId: 'version_2',
      completeBenchmarks: ['swe', 'terminal'],
      requiredBenchmarks: ['swe', 'terminal'],
      constraintCompliant: true,
      capabilityScore: 60,
      executorTokensMean: 1_000,
    };
    expect(() => assertOfficialCandidate(candidate)).not.toThrow();
    expect(() =>
      assertOfficialCandidate({ ...candidate, completeBenchmarks: ['swe'] }),
    ).toThrow('terminal');
    expect(() =>
      assertOfficialCandidate({ ...candidate, constraintCompliant: false }),
    ).toThrow('constraint');
  });
});
