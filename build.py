"""產品找店家：下載政府公司登記資料＋開放街圖（OSM），依產業整理成 site/data/*.json。

用法：
  python build.py                下載最新資料後重建
  python build.py --no-download  用 raw/ 裡現有的資料重建

資料來源：
  B. 經濟部商工登記開放資料：營業項目別的公司／商號（名稱、地址，沒有電話）
     - 有檔案的營業項目直接下載 CSV（公司＋商號）
     - 沒有檔案的 F 類營業項目用 API 查公司（商號查不到）
     - 室內設計直接沿用「台灣室內設計名錄」整理好的 data.json
  C. OpenStreetMap（Overpass API）：店家名稱、地址、部分有電話
同一個營業項目登記的公司很多（一家公司常登記幾十個項目），所以大多用「營業項目＋店名關鍵字」篩選。
"""
import csv, json, os, re, ssl, sys, time, unicodedata, urllib.parse, urllib.request, datetime

# 經濟部主機的憑證缺 Subject Key Identifier，新版 Python 的嚴格檢查會擋；只關掉這項，其餘照常驗證
SSL_CTX = ssl.create_default_context()
SSL_CTX.verify_flags &= ~getattr(ssl, 'VERIFY_X509_STRICT', 0)

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW, OUT = os.path.join(ROOT, 'raw'), os.path.join(ROOT, 'site', 'data')
INTERIOR = os.path.join(os.path.dirname(ROOT), '台灣室內設計名錄', 'site', 'data.json')
UA = {'User-Agent': 'Mozilla/5.0 (product-shop-finder)'}
COUNTIES = '臺北市 新北市 桃園市 臺中市 臺南市 高雄市 基隆市 新竹市 嘉義市 新竹縣 苗栗縣 彰化縣 南投縣 雲林縣 嘉義縣 屏東縣 宜蘭縣 花蓮縣 臺東縣 澎湖縣 金門縣 連江縣'.split()
OLD_NAMES = {'桃園縣': '桃園市', '臺北縣': '新北市', '臺中縣': '臺中市', '臺南縣': '臺南市', '高雄縣': '高雄市'}
SHARD = 2_500_000  # 單一檔案超過這個大小就依縣市拆開

# 營業項目別檔案：簡稱 → [(下載 oid, 公司/商號)]
FILES = {
    'deco':    [('C28A71A1-3410-47C6-8107-78CBEA63D3AC', 'c'), ('97276206-CC1E-4ADD-8EE1-F6C49E8B1692', 's'), ('FBC6DA04-0445-4088-830F-7CCEEE986BFD', 's')],  # 室內裝潢
    'reno':    [('C1AEB6AA-548D-43F0-9D83-A486CA765D8B', 'c'), ('1134EFA3-65C2-428C-814A-5FADDBBE2EDE', 's')],  # 室內裝修
    'door':    [('170DF451-D6F7-49AA-A7BE-BFAFC948B843', 'c'), ('57061DF8-2083-4E24-8480-4E4773871142', 's')],  # 門窗安裝工程
    'kitchen': [('B1CE2CFF-790C-4E0D-BF05-34BBDD5CD2F6', 'c'), ('9F599EC8-344A-4FDB-B22E-51C3BB4F0020', 's')],  # 廚具、衛浴設備安裝
    'realty':  [('4C46984F-D1EE-4391-8245-7C45FF5A88CE', 'c'), ('0041580E-F9C8-404E-AD44-03A43D0898C6', 's')],  # 不動產仲介經紀
    'clean':   [('1BD95287-B2CA-4B56-A73B-51D3BE350A11', 'c')],  # 建築物清潔服務
    'beauty':  [('6508BC6B-3DE9-429F-A9A9-EC121D3BE72B', 'c'), ('69F54B5A-2392-462B-8DD9-769E0C4F9A24', 's')],  # 美容美髮服務
    'slim':    [('C0F8D3EF-3A66-4AC2-8A8D-51B7865FC5FE', 'c'), ('37CEC132-64E9-4413-A380-27A3FAA87584', 's')],  # 瘦身美容
    'pet':     [('AAACB116-1609-49A4-844B-31588CE301B5', 'c'), ('0659BC4C-C7A8-4E83-B71A-59F860340C63', 's')],  # 寵物食品及用品零售
    'drug':    [('083B4F8B-C7B7-4B5E-9FBD-17A8F082C3EF', 'c'), ('068D420C-D346-401C-B995-561E984729D7', 's')],  # 西藥零售
    'rest':    [('03CCD26F-6B80-4AF2-AE2F-44FDC75F0D2E', 'c'), ('9D204D9C-9052-402F-B2B4-8B2DDC8F6835', 's')],  # 餐館
    'drink':   [('4B5E4FD4-1BD1-4C33-826B-01B0FF4DFE5F', 'c'), ('6EFF6E6F-832B-4FF2-972E-EBB102732969', 's')],  # 飲料店
    'hw':      [('19E703E5-3D0C-4B50-92A0-C919170AEE08', 'c'), ('ABBFBD0B-A7CF-4D8B-9DD8-C6F1ED2E5BB1', 's')],  # 五金零售
    'hww':     [('444F9B7F-71F5-462F-8354-51FEE1F9BDEC', 'c'), ('4F1C8219-7AF6-44D9-A322-9BADA83C0064', 's')],  # 五金批發
    'elec':    [('FAD84100-82BC-4810-B7B8-CDD90D2BF6B2', 'c'), ('2A81382A-7C42-4896-BA1D-BE9DC97E6EC8', 's')],  # 電器零售
    'elecw':   [('CB636271-DE56-4812-B98F-D467E9328DAD', 'c'), ('D7F372DA-646F-4BFC-BF54-A54309E3AA8D', 's')],  # 電器批發
    'bm':      [('A67D81CC-17B6-4F6F-A429-C089E1FE3F89', 'c'), ('816CCEAC-D50C-4A09-B7E9-A0B278BC370F', 's')],  # 建材零售
    'bmw':     [('E86F3D2F-7C3E-45C3-934C-7F0B082AFA27', 'c')],  # 建材批發
    'daily':   [('5CEF58C0-BE97-42B0-A781-4642593FE55C', 'c'), ('0C2F84AD-83A3-45AE-A33D-569AA03506A3', 's')],  # 日常用品零售
    'food':    [('E9AD9035-2D36-4ED7-9603-C0905CACF0CD', 'c'), ('B5844506-7784-466C-BC2E-EE19EBCAA6D3', 's')],  # 食品什貨、飲料零售
    'foodw':   [('E9DCDC20-6D60-4183-8285-2829548B3FA1', 'c'), ('DD946DAA-F46C-4AD1-A562-1074EEF6BE38', 's')],  # 食品什貨批發
    'cloth':   [('E874B75D-BB8C-4E6F-9AE1-D286704A1EFC', 'c'), ('EF77DE24-FCF4-43A9-8EC8-94F108159C04', 's')],  # 布疋、衣著零售
}
# 沒有檔案的 F 類營業項目：簡稱 → 營業項目代碼（只查得到公司）
API_CODES = {'furn': 'F205040', 'furnw': 'F105050', 'water': 'F206040', 'waterw': 'F106040', 'clothw': 'F104110'}
API = 'https://data.gcis.nat.gov.tw/od/data/api/C8782705-DA48-4897-8537-9F7B0FC463EF'

FURN = r'家具|傢俱|傢具|家俱|沙發|家飾|居家|寢具|床墊'
# 產業名稱（要和網頁上的名稱一致）→ g: 政府資料來源, kw: 店名關鍵字, osm: OSM 篩選 [(key, value 或 None)], okw: OSM 店名關鍵字
INDUSTRIES = {
    # 家具
    '家具行':       dict(g='furn', kw=FURN, osm=[('shop', 'furniture')]),
    '家具批發':     dict(g='furnw', kw=FURN),
    '實木家具':     dict(g='furn furnw', kw=r'實木|原木|木藝|木器|檜木|柚木', osm=[('shop', 'furniture')], okw=r'實木|原木|木'),
    '訂製家具':     dict(g='furn furnw', kw=r'訂製|客製|訂做|定製'),
    '二手家具':     dict(g='furn', kw=r'二手|中古|回收', osm=[('shop', 'second_hand')]),
    '辦公家具':     dict(g='furn furnw', kw=r'辦公|OA', osm=[('shop', 'furniture')], okw=r'辦公|OA'),
    '家具工廠':     dict(g='furnw', kw=r'(家具|傢俱|傢具|家俱|沙發|床墊).*(工業|工廠|木業|實業|製造)'),
    '木材行':       dict(g='bm bmw', kw=r'木材|木業|木行|木料'),
    '五金行':       dict(g='hw', kw=r'五金', osm=[('shop', 'hardware'), ('shop', 'doityourself')]),
    '沙發布・皮革': dict(g='cloth clothw', kw=r'布行|布莊|布料|布業|皮革|紡織|沙發布|布藝', osm=[('shop', 'fabric')]),
    '海綿・床墊':   dict(g='furn furnw', kw=r'海綿|床墊|寢具|彈簧床', osm=[('shop', 'bed')]),
    '室內設計':     dict(g='interior'),
    '系統櫃':       dict(g='deco reno furn', kw=r'系統'),
    '裝潢工程':     dict(g='deco reno', kw=r'裝潢|裝修|室內|木作|裝飾'),
    '窗簾店':       dict(g='furn', kw=r'窗簾|窗飾|窗藝|窗紗|簾', osm=[('shop', 'curtain')]),
    '燈具店':       dict(g='elec', kw=r'燈|照明|LED', osm=[('shop', 'lighting')]),
    '木地板':       dict(g='bm', kw=r'地板|木地', osm=[('shop', 'flooring')]),
    '房屋仲介':     dict(g='realty', kw=r'不動產|房屋|地產|房仲|仲介|置業|住商|信義|永慶|有巢|中信|太平洋|21世紀', osm=[('office', 'estate_agent')]),
    '飯店':         dict(osm=[('tourism', 'hotel')]),
    '民宿':         dict(osm=[('tourism', 'guest_house')]),
    '餐廳':         dict(g='rest', kw=r'餐|食|麵|飯|小吃|料理|廚|館|鍋|燒|烤|堂|屋|坊|膳|鮮|味', osm=[('amenity', 'restaurant')]),
    '咖啡廳':       dict(g='drink rest', kw=r'咖啡|珈琲|cafe|coffee|café', osm=[('amenity', 'cafe')]),
    '月子中心':     dict(osm=[('name', None)], okw=r'月子'),
    '補習班':       dict(osm=[('amenity', 'prep_school'), ('name', None)], okw=r'補習|文理|美語|英語|數學|升學'),
    '長照中心':     dict(osm=[('amenity', 'social_facility'), ('amenity', 'nursing_home'), ('name', None)], okw=r'長照|護理之家|養護|日照|安養|老人'),
    # 窗簾
    '百葉窗・捲簾': dict(g='furn', kw=r'百葉|捲簾|遮陽|窗簾', osm=[('shop', 'curtain')]),
    '窗簾工廠':     dict(g='furnw', kw=r'窗簾|窗飾|簾'),
    '窗簾清洗':     dict(g='clean', kw=r'窗簾|洗'),
    '窗簾布料批發': dict(g='clothw furnw', kw=r'窗簾|布'),
    '窗簾軌道五金': dict(g='hw hww', kw=r'窗簾|軌道'),
    '布料行':       dict(g='cloth', kw=r'布行|布莊|布料|布業|紡織|布藝', osm=[('shop', 'fabric')]),
    '壁紙':         dict(g='bm', kw=r'壁紙|璧紙|壁布|壁貼', osm=[('shop', 'wallpaper')]),
    '油漆工程':     dict(g='bm hw', kw=r'油漆|塗料|漆', osm=[('shop', 'paint')]),
    '鋁門窗':       dict(g='door bm', kw=r'門窗|鋁窗|鋁門|氣密窗|窗業|鋁業|鐵窗|紗窗'),
    '清潔公司':     dict(g='clean', kw=r'清潔|清掃|消毒|除蟲|環境'),
    '診所':         dict(osm=[('amenity', 'clinic'), ('amenity', 'doctors')]),
    '幼兒園':       dict(osm=[('amenity', 'kindergarten')]),
    '包租代管':     dict(g='realty', kw=r'代管|包租|租賃|租屋'),
    # 空氣清淨機
    '空氣清淨機':   dict(g='elec elecw', kw=r'空氣|清淨|淨化|空淨'),
    '家電行':       dict(g='elec', kw=r'電器|家電|電機行|電氣', osm=[('shop', 'electronics'), ('shop', 'appliance')]),
    '家電量販店':   dict(g='elec', kw=r'燦坤|全國電子|順發|大同|量販', osm=[('shop', 'electronics')], okw=r'燦坤|全國電子|順發|大同'),
    '3C 賣場':      dict(g='elec', kw=r'3C|資訊|電腦|通訊', osm=[('shop', 'computer'), ('shop', 'mobile_phone')]),
    '濾網耗材':     dict(g='elec elecw daily', kw=r'濾'),
    '家電維修':     dict(g='elec', kw=r'維修|修理', osm=[('craft', 'electronics_repair')]),
    '電器批發':     dict(g='elecw', kw=r'電器|家電|電機'),
    '冷氣空調':     dict(g='elec elecw', kw=r'冷氣|空調|冷凍|冷暖'),
    '全熱交換器':   dict(g='elec elecw', kw=r'全熱|換氣|通風'),
    '嬰兒用品店':   dict(g='daily', kw=r'嬰|寶寶|婦幼|baby|母嬰', osm=[('shop', 'baby_goods')]),
    '寵物用品店':   dict(g='pet', kw=r'寵物|動物|毛孩|狗|貓|犬|喵|汪|pet', osm=[('shop', 'pet')]),
    '除甲醛・空氣檢測': dict(g='elec daily clean', kw=r'甲醛|空氣|環境檢測'),
    '牙醫診所':     dict(osm=[('amenity', 'dentist')]),
    '美髮店':       dict(g='beauty', kw=r'髮|剪|沙龍|salon|hair|美容院', osm=[('shop', 'hairdresser')]),
    '寵物美容':     dict(g='pet', kw=r'美容|沙龍|salon', osm=[('shop', 'pet_grooming')]),
    '共享辦公室':   dict(osm=[('amenity', 'coworking_space'), ('office', 'coworking')]),
    # 淨水器
    '淨水器':       dict(g='water elec', kw=r'淨水|濾水|水處理|淨化|RO|活水|好水|水質'),
    '飲水機':       dict(g='water elec', kw=r'飲水'),
    'RO 逆滲透':    dict(g='water elec', kw=r'RO|逆滲透'),
    '淨水設備':     dict(g='waterw', kw=r'淨水|水處理|過濾|濾水'),
    '濾心耗材':     dict(g='water waterw', kw=r'濾'),
    '水電材料行':   dict(g='water waterw hw', kw=r'水電|水器|衛浴|管材'),
    '水處理設備':   dict(g='waterw', kw=r'水處理|淨水|環保'),
    '水電行':       dict(g='hw water elec', kw=r'水電', osm=[('craft', 'plumber'), ('craft', 'electrician')]),
    '廚具行':       dict(g='furn kitchen', kw=r'廚具|廚房|廚衛|廚藝', osm=[('shop', 'kitchen')]),
    '熱水器':       dict(g='elec water', kw=r'熱水器|瓦斯|熱水'),
    '水塔清洗':     dict(g='clean', kw=r'水塔|水池|清洗'),
    '飲料店':       dict(g='drink', kw=r'茶|飲|咖啡|果汁|冰|奶|tea|Tea', osm=[('shop', 'beverages')]),
    '早餐店':       dict(g='rest drink', kw=r'早餐|早午餐|晨'),
    '健身房':       dict(osm=[('leisure', 'fitness_centre')]),
    # 蛋白粉
    '運動營養品':   dict(g='food', kw=r'營養|乳清|蛋白|健身|補給', osm=[('shop', 'nutrition_supplements')]),
    '保健食品店':   dict(g='food', kw=r'保健|營養|健康|生技|生物科技', osm=[('shop', 'nutrition_supplements')]),
    '藥局':         dict(g='drug', kw=r'藥局|藥房|藥師|藥品', osm=[('amenity', 'pharmacy')]),
    '藥妝店':       dict(g='drug daily', kw=r'藥妝|美妝|屈臣氏|康是美|寶雅', osm=[('shop', 'chemist')]),
    '有機食品店':   dict(g='food', kw=r'有機|天然', osm=[('shop', 'health_food'), ('shop', 'organic')]),
    '食品原料行':   dict(g='foodw', kw=r'原料|材料|烘焙'),
    '保健食品代工': dict(g='foodw', kw=r'生技|生物科技|代工'),
    '營養品批發':   dict(g='foodw', kw=r'營養|保健|生技'),
    '健身工作室':   dict(osm=[('leisure', 'fitness_centre')], okw=r'工作室|教練|studio|Studio|STUDIO'),
    '運動用品店':   dict(osm=[('shop', 'sports')]),
    '物理治療':     dict(osm=[('healthcare', 'physiotherapist')]),
    '瑜伽教室':     dict(osm=[('sport', 'yoga'), ('name', None)], okw=r'瑜伽|瑜珈|yoga|Yoga|YOGA'),
    '拳擊館':       dict(osm=[('sport', 'boxing'), ('name', None)], okw=r'拳擊|拳館|boxing|Boxing|泰拳'),
    '運動中心':     dict(osm=[('leisure', 'sports_centre')]),
    '瘦身美容':     dict(g='slim', kw=r'美容|瘦身|美體|SPA|塑身|美學|美妍|纖|沙龍'),
}


def norm(s):
    return unicodedata.normalize('NFKC', s or '').replace('台', '臺').strip()


def parse_addr(addr):
    a = norm(addr)
    for old, new in OLD_NAMES.items():
        if a.startswith(old):
            a = new + a[len(old):]
    a = re.sub(r'^\d{3,6}', '', a)
    c = next((x for x in COUNTIES if a.startswith(x)), '')
    d = ''
    if c:
        rest = a[len(c):]
        m = re.match(r'(.{1,3}?區)', rest) if c.endswith('市') else re.match(r'(.{1,3}?(?:鄉|鎮|市))', rest)
        d = m.group(1) if m else ''
    return c, d, a


def fetch(url, data=None, tries=5, timeout=300, headers=UA):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as r:
                return r.read()
        except OSError as e:
            if i == tries - 1:
                raise
            print('  重試', url[:80], e, flush=True)
            time.sleep(15 * (i + 1))


# ---------- 下載 ----------

def download_files():
    for key, items in FILES.items():
        for oid, kind in items:
            path = os.path.join(RAW, f'{key}-{oid[:8]}.csv')
            for attempt in range(4):
                body = fetch('https://data.gcis.nat.gov.tw/od/file?oid=' + oid)
                if not body.lstrip(b'\xef\xbb\xbf').startswith(b'<'):
                    break
                print('  經濟部主機忙碌，稍後重試', key, flush=True)
                time.sleep(30)
            else:
                print('  ！下載失敗，沿用舊檔', key, oid, flush=True)
                continue
            open(path, 'wb').write(body)
            print('  檔案', key, kind, len(body) // 1024, 'KB', flush=True)


def download_api():
    for key, code in API_CODES.items():
        rows, skip = [], 0
        while skip <= 500000:
            q = urllib.parse.urlencode({'$format': 'json', '$filter': f'Business_Item eq {code}', '$skip': skip, '$top': 1000})
            body = fetch(API + '?' + q).decode('utf-8', 'ignore').strip()
            if not body.startswith('['):
                break
            page = json.loads(body)
            rows += page
            if len(page) < 1000:
                break
            skip += 1000
        json.dump(rows, open(os.path.join(RAW, f'api-{key}.json'), 'w', encoding='utf-8'), ensure_ascii=False)
        print('  API', key, code, len(rows), '家', flush=True)


def download_osm():
    filters = sorted({(k, v) for spec in INDUSTRIES.values() for k, v in spec.get('osm', []) if v})
    names = sorted({spec['okw'] for spec in INDUSTRIES.values() if ('name', None) in spec.get('osm', [])})
    parts = [f'nwr["{k}"="{v}"](area.a);' for k, v in filters]
    parts += [f'nwr["name"~"{p}"](area.a);' for p in names]
    q = '[out:json][timeout:600];area["ISO3166-1"="TW"][admin_level=2]->.a;(' + ''.join(parts) + ');out center tags;'
    body = fetch('https://overpass-api.de/api/interpreter', data=urllib.parse.urlencode({'data': q}).encode(), timeout=900,
                 headers={'User-Agent': 'product-shop-finder/1.0 (personal project)'})
    open(os.path.join(RAW, 'osm.json'), 'wb').write(body)
    print('  OSM', len(json.loads(body)['elements']), '筆', flush=True)
    if not os.path.exists(os.path.join(RAW, 'towns.json')):
        open(os.path.join(RAW, 'towns.json'), 'wb').write(fetch('https://cdn.jsdelivr.net/npm/taiwan-atlas@2021.9.20/towns-10t.json'))


# ---------- 鄉鎮界線（OSM 店家沒寫地址時用座標判斷）----------

def load_towns():
    t = json.load(open(os.path.join(RAW, 'towns.json'), encoding='utf-8'))
    sx, sy = t['transform']['scale']
    tx, ty = t['transform']['translate']
    arcs = []
    for arc in t['arcs']:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx; y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def ring(idx):
        pts = []
        for i in idx:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts += a if not pts else a[1:]
        return pts
    towns = []
    for g in t['objects']['towns']['geometries']:
        polys = [g['arcs']] if g['type'] == 'Polygon' else g['arcs']
        rings = [ring(r) for p in polys for r in p]
        xs = [p[0] for r in rings for p in r]; ys = [p[1] for r in rings for p in r]
        pr = g['properties']
        towns.append((norm(pr['COUNTYNAME']), norm(pr['TOWNNAME']), rings, (min(xs), min(ys), max(xs), max(ys))))
    return towns


def locate(towns, lon, lat):
    for c, d, rings, (x0, y0, x1, y1) in towns:
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        inside = False
        for r in rings:
            j = len(r) - 1
            for i in range(len(r)):
                xi, yi = r[i]; xj, yj = r[j]
                if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                    inside = not inside
                j = i
        if inside:
            return c, d
    return '', ''


# ---------- 讀資料 ----------

def load_gov():
    src = {}
    for key, items in FILES.items():
        rows = {}
        for oid, kind in items:
            path = os.path.join(RAW, f'{key}-{oid[:8]}.csv')
            if not os.path.exists(path):
                continue
            for x in csv.DictReader(open(path, encoding='utf-8-sig', errors='ignore')):
                name = x.get('公司名稱') or x.get('商業名稱')
                addr = x.get('公司地址') or x.get('商業地址')
                status = x.get('公司狀態') or x.get('登記狀態')
                if not name or status != '核准設立':
                    continue
                rows[kind + x['統一編號']] = (norm(name), addr, 0 if kind == 'c' else 1)
        src[key] = rows
    for key in API_CODES:
        path = os.path.join(RAW, f'api-{key}.json')
        data = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else []
        src[key] = {'c' + x['Business_Accounting_NO']: (norm(x['Company_Name']), x['Company_Location'], 0) for x in data}
    if os.path.exists(INTERIOR):
        d = json.load(open(INTERIOR, encoding='utf-8'))
        src['interior'] = {('s' if r[4] & 1 else 'c') + r[0]: (r[1], r[3], r[4] & 1) for r in d['rows']}
    return src


def phone_of(tags):
    p = tags.get('phone') or tags.get('contact:phone') or tags.get('contact:mobile') or ''
    p = p.split(';')[0].strip()
    m = re.match(r'^\+?886[\s-]*\(?0?(\d+)\)?[\s-]*(.*)$', p)
    if m:
        p = '0' + m.group(1) + ' ' + m.group(2)
    return re.sub(r'\s+', ' ', p).strip()


def load_osm(towns):
    path = os.path.join(RAW, 'osm.json')
    if not os.path.exists(path):
        return []
    out = []
    for e in json.load(open(path, encoding='utf-8'))['elements']:
        t = e.get('tags', {})
        name = norm(t.get('name:zh') or t.get('name') or '')
        if not name:
            continue
        lat = e.get('lat') or e.get('center', {}).get('lat')
        lon = e.get('lon') or e.get('center', {}).get('lon')
        if lat is None:
            continue
        addr = t.get('addr:full') or ''.join(t.get(k, '') for k in ('addr:city', 'addr:district', 'addr:street', 'addr:housenumber'))
        c, d, a = parse_addr(addr)
        if not c or not d:
            c2, d2 = locate(towns, lon, lat)
            c, d = c or c2, d or d2
        if c not in COUNTIES:
            continue
        if addr and not a.startswith(c):
            a = c + d + a
        out.append(dict(id=e['type'][0] + str(e['id']), name=name, county=c, dist=d, addr=a if addr else '',
                        phone=phone_of(t), lat=round(lat, 5), lon=round(lon, 5), tags=t))
    return out


# ---------- 整理 ----------

def main():
    os.makedirs(RAW, exist_ok=True)
    if '--osm-only' in sys.argv:
        print('下載 OSM…', flush=True); download_osm()
    elif '--no-download' not in sys.argv:
        print('下載經濟部檔案…', flush=True); download_files()
        print('查詢經濟部 API…', flush=True); download_api()
        print('下載 OSM…', flush=True); download_osm()
    towns = load_towns()
    gov = load_gov()
    osm = load_osm(towns)
    print('OSM 有名稱的店家', len(osm), flush=True)

    os.makedirs(OUT, exist_ok=True)
    old = os.path.join(OUT, 'manifest.json')
    old_total = sum(e['n'] for e in json.load(open(old, encoding='utf-8'))['industries'].values()) if os.path.exists(old) else 0
    if old_total and len(osm) < 30000:
        sys.exit(f'OSM 只有 {len(osm)} 筆，可能下載不完整，保留舊資料')
    for f in os.listdir(OUT):
        if f.endswith('.json'):
            os.remove(os.path.join(OUT, f))
    manifest = {'updated': datetime.date.today().isoformat(), 'counties': COUNTIES, 'industries': {}}
    for i, (name, spec) in enumerate(INDUSTRIES.items()):
        kw = re.compile(spec['kw'], re.I) if spec.get('kw') else None
        rows, seen = [], set()
        for key in (spec.get('g') or '').split():
            for k, (n, addr, src) in gov.get(key, {}).items():
                if k in seen or (kw and not kw.search(n)):
                    continue
                c, d, a = parse_addr(addr)
                if c not in COUNTIES:
                    continue
                seen.add(k)
                rows.append([n, COUNTIES.index(c), d, a, '', src, k])
        okw = re.compile(spec['okw']) if spec.get('okw') else None
        filt = spec.get('osm', [])
        for e in osm:
            if e['id'] in seen:
                continue
            hit = any((v is None and okw and okw.search(e['name'])) or (v and e['tags'].get(k) == v) for k, v in filt)
            if not hit or (okw and not okw.search(e['name'])):
                continue
            seen.add(e['id'])
            rows.append([e['name'], COUNTIES.index(e['county']), e['dist'], e['addr'], e['phone'], 2, e['id'], e['lat'], e['lon']])
        # 每列：[名稱, 縣市索引, 行政區, 地址, 電話, 來源(0公司/1商號/2OSM), 代號(c/s+統編 或 OSM n/w/r+id), 緯度, 經度]
        # 有電話的排前面，再依縣市、行政區、地址
        rows.sort(key=lambda r: (r[1], r[2], r[4] == '', r[3] == '', r[3], r[0]))
        fid = f'i{i}'
        body = json.dumps(rows, ensure_ascii=False, separators=(',', ':'))
        if len(body.encode()) > SHARD:
            parts = {}
            for ci in sorted({r[1] for r in rows}):
                sub = [r for r in rows if r[1] == ci]
                json.dump(sub, open(os.path.join(OUT, f'{fid}-{ci}.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
                parts[ci] = len(sub)
            entry = {'id': fid, 'n': len(rows), 'split': parts}
        elif rows:
            open(os.path.join(OUT, fid + '.json'), 'w', encoding='utf-8').write(body)
            entry = {'id': fid, 'n': len(rows)}
        else:
            entry = {'id': fid, 'n': 0}
        entry['osm'] = sum(1 for r in rows if r[5] == 2)
        entry['c'] = {ci: sum(1 for r in rows if r[1] == ci) for ci in sorted({r[1] for r in rows})}
        manifest['industries'][name] = entry
        print(f'  {name}: {len(rows)} 家（OSM {entry["osm"]}）', flush=True)
    total = sum(e['n'] for e in manifest['industries'].values())
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(json.dumps({'industries': len(INDUSTRIES), 'shops': total, 'old': old_total, 'files': len(os.listdir(OUT)), 'MB': round(size / 1e6, 1)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
