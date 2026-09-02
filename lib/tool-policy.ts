import type { ToolDefinition } from './tools';

export function getAllowedTool(
  name: string,
  allowedNames: readonly string[],
  availableTools: readonly ToolDefinition[],
): ToolDefinition | undefined {
  if (!allowedNames.includes(name)) return undefined;
  return availableTools.find((tool) => tool.name === name);
}
