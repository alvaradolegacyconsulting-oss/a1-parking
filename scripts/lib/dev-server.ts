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

  const stop = async () => {
    if (child.pid) {
      // Negative pid = the group. ESRCH just means it is already gone.
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already down */ }
    }
    // 🔴 Confirm, do not assume. A SIGTERM that did not land leaves the
    // next run racing a stale build.
    const until = Date.now() + 10_000
    while (Date.now() < until) {
      if (!(await portBusy(port))) return
      await new Promise(r => setTimeout(r, 250))
    }
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
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
