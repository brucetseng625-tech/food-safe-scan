import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const outputPath = resolve(projectRoot, 'public', 'tfda-unsafe-food.json')
const sourceUrl = 'https://data.fda.gov.tw/data/opendata/export/52/json'
const sourceBaseUrl = 'https://data.fda.gov.tw/'

function toText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toImageUrl(value) {
  const nextValue = toText(value)
  if (!nextValue) {
    return ''
  }

  try {
    return new URL(nextValue, sourceBaseUrl).toString()
  } catch {
    return nextValue
  }
}

function normalizeRecord(record, index) {
  const subject = toText(record['主旨'])
  const brand = toText(record['牌名'])
  const importer = toText(record['進口商名稱'])
  const manufacturer = toText(record['製造廠或出口商名稱'])
  const publishedAt = toText(record['發布日期'])

  return {
    id: `${publishedAt || 'unknown'}-${subject || brand || importer || manufacturer || 'record'}-${index}`,
    subject,
    brand,
    importer,
    manufacturer,
    origin: toText(record['產地']),
    reason: toText(record['原因']),
    detail: toText(record['不合格原因暨檢出量詳細說明']),
    disposal: toText(record['處置情形']),
    regulation: toText(record['法規限量標準']),
    publishedAt,
    reportAcceptedAt: toText(record['報驗受理日期']),
    imageUrl: toImageUrl(record['附圖']),
  }
}

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
  const response = await fetch(sourceUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'food-safe-scan-build-sync',
    },
  })

  if (!response.ok) {
    throw new Error(`TFDA data request failed with status ${response.status}`)
  }

  const rawData = await response.json()
  if (!Array.isArray(rawData)) {
    throw new Error('TFDA data payload is not an array')
  }

  const records = rawData
    .map(normalizeRecord)
    .filter((record) => record.subject || record.brand || record.importer || record.manufacturer)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))

  const payload = {
    sourceUrl,
    fetchedAt: new Date().toISOString(),
    recordCount: records.length,
    records,
  }

  await mkdir(resolve(projectRoot, 'public'), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  console.log(`Synced TFDA unsafe food dataset: ${records.length} records`)
}

try {
  await saveData()
} catch (error) {
  if (await fileExists(outputPath)) {
    const existingData = await loadExistingData()
    console.warn(
      `TFDA sync failed, keeping existing dataset from ${existingData.fetchedAt}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(0)
  }

  throw error
}
