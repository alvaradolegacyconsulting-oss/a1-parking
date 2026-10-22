// ════════════════════════════════════════════════════════════════════
// dead-branch — where an always-on flag's !flag blocks begin and end
// ════════════════════════════════════════════════════════════════════
//
// 🔴 EXTRACTED SO THERE IS ONE COPY. This logic was local to
// check-dead-branch-additions.ts. A second gate needed it, and a
// second gate with its own private copy of a predicate is how a gate
// goes green while the thing it guards is broken — the bulk validator
// passed its own twin of a regex the product had already diverged from.
// Both callers import this.

/**
 * Line ranges (1-indexed, inclusive) that sit inside a `!<flag> &&`
 * block — JSX that can never render while the flag is true.
 *
 * Brace-free paren counting is deliberate: these blocks are JSX
 * expressions, so the paren depth returning to zero is the block's end.
 */
export function deadRanges(lines: string[], flag: string): [number, number][] {
  const out: [number, number][] = []
  lines.forEach((l, i) => {
    if (!l.includes(`!${flag} &&`)) return
    let depth = 0, started = false
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\(/g) ?? []).length - (lines[j].match(/\)/g) ?? []).length
      if (!started && depth > 0) started = true
      if (started && depth <= 0) { out.push([i + 1, j + 1]); return }
    }
  })
  return out
}

/** True when a 1-indexed line falls inside any of the ranges. */
export function isDead(line: number, ranges: [number, number][]): boolean {
  return ranges.some(([a, b]) => line >= a && line <= b)
}
