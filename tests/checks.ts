// Tiny check runner shared by the acceptance test scripts. Results go to tests/results/<name>.json.
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export interface Check {
  name: string
  pass: boolean
  detail?: string
}

export const RESULTS_DIR = path.join(import.meta.dir, 'results')
mkdirSync(RESULTS_DIR, { recursive: true })

const results: Check[] = []

export async function check(name: string, run: () => Promise<string | void>) {
  try {
    const detail = (await run()) ?? undefined
    results.push({ name, pass: true, detail })
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    results.push({ name, pass: false, detail })
    console.log(`FAIL  ${name}  (${detail})`)
  }
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance

/** Writes the results file and exits non-zero if any check failed. */
export async function finish(name: string): Promise<never> {
  await Bun.write(path.join(RESULTS_DIR, `${name}.json`), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
