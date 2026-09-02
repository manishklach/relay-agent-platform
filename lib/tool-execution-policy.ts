export type FailureDisposition = {
  status: 'retry_scheduled' | 'dead_letter' | 'unknown';
  nextAttemptAt: number;
  terminal: boolean;
};

export function failureDisposition(
  input: { retrySafe: boolean; attempts: number; maxAttempts: number },
  now: number,
): FailureDisposition {
  if (!input.retrySafe)
    return { status: 'unknown', nextAttemptAt: now, terminal: true };
  if (input.attempts >= input.maxAttempts) {
    return { status: 'dead_letter', nextAttemptAt: now, terminal: true };
  }
  const delay = Math.min(1_000 * 2 ** Math.max(0, input.attempts - 1), 60_000);
  return {
    status: 'retry_scheduled',
    nextAttemptAt: now + delay,
    terminal: false,
  };
}
