import { oilBlacklist, type BlacklistBrandGroup, type BlacklistItem } from '../data/blacklist'

export type MatchStatus = 'flagged' | 'watch' | 'clear' | 'unknown'

export type ProductMatch = {
  brand: string
  item: BlacklistItem
}

export type LookupAnalysis = {
  status: MatchStatus
  normalizedQuery: string
  matchedProducts: ProductMatch[]
  matchedBrands: BlacklistBrandGroup[]
}

export function normalizeText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/臺/g, '台')
    .replace(/[()（）·•．.、,，:：\-－_／/\s]/g, '')
}

function includesAny(query: string, keywords: string[]) {
  return keywords.some((keyword) => query.includes(normalizeText(keyword)))
}

function findMatchedProducts(query: string) {
  const matches: ProductMatch[] = []

  for (const group of oilBlacklist) {
    const brandMatched = includesAny(query, group.aliases)

    for (const item of group.items) {
      const directKeywordMatch = includesAny(query, item.keywords)
      const brandAndNameMatch = brandMatched && query.includes(normalizeText(item.name))

      if (directKeywordMatch || brandAndNameMatch) {
        matches.push({ brand: group.brand, item })
      }
    }
  }

  return matches
}

function findMatchedBrands(query: string) {
  return oilBlacklist.filter((group) => includesAny(query, group.aliases))
}

export function analyzeLookup(...parts: Array<string | undefined>) {
  const normalizedQuery = normalizeText(parts.filter(Boolean).join(' '))
  if (!normalizedQuery) {
    return {
      status: 'unknown',
      normalizedQuery,
      matchedProducts: [],
      matchedBrands: [],
    } satisfies LookupAnalysis
  }

  const matchedProducts = findMatchedProducts(normalizedQuery)
  const matchedBrands = findMatchedBrands(normalizedQuery)

  if (matchedProducts.length > 0) {
    return {
      status: 'flagged',
      normalizedQuery,
      matchedProducts,
      matchedBrands,
    } satisfies LookupAnalysis
  }

  if (matchedBrands.length > 0) {
    return {
      status: 'watch',
      normalizedQuery,
      matchedProducts,
      matchedBrands,
    } satisfies LookupAnalysis
  }

  return {
    status: 'clear',
    normalizedQuery,
    matchedProducts,
    matchedBrands,
  } satisfies LookupAnalysis
}
