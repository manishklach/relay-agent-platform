export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalDecision = Exclude<ApprovalStatus, 'pending'>;

export type ApprovalTransition = {
  from: 'pending';
  to: ApprovalDecision;
  executeTool: boolean;
};

export function transitionApproval(current: ApprovalStatus, decision: ApprovalDecision): ApprovalTransition {
  if (current !== 'pending') throw new Error('Approval has already been decided.');
  return { from: 'pending', to: decision, executeTool: decision === 'approved' };
}

export async function applyApprovalDecision<T>(
  transition: ApprovalTransition,
  execute: () => Promise<T>,
): Promise<T | { rejected: true }> {
  if (!transition.executeTool) return { rejected: true };
  return execute();
}
