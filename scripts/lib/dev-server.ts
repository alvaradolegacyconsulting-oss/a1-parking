// ════════════════════════════════════════════════════════════════════
// dev-server — start one for a gate, and actually stop it
// ════════════════════════════════════════════════════════════════════
// 🔴 LEARNED 2026-10-16. Gates spawned `npx next dev -p <port>` and
// stopped it with child.kill('SIGTERM'). That kills the `npx` wrapper.
// It does NOT kill its children, so `next dev` and `next-server` were
// left running — one was found 45 minutes later still holding port
// 3995, which then surfaced inside a LATER run as
//
//   [server] Error: listen EADDRINUSE: address already in use :::3995
//
// A gate that leaves a server behind is worse than one that fails:
// the next run's port check passes (the stray is on a different port,
// or the check races), and a stale build can answer a gate's requests
// and report green. "Gates must refuse a server they did not start"
// only works if gates also stop the ones they did.
//
// So: spawn DETACHED, which makes the child a process-group leader, and
// kill the whole group with process.kill(-pid). Then confirm the port
// is actually free rather than assuming the signal landed.

import { spawn, type ChildProcess } from 'child_process'
import net from 'net'

export const portBusy = (port: number) => new Promise<boolean>(res => {
  const s = net.createServer()
  s.once('error', () => res(true))
  s.once('listening', () => s.close(() => res(false)))
  s.listen(port, '127.0.0.1')
})

export interface DevServer {
  child: ChildProcess
  /** Kills the whole process group and waits for the port to free. */
  stop: () => Promise<void>
}

/**
 * Start `next dev` on `port` and wait for it to answer.
 *
 * Returns null if it never came up — the caller refuses rather than
 * running against nothing.
 */
export async function startDevServer(
  port: number,
  opts: { env?: Record<string, string>; readyPath?: string; timeoutMs?: number } = {},
): Promise<DevServer | null> {
  const base = `http://127.0.0.1:${port}`
  const readyPath = opts.readyPath ?? '/login'

  const child = spawn('npx', ['next', 'dev', '-p', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe'],
    // 🔴 Its own process group, so stop() can take the whole tree.
    detached: true,
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  child.stderr?.on('data', d => {
    const s = String(d)
    if (/error/i.test(s) && !/EADDRINUSE/.test(s)) process.stderr.write(`   [server] ${s}`)
  })

  // Resolves when the child process actually exits.
  const exited = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
  })

  const stop = async () => {
    // 🔴 WAIT ON THE PROCESS, NOT ON THE PORT, AND ALWAYS ESCALATE.
    // The first version polled portBusy(port) and returned as soon as
    // 127.0.0.1:<port> was bindable — before the SIGKILL. But `next dev`
    // binds `::` (its own EADDRINUSE says `address already in use
    // :::3995`), so the port can read FREE while the process is still
    // alive, and stop() then returned having reported success and
    // killed nothing. A `next dev -p 3990` was found six minutes later,
    // and a second dev server contending for .next is why the next
    // gate's server would not start at all.
    //
    // Process liveness is the thing being waited on, so that is what is
    // waited on; the port is a final sanity check, not the signal.
    if (!child.pid) return
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already down */ }
    await Promise.race([exited, new Promise(r => setTimeout(r, 8_000))])

    if (child.exitCode === null && child.signalCode === null) {
      // SIGTERM did not take. Escalate unconditionally rather than
      // trusting a heuristic to tell us whether it did.
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
      await Promise.race([exited, new Promise(r => setTimeout(r, 3_000))])
    }

    // Now the port, as the last word. If it is still held, something is
    // left behind and the next run would race a stale build — say so
    // loudly rather than let it be discovered as "server did not come
    // up" three gates later.
    for (let i = 0; i < 12; i++) {
      if (!(await portBusy(port))) return
      await new Promise(r => setTimeout(r, 250))
    }
    process.stderr.write(`   🔴 port ${port} is STILL HELD after SIGKILL — a stale dev server is running. Find it with: ps -eo pid,command | grep 'next dev'\n`)
  }

  const until = Date.now() + (opts.timeoutMs ?? 120_000)
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}${readyPath}`)
      if (r.status === 200) return { child, stop }
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 700))
  }
  await stop()
  return null
}
