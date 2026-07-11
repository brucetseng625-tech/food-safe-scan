import { access, mkdir, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(import.meta.dirname, '..')
const outputPath = resolve(projectRoot, 'public', 'downstream-products.json')
const scriptPath = resolve(projectRoot, 'scripts', 'sync-downstream-data.py')

const pythonCandidates = [
  process.env.CODEX_PYTHON_PATH,
  '/Users/brucetseng/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',
  'python3',
].filter(Boolean)

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function loadExistingData() {
  const raw = await readFile(outputPath, 'utf8')
  return JSON.parse(raw)
}

async function saveData() {
  await mkdir(resolve(projectRoot, 'public'), { recursive: true })

  let lastError = 'No Python runtime was available to sync the downstream dataset.'

  for (const pythonPath of pythonCandidates) {
    const result = spawnSync(pythonPath, [scriptPath], {
      cwd: projectRoot,
      encoding: 'utf8',
    })

    if (result.status === 0) {
      if (result.stdout.trim()) {
        console.log(result.stdout.trim())
      }
      return
    }

    lastError = [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || lastError
  }

  throw new Error(lastError)
}

try {
  await saveData()
} catch (error) {
  if (await fileExists(outputPath)) {
    const existingData = await loadExistingData()
    console.warn(
      `Downstream sync failed, keeping existing dataset from ${existingData.fetchedAt}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(0)
  }

  throw error
}
