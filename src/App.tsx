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
  Smartphone,
  X,
} from 'lucide-react'
import { blacklistStats, officialResources, oilBlacklist, quickSuggestions } from './data/blacklist'
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
  source: 'keyword' | 'barcode'
  query: string
  barcode?: string
  product?: OpenFoodFactsProduct | null
  analysis: LookupAnalysis
  tfdaMatches: TfdaUnsafeRecord[]
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

function mapScannerError(error: unknown, source: 'camera' | 'photo') {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (source === 'camera') {
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
      return '這張照片沒有成功辨識到條碼，請讓條碼更近、更清楚，並避免反光。'
    }
  }

  return source === 'camera'
    ? '相機啟動失敗，請改用手動輸入條碼或上傳照片。'
    : '這張照片沒有順利讀到條碼，請換一張近一點、清楚一點的照片。'
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
  const [tfdaDataset, setTfdaDataset] = useState<TfdaUnsafeDataset | null>(null)
  const [tfdaError, setTfdaError] = useState('')

  const scannerRef = useRef<Html5Qrcode | null>(null)
  const scanResolvedRef = useRef(false)
  const tfdaPromiseRef = useRef<Promise<TfdaUnsafeDataset | null> | null>(null)
  const cameraScannerRegionId = 'barcode-camera-scanner-region'
  const fileScannerRegionId = 'barcode-file-scanner-region'

  const resultTone = useMemo(() => {
    if ((lookupState?.tfdaMatches.length ?? 0) > 0) {
      return {
        badge: '命中食藥署官方資料',
        icon: ShieldAlert,
        title: '這個查詢結果命中食藥署官方不符合食品資料',
        description: '這一段是根據食藥署官方開放資料比對出來的，可信度高於手整理的歷史事件名單。',
      }
    }

    switch (lookupState?.analysis.status) {
      case 'flagged':
        return {
          badge: '命中歷史黑名單',
          icon: ShieldAlert,
          title: '這個品項已命中歷史問題油品名單',
          description: '建議立刻查看官方公告與批號資訊，不要只憑品牌印象判斷。',
        }
      case 'watch':
        return {
          badge: '品牌有歷史風險',
          icon: CircleAlert,
          title: '同品牌曾出現在歷史黑名單，請再核對產品名',
          description: '目前是品牌層級命中，不代表此商品一定在名單內，但應提醒使用者再確認。',
        }
      case 'clear':
        return {
          badge: '未命中載入名單',
          icon: CheckCircle2,
          title: '這次查詢沒有命中目前載入的歷史油品黑名單',
          description: '這不是官方安全保證，仍建議連到食藥署公告再核對一次。',
        }
      default:
        return {
          badge: '資料不足',
          icon: CircleAlert,
          title: '目前還沒有足夠資料做判斷',
          description: '可能是掃不到商品資料，或輸入內容太泛；可以改用商品全名再查一次。',
        }
    }
  }, [lookupState])

  const nextSteps = useMemo(() => {
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

  useEffect(() => {
    void ensureTfdaDataset()
  }, [ensureTfdaDataset])

  async function runKeywordLookup(nextKeyword: string) {
    const trimmed = nextKeyword.trim()
    if (!trimmed) {
      return
    }

    setLookupError('')
    setIsLoading(true)

    try {
      const nextTfdaDataset = await ensureTfdaDataset()
      const analysis = analyzeLookup(trimmed)
      const tfdaMatches = analyzeTfdaRecords([trimmed], nextTfdaDataset)
      const nextState: LookupState = {
        source: 'keyword',
        query: trimmed,
        analysis,
        tfdaMatches,
      }
      setLookupState(nextState)
      storeHistory(nextState)
    } finally {
      setIsLoading(false)
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
      const product = await fetchProductByBarcode(cleanedBarcode)
      const nextTfdaDataset = await ensureTfdaDataset()
      const analysis = product
        ? analyzeLookup(cleanedBarcode, product.product_name, product.brands)
        : {
            ...analyzeLookup(cleanedBarcode),
            status: 'unknown' as const,
          }
      const tfdaMatches = analyzeTfdaRecords(
        [cleanedBarcode, product?.product_name, product?.brands],
        nextTfdaDataset,
      )

      const nextState: LookupState = {
        source: 'barcode',
        query: cleanedBarcode,
        barcode: cleanedBarcode,
        product,
        analysis,
        tfdaMatches,
      }
      setLookupState(nextState)
      storeHistory(nextState)
    } catch (error) {
      const message = error instanceof Error ? error.message : '條碼查詢失敗，請稍後再試。'
      setLookupError(message)
    } finally {
      setIsLoading(false)
    }
  }

  async function stopScanner() {
    if (!scannerRef.current) {
      setScannerOpen(false)
      setScannerBusy(false)
      return
    }

    try {
      await scannerRef.current.stop()
    } catch {
      // Ignore stop errors when the scanner has not fully started.
    }

    try {
      scannerRef.current.clear()
    } catch {
      // Ignore cleanup issues on mobile browsers.
    }

    scannerRef.current = null
    scanResolvedRef.current = false
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
      const instance = new Html5Qrcode(cameraScannerRegionId, {
        verbose: false,
        useBarCodeDetectorIfSupported: false,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
        ],
      })

      scannerRef.current = instance

      await instance.start(
        { facingMode: { ideal: 'environment' } },
        {
          fps: 10,
          aspectRatio: 1.25,
          qrbox: { width: 260, height: 160 },
          disableFlip: true,
        },
        (decodedText) => {
          if (scanResolvedRef.current) {
            return
          }

          scanResolvedRef.current = true
          setBarcode(decodedText)
          void stopScanner().then(() => runBarcodeLookup(decodedText))
        },
        () => {
          // Skip noisy frame-by-frame errors.
        },
      )

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
        useBarCodeDetectorIfSupported: false,
        formatsToSupport: [
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.UPC_E,
          Html5QrcodeSupportedFormats.CODE_128,
        ],
      })

      const decodedText = await instance.scanFile(file, false)
      instance.clear()
      setBarcode(decodedText)
      await runBarcodeLookup(decodedText)
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
          <h1>掃一下條碼，就知道這款油品有沒有踩到歷史黑名單</h1>
          <p className="hero-text">
            這版把原本站分散的功能收斂成最短路徑：掃碼、立即判斷、再看依據。先幫民眾做決定，再讓他們決定要不要往下讀。
          </p>

          <div className="hero-stats">
            <div className="stat-card">
              <strong>{blacklistStats.products}</strong>
              <span>歷史問題品項</span>
            </div>
            <div className="stat-card">
              <strong>{blacklistStats.brands}</strong>
              <span>品牌群組</span>
            </div>
            <div className="stat-card">
              <strong>{blacklistStats.affectedBusinesses}</strong>
              <span>受波及據點</span>
            </div>
          </div>
        </div>

        <div className="hero-rail">
          <div className="rail-card">
            <div className="rail-title">
              <Smartphone size={18} />
              <span>新版操作節奏</span>
            </div>
            <ol className="flow-list">
              <li>1. 開相機掃條碼，或先拍照上傳。</li>
              <li>2. 先看紅燈、黃燈、未命中，不逼使用者讀長文。</li>
              <li>3. 需要時再往下看品牌、品項、城市與官方連結。</li>
            </ol>
          </div>
        </div>
      </section>

      <section className="action-grid">
        <article className="action-card primary-card">
          <div className="card-head">
            <div>
              <span className="card-kicker">掃碼模式</span>
              <h2>直接用手機查</h2>
            </div>
            <Barcode size={20} />
          </div>

          <div className="cta-row">
            <button type="button" className="primary-btn" onClick={() => void startScanner()}>
              <Camera size={18} />
              開啟相機掃碼
            </button>

            <label className="secondary-btn file-btn">
              <ImageUp size={18} />
              從照片讀條碼
              <input type="file" accept="image/*,.heic,.heif" onChange={handleImageScan} />
            </label>
          </div>

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
          <div id={fileScannerRegionId} className="scanner-host-hidden" aria-hidden="true" />

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

          {scannerError ? <p className="inline-feedback warning">{scannerError}</p> : null}
        </article>

        <article className="action-card">
          <div className="card-head">
            <div>
              <span className="card-kicker">關鍵字模式</span>
              <h2>手動輸入商品名</h2>
            </div>
            <Search size={20} />
          </div>

          <p className="card-copy">適合老闆、店員或消費者直接輸入品名。像「泰山大豆沙拉油」這種完整商品名，會比只打品牌更準。</p>

          <form
            className="input-stack"
            onSubmit={(event) => {
              event.preventDefault()
              void runKeywordLookup(keyword)
            }}
          >
            <input
              placeholder="例如：益康大豆沙拉油"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <button type="submit" className="secondary-dark-btn">
              立即比對
              <ChevronRight size={18} />
            </button>
          </form>

          <div className="suggestion-wrap">
            {quickSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="suggestion-chip"
                onClick={() => {
                  setKeyword(suggestion)
                  void runKeywordLookup(suggestion)
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <div className="trust-box">
            <CircleAlert size={18} />
            <p>新版不會直接說「安全」，只會說有沒有命中目前載入的歷史黑名單，以及下一步該去哪裡核對。</p>
          </div>
        </article>
      </section>

      <section className="result-panel">
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
          <article className={`result-card tone-${lookupState.analysis.status}`}>
            <div className="result-top">
              <div>
                <span className="result-badge">{resultTone.badge}</span>
                <h3>{resultTone.title}</h3>
                <p>{resultTone.description}</p>
              </div>
              <resultTone.icon size={28} />
            </div>

            <div className="result-grid">
              <div className="info-block">
                <span className="info-label">查詢方式</span>
                <strong>{lookupState.source === 'barcode' ? '條碼查詢' : '關鍵字查詢'}</strong>
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
            ) : null}

            {lookupState.analysis.status === 'watch' ? (
              <div className="match-card watch-card">
                <strong>為什麼是黃燈？</strong>
                <p>
                  這次只比對到品牌層級風險，還沒命中具體黑名單品項。對手機 UX 來說，這比直接放一大段說明更容易懂。
                </p>
              </div>
            ) : null}

            {lookupState.tfdaMatches.length > 0 ? (
              <div className="official-card">
                <div className="official-card-head">
                  <strong>食藥署官方命中結果</strong>
                  <span>{lookupState.tfdaMatches.length} 筆</span>
                </div>
                <div className="official-list">
                  {lookupState.tfdaMatches.map((record) => (
                    <article key={record.id} className="official-item">
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
              </div>
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

            {lookupState.source === 'barcode' && !lookupState.product ? (
              <div className="unknown-card">
                <strong>條碼資料庫沒有這個商品</strong>
                <p>這不代表安全或危險，只是目前查不到商品資料。你可以直接改用商品全名查詢。</p>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setKeyword(lookupState.query)
                    void runKeywordLookup(lookupState.query)
                  }}
                >
                  用目前內容改做關鍵字查詢
                </button>
              </div>
            ) : null}
          </article>
        ) : (
          <article className="empty-state">
            <AlertTriangle size={24} />
            <div>
              <h3>先掃碼，再看完整結果</h3>
              <p>首頁只保留最重要的兩個入口，避免像原站那樣一打開就有太多分頁讓人分心。</p>
            </div>
          </article>
        )}
      </section>

      <section className="support-grid">
        <article className="support-card">
          <div className="section-heading">
            <span>官方資料來源</span>
            {tfdaDataset ? (
              <button type="button" className="refresh-btn" onClick={() => void ensureTfdaDataset(true)}>
                <RefreshCcw size={16} />
                重新載入
              </button>
            ) : null}
          </div>
          <p className="support-copy">
            條碼資料來自 Open Food Facts；最新官方不符合食品名單則在建置時直接同步食藥署官方 JSON，避開瀏覽器跨網域限制後再隨網站一起發佈。
          </p>
          {tfdaDataset ? (
            <div className="dataset-meta">
              <div className="info-block">
                <span className="info-label">官方資料筆數</span>
                <strong>{tfdaDataset.recordCount}</strong>
              </div>
              <div className="info-block">
                <span className="info-label">本站同步時間</span>
                <strong>{tfdaDataset.fetchedAt.slice(0, 10)}</strong>
              </div>
            </div>
          ) : null}
          {tfdaError ? <p className="inline-feedback warning">{tfdaError}</p> : null}
          <div className="resource-list">
            {officialResources.map((resource) => (
              <a key={resource.url} href={resource.url} target="_blank" rel="noreferrer" className="resource-link">
                <span>{resource.label}</span>
                <ArrowUpRight size={16} />
              </a>
            ))}
          </div>
        </article>

        <article className="support-card">
          <div className="section-heading">
            <span>黑名單清單</span>
          </div>
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
                    void runKeywordLookup(entry.label)
                  }}
                >
                  <div>
                    <strong>{entry.label}</strong>
                    <small>{entry.source === 'barcode' ? `條碼 ${entry.query}` : '關鍵字查詢'}</small>
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
