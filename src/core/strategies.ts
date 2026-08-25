// ponytail: RSI level 3 - remember which explanation strategy worked per concept
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export interface StrategyStat {
  attempts: number
  successes: number
}

type StrategyStore = Record<string, Record<string, StrategyStat>>

const dir = (vaultRoot: string) => join(vaultRoot, '000-Meta', 'minerva')

// ponytail: same trust-our-own-writes policy as learner.ts; corrupt -> empty
export async function loadStrategies(vaultRoot: string): Promise<StrategyStore> {
  try {
    const raw = await readFile(join(dir(vaultRoot), 'strategies.json'), 'utf8')
    const s = JSON.parse(raw)
    return typeof s === 'object' && s !== null && !Array.isArray(s) ? s : {}
  } catch {
    return {}
  }
}

// ponytail: load-modify-save with tmp+rename, atomic like learner.ts saveModel
export async function recordOutcome(
  vaultRoot: string,
  concept: string,
  strategy: string,
  success: boolean,
): Promise<void> {
  const store = await loadStrategies(vaultRoot)
  const stats = (store[concept] ??= {})
  const stat = (stats[strategy] ??= { attempts: 0, successes: 0 })
  // heal corrupt persisted values instead of propagating NaN forever
  stat.attempts = Number(stat.attempts) || 0
  stat.successes = Number(stat.successes) || 0
  stat.attempts++
  if (success) stat.successes++
  await mkdir(dir(vaultRoot), { recursive: true })
  const target = join(dir(vaultRoot), 'strategies.json')
  // atomic write: crash mid-save must not corrupt strategy data
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  await rename(tmp, target)
}

// ponytail: pure frequency heuristic, upgrade to Thompson sampling when data justifies it
export function bestStrategy(stats: Record<string, StrategyStat> | undefined): string | undefined {
  let best: string | undefined
  let bestRate = -1
  for (const [name, s] of Object.entries(stats ?? {})) {
    if (s.attempts < 2) continue
    const rate = s.successes / s.attempts
    if (rate > bestRate) {
      best = name
      bestRate = rate
    }
  }
  return best
}

export const STRATEGY_NAMES = ['analogy', 'first-principles', 'worked-example', 'visual-diagram', 'question-led'] as const

// ponytail: one-line tutor prompt hint; undefined when no data at all
export function strategyRotationHint(stats: Record<string, StrategyStat> | undefined, concept: string): string | undefined {
  if (!stats || Object.keys(stats).length === 0) return undefined
  const best = bestStrategy(stats)
  if (best) {
    const s = stats[best]
    return `Use the ${best} strategy for concept ${concept} - it worked ${s.successes}/${s.attempts} times before.`
  }
  // ponytail: no qualifying winner -> steer away from the most-attempted failure
  let worst: string | undefined
  let worstFails = 0
  for (const [name, s] of Object.entries(stats)) {
    const fails = s.attempts - s.successes
    if (fails > worstFails) {
      worst = name
      worstFails = fails
    }
  }
  if (!worst) return undefined
  return `Try a different strategy than ${worst} for concept ${concept} - ${worst} failed ${worstFails} times.`
}
