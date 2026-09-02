export type GraderInput = {
  output: string;
  expected: Record<string, unknown>;
};

export type GraderResult = {
  passed: boolean;
  score: number;
  reason?: string;
};

export interface EvaluationGrader {
  readonly type: string;
  grade(input: GraderInput): GraderResult | Promise<GraderResult>;
}

export class GraderRegistry {
  private readonly graders = new Map<string, EvaluationGrader>();

  constructor(graders: readonly EvaluationGrader[] = []) {
    for (const grader of graders) this.register(grader);
  }

  register(grader: EvaluationGrader): void {
    if (!/^[a-z][a-z0-9_]*$/.test(grader.type)) throw new Error(`Invalid grader type: ${grader.type}`);
    if (this.graders.has(grader.type)) throw new Error(`Grader already registered: ${grader.type}`);
    this.graders.set(grader.type, grader);
  }

  has(type: string): boolean {
    return this.graders.has(type);
  }

  async grade(type: string, input: GraderInput): Promise<GraderResult> {
    const grader = this.graders.get(type);
    if (!grader) throw new Error(`Unsupported grader type: ${type}`);
    return grader.grade(input);
  }
}

const containsGrader: EvaluationGrader = {
  type: 'contains',
  grade: ({ output, expected }) => {
    const terms = stringArray(expected.contains);
    const normalized = output.toLowerCase();
    const missing = terms.filter((term) => !normalized.includes(term.toLowerCase()));
    return {
      passed: terms.length > 0 && missing.length === 0,
      score: terms.length ? (terms.length - missing.length) / terms.length : 0,
      reason: missing.length ? `Missing expected terms: ${missing.join(', ')}` : undefined,
    };
  },
};

const notContainsGrader: EvaluationGrader = {
  type: 'not_contains',
  grade: ({ output, expected }) => {
    const terms = stringArray(expected.notContains);
    const normalized = output.toLowerCase();
    const present = terms.filter((term) => normalized.includes(term.toLowerCase()));
    return {
      passed: terms.length > 0 && present.length === 0,
      score: terms.length ? (terms.length - present.length) / terms.length : 0,
      reason: present.length ? `Found forbidden terms: ${present.join(', ')}` : undefined,
    };
  },
};

export const defaultGraderRegistry = new GraderRegistry([containsGrader, notContainsGrader]);

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
