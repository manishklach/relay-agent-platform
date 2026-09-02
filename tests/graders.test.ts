import { describe, expect, it } from 'vitest';

import { defaultGraderRegistry, GraderRegistry, type EvaluationGrader } from '../lib/graders';

describe('evaluation grader registry', () => {
  it('grades required terms case-insensitively', async () => {
    await expect(defaultGraderRegistry.grade('contains', {
      output: 'This REFUND is eligible.',
      expected: { contains: ['refund', 'eligible'] },
    })).resolves.toMatchObject({ passed: true, score: 1 });
  });

  it('reports partial deterministic scores and reasons', async () => {
    await expect(defaultGraderRegistry.grade('contains', {
      output: 'Refund requested.',
      expected: { contains: ['refund', 'approved'] },
    })).resolves.toMatchObject({ passed: false, score: 0.5, reason: 'Missing expected terms: approved' });
  });

  it('fails not-contains when a forbidden term appears', async () => {
    await expect(defaultGraderRegistry.grade('not_contains', {
      output: 'The secret was shown.',
      expected: { notContains: ['secret', 'password'] },
    })).resolves.toMatchObject({ passed: false, score: 0.5 });
  });

  it('accepts an asynchronous future rubric grader without changing the call shape', async () => {
    const rubric: EvaluationGrader = {
      type: 'model_rubric',
      grade: async ({ output, expected }) => ({
        passed: output.length >= Number(expected.minimumLength),
        score: output.length >= Number(expected.minimumLength) ? 1 : 0,
      }),
    };
    const registry = new GraderRegistry([rubric]);
    await expect(registry.grade('model_rubric', {
      output: 'A sufficiently detailed answer.',
      expected: { minimumLength: 10, rubric: 'Be detailed.' },
    })).resolves.toEqual({ passed: true, score: 1 });
  });

  it('rejects unknown and duplicate grader types', async () => {
    await expect(new GraderRegistry().grade('missing', { output: '', expected: {} }))
      .rejects.toThrow(/Unsupported grader type/);
    expect(() => new GraderRegistry([
      { type: 'same', grade: () => ({ passed: true, score: 1 }) },
      { type: 'same', grade: () => ({ passed: true, score: 1 }) },
    ])).toThrow(/already registered/);
  });
});
