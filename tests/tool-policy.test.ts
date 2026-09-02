import { describe, expect, it } from 'vitest';

import { getAllowedTool } from '../lib/tool-policy';
import type { ToolDefinition } from '../lib/tools';

const available: ToolDefinition[] = [
  { name: 'lookup', description: 'Read data', parameters: {}, mutating: false },
  { name: 'delete', description: 'Delete data', parameters: {}, mutating: true },
];

describe('tool allowlist enforcement', () => {
  it('returns a tool only when both registered and explicitly allowlisted', () => {
    expect(getAllowedTool('lookup', ['lookup'], available)?.name).toBe('lookup');
  });

  it('rejects a registered tool omitted from the agent allowlist', () => {
    expect(getAllowedTool('delete', ['lookup'], available)).toBeUndefined();
  });

  it('rejects an allowlisted name that is unavailable at runtime', () => {
    expect(getAllowedTool('missing', ['missing'], available)).toBeUndefined();
  });
});
