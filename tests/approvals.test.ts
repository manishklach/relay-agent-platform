import { describe, expect, it, vi } from 'vitest';

import { applyApprovalDecision, transitionApproval } from '../lib/approvals';

describe('approval state machine', () => {
  it('transitions pending to approved and executes exactly once', async () => {
    const execute = vi.fn(async () => ({ submitted: true }));
    const transition = transitionApproval('pending', 'approved');
    await expect(applyApprovalDecision(transition, execute)).resolves.toEqual({ submitted: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('transitions pending to rejected without executing', async () => {
    const execute = vi.fn(async () => ({ submitted: true }));
    const transition = transitionApproval('pending', 'rejected');
    await expect(applyApprovalDecision(transition, execute)).resolves.toEqual({ rejected: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['approved', 'rejected'] as const)('prevents a decided %s approval from transitioning again', (status) => {
    expect(() => transitionApproval(status, 'approved')).toThrow(/already been decided/);
  });
});
