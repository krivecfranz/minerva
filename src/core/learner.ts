// ponytail: single JSON file as learner store, sessions.jsonl append-only log
import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

export interface SubjectMastery {
  concept: string
  mastery: number // 0..1
  confidence: number // 0..1
  evidence: string
  updated: string // ISO
}

export interface LearnerModel {
  goals: string[]
  preferences: Record<string, string>
  subjects: Record<string, SubjectMastery[]>
}

const dir = (vaultRoot: string) => join(vaultRoot, '000-Meta', 'minerva')
const clamp = (n: number) => Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0

function emptyModel(): LearnerModel {
  return { goals: [], preferences: {}, subjects: {} }
}

// ponytail: no schema validation, trust our own writes; corrupt file falls back to defaults
export async function loadModel(vaultRoot: string): Promise<LearnerModel> {
  try {
    const raw = await readFile(join(dir(vaultRoot), 'model.json'), 'utf8')
    const m = JSON.parse(raw)
    return { goals: m.goals ?? [], preferences: m.preferences ?? {}, subjects: m.subjects ?? {} }
  } catch {
    return emptyModel()
  }
}

export async function saveModel(vaultRoot: string, m: LearnerModel): Promise<void> {
  await mkdir(dir(vaultRoot), { recursive: true })
  const target = join(dir(vaultRoot), 'model.json')
  // atomic write: crash mid-save must not corrupt mastery data
  const tmp = target + '.tmp'
  await writeFile(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8')
  await rename(tmp, target)
}

// belegpflicht: evidence is mandatory, always overwritten with the latest reason
export async function updateMastery(
  vaultRoot: string,
  subject: string,
  concept: string,
  patch: Partial<SubjectMastery>,
  evidence: string,
): Promise<LearnerModel> {
  if (!evidence.trim()) throw new Error('evidence is mandatory (Belegpflicht)')
  const m = await loadModel(vaultRoot)
  const list = (m.subjects[subject] ??= [])
  let entry = list.find((e) => e.concept === concept)
  if (!entry) {
    entry = { concept, mastery: 0, confidence: 0, evidence: '', updated: '' }
    list.push(entry)
  }
  Object.assign(entry, patch, { mastery: clamp(patch.mastery ?? entry.mastery), confidence: clamp(patch.confidence ?? entry.confidence), evidence, updated: new Date().toISOString() })
  await saveModel(vaultRoot, m)
  return m
}

export async function recordSessionLog(vaultRoot: string, summary: string): Promise<void> {
  await mkdir(dir(vaultRoot), { recursive: true })
  await appendFile(join(dir(vaultRoot), 'sessions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), summary }) + '\n', 'utf8')
}
