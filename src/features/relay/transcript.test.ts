import assert from 'node:assert/strict';
import test from 'node:test';

import { createTranscriptProjector, type TranscriptActivityRow, type TranscriptRow } from './transcript.ts';
import type { HermesMessage, HermesRunEvent } from '../../lib/types.ts';

const message = (value: Partial<HermesMessage> & Pick<HermesMessage, 'role'>): HermesMessage => value;
const event = (value: Partial<HermesRunEvent> & Pick<HermesRunEvent, 'event'>): HermesRunEvent => value;

function activityOf(rows: readonly TranscriptRow[]): TranscriptActivityRow {
  const row = rows.find((candidate) => candidate.kind === 'activity');
  if (!row || row.kind !== 'activity') assert.fail('expected an activity row');
  return row;
}

test('folds commentary and tool calls of a finished turn into one activity row', () => {
  const rows = createTranscriptProjector()({
    history: [
      message({ id: 'u1', role: 'user', content: 'Find the report', timestamp: 1000 }),
      message({ id: 'meta', role: 'system', content: 'raw protocol metadata' }),
      message({ id: 'a1', role: 'assistant', content: 'I will look.', timestamp: 1001 }),
      message({ id: 't1', role: 'tool', toolName: 'search', content: 'searched', toolCallId: 'call-1' }),
      message({ id: 't2', role: 'tool', toolName: 'open', content: 'opened', toolCallId: 'call-2' }),
      message({ id: 'a2', role: 'assistant', content: 'Here it is.', timestamp: 1042 }),
    ],
    events: [],
    running: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'activity', 'assistant']);
  const activity = activityOf(rows);
  assert.equal(activity.status, 'complete');
  assert.deepEqual(activity.steps.map((step) => step.kind), ['note', 'tool', 'tool']);
  assert.deepEqual(activity.steps.map((step) => step.kind === 'tool' ? step.output : step.text), ['I will look.', 'searched', 'opened']);
  assert.equal(activity.startedAt, 1000);
  assert.equal(activity.endedAt, 1042);
});

test('merges durable tool calls with their results, keeping the target, reasoning, and failures', () => {
  const rows = createTranscriptProjector()({
    history: [
      message({ id: 'u1', role: 'user', content: 'Run the tests' }),
      message({
        id: 'a1',
        role: 'assistant',
        reasoning: 'The suite lives in pnpm.',
        toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'terminal', arguments: '{"command":"pnpm test"}' } }],
      }),
      message({ id: 't1', role: 'tool', toolName: 'terminal', toolCallId: 'call-1', content: '{"output":"1 failing","exit_code":1}' }),
      message({ id: 'a2', role: 'assistant', content: 'One test fails.' }),
    ],
    events: [],
    running: false,
  });

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'activity', 'assistant']);
  const [thought, tool] = activityOf(rows).steps;
  assert.equal(thought?.kind === 'thought' && thought.text, 'The suite lives in pnpm.');
  assert.equal(tool?.kind, 'tool');
  if (tool?.kind === 'tool') {
    assert.equal(tool.name, 'terminal');
    assert.equal(tool.input, 'pnpm test');
    assert.equal(tool.output, '{"output":"1 failing","exit_code":1}');
    assert.equal(tool.status, 'failed');
  }
});

test('keeps a live tool target from its start and its duration from completion', () => {
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

  assert.deepEqual(rows.map((row) => row.kind), ['activity', 'assistant']);
  const activity = activityOf(rows);
  assert.equal(activity.status, 'running');
  assert.deepEqual(activity.steps.map((step) => step.kind), ['note', 'tool', 'tool']);
  const [, search, open] = activity.steps;
  assert.deepEqual(search?.kind === 'tool' && [search.input, search.output, search.duration, search.status], ['{"query":"report"}', '', 12, 'complete']);
  assert.deepEqual(open?.kind === 'tool' && [open.input, open.output], ['report.md', 'done']);
});

test('moves streamed commentary into the activity once a tool follows it', () => {
  const projector = createTranscriptProjector();
  const history = [message({ id: 'u1', role: 'user', content: 'Check it' })];
  const commentary = [event({ event: 'message.delta', delta: 'Checking the config first.' })];
  const streaming = projector({ history, events: commentary, runId: 'run-1', running: true });
  assert.deepEqual(streaming.map((row) => row.kind), ['user', 'activity', 'assistant']);

  const tooling = projector({ history, events: [...commentary, event({ event: 'reasoning.available', text: 'Config first.' }), event({ event: 'tool.started', tool: 'read_file', preview: 'app.config.ts' })], runId: 'run-1', running: true });
  assert.deepEqual(tooling.map((row) => row.kind), ['user', 'activity']);
  assert.deepEqual(activityOf(tooling).steps.map((step) => step.kind), ['note', 'thought', 'tool']);
});

test('reasoning reported after the answer does not fold the answer into the activity', () => {
  const rows = createTranscriptProjector()({
    history: [message({ id: 'u1', role: 'user', content: 'Why?' })],
    events: [
      event({ event: 'message.delta', delta: 'Because.' }),
      event({ event: 'reasoning.available', text: 'Short answer is enough.' }),
      event({ event: 'run.completed', output: 'Because.' }),
    ],
    runId: 'run-1',
    running: false,
  });
  assert.deepEqual(rows.map((row) => row.kind), ['user', 'activity', 'assistant']);
  assert.equal(rows[2]?.kind === 'assistant' && rows[2].text, 'Because.');
  assert.deepEqual(activityOf(rows).steps.map((step) => step.kind), ['thought']);
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

  const steps = activityOf(rows).steps;
  assert.equal(steps.length, 2);
  assert.notEqual(steps[0]?.id, steps[1]?.id);
  assert.deepEqual(steps.map((step) => step.kind === 'tool' && step.status), ['complete', 'complete']);
});

test('names the run phase while active and the outcome once stopped', () => {
  const history = [message({ id: 'u1', role: 'user', content: 'Deploy', timestamp: 100 })];
  const phase = (runStatus: 'queued' | 'waiting_for_approval' | 'stopping' | 'running') => activityOf(createTranscriptProjector()({ history, events: [], runId: 'run-1', runStatus, running: true })).phase;
  assert.equal(phase('queued'), 'working');
  assert.equal(phase('waiting_for_approval'), 'approval');
  assert.equal(phase('stopping'), 'stopping');
  assert.equal(phase('running'), 'working');

  const stopped = createTranscriptProjector()({ history, events: [event({ event: 'run.cancelled' })], runId: 'run-1', runStatus: 'cancelled', runStartedAt: 100, runEndedAt: 112, running: false });
  assert.deepEqual(stopped.map((row) => row.kind), ['user', 'activity']);
  const activity = activityOf(stopped);
  assert.deepEqual([activity.status, activity.startedAt, activity.endedAt], ['stopped', 100, 112]);
});

test('refreshed history timestamps update the turn duration', () => {
  const projector = createTranscriptProjector();
  const history = (end: number) => [
    message({ id: 'u1', role: 'user', content: 'Go', timestamp: 100 }),
    message({ id: 't1', role: 'tool', toolName: 'terminal', toolCallId: 'c1', content: 'ok' }),
    message({ id: 'a1', role: 'assistant', content: 'Done.', timestamp: end }),
  ];
  assert.equal(activityOf(projector({ history: history(110), events: [], running: false })).endedAt, 110);
  assert.equal(activityOf(projector({ history: history(142), events: [], running: false })).endedAt, 142);
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

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'activity', 'assistant']);
  assert.equal(activityOf(rows).steps.length, 2);
});

test('keeps errors visible and only adds an activity to a settled turn with steps', () => {
  const history = [
    message({ id: 'u1', role: 'user', content: 'Run it' }),
    message({ id: 'a1', role: 'assistant', content: 'Starting.' }),
    message({ id: 'e1', role: 'error', content: 'Permission denied' }),
    message({ id: 'a2', role: 'assistant', content: 'I could not finish.' }),
  ];
  const active = createTranscriptProjector()({ history, events: [], running: true });
  assert.deepEqual(active.map((row) => row.kind), ['user', 'activity', 'assistant', 'error', 'assistant']);

  const finished = createTranscriptProjector()({ history, events: [], running: false });
  assert.deepEqual(finished.map((row) => row.kind), ['user', 'assistant', 'error', 'assistant']);
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

  assert.deepEqual(rows.map((row) => row.kind), ['user', 'activity', 'assistant']);
  assert.equal(activityOf(rows).status, 'complete');
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
  assert.equal(second[1], first[1], 'an unchanged activity keeps its identity');
  assert.notEqual(second[2], first[2]);
  if (second[2]?.kind === 'assistant') assert.equal(second[2].text, 'one two');
  else assert.fail('expected the live tail to be an assistant row');

  firstEvents.push(event({ event: 'message.delta', delta: ' two' }));
  const appended = projector({ history, events: firstEvents, runId: 'run-1', running: true });
  assert.equal(appended[2]?.kind, 'assistant');
  firstEvents.push(event({ event: 'message.delta', delta: ' three' }));
  const inPlace = projector({ history, events: firstEvents, runId: 'run-1', running: true });
  assert.equal(inPlace[0], second[0]);
  assert.equal(inPlace[2]?.kind, 'assistant');
  if (inPlace[2]?.kind === 'assistant') assert.equal(inPlace[2].text, 'one two three');

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
  assert.deepEqual(rows.map((row) => row.kind), ['activity', 'assistant']);
  assert.equal(rows[1].kind === 'assistant' && rows[1].text, 'Only once');
});

test('preserves identical timestamped deltas without a transport identity', () => {
  const projector = createTranscriptProjector();
  const delta = event({ event: 'message.delta', delta: 'Same chunk', timestamp: 100 });
  const rows = projector({ history: [], events: [delta, { ...delta }], runId: 'run-1', running: true });
  assert.deepEqual(rows.map((row) => row.kind), ['activity', 'assistant']);
  assert.equal(rows[1].kind === 'assistant' && rows[1].text, 'Same chunkSame chunk');
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
  assert.deepEqual(live.map((row) => row.kind), ['activity', 'assistant']);
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
