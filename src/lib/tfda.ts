import { normalizeText } from './match'

export type TfdaUnsafeRecord = {
  id: string
  subject: string
  brand: string
  importer: string
  manufacturer: string
  origin: string
  reason: string
  detail: string
  disposal: string
  regulation: string
  publishedAt: string
  reportAcceptedAt: string
  imageUrl: string
}

export type TfdaUnsafeDataset = {
  sourceUrl: string
  fetchedAt: string
  recordCount: number
  records: TfdaUnsafeRecord[]
}

function fieldMatches(query: string, value: string) {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return false
  }

  return normalizedValue.includes(query) || query.includes(normalizedValue)
}

export function analyzeTfdaRecords(
  parts: Array<string | undefined>,
  dataset: TfdaUnsafeDataset | null,
  limit = 6,
) {
  if (!dataset) {
    return []
  }

  const query = normalizeText(parts.filter(Boolean).join(' '))
  if (!query) {
    return []
  }

  return dataset.records
    .filter((record) =>
      [
        record.subject,
        record.brand,
        record.importer,
        record.manufacturer,
        record.reason,
        record.detail,
      ].some((value) => fieldMatches(query, value)),
    )
    .slice(0, limit)
}
