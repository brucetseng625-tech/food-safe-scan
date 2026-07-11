import { normalizeText } from './match'

export type DownstreamOilItem = {
  name: string
  batch: string[]
  expiry: string[]
}

export type DownstreamBusinessEntry = {
  id: string
  businessNo: string
  isStarred: boolean
  city: string
  business: string
  status: 'market' | 'duplicate' | 'removed' | 'feed' | 'non_food'
  statusNote: string
  duplicateOf: string
  oilItems: DownstreamOilItem[]
}

export type PreventiveProductEntry = {
  id: string
  businessNo: string
  city: string
  business: string
  productNo: string
  productName: string
  expiry: string
}

export type DownstreamDataset = {
  sourceUrls: {
    businesses: string
    preventiveProducts: string
    caseSection: string
    caseList: string
  }
  fetchedAt: string
  businessCount: number
  marketBusinessCount: number
  preventiveProductCount: number
  businessEntries: DownstreamBusinessEntry[]
  preventiveProducts: PreventiveProductEntry[]
}

export type DownstreamLookupResult = {
  businessMatches: DownstreamBusinessEntry[]
  businessMatchCount: number
  productMatches: PreventiveProductEntry[]
  productMatchCount: number
}

function fieldMatches(query: string, value: string) {
  const normalizedValue = normalizeText(value)
  if (!normalizedValue) {
    return false
  }

  return normalizedValue.includes(query) || query.includes(normalizedValue)
}

export function analyzeDownstreamRecords(
  parts: Array<string | undefined>,
  dataset: DownstreamDataset | null,
  limit = 12,
) {
  if (!dataset) {
    return {
      businessMatches: [],
      businessMatchCount: 0,
      productMatches: [],
      productMatchCount: 0,
    } satisfies DownstreamLookupResult
  }

  const query = normalizeText(parts.filter(Boolean).join(' '))
  if (!query) {
    return {
      businessMatches: [],
      businessMatchCount: 0,
      productMatches: [],
      productMatchCount: 0,
    } satisfies DownstreamLookupResult
  }

  const businessMatches = dataset.businessEntries.filter((entry) =>
    [
      entry.business,
      entry.city,
      ...entry.oilItems.flatMap((item) => [item.name, ...item.batch, ...item.expiry]),
    ].some((value) => fieldMatches(query, value)),
  )

  const productMatches = dataset.preventiveProducts.filter((entry) =>
    [entry.productName, entry.business, entry.city, entry.expiry].some((value) => fieldMatches(query, value)),
  )

  return {
    businessMatches: businessMatches.slice(0, limit),
    businessMatchCount: businessMatches.length,
    productMatches: productMatches.slice(0, limit),
    productMatchCount: productMatches.length,
  } satisfies DownstreamLookupResult
}
