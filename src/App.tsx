import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Html5Qrcode } from 'html5-qrcode'
import {
  AlertTriangle,
  ArrowUpRight,
  Barcode,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ImageUp,
  LoaderCircle,
  RefreshCcw,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react'
import { downstreamResources, officialResources, oilBlacklist, quickSuggestions } from './data/blacklist'
import {
  analyzeDownstreamRecords,
  type DownstreamDataset,
  type DownstreamLookupResult,
} from './lib/downstream'
import { analyzeLookup, type LookupAnalysis, type MatchStatus } from './lib/match'
import { analyzeTfdaRecords, type TfdaUnsafeDataset, type TfdaUnsafeRecord } from './lib/tfda'
import './App.css'

type OpenFoodFactsProduct = {
  code: string
  product_name?: string
  brands?: string
  image_front_small_url?: string
  quantity?: string
}

type LookupState = {
  source: 'keyword' | 'barcode' | 'photo'
  query: string
  barcode?: string
  product?: OpenFoodFactsProduct | null
  analysis: LookupAnalysis
  tfdaMatches: TfdaUnsafeRecord[]
  downstreamMatches: DownstreamLookupResult
  dataStatus: LookupDataStatus
}

type LookupHistoryEntry = {
  id: string
  source: LookupState['source']
  query: string
  label: string
  status: MatchStatus
}

const openFoodFactsEndpoint = 'https://world.openfoodfacts.net/api/v2/product'
const historyStorageKey = 'food-safe-scan-history'
const tfdaDataUrl = `${import.meta.env.BASE_URL}tfda-unsafe-food.json`
const downstreamDataUrl = `${import.meta.env.BASE_URL}downstream-products.json`
const barcodeSourceUnavailableMessage =
  '目前暫時連不到條碼商品資料來源，所以這次無法完整判斷是否命中問題品項。請稍後再試，或直接改用商品全名查詢。'
const officialDatasetUnavailableMessage =
  '官方資料目前載入不完整，這次結果不能直接視為未命中；請稍後再試，或先重新載入官方資料。'
const photoNameUnavailableMessage =
  '這張照片裡暫時沒有穩定辨識到商品名，請盡量拍包裝正面的大字品名，或直接手動輸入。'

type BarcodeCatalogStatus = 'loaded' | 'not_found' | 'unavailable'

type LookupDataStatus = {
  tfdaAvailable: boolean
  downstreamAvailable: boolean
  productCatalogStatus?: BarcodeCatalogStatus
}

type BarcodeCandidateSpec = {
  key: string
  xRatio: number
  yRatio: number
  widthRatio: number
  heightRatio: number
  scale: number
  monochrome?: boolean
  contrast?: number
  threshold?: number
}

type BarcodeScanCandidate = {
  key: string
  file?: File
  canvas?: HTMLCanvasElement
}

type ProductTextScanCandidate = {
  key: string
  canvas: HTMLCanvasElement
}

type RankedProductTextCandidate = {
  text: string
  score: number
  confidence: number
  hanCount: number
}

type PhotoOcrLine = {
  text: string
  confidence: number
  top: number
  height: number
  left: number
  width: number
}

let barcodeOcrWorkerPromise: Promise<any> | null = null
let productNameOcrWorkerPromise: Promise<any> | null = null

function buildUnknownAnalysis(...parts: Array<string | undefined>) {
  const nextAnalysis = analyzeLookup(...parts)
  return {
    ...nextAnalysis,
    status: 'unknown' as const,
  }
}

function hasFullOfficialData(dataStatus: LookupDataStatus) {
  return dataStatus.tfdaAvailable && dataStatus.downstreamAvailable
}

function hasAnyLookupMatch(state: LookupState) {
  return (
    state.analysis.matchedProducts.length > 0 ||
    state.analysis.matchedBrands.length > 0 ||
    state.tfdaMatches.length > 0 ||
    state.downstreamMatches.productMatchCount > 0 ||
    state.downstreamMatches.businessMatchCount > 0
  )
}

function getNumericChecksum(code: string) {
  const reversed = code
    .slice(0, -1)
    .split('')
    .reverse()
    .map(Number)

  const sum = reversed.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10
}

function isValidBarcodeDigits(code: string) {
  if (!/^\d+$/.test(code)) {
    return false
  }

  if (code.length === 13 || code.length === 12 || code.length === 8) {
    return Number(code.at(-1)) === getNumericChecksum(code)
  }

  return false
}

function extractBarcodeFromOcrText(text: string) {
  const normalized = text
    .replace(/[OoDQ]/g, '0')
    .replace(/[Il|!]/g, '1')
    .replace(/Z/g, '2')
    .replace(/[Ss]/g, '5')
    .replace(/B/g, '8')

  const segments = normalized.match(/[0-9\s]{8,40}/g) ?? []
  const exactLengths = [13, 12, 8]

  for (const targetLength of exactLengths) {
    for (const segment of segments) {
      const digits = segment.replace(/\D/g, '')
      if (digits.length < targetLength) {
        continue
      }

      for (let startIndex = 0; startIndex <= digits.length - targetLength; startIndex += 1) {
        const candidate = digits.slice(startIndex, startIndex + targetLength)
        if (isValidBarcodeDigits(candidate)) {
          return candidate
        }
      }
    }
  }

  for (const segment of segments) {
    const digits = segment.replace(/\D/g, '')
    if (digits.length >= 12 && digits.length <= 14) {
      return digits.slice(0, 13)
    }
  }

  return ''
}

async function getBarcodeOcrWorker() {
  if (!barcodeOcrWorkerPromise) {
    barcodeOcrWorkerPromise = (async () => {
      const { createWorker, PSM } = await import('tesseract.js')
      const worker = await createWorker('eng', 1, {
        logger: () => {},
      })

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: '0123456789 ',
        preserve_interword_spaces: '1',
      })

      return worker
    })()
  }

  return barcodeOcrWorkerPromise
}

async function getProductNameOcrWorker() {
  if (!productNameOcrWorkerPromise) {
    productNameOcrWorkerPromise = (async () => {
      const { createWorker, PSM } = await import('tesseract.js')
      const worker = await createWorker(['chi_tra', 'eng'], 1, {
        logger: () => {},
      })

      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
      })

      return worker
    })()
  }

  return productNameOcrWorkerPromise
}

function getSupportedBarcodeFormats(Html5QrcodeSupportedFormats: {
  EAN_13: number
  EAN_8: number
  UPC_A: number
  UPC_E: number
  CODE_128: number
  CODE_39: number
  CODE_93: number
  ITF: number
  RSS_14: number
  RSS_EXPANDED: number
}) {
  return [
    Html5QrcodeSupportedFormats.EAN_13,
    Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A,
    Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_128,
    Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.CODE_93,
    Html5QrcodeSupportedFormats.ITF,
    Html5QrcodeSupportedFormats.RSS_14,
    Html5QrcodeSupportedFormats.RSS_EXPANDED,
  ]
}

function loadImageFromFile(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    const objectUrl = URL.createObjectURL(file)

    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(image)
    }

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('unable to load image'))
    }

    image.src = objectUrl
  })
}

function createCroppedCanvas(image: HTMLImageElement, spec: BarcodeCandidateSpec) {
  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight
  const cropX = Math.max(0, Math.floor(sourceWidth * spec.xRatio))
  const cropY = Math.max(0, Math.floor(sourceHeight * spec.yRatio))
  const cropWidth = Math.max(1, Math.floor(sourceWidth * spec.widthRatio))
  const cropHeight = Math.max(1, Math.floor(sourceHeight * spec.heightRatio))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(cropWidth * spec.scale))
  canvas.height = Math.max(1, Math.floor(cropHeight * spec.scale))

  const context = canvas.getContext('2d', { willReadFrequently: spec.monochrome })
  if (!context) {
    throw new Error('unable to prepare barcode canvas')
  }

  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height)

  if (spec.monochrome) {
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    const pixels = imageData.data
    const contrast = spec.contrast ?? 1.9

    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114
      const adjusted = Math.max(0, Math.min(255, (luminance - 128) * contrast + 128))
      const boosted = typeof spec.threshold === 'number' ? (adjusted >= spec.threshold ? 255 : 0) : adjusted
      pixels[index] = boosted
      pixels[index + 1] = boosted
      pixels[index + 2] = boosted
    }

    context.putImageData(imageData, 0, 0)
  }

  return canvas
}

function canvasToPngFile(canvas: HTMLCanvasElement, originalName: string, variant: string) {
  return new Promise<File>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('unable to export barcode image'))
        return
      }

      resolve(new File([blob], `${originalName}-${variant}.png`, { type: 'image/png' }))
    }, 'image/png')
  })
}

async function buildBarcodeScanCandidates(file: File) {
  const image = await loadImageFromFile(file)
  const candidates: BarcodeScanCandidate[] = [{ key: 'original-file', file }]

  // Mobile photos often include a lot of package text above the barcode, so we
  // retry with tighter crops around the lower barcode band.
  const specs: BarcodeCandidateSpec[] = [
    { key: 'full-resample', xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1, scale: 1.35 },
    { key: 'lower-half', xRatio: 0, yRatio: 0.38, widthRatio: 1, heightRatio: 0.62, scale: 1.8 },
    { key: 'barcode-band', xRatio: 0.02, yRatio: 0.48, widthRatio: 0.96, heightRatio: 0.34, scale: 2.3, monochrome: true },
    { key: 'tight-band', xRatio: 0.05, yRatio: 0.56, widthRatio: 0.9, heightRatio: 0.24, scale: 2.8, monochrome: true },
    { key: 'digits-band', xRatio: 0.04, yRatio: 0.63, widthRatio: 0.92, heightRatio: 0.2, scale: 3.2, monochrome: true },
    { key: 'digits-tight', xRatio: 0.06, yRatio: 0.69, widthRatio: 0.88, heightRatio: 0.14, scale: 3.8, monochrome: true },
  ]

  for (const spec of specs) {
    const canvas = createCroppedCanvas(image, spec)
    candidates.push({
      key: spec.key,
      canvas,
      file: await canvasToPngFile(canvas, file.name, spec.key),
    })
  }

  return candidates
}

function buildProductTextScanCandidates(image: HTMLImageElement) {
  const specs: BarcodeCandidateSpec[] = [
    {
      key: 'title-center-mono',
      xRatio: 0.18,
      yRatio: 0.02,
      widthRatio: 0.7,
      heightRatio: 0.2,
      scale: 3.2,
      monochrome: true,
      contrast: 2.5,
      threshold: 168,
    },
    {
      key: 'title-right-mono',
      xRatio: 0.24,
      yRatio: 0.02,
      widthRatio: 0.64,
      heightRatio: 0.18,
      scale: 3.3,
      monochrome: true,
      contrast: 2.7,
      threshold: 172,
    },
    {
      key: 'top-focus',
      xRatio: 0.06,
      yRatio: 0.02,
      widthRatio: 0.88,
      heightRatio: 0.28,
      scale: 2.4,
      monochrome: true,
      contrast: 2.2,
    },
    {
      key: 'top-wide',
      xRatio: 0.02,
      yRatio: 0,
      widthRatio: 0.96,
      heightRatio: 0.4,
      scale: 2.05,
      monochrome: true,
      contrast: 2.1,
    },
    { key: 'upper-half', xRatio: 0.02, yRatio: 0.05, widthRatio: 0.96, heightRatio: 0.5, scale: 1.7 },
    { key: 'full-image', xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1, scale: 1.25 },
  ]

  return specs.map((spec) => ({
    key: spec.key,
    canvas: createCroppedCanvas(image, spec),
  })) satisfies ProductTextScanCandidate[]
}

function normalizePhotoNameText(value: string) {
  return value
    .normalize('NFKC')
    .replace(/[|｜]/g, 'I')
    .replace(/[「」【】[\]<>]/g, ' ')
    .replace(/[—–]/g, '-')
    .replace(/[_~]+/g, ' ')
    .replace(/^[^0-9A-Za-z\p{Script=Han}]+/u, '')
    .replace(/[^0-9A-Za-z\p{Script=Han}]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripRetailPrefix(value: string) {
  return value
    .replace(/^(7[- ]?eleven|7[- ]?11|familymart|ok ?mart|全家便利商店|全家|萊爾富|美廉社|全聯)\s*/iu, '')
    .replace(/^[A-Z0-9 ]{2,}(?=\s*[\p{Script=Han}])/u, '')
    .trim()
}

function scorePhotoNameCandidate(line: PhotoOcrLine, variantIndex: number, lineIndex: number) {
  const normalized = normalizePhotoNameText(line.text)
  if (!normalized) {
    return null
  }

  const compact = normalized.replace(/\s+/g, '')
  if (compact.length < 2 || compact.length > 28) {
    return null
  }

  if (
    /(製造日期|有效日期|賞味期限|營養|成分|保存|原產地|條碼|客服|地址|電話|本產品|重量|公克|熱量|每份|過敏|食用|微波|加熱|冷藏|冷凍|蛋白質|脂肪|碳水化合物|鈉|批號)/u.test(
      normalized,
    )
  ) {
    return null
  }

  if (/\d{4}[./-]\d{1,2}[./-]\d{1,2}/.test(normalized)) {
    return null
  }

  const hanCount = Array.from(normalized).filter((char) => /\p{Script=Han}/u.test(char)).length
  const latinCount = Array.from(normalized).filter((char) => /[A-Za-z]/.test(char)).length
  const digitCount = Array.from(normalized).filter((char) => /\d/.test(char)).length
  const hasFoodKeyword =
    /(飯糰|豆漿|便當|燒肉|雞胸|三明治|沙拉|漢堡|奶茶|咖啡|鮮奶|牛奶|果汁|麵包|蛋糕|布丁|壽司|拉麵|涼麵|炒飯|粥|吐司|可頌|sandwich|salad|burger|coffee|milk|tea|rice|noodle)/iu.test(
      normalized,
    )

  if (hanCount + latinCount < 2 || digitCount > hanCount + latinCount) {
    return null
  }

  if (hanCount < 2 && !hasFoodKeyword) {
    return null
  }

  let score = hanCount * 5 + latinCount
  score += Math.max(0, 8 - variantIndex * 2)
  score += Math.max(0, 6 - lineIndex)
  score += Math.min(12, line.confidence / 9)
  score += Math.min(12, line.height / 14)
  score += Math.max(0, 8 - line.top / 36)

  if (hanCount >= 2) {
    score += 12
  } else if (latinCount >= 4) {
    score -= 8
  }

  if (hasFoodKeyword) {
    score += 8
  }

  if (/[-－—]/.test(normalized)) {
    score += 1
  }

  return {
    text: stripRetailPrefix(normalized),
    score,
    confidence: line.confidence,
    hanCount,
  } satisfies RankedProductTextCandidate
}

function collectPhotoOcrLines(pageData: any) {
  const lines: PhotoOcrLine[] = []

  if (pageData?.blocks) {
    for (const block of pageData.blocks) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          if (line?.text) {
            const bbox = line.bbox ?? {}
            lines.push({
              text: line.text,
              confidence: Number(line.confidence ?? paragraph.confidence ?? block.confidence ?? 0),
              top: Number(bbox.y0 ?? 0),
              height: Math.max(0, Number(bbox.y1 ?? 0) - Number(bbox.y0 ?? 0)),
              left: Number(bbox.x0 ?? 0),
              width: Math.max(0, Number(bbox.x1 ?? 0) - Number(bbox.x0 ?? 0)),
            })
          }
        }
      }
    }
  }

  if (pageData?.text) {
    lines.push(
      ...String(pageData.text)
        .split('\n')
        .map((text) => ({
          text,
          confidence: 0,
          top: 0,
          height: 0,
          left: 0,
          width: 0,
        })),
    )
  }

  return lines
}

function rankPhotoNameCandidates(lines: Array<PhotoOcrLine & { variantIndex: number; lineIndex: number }>) {
  const bestByText = new Map<string, RankedProductTextCandidate>()

  for (const line of lines) {
    const scored = scorePhotoNameCandidate(line, line.variantIndex, line.lineIndex)
    if (!scored || !scored.text) {
      continue
    }

    const current = bestByText.get(scored.text)
    if (!current || scored.score > current.score) {
      bestByText.set(scored.text, scored)
    }
  }

  return [...bestByText.values()]
    .sort((left, right) => {
      if (left.hanCount >= 2 && right.hanCount < 2) {
        return -1
      }

      if (right.hanCount >= 2 && left.hanCount < 2) {
        return 1
      }

      if (right.score !== left.score) {
        return right.score - left.score
      }

      return right.confidence - left.confidence
    })
    .map((entry) => entry.text)
}

function mapPhotoOcrError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (normalized.includes('heic') || normalized.includes('heif')) {
    return 'iPhone 的 HEIC 照片常會讓辨識失敗，請改拍成 JPG/PNG 再試。'
  }

  if (normalized.includes('no product name')) {
    return '照片裡沒有穩定辨識到商品名，請盡量只拍包裝正面的品名大字。'
  }

  if (normalized.includes('network') || normalized.includes('fetch') || normalized.includes('language')) {
    return '照片辨識模型暫時載入失敗，請稍後再試，或直接手動輸入品名。'
  }

  return photoNameUnavailableMessage
}

function isLikelyInAppBrowser() {
  if (typeof navigator === 'undefined') {
    return false
  }

  const userAgent = navigator.userAgent || ''
  return /(Line|FBAN|FBAV|Instagram|Messenger|MicroMessenger|WebView)/i.test(userAgent)
}

function pickPreferredCamera(cameras: Array<{ id: string; label: string }>) {
  if (cameras.length === 0) {
    return null
  }

  const preferred = cameras.find((camera) =>
    /(back|rear|environment|world|wide|ultra|後鏡頭|背面)/i.test(camera.label),
  )

  return preferred ?? cameras.at(-1) ?? cameras[0]
}

function mapScannerError(error: unknown, source: 'camera' | 'photo') {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (source === 'camera') {
    if (
      normalized.includes('overconstrainederror') ||
      normalized.includes('constraint') ||
      normalized.includes('facingmode')
    ) {
      return '這個瀏覽器沒有順利切到後鏡頭，請改用「直接拍照掃條碼」，或換 Safari 開啟。'
    }

    if (normalized.includes('notallowederror') || normalized.includes('permission')) {
      return '相機權限被拒絕了，請到瀏覽器設定允許相機後再試一次。'
    }

    if (normalized.includes('notfounderror') || normalized.includes('no camera')) {
      return '這台裝置目前找不到可用相機。'
    }

    if (normalized.includes('secure context')) {
      return '相機掃碼需要在 https 網址下開啟。'
    }

    if (normalized.includes('notreadableerror') || normalized.includes('could not start video source')) {
      return '相機目前被其他 App 或分頁占用，請先關掉再試。'
    }
  }

  if (source === 'photo') {
    if (normalized.includes('heic') || normalized.includes('heif')) {
      return 'iPhone 的 HEIC 照片常會導致讀碼失敗，請改拍成 JPG/PNG，或直接用即時相機掃碼。'
    }

    if (normalized.includes('no multi format readers') || normalized.includes('no barcode')) {
      return '這張照片沒有成功辨識到條碼，請先裁到只剩條碼和下方數字，並保留條碼左右留白後再試。'
    }
  }

  return source === 'camera'
    ? '相機啟動失敗，請改用手動輸入條碼或上傳照片。'
    : '這張照片沒有順利讀到條碼，請先裁到只剩條碼與數字，再換一張近一點、清楚一點的照片。'
}

function getCameraHintText() {
  if (isLikelyInAppBrowser()) {
    return '你現在像是從 App 內建瀏覽器開啟；如果即時相機打不開，請改用「直接拍照掃條碼」，或用 Safari 重新開啟。'
  }

  return '如果相機或條碼不好讀，主流程建議直接拍包裝正面，讓系統辨識商品名。'
}

function getHistoryLabel(state: LookupState) {
  if (state.product?.product_name) {
    return state.product.product_name
  }

  return state.query
}

function getNextSteps(status: MatchStatus) {
  switch (status) {
    case 'flagged':
      return [
        '先核對包裝上的完整商品名、品牌與批號。',
        '暫時先不要購買或下架待確認。',
        '打開下方官方連結，比對最新公告名單。',
      ]
    case 'watch':
      return [
        '品牌有歷史風險，但還沒命中具體品項。',
        '改輸入更完整的商品名再查一次。',
        '若是店家採購，建議再查供貨批號與進貨單。',
      ]
    case 'clear':
      return [
        '目前未命中這份歷史黑名單。',
        '如果擔心同系列商品，建議再換完整品名查一次。',
        '正式判斷仍以食藥署最新公告為準。',
      ]
    default:
      return [
        '條碼資料可能不存在或不完整。',
        '請改用包裝正面的商品全名手動查詢。',
        '必要時直接比對官方公告，不只看條碼結果。',
      ]
  }
}

function getBarcodeLookupNextSteps(productCatalogStatus: BarcodeCatalogStatus | undefined) {
  if (productCatalogStatus === 'unavailable') {
    return [
      '這次不是查到安全，而是條碼商品資料來源暫時連不上。',
      '請稍後再試一次，或直接改用品名、品牌名查詢。',
      '若你是店家，建議先用包裝全名對照下方官方清單。',
    ]
  }

  if (productCatalogStatus === 'not_found') {
    return [
      '這次不是命中問題品項，而是條碼商品庫沒有辨識到這個商品。',
      '請直接輸入包裝正面的完整品名，再查一次會更準。',
      '若你有照片，盡量裁到只剩條碼區，從相簿讀碼成功率會更高。',
    ]
  }

  return null
}

function getPhotoLookupNextSteps(status: MatchStatus) {
  switch (status) {
    case 'clear':
      return [
        '這次是用品名比對後未命中目前載入名單，不是條碼資料落空。',
        '如果你擔心是同系列商品，可以把更完整的品名補上再查一次。',
        '正式判斷仍以食藥署最新公告與通路公告為準。',
      ]
    default:
      return null
  }
}

function getTfdaNextSteps(matchCount: number) {
  if (matchCount === 0) {
    return null
  }

  return [
    '這次已命中食藥署官方不符合食品資料，請先看發布日期與不合格原因。',
    '若你是消費者，先避免購買同款商品；若你是店家，先暫停上架並核對進貨來源。',
    '再點官方資料來源確認最新公告，因為同品名可能有不同批次或不同進口商。',
  ]
}

function getDownstreamNextSteps(downstreamMatches: DownstreamLookupResult | undefined) {
  if (!downstreamMatches) {
    return null
  }

  if (downstreamMatches.productMatchCount > 0) {
    return [
      '這次已命中食藥署官方預防性下架產品清單，先核對產品名稱與有效日期。',
      '如果手邊商品名稱相同，先暫停食用、販售或上架，並查看原通路公告。',
      '再往下看對應業者與官方資料來源，確認是否有退貨或後續更新資訊。',
    ]
  }

  if (downstreamMatches.businessMatchCount > 0) {
    return [
      '這次已命中食藥署官方下游業者清單，代表該業者曾使用到受影響油品。',
      '若你要查的是成品，請再輸入更完整的食品名，或直接用條碼查商品名。',
      '同一業者可能有多項產品，請點官方來源持續核對最新下架與揭露資訊。',
    ]
  }

  return null
}

function App() {
  const [keyword, setKeyword] = useState('')
  const [barcode, setBarcode] = useState('')
  const [lookupState, setLookupState] = useState<LookupState | null>(null)
  const [lookupHistory, setLookupHistory] = useState<LookupHistoryEntry[]>(() => {
    if (typeof window === 'undefined') {
      return []
    }

    try {
      const raw = window.localStorage.getItem(historyStorageKey)
      return raw ? (JSON.parse(raw) as LookupHistoryEntry[]) : []
    } catch {
      return []
    }
  })
  const [isLoading, setIsLoading] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerBusy, setScannerBusy] = useState(false)
  const [scannerError, setScannerError] = useState('')
  const [photoOcrBusy, setPhotoOcrBusy] = useState(false)
  const [photoOcrError, setPhotoOcrError] = useState('')
  const [photoKeywordDraft, setPhotoKeywordDraft] = useState('')
  const [photoKeywordSuggestions, setPhotoKeywordSuggestions] = useState<string[]>([])
  const [tfdaDataset, setTfdaDataset] = useState<TfdaUnsafeDataset | null>(null)
  const [tfdaError, setTfdaError] = useState('')
  const [downstreamDataset, setDownstreamDataset] = useState<DownstreamDataset | null>(null)
  const [downstreamError, setDownstreamError] = useState('')

  const scannerRef = useRef<Html5Qrcode | null>(null)
  const scanResolvedRef = useRef(false)
  const tfdaPromiseRef = useRef<Promise<TfdaUnsafeDataset | null> | null>(null)
  const downstreamPromiseRef = useRef<Promise<DownstreamDataset | null> | null>(null)
  const keywordInputRef = useRef<HTMLInputElement | null>(null)
  const resultPanelRef = useRef<HTMLElement | null>(null)
  const cameraScannerRegionId = 'barcode-camera-scanner-region'
  const fileScannerRegionId = 'barcode-file-scanner-region'
  const cameraHintText = getCameraHintText()

  const scrollToResults = useCallback(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        resultPanelRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        })
      })
    })
  }, [])

  const focusKeywordLookup = useCallback(() => {
    keywordInputRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
    keywordInputRef.current?.focus()
  }, [])

  const resultTone = useMemo(() => {
    if (!lookupState) {
      return {
        tone: 'unknown' as const,
        badge: '資料不足',
        icon: CircleAlert,
        title: '目前還沒有足夠資料做判斷',
        description: '可能是掃不到商品資料，或輸入內容太泛；可以改用商品全名再查一次。',
      }
    }

    const hasFullData = hasFullOfficialData(lookupState.dataStatus)
    const hasAnyMatch = hasAnyLookupMatch(lookupState)

    if (!hasFullData) {
      return {
        tone: 'unknown' as const,
        badge: '官方資料載入不完整',
        icon: CircleAlert,
        title: '這次查詢暫時無法完整比對官方名單',
        description: '目前不是確認安全，而是本站沒有把官方資料完整載入；請稍後再查一次。',
      }
    }

    if ((lookupState?.downstreamMatches.productMatchCount ?? 0) > 0) {
      return {
        tone: 'flagged' as const,
        badge: '命中官方下游產品名單',
        icon: ShieldAlert,
        title: '這個食品已命中食藥署官方預防性下架產品清單',
        description: '這一段直接對到官方公布的產品名稱與有效日期，比只看品牌或油品名更接近消費者手上的食品。',
      }
    }

    if ((lookupState?.downstreamMatches.businessMatchCount ?? 0) > 0) {
      return {
        tone: 'watch' as const,
        badge: '命中官方下游業者名單',
        icon: CircleAlert,
        title: '這次查詢命中食藥署官方下游業者名單',
        description: '代表這個業者曾使用到受影響油品，下一步應再核對該業者公開揭露的產品資訊。',
      }
    }

    if ((lookupState?.tfdaMatches.length ?? 0) > 0) {
      return {
        tone: 'flagged' as const,
        badge: '命中食藥署官方資料',
        icon: ShieldAlert,
        title: '這個查詢結果命中食藥署官方不符合食品資料',
        description: '這一段是根據食藥署官方開放資料比對出來的，可信度高於手整理的歷史事件名單。',
      }
    }

    if (lookupState.source === 'barcode' && !hasAnyMatch) {
      if (lookupState.dataStatus.productCatalogStatus === 'unavailable') {
        return {
          tone: 'unknown' as const,
          badge: '條碼商品來源暫時失敗',
          icon: CircleAlert,
          title: '這次不是未命中，而是條碼商品資料來源暫時連不上',
          description: '系統沒能先把條碼換成商品名稱，所以這次結果不能當成沒有問題品項。',
        }
      }

      if (lookupState.dataStatus.productCatalogStatus === 'not_found') {
        return {
          tone: 'unknown' as const,
          badge: '條碼已讀到，但商品資料未找到',
          icon: CircleAlert,
          title: '這串條碼有讀到，但商品資料庫沒有找到對應商品',
          description: '這不等於安全，也不等於有問題，只是目前沒辦法用商品名去對官方名單。',
        }
      }
    }

    switch (lookupState?.analysis.status) {
      case 'flagged':
        return {
          tone: 'flagged' as const,
          badge: '命中歷史黑名單',
          icon: ShieldAlert,
          title: '這個品項已命中歷史問題油品名單',
          description: '建議立刻查看官方公告與批號資訊，不要只憑品牌印象判斷。',
        }
      case 'watch':
        return {
          tone: 'watch' as const,
          badge: '品牌有歷史風險',
          icon: CircleAlert,
          title: '同品牌曾出現在歷史黑名單，請再核對產品名',
          description: '目前是品牌層級命中，不代表此商品一定在名單內，但應提醒使用者再確認。',
        }
      case 'clear':
        return {
          tone: 'clear' as const,
          badge: '未命中載入名單',
          icon: CheckCircle2,
          title: '這次查詢沒有命中目前載入的歷史油品黑名單',
          description: '這不是官方安全保證，仍建議連到食藥署公告再核對一次。',
        }
      default:
        return {
          tone: 'unknown' as const,
          badge: '資料不足',
          icon: CircleAlert,
          title: '目前還沒有足夠資料做判斷',
          description: '可能是輸入內容太泛，或還需要再改用更完整的商品名稱。',
        }
    }
  }, [lookupState])

  const nextSteps = useMemo(() => {
    if (!lookupState) {
      return getNextSteps('unknown')
    }

    if (!hasFullOfficialData(lookupState.dataStatus)) {
      return [
        '目前先不要把這次結果當成未命中，因為官方資料沒有完整載入。',
        '請稍後重新查一次，或按下方的「重新載入」再比對。',
        '如果是現場要快速判斷，建議同時改用品名再查一次。',
      ]
    }

    const photoLookupNextSteps = lookupState.source === 'photo' ? getPhotoLookupNextSteps(lookupState.analysis.status) : null
    if (photoLookupNextSteps) {
      return photoLookupNextSteps
    }

    const barcodeLookupNextSteps = getBarcodeLookupNextSteps(lookupState.dataStatus.productCatalogStatus)
    if (lookupState.source === 'barcode' && barcodeLookupNextSteps && !hasAnyLookupMatch(lookupState)) {
      return barcodeLookupNextSteps
    }

    const downstreamNextSteps = getDownstreamNextSteps(lookupState?.downstreamMatches)
    if (downstreamNextSteps) {
      return downstreamNextSteps
    }

    const tfdaNextSteps = getTfdaNextSteps(lookupState?.tfdaMatches.length ?? 0)
    if (tfdaNextSteps) {
      return tfdaNextSteps
    }

    return getNextSteps(lookupState?.analysis.status ?? 'unknown')
  }, [lookupState])

  useEffect(() => {
    return () => {
      void stopScanner()
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(historyStorageKey, JSON.stringify(lookupHistory))
  }, [lookupHistory])

  function clearScannerHost(elementId: string) {
    const host = document.getElementById(elementId)
    if (!host) {
      return
    }

    host.innerHTML = ''
  }

  function storeHistory(nextState: LookupState) {
    const nextEntry: LookupHistoryEntry = {
      id: `${nextState.source}:${nextState.query}`,
      source: nextState.source,
      query: nextState.query,
      label: getHistoryLabel(nextState),
      status: nextState.analysis.status,
    }

    setLookupHistory((current) => {
      const deduped = current.filter((entry) => entry.id !== nextEntry.id)
      return [nextEntry, ...deduped].slice(0, 6)
    })
  }

  async function fetchProductByBarcode(nextBarcode: string) {
    const response = await fetch(
      `${openFoodFactsEndpoint}/${nextBarcode}?fields=code,product_name,brands,image_front_small_url,quantity`,
    )

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error('目前暫時連不到條碼商品資料來源。')
    }

    const payload = (await response.json()) as {
      product?: OpenFoodFactsProduct
      status: number
    }

    return payload.status === 1 ? payload.product ?? null : null
  }

  const ensureTfdaDataset = useCallback(async (forceRefresh = false) => {
    if (tfdaDataset && !forceRefresh) {
      return tfdaDataset
    }

    if (tfdaPromiseRef.current && !forceRefresh) {
      return tfdaPromiseRef.current
    }

    const nextPromise = fetch(tfdaDataUrl, {
      cache: forceRefresh ? 'no-store' : 'default',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`TFDA dataset request failed with status ${response.status}`)
        }

        const payload = (await response.json()) as TfdaUnsafeDataset
        setTfdaDataset(payload)
        setTfdaError('')
        return payload
      })
      .catch((error) => {
        setTfdaError(error instanceof Error ? error.message : '無法載入食藥署官方資料')
        return null
      })
      .finally(() => {
        tfdaPromiseRef.current = null
      })

    tfdaPromiseRef.current = nextPromise
    return nextPromise
  }, [tfdaDataset])

  const ensureDownstreamDataset = useCallback(async (forceRefresh = false) => {
    if (downstreamDataset && !forceRefresh) {
      return downstreamDataset
    }

    if (downstreamPromiseRef.current && !forceRefresh) {
      return downstreamPromiseRef.current
    }

    const nextPromise = fetch(downstreamDataUrl, {
      cache: forceRefresh ? 'no-store' : 'default',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Downstream dataset request failed with status ${response.status}`)
        }

        const payload = (await response.json()) as DownstreamDataset
        setDownstreamDataset(payload)
        setDownstreamError('')
        return payload
      })
      .catch((error) => {
        setDownstreamError(error instanceof Error ? error.message : '無法載入官方下游清單')
        return null
      })
      .finally(() => {
        downstreamPromiseRef.current = null
      })

    downstreamPromiseRef.current = nextPromise
    return nextPromise
  }, [downstreamDataset])

  useEffect(() => {
    void ensureTfdaDataset()
  }, [ensureTfdaDataset])

  useEffect(() => {
    void ensureDownstreamDataset()
  }, [ensureDownstreamDataset])

  async function runKeywordLookup(nextKeyword: string, source: LookupState['source'] = 'keyword') {
    const trimmed = nextKeyword.trim()
    if (!trimmed) {
      return
    }

    setLookupError('')
    setIsLoading(true)

    try {
      const [nextTfdaDataset, nextDownstreamDataset] = await Promise.all([
        ensureTfdaDataset(),
        ensureDownstreamDataset(),
      ])
      const analysis = analyzeLookup(trimmed)
      const tfdaMatches = analyzeTfdaRecords([trimmed], nextTfdaDataset)
      const downstreamMatches = analyzeDownstreamRecords([trimmed], nextDownstreamDataset)
      const nextState: LookupState = {
        source,
        query: trimmed,
        analysis,
        tfdaMatches,
        downstreamMatches,
        dataStatus: {
          tfdaAvailable: Boolean(nextTfdaDataset),
          downstreamAvailable: Boolean(nextDownstreamDataset),
        },
      }
      setLookupState(nextState)
      storeHistory(nextState)
      if (!nextTfdaDataset || !nextDownstreamDataset) {
        setLookupError(officialDatasetUnavailableMessage)
      }
      scrollToResults()
    } finally {
      setIsLoading(false)
    }
  }

  async function runPhotoNameLookup(file: File) {
    setPhotoOcrError('')
    setScannerError('')
    setLookupError('')
    setPhotoOcrBusy(true)

    try {
      const isHeicFile = /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
      if (isHeicFile) {
        throw new Error('heic photo is not supported')
      }

      const [image, worker] = await Promise.all([loadImageFromFile(file), getProductNameOcrWorker()])
      const scanCandidates = buildProductTextScanCandidates(image)
      const collectedLines: Array<PhotoOcrLine & { variantIndex: number; lineIndex: number }> = []

      for (const [variantIndex, candidate] of scanCandidates.entries()) {
        try {
          const { data } = await worker.recognize(candidate.canvas, { rotateAuto: true }, { blocks: true })
          const lines = collectPhotoOcrLines(data)

          lines.forEach((line, lineIndex) => {
            collectedLines.push({
              ...line,
              variantIndex,
              lineIndex,
            })
          })
        } catch {
          // Continue trying other cropped regions.
        }
      }

      const rankedCandidates = rankPhotoNameCandidates(collectedLines)
      const nextKeyword = rankedCandidates[0]

      if (!nextKeyword) {
        throw new Error('no product name')
      }

      setPhotoKeywordDraft(nextKeyword)
      setPhotoKeywordSuggestions(rankedCandidates.slice(1, 5))
      setKeyword(nextKeyword)
      await runKeywordLookup(nextKeyword, 'photo')
    } catch (error) {
      setPhotoOcrError(mapPhotoOcrError(error))
    } finally {
      setPhotoOcrBusy(false)
    }
  }

  async function runBarcodeLookup(rawBarcode: string) {
    const cleanedBarcode = rawBarcode.replace(/\D/g, '')
    if (!cleanedBarcode) {
      setLookupError('請先輸入有效條碼，或直接用相機掃描。')
      return
    }

    setLookupError('')
    setIsLoading(true)

    try {
      let product: OpenFoodFactsProduct | null = null
      let productCatalogStatus: BarcodeCatalogStatus = 'loaded'

      try {
        product = await fetchProductByBarcode(cleanedBarcode)
        productCatalogStatus = product ? 'loaded' : 'not_found'
      } catch {
        productCatalogStatus = 'unavailable'
      }

      const [nextTfdaDataset, nextDownstreamDataset] = await Promise.all([
        ensureTfdaDataset(),
        ensureDownstreamDataset(),
      ])
      const dataStatus: LookupDataStatus = {
        tfdaAvailable: Boolean(nextTfdaDataset),
        downstreamAvailable: Boolean(nextDownstreamDataset),
        productCatalogStatus,
      }
      const tfdaMatches = analyzeTfdaRecords(
        [cleanedBarcode, product?.product_name, product?.brands],
        nextTfdaDataset,
      )
      const downstreamMatches = analyzeDownstreamRecords(
        [cleanedBarcode, product?.product_name, product?.brands],
        nextDownstreamDataset,
      )
      const shouldForceUnknown =
        !hasFullOfficialData(dataStatus) || productCatalogStatus !== 'loaded'
      const analysis = product
        ? analyzeLookup(cleanedBarcode, product.product_name, product.brands)
        : shouldForceUnknown
          ? buildUnknownAnalysis(cleanedBarcode)
          : analyzeLookup(cleanedBarcode)

      const nextState: LookupState = {
        source: 'barcode',
        query: cleanedBarcode,
        barcode: cleanedBarcode,
        product,
        analysis,
        tfdaMatches,
        downstreamMatches,
        dataStatus,
      }
      setLookupState(nextState)
      storeHistory(nextState)
      if (productCatalogStatus === 'unavailable') {
        setLookupError(barcodeSourceUnavailableMessage)
      } else if (!nextTfdaDataset || !nextDownstreamDataset) {
        setLookupError(officialDatasetUnavailableMessage)
      }
      scrollToResults()
    } catch (error) {
      const message = error instanceof Error ? error.message : '條碼查詢失敗，請稍後再試。'
      setLookupError(message)
      scrollToResults()
    } finally {
      setIsLoading(false)
    }
  }

  async function stopScanner() {
    const currentScanner = scannerRef.current
    scannerRef.current = null
    scanResolvedRef.current = false

    if (!currentScanner) {
      clearScannerHost(cameraScannerRegionId)
      clearScannerHost(fileScannerRegionId)
      setScannerOpen(false)
      setScannerBusy(false)
      return
    }

    try {
      await currentScanner.stop()
    } catch {
      // Ignore stop errors when the scanner has not fully started.
    }

    try {
      currentScanner.clear()
    } catch {
      // Ignore cleanup issues on mobile browsers.
    }

    clearScannerHost(cameraScannerRegionId)
    clearScannerHost(fileScannerRegionId)
    setScannerOpen(false)
    setScannerBusy(false)
  }

  async function startScanner() {
    setScannerError('')
    setLookupError('')
    await stopScanner()

    if (!window.isSecureContext) {
      setScannerError('相機掃碼需要在 https 網址下開啟。')
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setScannerError('這個瀏覽器目前不支援直接開啟相機掃碼，請改用照片或手動輸入。')
      return
    }

    setScannerOpen(true)
    setScannerBusy(true)
    scanResolvedRef.current = false

    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
      const scanConfig = {
        fps: 10,
        aspectRatio: 1.25,
        qrbox: { width: 260, height: 160 },
        disableFlip: true,
      }
      const instance = new Html5Qrcode(cameraScannerRegionId, {
        verbose: false,
        useBarCodeDetectorIfSupported: false,
        formatsToSupport: getSupportedBarcodeFormats(Html5QrcodeSupportedFormats),
      })

      scannerRef.current = instance

      const handleScanSuccess = (decodedText: string) => {
        if (scanResolvedRef.current) {
          return
        }

        scanResolvedRef.current = true
        setBarcode(decodedText)
        void stopScanner().then(() => runBarcodeLookup(decodedText))
      }

      try {
        await instance.start(
          { facingMode: 'environment' },
          scanConfig,
          handleScanSuccess,
          () => {
            // Skip noisy frame-by-frame errors.
          },
        )
      } catch (primaryError) {
        const cameras = await Html5Qrcode.getCameras().catch(() => [])
        const preferredCamera = pickPreferredCamera(cameras)

        if (!preferredCamera) {
          throw primaryError
        }

        await instance.start(
          preferredCamera.id,
          scanConfig,
          handleScanSuccess,
          () => {
            // Skip noisy frame-by-frame errors.
          },
        )
      }

      setScannerBusy(false)
    } catch (error) {
      setScannerError(mapScannerError(error, 'camera'))
      await stopScanner()
    }
  }

  async function handleImageScan(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    setScannerError('')
    setLookupError('')
    setScannerBusy(true)

    try {
      const isHeicFile =
        /heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)

      if (isHeicFile) {
        throw new Error('heic photo is not supported')
      }

      await stopScanner()
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
      const instance = new Html5Qrcode(fileScannerRegionId, {
        verbose: false,
        useBarCodeDetectorIfSupported: true,
        formatsToSupport: getSupportedBarcodeFormats(Html5QrcodeSupportedFormats),
      })

      try {
        const candidates = await buildBarcodeScanCandidates(file)
        let decodedText = ''

        for (const candidate of candidates) {
          if (!candidate.file) {
            continue
          }

          try {
            const result = await instance.scanFileV2(candidate.file, false)
            decodedText = result.decodedText
            break
          } catch {
            // Try the next crop or contrast variant.
          }
        }

        if (!decodedText) {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
            import('@zxing/browser'),
            import('@zxing/library'),
          ])

          const hints = new Map()
          hints.set(DecodeHintType.TRY_HARDER, true)
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.CODE_93,
            BarcodeFormat.ITF,
            BarcodeFormat.RSS_14,
            BarcodeFormat.RSS_EXPANDED,
          ])

          const zxingReader = new BrowserMultiFormatReader(hints)

          for (const candidate of candidates) {
            if (!candidate.canvas) {
              continue
            }

            try {
              const result = zxingReader.decodeFromCanvas(candidate.canvas)
              decodedText = result.getText()
              break
            } catch {
              // Keep trying tighter crops.
            }
          }
        }

        if (!decodedText) {
          const worker = await getBarcodeOcrWorker()

          for (const candidate of [...candidates].reverse()) {
            if (!candidate.canvas) {
              continue
            }

            try {
              const {
                data: { text },
              } = await worker.recognize(candidate.canvas)
              const ocrBarcode = extractBarcodeFromOcrText(text)

              if (ocrBarcode) {
                decodedText = ocrBarcode
                break
              }
            } catch {
              // Ignore OCR failures and keep trying other crops.
            }
          }
        }

        if (!decodedText) {
          throw new Error('no barcode')
        }

        setBarcode(decodedText)
        await runBarcodeLookup(decodedText)
      } finally {
        try {
          instance.clear()
        } catch {
          // Ignore cleanup issues after file scan.
        }
        clearScannerHost(fileScannerRegionId)
      }
    } catch (error) {
      setScannerError(mapScannerError(error, 'photo'))
    } finally {
      setScannerBusy(false)
    }
  }

  return (
    <div className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">手機優先食安查詢</span>
          <h1>先拍包裝辨識商品名，再對官方名單；條碼改當輔助工具</h1>
          <p className="hero-text">
            主流程先抓包裝上的品名大字，直接核對食藥署名單；如果剛好讀得到條碼，再把它當成補充捷徑。
          </p>

          <div className="hero-guides">
            <span className="hero-guide">主查：拍照辨識商品名、手動輸入食品名</span>
            <span className="hero-guide">輔助：條碼能對到商品時，再補商品資料與品牌</span>
          </div>

          <div className="hero-stats">
            <div className="stat-card">
              <strong>{downstreamDataset?.preventiveProductCount ?? 440}</strong>
              <span>下架產品</span>
            </div>
            <div className="stat-card">
              <strong>{downstreamDataset?.businessCount ?? 360}</strong>
              <span>下游業者</span>
            </div>
            <div className="stat-card">
              <strong>{tfdaDataset?.recordCount ?? 2487}</strong>
              <span>TFDA 資料</span>
            </div>
          </div>
        </div>
      </section>

      <section className="action-grid">
        <article className="action-card primary-card">
          <div className="card-head">
            <div>
              <span className="card-kicker">拍照模式</span>
              <h2>先拍包裝，直接辨識品名</h2>
            </div>
            <Camera size={20} />
          </div>

          <p className="card-copy">這一版把主流程改成拍包裝辨識商品名，再直接核對官方清單；條碼只留作輔助。</p>

          <div className="cta-row">
            <label className="primary-btn file-btn">
              <Camera size={18} />
              直接拍照辨識品名
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) {
                    void runPhotoNameLookup(file)
                  }
                }}
              />
            </label>

            <label className="secondary-btn file-btn">
              <ImageUp size={18} />
              從相簿辨識品名
              <input
                type="file"
                accept="image/*,.heic,.heif"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) {
                    void runPhotoNameLookup(file)
                  }
                }}
              />
            </label>
          </div>
          <p className="scanner-note">第一次辨識會多等幾秒下載文字模型；如果字不準，你可以直接改字再查。</p>

          {photoOcrBusy ? (
            <p className="inline-feedback info">
              <LoaderCircle size={18} className="spin" />
              正在辨識照片裡的商品名…
            </p>
          ) : null}
          {photoOcrError ? <p className="inline-feedback warning">{photoOcrError}</p> : null}

          {photoKeywordDraft ? (
            <div className="ocr-review">
              <div className="ocr-review-head">
                <strong>我辨識到的商品名</strong>
                <span>如果字不夠準，可以直接改字再查</span>
              </div>

              <form
                className="input-stack"
                onSubmit={(event) => {
                  event.preventDefault()
                  void runKeywordLookup(photoKeywordDraft, 'photo')
                }}
              >
                <input
                  value={photoKeywordDraft}
                  onChange={(event) => {
                    setPhotoKeywordDraft(event.target.value)
                    setKeyword(event.target.value)
                  }}
                />
                <button type="submit" className="secondary-dark-btn">
                  用這個品名查
                  <ChevronRight size={18} />
                </button>
              </form>

              {photoKeywordSuggestions.length > 0 ? (
                <>
                  <p className="suggestion-label">其他可能字樣</p>
                  <div className="ocr-suggestion-row">
                    {photoKeywordSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        className="suggestion-chip"
                        onClick={() => {
                          setPhotoKeywordDraft(suggestion)
                          setKeyword(suggestion)
                          void runKeywordLookup(suggestion, 'photo')
                        }}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          <details className="assist-detail">
            <summary className="detail-summary">
              <div>
                <strong>想用條碼工具再展開</strong>
                <span>只有在商品資料庫對得到時，條碼才比較有幫助</span>
              </div>
              <span className="detail-count">條碼輔助</span>
            </summary>

            <div className="assist-tools">
              <div className="cta-row">
                <button type="button" className="secondary-btn" onClick={() => void startScanner()}>
                  <Barcode size={18} />
                  開啟相機掃條碼
                </button>

                <label className="secondary-btn file-btn">
                  <ImageUp size={18} />
                  從相簿讀條碼
                  <input type="file" accept="image/*,.heic,.heif" onChange={handleImageScan} />
                </label>
              </div>
              <p className="scanner-note">{cameraHintText}</p>

              <div className="scanner-panel">
                {scannerOpen ? (
                  <div className="scanner-stage">
                    <div id={cameraScannerRegionId} className="scanner-region" />
                    <button type="button" className="icon-btn close-btn" onClick={() => void stopScanner()}>
                      <X size={18} />
                    </button>
                    {scannerBusy ? (
                      <div className="scanner-overlay">
                        <LoaderCircle size={18} className="spin" />
                        <span>正在準備相機…</span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="scanner-placeholder">
                    <div className="scan-frame" />
                    <p>相機一打開就直接掃條碼，不需要切頁或跳轉。</p>
                  </div>
                )}
              </div>

              <form
                className="manual-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void runBarcodeLookup(barcode)
                }}
              >
                <label htmlFor="barcode-input">沒有要開相機，也可以直接輸入條碼</label>
                <div className="input-row">
                  <input
                    id="barcode-input"
                    inputMode="numeric"
                    placeholder="例如：471..."
                    value={barcode}
                    onChange={(event) => setBarcode(event.target.value)}
                  />
                  <button type="button" className="dark-btn" onClick={() => void runBarcodeLookup(barcode)}>
                    查條碼
                  </button>
                </div>
              </form>
            </div>
          </details>
          <div id={fileScannerRegionId} className="scanner-host-hidden" aria-hidden="true" />

          {scannerError ? <p className="inline-feedback warning">{scannerError}</p> : null}
        </article>

        <article className="action-card">
          <div className="card-head">
            <div>
              <span className="card-kicker">關鍵字模式</span>
              <h2>手動輸入食品名或業者名</h2>
            </div>
            <Search size={20} />
          </div>

          <p className="card-copy">直接輸入食品名、品牌或業者名即可比對。像「雙蔬鮪魚飯糰」或「南僑油脂事業股份有限公司」都能查。</p>

          <form
            className="input-stack"
            onSubmit={(event) => {
              event.preventDefault()
              void runKeywordLookup(keyword, 'keyword')
            }}
          >
            <input
              ref={keywordInputRef}
              placeholder="例如：雙蔬鮪魚飯糰／爭鮮股份有限公司"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <button type="submit" className="secondary-dark-btn">
              立即比對
              <ChevronRight size={18} />
            </button>
          </form>

          <p className="suggestion-label">常見查法</p>
          <div className="suggestion-wrap">
            {quickSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-chip"
                onClick={() => {
                  setKeyword(suggestion)
                  void runKeywordLookup(suggestion, 'keyword')
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <p className="card-footnote">系統只會告訴你是否命中目前載入的官方資料，不會直接宣告某食品絕對安全。</p>
        </article>
      </section>

      <section ref={resultPanelRef} className="result-panel">
        <div className="section-heading">
          <span>查詢結果</span>
          {isLoading ? (
            <div className="loading-state">
              <LoaderCircle size={18} className="spin" />
              <span>正在比對資料…</span>
            </div>
          ) : null}
        </div>

        {lookupError ? <p className="inline-feedback danger">{lookupError}</p> : null}

        {lookupState ? (
          <article className={`result-card tone-${resultTone.tone}`}>
            <div className="result-top">
              <div>
                <span className="result-badge">{resultTone.badge}</span>
                <h3>{resultTone.title}</h3>
                <p>{resultTone.description}</p>
              </div>
              <resultTone.icon size={28} />
            </div>

            <div className="result-grid result-grid-compact">
              <div className="info-block">
                <span className="info-label">查詢方式</span>
                <strong>
                  {lookupState.source === 'barcode'
                    ? '條碼查詢'
                    : lookupState.source === 'photo'
                      ? '拍照辨識'
                      : '關鍵字查詢'}
                </strong>
              </div>
              <div className="info-block">
                <span className="info-label">輸入內容</span>
                <strong>{lookupState.query}</strong>
              </div>
              {lookupState.product?.product_name ? (
                <div className="info-block">
                  <span className="info-label">商品資料</span>
                  <strong>{lookupState.product.product_name}</strong>
                  <small>{lookupState.product.brands || '品牌未提供'}</small>
                </div>
              ) : null}
            </div>

            {lookupState.product ? (
              <article className="product-card">
                {lookupState.product.image_front_small_url ? (
                  <img
                    className="product-thumb"
                    src={lookupState.product.image_front_small_url}
                    alt={lookupState.product.product_name || '商品圖片'}
                  />
                ) : null}
                <div className="product-copy">
                  <strong>{lookupState.product.product_name || '已找到商品資料'}</strong>
                  <p>
                    {lookupState.product.brands || '品牌未提供'}
                    {lookupState.product.quantity ? ` · ${lookupState.product.quantity}` : ''}
                  </p>
                  <small>條碼：{lookupState.product.code}</small>
                </div>
              </article>
            ) : null}

            {lookupState.analysis.matchedProducts.length > 0 ? (
              <details className="result-detail">
                <summary className="detail-summary">
                  <div>
                    <strong>歷史油品黑名單命中</strong>
                    <span>品牌與品項層級的歷史風險比對</span>
                  </div>
                  <span className="detail-count">{lookupState.analysis.matchedProducts.length} 項</span>
                </summary>
                <div className="match-list">
                  {lookupState.analysis.matchedProducts.map(({ brand, item }) => (
                    <article key={`${brand}-${item.name}`} className="match-card">
                      <div className="match-title">
                        <span>{brand}</span>
                        <strong>{item.name}</strong>
                      </div>
                      <p>{item.affectedBusinesses} 個受波及據點，涵蓋 {item.cities.join('、')}</p>
                    </article>
                  ))}
                </div>
              </details>
            ) : null}

            {lookupState.analysis.status === 'watch' ? (
              <div className="match-card watch-card">
                <strong>為什麼是黃燈？</strong>
                <p>
                  這次只比對到品牌層級風險，還沒命中具體黑名單品項。對手機 UX 來說，這比直接放一大段說明更容易懂。
                </p>
              </div>
            ) : null}

            {lookupState.downstreamMatches.productMatchCount > 0 ? (
              <details className="official-card" open>
                <summary className="detail-summary">
                  <div>
                    <strong>食藥署官方預防性下架產品</strong>
                    <span>最接近消費者手上成品的官方名單</span>
                  </div>
                  <span className="detail-count">{lookupState.downstreamMatches.productMatchCount} 項</span>
                </summary>
                <div className="official-list">
                  {lookupState.downstreamMatches.productMatches.map((entry) => (
                    <article key={entry.id} className="official-item">
                      <div className="official-item-head">
                        <strong>{entry.productName}</strong>
                        <span>{entry.expiry || '日期未提供'}</span>
                      </div>
                      <p>
                        {entry.business} · {entry.city}
                      </p>
                      <small>官方產品序號：{entry.productNo}</small>
                    </article>
                  ))}
                </div>
                {lookupState.downstreamMatches.productMatchCount > lookupState.downstreamMatches.productMatches.length ? (
                  <small className="section-note">
                    先顯示前 {lookupState.downstreamMatches.productMatches.length} 項，完整名單請再點官方來源查看。
                  </small>
                ) : null}
              </details>
            ) : null}

            {lookupState.downstreamMatches.businessMatchCount > 0 ? (
              <details className="official-card">
                <summary className="detail-summary">
                  <div>
                    <strong>食藥署官方下游業者</strong>
                    <span>如果你查的是通路、品牌方或製造業者，可從這裡往下看</span>
                  </div>
                  <span className="detail-count">{lookupState.downstreamMatches.businessMatchCount} 家</span>
                </summary>
                <div className="official-list">
                  {lookupState.downstreamMatches.businessMatches.map((entry) => (
                    <article key={entry.id} className="official-item">
                      <div className="official-item-head">
                        <strong>
                          {entry.business}
                          {entry.status === 'market' ? '' : ' · 需看官方備註'}
                        </strong>
                        <span>{entry.city}</span>
                      </div>
                      <p>{entry.oilItems.map((item) => item.name).join('、')}</p>
                      <small>
                        序號：{entry.businessNo}
                        {entry.statusNote ? ` · ${entry.statusNote}` : ''}
                      </small>
                    </article>
                  ))}
                </div>
                {lookupState.downstreamMatches.businessMatchCount > lookupState.downstreamMatches.businessMatches.length ? (
                  <small className="section-note">
                    先顯示前 {lookupState.downstreamMatches.businessMatches.length} 家，完整名單請再點官方來源查看。
                  </small>
                ) : null}
              </details>
            ) : null}

            {lookupState.tfdaMatches.length > 0 ? (
              <details className="official-card">
                <summary className="detail-summary">
                  <div>
                    <strong>食藥署官方不符合食品資料</strong>
                    <span>延伸比對同名或同品牌食品的官方紀錄</span>
                  </div>
                  <span className="detail-count">{lookupState.tfdaMatches.length} 筆</span>
                </summary>
                <div className="official-list">
                  {lookupState.tfdaMatches.map((record, index) => (
                    <article key={`${record.id}-${index}`} className="official-item">
                      <div className="official-item-head">
                        <strong>{record.subject || record.brand || '未命名產品'}</strong>
                        <span>{record.publishedAt || '日期未提供'}</span>
                      </div>
                      <p>{record.reason || '原因未提供'}</p>
                      <small>
                        {record.brand ? `牌名：${record.brand} · ` : ''}
                        {record.importer ? `進口商：${record.importer}` : record.manufacturer}
                      </small>
                    </article>
                  ))}
                </div>
              </details>
            ) : null}

            {lookupState.analysis.matchedBrands.length > 0 ? (
              <div className="brand-chip-row">
                {lookupState.analysis.matchedBrands.map((brandGroup) => (
                  <span key={brandGroup.brand} className="brand-chip">
                    {brandGroup.brand}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="steps-card">
              <strong>接下來建議這樣做</strong>
              <ol className="steps-list">
                {nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            {lookupState.source === 'barcode' && lookupState.dataStatus.productCatalogStatus !== 'loaded' ? (
              <div className="unknown-card">
                <strong>
                  {lookupState.dataStatus.productCatalogStatus === 'unavailable'
                    ? '條碼商品資料來源暫時連不上'
                    : '條碼有讀到，但商品資料庫沒有找到這個商品'}
                </strong>
                <p>
                  {lookupState.dataStatus.productCatalogStatus === 'unavailable'
                    ? '所以這次不是已確認沒問題，而是少了條碼對商品名這一步。建議改用包裝上的完整品名查詢。'
                    : '這不代表安全或危險，只是目前還查不到商品資料。直接輸入包裝上的完整品名會更準。'}
                </p>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    focusKeywordLookup()
                  }}
                >
                  改用品名查詢
                </button>
              </div>
            ) : null}
          </article>
        ) : (
          <article className="empty-state">
            <AlertTriangle size={24} />
            <div>
              <h3>先拍照辨識，再看完整結果</h3>
              <p>現在主流程會先抓包裝上的商品名大字，再直接對官方名單，比單靠條碼更貼近實際食品本身。</p>
            </div>
          </article>
        )}
      </section>

      <section className="support-grid">
        <article className="support-card">
          <div className="section-heading">
            <span>官方資料來源</span>
            {tfdaDataset || downstreamDataset ? (
              <button
                type="button"
                className="refresh-btn"
                onClick={() => {
                  void Promise.all([ensureTfdaDataset(true), ensureDownstreamDataset(true)])
                }}
              >
                <RefreshCcw size={16} />
                重新載入
              </button>
            ) : null}
          </div>
          <p className="support-copy">
            條碼資料來自 Open Food Facts；其餘名單則在建置時同步食藥署官方資料，再隨網站一起發佈。
          </p>
          {tfdaDataset || downstreamDataset ? (
            <div className="dataset-meta">
              {downstreamDataset ? (
                <>
                  <div className="info-block">
                    <span className="info-label">下游業者</span>
                    <strong>{downstreamDataset.businessCount}</strong>
                    <small>其中 {downstreamDataset.marketBusinessCount} 家仍屬流入市面名單</small>
                  </div>
                  <div className="info-block">
                    <span className="info-label">預防性下架產品</span>
                    <strong>{downstreamDataset.preventiveProductCount}</strong>
                  </div>
                </>
              ) : null}
              <div className="info-block">
                <span className="info-label">官方資料筆數</span>
                <strong>{tfdaDataset?.recordCount ?? '載入中'}</strong>
              </div>
              <div className="info-block">
                <span className="info-label">本站同步時間</span>
                <strong>{(downstreamDataset?.fetchedAt ?? tfdaDataset?.fetchedAt ?? '').slice(0, 10)}</strong>
              </div>
            </div>
          ) : null}
          {tfdaError ? <p className="inline-feedback warning">{tfdaError}</p> : null}
          {downstreamError ? <p className="inline-feedback warning">{downstreamError}</p> : null}
          <details className="support-detail">
            <summary className="detail-summary">
              <div>
                <strong>查看官方來源與附件</strong>
                <span>需要時再展開，不把主流程塞滿</span>
              </div>
              <span className="detail-count">展開</span>
            </summary>
            <div className="resource-list">
              {officialResources.map((resource) => (
                <a key={resource.url} href={resource.url} target="_blank" rel="noreferrer" className="resource-link">
                  <span>{resource.label}</span>
                  <ArrowUpRight size={16} />
                </a>
              ))}
              {downstreamResources.map((resource) => (
                <a key={resource.url} href={resource.url} target="_blank" rel="noreferrer" className="resource-link">
                  <span>{resource.label}</span>
                  <ArrowUpRight size={16} />
                </a>
              ))}
            </div>
          </details>
        </article>

        <article className="support-card">
          <div className="section-heading">
            <span>歷史油品清單</span>
          </div>
          <p className="support-copy">這一塊是補充背景資料，不是你每次查詢都一定要先讀完。</p>
          <div className="catalog-list">
            {oilBlacklist.map((group) => (
              <details key={group.brand} className="catalog-item">
                <summary>
                  <div>
                    <strong>{group.brand}</strong>
                    <span>{group.items.length} 項品類</span>
                  </div>
                  <ChevronRight size={16} />
                </summary>
                <p className="catalog-note">{group.note}</p>
                <div className="catalog-tags">
                  {group.items.map((item) => (
                    <span key={item.name} className="catalog-chip">
                      {item.name}
                    </span>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </article>
      </section>

      <section className="support-grid">
        <article className="support-card">
          <div className="section-heading">
            <span>最近查詢</span>
          </div>
          {lookupHistory.length > 0 ? (
            <div className="history-list">
              {lookupHistory.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="history-item"
                  onClick={() => {
                    if (entry.source === 'barcode') {
                      setBarcode(entry.query)
                      void runBarcodeLookup(entry.query)
                      return
                    }

                    setKeyword(entry.label)
                    if (entry.source === 'photo') {
                      setPhotoKeywordDraft(entry.label)
                    }
                    void runKeywordLookup(entry.label, entry.source)
                  }}
                >
                  <div>
                    <strong>{entry.label}</strong>
                    <small>
                      {entry.source === 'barcode'
                        ? `條碼 ${entry.query}`
                        : entry.source === 'photo'
                          ? '拍照辨識'
                          : '關鍵字查詢'}
                    </small>
                  </div>
                  <span className={`history-pill tone-${entry.status}`}>{entry.status}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="support-copy">查過的商品會先留在這裡，方便你在手機上快速重查。</p>
          )}
        </article>
      </section>
    </div>
  )
}

export default App
