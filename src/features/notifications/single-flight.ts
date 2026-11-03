type Task<A> = (arg?: A) => Promise<void>;

/**
 * Runs one task at a time. Calls made while one runs collapse into a single follow-up run of
 * the latest task, which keeps the most recent defined argument.
 */
export function singleFlight<A>() {
  let running = false;
  let queued: { task: Task<A>; arg?: A } | undefined;
  const run = async (task: Task<A>, arg?: A): Promise<void> => {
    if (running) {
      queued = { task, arg: arg ?? queued?.arg };
      return;
    }
    running = true;
    try {
      await task(arg);
    } finally {
      running = false;
      const next = queued;
      queued = undefined;
      if (next) void run(next.task, next.arg).catch(() => {});
    }
  };
  return run;
}
