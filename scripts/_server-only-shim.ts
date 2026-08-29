// Shim: stub the 'server-only' guard for Node CLI runs.
// In Next.js builds the package is replaced by a no-op via webpack
// alias for server bundles; tsx has no such alias, so importing
// modules that gate behind 'server-only' throws. Pre-empt by
// hijacking require for that single module name.
import { createRequire } from 'module'
const req = createRequire(import.meta.url)
const Module = req('module')
const orig = Module.prototype.require
Module.prototype.require = function (id: string) {
  if (id === 'server-only') return {}
  return orig.apply(this, arguments as never)
}
