import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranscriptProjector } from './transcript.ts';
import type { HermesMessage, HermesRunEvent } from '../../lib/types.ts';

const message = (value: Partial<HermesMessage> & Pick<HermesMessage, 'role'>): HermesMessage => value;
const event = (value: Partial<HermesRunEvent> & Pick<HermesRunEvent, 'event'>): HermesRunEvent => value;

test('projects messages and collapses consecutive historical tools', () => {
  const rows = createTranscriptProjector()({
    history: [
      message({ id: 'u1', role: 'user', content: 'Find the report' }),
      message({ id: 'meta', role: 'system', content: 'raw protocol metadata' }),
      message({ id: 'a1', role: 'assistant', content: 'I will look.' }),
      message({ id: 't1', role: 'tool', toolName: 'search', content: 'searched', toolCallId: 'call-1' }),
      message({ id: 't2', role: 'tool', toolName: 'open', content: 'opened', toolCallId: 'call-2' }),
      message({ id: 'a2', role: 'assistant', content: 'Here it is.' }),
    ],
    events: [],
    running: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'assistant', 'work', 'assistant']);
  assert.equal(rows[2]?.kind, 'work');
  if (rows[2]?.kind === 'work') {
    assert.equal(rows[2].items.length, 2);
    assert.deepEqual(rows[2].items.map((item) => item.name), ['search', 'open']);
    assert.equal(rows[2].status, 'complete');
  }
});

test('groups live tools, preserves assistant segments around them, and collapses start/completion', () => {
  const events = [
    event({ event: 'message.delta', delta: 'Before ' }),
    event({ event: 'message.delta', delta: 'the tool' }),
    event({ event: 'tool.started', tool: 'search', preview: '{"query":"report"}' }),
    event({ event: 'tool.completed', tool: 'search', duration: 12 }),
    event({ event: 'tool.started', tool: 'open', preview: 'report.md', call_id: 'call-open' }),
    event({ event: 'tool.completed', tool: 'open', call_id: 'call-open', text: 'done' }),
    event({ event: 'message.delta', delta: 'After the tools.' }),
  ];
  const rows = createTranscriptProjector()({ history: [], events, runId: 'run-1', running: true });

  assert.deepEqual(rows.map((row) => row.kind), ['assistant', 'work', 'assistant']);
  assert.notEqual(rows[0]?.id, rows[2]?.id);
  if (rows[1]?.kind === 'work') {
    assert.equal(rows[1].items.length, 2);
    assert.deepEqual(rows[1].items.map((item) => item.status), ['complete', 'complete']);
    assert.equal(rows[1].items[0]?.text, '{"query":"report"}');
    assert.equal(rows[1].items[1]?.text, 'done');
  }
});

test('keeps concurrent same-name no-ID tools separate', () => {
  const rows = createTranscriptProjector()({
    history: [],
    events: [
      event({ event: 'tool.started', tool: 'search', preview: 'first query' }),
      event({ event: 'tool.started', tool: 'search', preview: 'second query' }),
      event({ event: 'tool.completed', tool: 'search' }),
      event({ event: 'tool.completed', tool: 'search' }),
    ],
    runId: 'run-concurrent',
    running: true,
  });

  assert.equal(rows.length, 1);
  if (rows[0]?.kind === 'work') {
    assert.equal(rows[0].items.length, 2);
    assert.notEqual(rows[0].items[0]?.id, rows[0].items[1]?.id);
    assert.deepEqual(rows[0].items.map((item) => item.status), ['complete', 'complete']);
    assert.equal(rows[0].summary, '2 tools completed');
  }
});

test('switches to durable current-turn history after a terminal final match', () => {
  const rows = createTranscriptProjector()({
    history: [
      message({ id: 'u1', role: 'user', content: 'Read the guide', timestamp: 1000 }),
      message({ id: 'a-open', role: 'assistant', content: 'I will inspect it.', timestamp: 1001 }),
      message({ id: 't1', role: 'tool', toolName: 'skill_view', content: 'guide content', timestamp: 1002 }),
      message({ id: 'a-final', role: 'assistant', content: 'Here is the guide.', timestamp: 1003 }),
    ],
    events: [
      event({ event: 'message.delta', delta: 'I will inspect it.', timestamp: 1001 }),
      event({ event: 'tool.started', tool: 'skill_view', preview: 'guide', timestamp: 1002 }),
      event({ event: 'tool.completed', tool: 'skill_view', timestamp: 1002 }),
      event({ event: 'message.delta', delta: 'Here is the guide.', timestamp: 1003 }),
      event({ event: 'run.completed', timestamp: 1003 }),
    ],
    runId: 'run-durable',
    runStartedAt: 1000,
    running: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'assistant', 'work', 'assistant']);
  assert.equal(rows.at(-1)?.kind, 'assistant');
  assert.equal(rows.length, 4);
});

test('folds finished turn progress while keeping opening and final assistants visible', () => {
  const rows = createTranscriptProjector()({
    history: [
      message({ id: 'u1', role: 'user', content: 'Inspect the project' }),
      message({ id: 'a1', role: 'assistant', content: 'I am checking.' }),
      message({ id: 't1', role: 'tool', toolName: 'list_files', content: 'src' }),
      message({ id: 'a2', role: 'assistant', content: 'I found the relevant files.' }),
      message({ id: 't2', role: 'tool', toolName: 'read_file', content: 'transcript.ts' }),
      message({ id: 'a3', role: 'assistant', content: 'Here is what changed.' }),
    ],
    events: [],
    running: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'assistant', 'work', 'assistant']);
  if (rows[2]?.kind === 'work') {
    assert.equal(rows[2].summary, 'Worked through 3 steps');
    assert.deepEqual(rows[2].items.map((item) => item.name), ['list_files', 'Progress update', 'read_file']);
  }
});

test('does not fold the active current turn and keeps errors outside folded work', () => {
  const history = [
    message({ id: 'u1', role: 'user', content: 'Run it' }),
    message({ id: 'a1', role: 'assistant', content: 'Starting.' }),
    message({ id: 'e1', role: 'error', content: 'Permission denied' }),
    message({ id: 'a2', role: 'assistant', content: 'I could not finish.' }),
  ];
  const active = createTranscriptProjector()({ history, events: [], running: true });
  assert.deepEqual(active.map((row) => row.kind), ['user', 'assistant', 'error', 'assistant']);

  const finished = createTranscriptProjector()({ history, events: [], running: false });
  assert.deepEqual(finished.map((row) => row.kind), ['user', 'assistant', 'error', 'assistant']);
  assert.equal(finished[2]?.kind, 'error');
});

test('folds a completed live turn before durable history catches up', () => {
  const rows = createTranscriptProjector()({
    history: [message({ id: 'u1', role: 'user', content: 'Inspect it' })],
    events: [
      event({ event: 'message.delta', delta: 'I am checking.' }),
      event({ event: 'tool.started', tool: 'read_file', preview: 'transcript.ts' }),
      event({ event: 'tool.completed', tool: 'read_file' }),
      event({ event: 'message.delta', delta: 'Here is what changed.' }),
      event({ event: 'run.completed' }),
    ],
    runId: 'run-live-finished',
    running: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'assistant', 'work', 'assistant']);
  if (rows[2]?.kind === 'work') assert.equal(rows[2].summary, 'Worked through 1 step');
});

test('suppresses only a final assistant replay, preserving legitimate repeated text', () => {
  const projector = createTranscriptProjector();
  const replay = projector({
    history: [message({ id: 'a1', role: 'assistant', content: 'same answer' })],
    events: [event({ event: 'message.delta', delta: 'same answer' }), event({ event: 'run.completed' })],
    runId: 'run-1',
    running: false,
  });
  assert.equal(replay.length, 1);

  const repeated = createTranscriptProjector()({
    history: [
      message({ id: 'a1', role: 'assistant', content: 'same answer' }),
      message({ id: 'u2', role: 'user', content: 'Again' }),
    ],
    events: [event({ event: 'message.delta', delta: 'same answer' }), event({ event: 'run.completed' })],
    runId: 'run-2',
    running: false,
  });
  assert.deepEqual(repeated.map((row) => row.kind), ['assistant', 'user', 'assistant']);
});

test('reuses settled history and unchanged live rows across tail updates and replacement arrays', () => {
  const projector = createTranscriptProjector();
  const history = [message({ id: 'u1', role: 'user', content: 'hello' })];
  const firstEvents = [event({ event: 'message.delta', delta: 'one' })];
  const first = projector({ history, events: firstEvents, runId: 'run-1', running: true });
  const second = projector({ history, events: [...firstEvents, event({ event: 'message.delta', delta: ' two' })], runId: 'run-1', running: true });
  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  if (second[1]?.kind === 'assistant') assert.equal(second[1].text, 'one two');
  else assert.fail('expected the live tail to be an assistant row');

  firstEvents.push(event({ event: 'message.delta', delta: ' two' }));
  const appended = projector({ history, events: firstEvents, runId: 'run-1', running: true });
  assert.equal(appended[1]?.kind, 'assistant');
  firstEvents.push(event({ event: 'message.delta', delta: ' three' }));
  const inPlace = projector({ history, events: firstEvents, runId: 'run-1', running: true });
  assert.equal(inPlace[0], second[0]);
  assert.equal(inPlace[1]?.kind, 'assistant');
  if (inPlace[1]?.kind === 'assistant') assert.equal(inPlace[1].text, 'one two three');

  const replacement = projector({ history: [...history], events: [...firstEvents], runId: 'run-1', running: true });
  assert.equal(replacement, inPlace);
});

test('keeps a long settled history cheap while the live tail changes', () => {
  const history = Array.from({ length: 3000 }, (_, index) => message({ id: `u-${index}`, role: index % 2 ? 'assistant' : 'user', content: `message ${index}` }));
  const projector = createTranscriptProjector();
  const first = projector({ history, events: [event({ event: 'message.delta', delta: 'tail' })], runId: 'run-1', running: true });
  const started = performance.now();
  const second = projector({ history, events: [event({ event: 'message.delta', delta: 'tail 2' })], runId: 'run-1', running: true });
  const elapsed = performance.now() - started;

  assert.equal(second.length, first.length);
  assert.equal(second[0], first[0]);
  assert.equal(second.at(-1)?.kind, 'assistant');
  assert.ok(elapsed < 1000, `tail projection took ${elapsed.toFixed(1)}ms`);
});

test('replayed timestamped events do not duplicate streamed text', () => {
  const projector = createTranscriptProjector();
  const delta = event({ event: 'message.delta', delta: 'Only once', timestamp: 100, event_id: 'event-1' });
  const rows = projector({ history: [], events: [delta, { ...delta }], runId: 'run-1', running: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind === 'assistant' && rows[0].text, 'Only once');
});

test('preserves identical timestamped deltas without a transport identity', () => {
  const projector = createTranscriptProjector();
  const delta = event({ event: 'message.delta', delta: 'Same chunk', timestamp: 100 });
  const rows = projector({ history: [], events: [delta, { ...delta }], runId: 'run-1', running: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind === 'assistant' && rows[0].text, 'Same chunkSame chunk');
});

test('a polled final response replaces stale progress after the event stream disconnects', () => {
  const rows = createTranscriptProjector()({
    history: [
      message({ id: 'u', role: 'user', content: 'Count files', timestamp: 100 }),
      message({ id: 'a', role: 'assistant', content: 'The counts are ready.', timestamp: 110 }),
    ],
    events: [event({ event: 'message.delta', delta: 'Checking the files.' }), event({ event: 'tool.started', tool: 'terminal' })],
    runId: 'disconnected', runStartedAt: 100, runOutput: 'The counts are ready.', running: false,
  });
  assert.deepEqual(rows.map((row) => row.kind), ['user', 'assistant']);
  const final = rows.at(-1);
  assert.equal(final?.kind === 'assistant' && final.text, 'The counts are ready.');
});

test('terminal output supplies the answer when deltas were missed', () => {
  const events = [
    event({ event: 'tool.started', tool: 'vision_analyze', call_id: 'call-1' }),
    event({ event: 'tool.completed', tool: 'vision_analyze', call_id: 'call-1' }),
    event({ event: 'run.completed', output: 'It looks like an old engine block, heavily corroded.' }),
  ];
  const projector = createTranscriptProjector();
  const live = projector({ history: [], events, runId: 'run-1', running: false });
  assert.deepEqual(live.map((row) => row.kind), ['work', 'assistant']);
  const answer = live.at(-1);
  assert.equal(answer?.kind === 'assistant' && answer.text, 'It looks like an old engine block, heavily corroded.');
});

test('terminal output extends a partial stream instead of duplicating it', () => {
  const events = [
    event({ event: 'message.delta', delta: 'It looks like an old' }),
    event({ event: 'run.completed', output: 'It looks like an old engine block, heavily corroded.' }),
  ];
  const rows = createTranscriptProjector()({ history: [], events, runId: 'run-1', running: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind === 'assistant' && rows[0].text, 'It looks like an old engine block, heavily corroded.');
});

test('terminal output replaces a stream that missed its opening deltas', () => {
  const events = [
    event({ event: 'message.delta', delta: 'engine block, heavily corroded.' }),
    event({ event: 'run.completed', output: 'It looks like an old engine block, heavily corroded.' }),
  ];
  const rows = createTranscriptProjector()({ history: [], events, runId: 'run-1', running: false });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind === 'assistant' && rows[0].text, 'It looks like an old engine block, heavily corroded.');
});

test('terminal output dedupes against equal fresh history', () => {
  const events = [event({ event: 'run.completed', output: 'Here is the summary.' })];
  const history = [message({ role: 'user', content: 'Tell me', timestamp: 10 }), message({ role: 'assistant', content: 'Here is the summary.', timestamp: 15 })];
  const projector = createTranscriptProjector();
  const live = projector({ history, events, runId: 'run-1', running: false });
  assert.deepEqual(live.map((row) => row.kind), ['user', 'assistant']);
});
