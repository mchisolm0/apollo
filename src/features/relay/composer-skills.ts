import type { HermesSkill } from '../../lib/types.ts';

export type SkillTrigger = { query: string; start: number; end: number };

export function skillTrigger(text: string, cursor = text.length): SkillTrigger | undefined {
  const end = Math.max(0, Math.min(text.length, Math.floor(cursor)));
  let start = end - 1;
  while (start >= 0 && !/\s/.test(text[start] ?? '')) start -= 1;
  start += 1;
  const token = text.slice(start, end);
  if (!token.startsWith('$')) return;
  return { query: token.slice(1), start, end };
}

export function matchingSkills(trigger: SkillTrigger | undefined, skills: readonly HermesSkill[], limit = 20): readonly HermesSkill[] {
  if (!trigger) return [];
  const query = trigger.query.toLocaleLowerCase();
  if (!query) return skills.slice(0, limit);
  return skills
    .map((skill) => {
      const name = skill.name.toLocaleLowerCase();
      const details = `${skill.category ?? ''} ${skill.description ?? ''}`.toLocaleLowerCase();
      const score = name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : details.includes(query) ? 3 : -1;
      return { skill, score };
    })
    .filter((result) => result.score >= 0)
    .sort((left, right) => left.score - right.score || left.skill.name.localeCompare(right.skill.name))
    .slice(0, limit)
    .map(({ skill }) => skill);
}

export function insertSkill(text: string, trigger: SkillTrigger, name: string) {
  const prefix = trigger.start > 0 && !/\s/.test(text[trigger.start - 1] ?? '') ? ' ' : '';
  const suffix = /\s/.test(text[trigger.end] ?? '') ? '' : ' ';
  const replacement = `${prefix}$${name}${suffix}`;
  return {
    text: `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`,
    cursor: trigger.start + replacement.length,
  };
}

/** Returns known skill references once, in the order they appear in the message. */
export function selectedSkillNames(text: string, skills: readonly HermesSkill[]): readonly string[] {
  if (!skills.length) return [];
  // Typed references are case-insensitive; report the catalog spelling.
  const canonical = new Map(skills.map((skill) => [skill.name.toLocaleLowerCase(), skill.name]));
  const names = [...canonical.keys()].sort((left, right) => right.length - left.length);
  const pattern = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const references = new RegExp(`(?:^|\\s)\\$(${pattern})(?=$|\\s|[.,!?;:)\\]])`, 'gi');
  const selected: string[] = [];
  for (const match of text.matchAll(references)) {
    const name = canonical.get((match[1] ?? '').toLocaleLowerCase());
    if (name && !selected.includes(name)) selected.push(name);
  }
  return selected;
}
