import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { Inbox } from '../src/inbox';
import { inbox } from './helpers';

describe('migrations', () => {
  it('leave a schema version newer than the code alone, as after a rollback', async () => {
    const version = await runInDurableObject(inbox(), (_, state) => {
      const current = state.storage.kv.get<number>('schemaVersion') ?? 0;
      state.storage.kv.put('schemaVersion', current + 1);
      // Older code starting on newer storage: it must neither lower the version nor run anything.
      new Inbox(state, env);
      return { current, after: state.storage.kv.get<number>('schemaVersion') };
    });
    expect(version.after).toBe(version.current + 1);
  });
});
