import assert from 'node:assert/strict';
import test from 'node:test';

import { insertSkill, matchingSkills, selectedSkillNames, skillTrigger } from './composer-skills.ts';

const skills = [
  { name: 'research', description: 'Find primary sources', category: 'Writing' },
  { name: 'frontend-design', description: 'Build polished interfaces', category: 'Design' },
  { name: 'web-research', description: 'Search the web', category: 'Research' },
] as const;

test('skill triggers use the token at the cursor', () => {
  assert.deepEqual(skillTrigger('Use $front'), { query: 'front', start: 4, end: 10 });
  assert.deepEqual(skillTrigger('$research\nthen', 9), { query: 'research', start: 0, end: 9 });
  assert.equal(skillTrigger('price$research'), undefined);
  assert.equal(skillTrigger('Use $research later'), undefined);
});

test('skills filter by name first, then metadata', () => {
  assert.deepEqual(matchingSkills(skillTrigger('$research'), skills).map((skill) => skill.name), ['research', 'web-research']);
  assert.deepEqual(matchingSkills(skillTrigger('$design'), skills).map((skill) => skill.name), ['frontend-design']);
});

test('selection replaces the trigger and known references are deduplicated', () => {
  assert.deepEqual(insertSkill('Use $front today', { query: 'front', start: 4, end: 10 }, 'frontend-design'), { text: 'Use $frontend-design today', cursor: 20 });
  assert.deepEqual(insertSkill('hello world', { query: '', start: 5, end: 5 }, 'research'), { text: 'hello $research world', cursor: 15 });
  assert.deepEqual(insertSkill('helloworld', { query: '', start: 5, end: 5 }, 'research'), { text: 'hello $research world', cursor: 16 });
  assert.deepEqual(selectedSkillNames('$research, compare with $frontend-design and $research.', skills), ['research', 'frontend-design']);
  assert.deepEqual(selectedSkillNames('$unknown $researching', skills), []);
});

test('skill references match regardless of case and report the catalog spelling', () => {
  assert.deepEqual(selectedSkillNames('Use $Research for this', skills), ['research']);
  assert.deepEqual(selectedSkillNames('$RESEARCH and $research', skills), ['research']);
  assert.deepEqual(selectedSkillNames('$Frontend-Design mock', skills), ['frontend-design']);
  assert.deepEqual(selectedSkillNames('$Unknown $researching', skills), []);
});
