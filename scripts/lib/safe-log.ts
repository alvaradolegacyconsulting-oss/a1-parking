// ════════════════════════════════════════════════════════════════════
// safe-log — writes that cannot abort a cleanup
// ════════════════════════════════════════════════════════════════════
// 🔴 LEARNED THE HARD WAY, 2026-10-16. verify:queue was run as
//
//   npm run verify:queue 2>&1 | head -60
//
// head exited at line 60 and closed both pipes. The gate took SIGPIPE,
// its handler called cleanup, and cleanup's FIRST statement was a
// console.error — which threw EPIPE on the closed stream and aborted
// the function before it restored anything. It left
// bulk_onboarding_enabled ON for the demo company and, worse, TWO LIVE
// `admin` role rows, which is the exact leftover that gate's own
// comment calls the worst thing it could leave behind.
//
// The lesson generalises past SIGPIPE: a cleanup path must not depend
// on stdout being alive. Any `console.*` inside one is a statement that
// can throw, and everything after it is conditional on a pipe nobody
// controls. So cleanups log through these, which swallow their own
// failures, and do their restores regardless.
//
// 🔴 And the ORDER still matters. Logging that cannot throw is not a
// licence to log before restoring: put the writes that undo state
// first, so even an uncaught throw somewhere unexpected has already
// been preceded by the restore.

export const say = (msg: string): void => {
  try { process.stdout.write(msg + '\n') } catch { /* the pipe is gone; the work is not */ }
}

export const warn = (msg: string): void => {
  try { process.stderr.write(msg + '\n') } catch { /* same */ }
}
