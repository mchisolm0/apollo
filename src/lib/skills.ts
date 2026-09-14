import { isJsonObject, stringValue } from './protocol.ts';
import type { HermesSkill } from './types.ts';

/** The API returns only skills available to this agent. Keep names intact for skill_view. */
export function parseSkills(value: unknown): readonly HermesSkill[] {
  if (!isJsonObject(value) || !Array.isArray(value.data)) throw new Error('The skills response was invalid.');
  const skills = new Map<string, HermesSkill>();
  for (const entry of value.data) {
    if (!isJsonObject(entry) || typeof entry.name !== 'string' || !entry.name.trim()) continue;
    skills.set(entry.name, {
      name: entry.name,
      description: stringValue(entry.description),
      category: stringValue(entry.category),
    });
  }
  return [...skills.values()];
}
