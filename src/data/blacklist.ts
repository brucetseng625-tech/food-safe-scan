export type BlacklistItem = {
  name: string
  keywords: string[]
  affectedBusinesses: number
  cities: string[]
}

export type BlacklistBrandGroup = {
  brand: string
  aliases: string[]
  note: string
  items: BlacklistItem[]
}

export const officialResources = [
  {
    label: '食藥署官方開放資料：不符合食品資訊',
    url: 'https://data.gov.tw/dataset/6133',
  },
  {
    label: '食藥署官方 JSON 端點',
    url: 'https://data.fda.gov.tw/data/opendata/export/52/json',
  },
  {
    label: 'Open Food Facts 條碼商品資料',
    url: 'https://openfoodfacts.github.io/openfoodfacts-server/api/tutorial-off-api/',
  },
] as const

export const downstreamResources = [
  {
    label: '食藥署黑心油品事件專區',
    url: 'https://www.fda.gov.tw/tc/sitecontent.aspx?sid=4094',
  },
  {
    label: '食藥署 2026/07/05 公布的下游業者清單',
    url: 'https://www.fda.gov.tw/tc/newsContent.aspx?cid=4&id=t634418',
  },
  {
    label: '福壽及泰山油品下游業者清單 PDF',
    url: 'https://www.fda.gov.tw/tc/includes/GetFile.ashx?id=t408966',
  },
  {
    label: '臺南市中聯油脂受影響油品查詢與處置專區',
    url: 'https://health.tainan.gov.tw/list.asp?orcaid=7F827088-05ED-4277-8679-783BB5E47C5C',
  },
] as const

export const oilBlacklist: BlacklistBrandGroup[] = [
  {
    brand: '泰山企業',
    aliases: ['泰山企業', '泰山'],
    note: '以歷史黑心油事件整理名單為底，適合拿來做手機快查原型。',
    items: [
      {
        name: '大豆沙拉油',
        keywords: ['泰山大豆沙拉油'],
        affectedBusinesses: 18,
        cities: ['基隆市', '新北市', '桃園市', '臺中市', '彰化縣', '雲林縣', '臺南市', '高雄市'],
      },
      {
        name: '泰山精選蔬菜油',
        keywords: ['泰山精選蔬菜油'],
        affectedBusinesses: 4,
        cities: ['新北市', '桃園市', '臺中市'],
      },
      {
        name: '泰山花生風味調和油',
        keywords: ['泰山花生風味調和油'],
        affectedBusinesses: 10,
        cities: ['新北市', '桃園市', '苗栗縣', '臺中市', '彰化縣', '高雄市'],
      },
      {
        name: '泰山不飽和大豆沙拉油',
        keywords: ['泰山不飽和大豆沙拉油'],
        affectedBusinesses: 14,
        cities: ['新北市', '桃園市', '苗栗縣', '臺中市', '彰化縣', '雲林縣', '高雄市', '花蓮縣'],
      },
      {
        name: '泰山大豆沙拉油',
        keywords: ['泰山大豆沙拉油'],
        affectedBusinesses: 13,
        cities: ['桃園市', '苗栗縣', '臺中市', '彰化縣', '臺南市', '高雄市', '花蓮縣'],
      },
      {
        name: '泰山好理調合油',
        keywords: ['泰山好理調合油'],
        affectedBusinesses: 5,
        cities: ['桃園市', '臺中市', '高雄市'],
      },
      {
        name: '泰山歐式果實精華調合油',
        keywords: ['泰山歐式果實精華調合油'],
        affectedBusinesses: 4,
        cities: ['桃園市', '臺南市', '高雄市'],
      },
    ],
  },
  {
    brand: '福壽實業',
    aliases: ['福壽實業', '福壽'],
    note: '品牌命中不代表所有商品都在黑名單內，需再比對到產品名稱。',
    items: [
      {
        name: 'L福壽',
        keywords: ['l福壽', 'Ｌ福壽'],
        affectedBusinesses: 41,
        cities: ['臺北市', '新北市', '桃園市', '臺中市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '臺南市', '高雄市', '宜蘭縣', '花蓮縣', '臺東縣'],
      },
      {
        name: '健味香油',
        keywords: ['健味香油', '福壽健味香油'],
        affectedBusinesses: 11,
        cities: ['新北市', '桃園市', '臺中市', '臺南市', '高雄市', '花蓮縣'],
      },
    ],
  },
  {
    brand: '福懋油脂',
    aliases: ['福懋油脂', '福懋', '益康'],
    note: '這組品項相對容易用商品名直接命中，適合掃碼查詢示範。',
    items: [
      {
        name: '益康大豆沙拉油',
        keywords: ['益康大豆沙拉油', '福懋益康大豆沙拉油'],
        affectedBusinesses: 74,
        cities: ['基隆市', '臺北市', '新北市', '桃園市', '臺中市', '新竹市', '新竹縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣'],
      },
      {
        name: '益康烹調油調合油',
        keywords: ['益康烹調油調合油', '福懋益康烹調油調合油'],
        affectedBusinesses: 23,
        cities: ['基隆市', '臺北市', '新北市', '桃園市', '臺中市', '彰化縣', '南投縣', '臺南市', '高雄市', '宜蘭縣', '花蓮縣', '金門縣'],
      },
      {
        name: '金酥耐炸油',
        keywords: ['金酥耐炸油', '福懋金酥耐炸油'],
        affectedBusinesses: 6,
        cities: ['新北市', '桃園市', '臺中市', '臺南市'],
      },
      {
        name: '環保鐵桶沙拉油',
        keywords: ['環保鐵桶沙拉油', '福懋環保鐵桶沙拉油'],
        affectedBusinesses: 12,
        cities: ['新北市', '桃園市', '臺中市', '彰化縣', '雲林縣'],
      },
    ],
  },
  {
    brand: '未標示／其他廠牌',
    aliases: ['未標示', '其他廠牌', '其他廠牌油品'],
    note: '這類型資料偏泛稱，建議只做風險提醒，不直接宣告命中。',
    items: [
      {
        name: '油品',
        keywords: ['未標示油品', '其他廠牌油品'],
        affectedBusinesses: 108,
        cities: ['基隆市', '臺北市', '新北市', '桃園市', '臺中市', '新竹市', '新竹縣', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣', '臺南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣'],
      },
      {
        name: '一級黃豆油',
        keywords: ['未標示一級黃豆油'],
        affectedBusinesses: 23,
        cities: ['基隆市', '新北市', '桃園市', '新竹縣', '臺中市', '彰化縣', '南投縣', '雲林縣', '臺南市', '高雄市', '屏東縣'],
      },
      {
        name: '沙拉油',
        keywords: ['未標示沙拉油'],
        affectedBusinesses: 41,
        cities: ['臺北市', '新北市', '桃園市', '臺中市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '臺南市', '高雄市', '宜蘭縣', '花蓮縣', '臺東縣'],
      },
      {
        name: '沙拉油－塑桶',
        keywords: ['沙拉油塑桶', '未標示沙拉油塑桶'],
        affectedBusinesses: 23,
        cities: ['臺北市', '新北市', '桃園市', '臺中市', '彰化縣', '南投縣', '嘉義市', '臺南市', '高雄市', '屏東縣', '宜蘭縣'],
      },
    ],
  },
]

export const blacklistStats = {
  brands: oilBlacklist.length,
  products: oilBlacklist.reduce((sum, group) => sum + group.items.length, 0),
  affectedBusinesses: oilBlacklist.reduce(
    (sum, group) => sum + group.items.reduce((groupSum, item) => groupSum + item.affectedBusinesses, 0),
    0,
  ),
}

export const quickSuggestions = [
  '泰山大豆沙拉油',
  '益康大豆沙拉油',
  '健味香油',
  '福壽',
] as const
