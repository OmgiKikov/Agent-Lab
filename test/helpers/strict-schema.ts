import { z } from 'zod';

/**
 * Why a provider's strict structured output would refuse a schema: the root is not an object, an object
 * is open or has an optional property, or a union is written as `oneOf`. Size and range bounds are left
 * alone: callers strip them before sending (JUDGE_RESPONSE_FORMAT) and zod still checks them locally.
 */
export function strictSchemaProblems(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const problems: string[] = json.type === 'object' ? [] : ['#: the root is not an object'];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${path}/${index}`)); return; }
    if (!node || typeof node !== 'object') return;
    const object = node as Record<string, unknown>;
    if (object.type === 'object') {
      if (object.additionalProperties !== false) problems.push(`${path}: open object`);
      const required = new Set(object.required as string[] | undefined);
      for (const key of Object.keys(object.properties ?? {})) if (!required.has(key)) problems.push(`${path}/${key}: optional property`);
    }
    for (const keyword of ['oneOf', 'allOf', 'not', 'if', 'patternProperties']) if (keyword in object) problems.push(`${path}: ${keyword}`);
    for (const [key, value] of Object.entries(object)) visit(value, `${path}/${key}`);
  };
  visit(json, '#');
  return problems;
}
