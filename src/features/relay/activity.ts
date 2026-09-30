import type { TranscriptActivityRow, TranscriptStatus } from './transcript.ts';
import type { ConnectionState } from './types.ts';

type ToolCopy = {
  readonly active: string;
  readonly done: string;
  /** The argument Hermes treats as the call's target, mirrored from its tool previews. */
  readonly arg?: string;
};

// Verbs for the Hermes tools that dominate coding turns. Unknown tools fall back to their name.
const TOOL_COPY: Readonly<Record<string, ToolCopy>> = {
  terminal: { active: 'Running', done: 'Ran', arg: 'command' },
  execute_code: { active: 'Running code', done: 'Ran code', arg: 'code' },
  process_manage: { active: 'Managing process', done: 'Managed process', arg: 'action' },
  read_file: { active: 'Reading', done: 'Read', arg: 'path' },
  write_file: { active: 'Writing', done: 'Wrote', arg: 'path' },
  patch: { active: 'Editing', done: 'Edited', arg: 'path' },
  search_files: { active: 'Searching', done: 'Searched', arg: 'pattern' },
  web_search: { active: 'Searching web', done: 'Searched web', arg: 'query' },
  web_extract: { active: 'Fetching', done: 'Fetched', arg: 'urls' },
  browser_navigate: { active: 'Opening', done: 'Opened', arg: 'url' },
  vision_analyze: { active: 'Viewing image', done: 'Viewed image', arg: 'question' },
  skill_view: { active: 'Loading skill', done: 'Loaded skill', arg: 'name' },
  delegate_task: { active: 'Delegating', done: 'Delegated', arg: 'goal' },
};

export function friendlyToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function toolVerb(name: string, status: TranscriptStatus): string {
  const copy = TOOL_COPY[name];
  if (!copy) return friendlyToolName(name);
  return status === 'running' ? copy.active : copy.done;
}

/** The single-line target for a durable tool call, read from its parsed arguments. */
export function toolTarget(name: string, args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args[TOOL_COPY[name]?.arg ?? ''];
  if (typeof value === 'string') return oneLine(value) || undefined;
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(', ') || undefined;
  return undefined;
}

export function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Hermes wraps many tool results as JSON ({ output, exit_code } or { success, error }); show the text inside. */
export function readableOutput(output: string): string {
  if (!output.trimStart().startsWith('{')) return output;
  try {
    const result: unknown = JSON.parse(output);
    if (typeof result !== 'object' || result === null) return output;
    const { output: text, error, exit_code: exitCode } = result as Record<string, unknown>;
    const parts = [typeof text === 'string' ? text : undefined, typeof error === 'string' ? error : undefined, typeof exitCode === 'number' && exitCode !== 0 ? `Exit code ${exitCode}` : undefined];
    return parts.some(Boolean) ? parts.filter(Boolean).join('\n') : output;
  } catch {
    return output;
  }
}

/** Hermes reports seconds; some clients stamp milliseconds. */
export function toSeconds(value: number): number {
  return value > 100_000_000_000 ? value / 1000 : value;
}

export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m ${whole % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Seconds between two timestamps, or undefined when either end is unknown. */
export function elapsed(startedAt: number | undefined, endedAt: number | undefined): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  return Math.max(0, toSeconds(endedAt) - toSeconds(startedAt));
}

/**
 * What a running turn is doing right now. Only states the agent or transport
 * actually reported: Hermes exposes no live reasoning, so there is no "Thinking".
 */
export function liveActivityLabel(row: TranscriptActivityRow, connection: ConnectionState): string {
  if (row.phase === 'approval') return 'Needs approval';
  if (row.phase === 'stopping') return 'Stopping';
  if (connection === 'revoked') return 'Access revoked';
  if (connection !== 'connected') return 'Reconnecting';
  if (row.phase === 'starting') return 'Starting';
  const tool = row.steps.findLast((step) => step.kind === 'tool' && step.status === 'running');
  if (tool?.kind === 'tool') return [toolVerb(tool.name, 'running'), oneLine(tool.input)].filter(Boolean).join(' ');
  return 'Working';
}

/** The one-line fold for a settled turn, e.g. "Worked for 42s · 6 steps", or "Thought for 8s" for reasoning alone. */
export function settledActivityLabel(row: TranscriptActivityRow): string {
  const seconds = elapsed(row.startedAt, row.endedAt);
  const took = seconds === undefined ? undefined : formatDuration(seconds);
  if (row.status === 'complete' && row.steps.length && row.steps.every((step) => step.kind === 'thought')) return took ? `Thought for ${took}` : 'Thought';
  const count = row.steps.length;
  const steps = count ? `${count} ${count === 1 ? 'step' : 'steps'}` : undefined;
  const outcome = row.status === 'stopped' ? 'Stopped' : row.status === 'failed' ? 'Failed' : undefined;
  if (outcome) return [took ? `${outcome} after ${took}` : outcome, steps].filter(Boolean).join(' · ');
  if (took) return [`Worked for ${took}`, steps].filter(Boolean).join(' · ');
  return `Worked through ${steps ?? '0 steps'}`;
}
