/**
 * 產品找店家（Google Apps Script 版）
 *
 * 輸入產品 → 列出相關產業 → 點產業依地區列出店家（名稱、地址、電話）
 * 店家資料來自 Google 地圖（Places API 文字搜尋）。
 *
 * 第一次使用：
 *   1. 專案設定（齒輪）→ 指令碼屬性 → 新增 PLACES_API_KEY，值填 Google Places API 金鑰
 *   2. 部署 → 新增部署作業 → 網頁應用程式，存取權選「所有人」
 */

const CACHE_SECONDS = 21600; // 同一個搜尋 6 小時內不重複花額度

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('產品找店家')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 手動執行檢查金鑰能不能用。 */
function testKey() {
  const r = searchPlaces('咖啡豆 批發', '臺北市', '', '');
  Logger.log('找到 ' + r.places.length + ' 家，第一家：' + JSON.stringify(r.places[0]));
}

/**
 * 搜尋店家。county / district 可留空。
 * 回傳 { places: [{name, address, phone, rating, reviews, url, website}], next }
 */
function searchPlaces(query, county, district, pageToken) {
  const key = PropertiesService.getScriptProperties().getProperty('PLACES_API_KEY');
  if (!key) throw new Error('還沒設定 Google 地圖金鑰（指令碼屬性 PLACES_API_KEY）');

  const area = (county || '') + (district || '');
  const text = String(query || '').trim() + (area ? ' ' + area : '');
  if (!String(query || '').trim()) throw new Error('沒有搜尋關鍵字');

  const cacheKey = 'q:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text + '|' + (pageToken || ''), Utilities.Charset.UTF_8));
  const cache = CacheService.getScriptCache();
  const hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);

  const body = { textQuery: text, languageCode: 'zh-TW', regionCode: 'TW', pageSize: 20 };
  if (pageToken) body.pageToken = pageToken;
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': [
        'places.displayName', 'places.formattedAddress', 'places.nationalPhoneNumber',
        'places.rating', 'places.userRatingCount', 'places.googleMapsUri',
        'places.websiteUri', 'places.businessStatus', 'nextPageToken'
      ].join(',')
    },
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) {
    throw new Error('Google 地圖回應錯誤：' + ((data.error && data.error.message) || res.getResponseCode()));
  }

  // 只留在所選地區、還在營業的店家（Google 偶爾會給鄰近縣市的結果）
  const norm = s => String(s || '').replace(/臺/g, '台');
  const places = (data.places || [])
    .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map(p => ({
      name: (p.displayName && p.displayName.text) || '',
      address: (p.formattedAddress || '').replace(/^\d{3,6}\s*/, '').replace(/^台灣/, ''),
      phone: p.nationalPhoneNumber || '',
      rating: p.rating || 0,
      reviews: p.userRatingCount || 0,
      url: p.googleMapsUri || '',
      website: p.websiteUri || ''
    }))
    .filter(p => (!county || norm(p.address).indexOf(norm(county)) >= 0) &&
                 (!district || norm(p.address).indexOf(norm(district)) >= 0));

  const out = { places: places, next: data.nextPageToken || '' };
  try { cache.put(cacheKey, JSON.stringify(out), CACHE_SECONDS); } catch (e) {}
  return out;
}
