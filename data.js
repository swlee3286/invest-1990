// ===== 게임 설정 (수수료·세금·월급·대출 등은 여기서만 조정) =====
const SETTINGS = {
  startYear: 1990,
  startMonth: 1,
  endYear: 2026,
  endMonth: 10,

  // 비용 (6단계)
  fees: { stock: 0.00015, bond: 0.0005, gold: 0.01, coin: 0.0005, property: 0.005 },
  stockSellTax: 0.003,      // 주식 매도 거래세
  interestTax: 0.154,       // 예금·채권 이자소득세
  propertyBuyTax: 0.02,     // 부동산 취득세
  propertyGainTax: 0.2,     // 부동산 양도차익세
  coinGainTax: 0,           // 코인 과세 (현재 비과세)

  capitalOptions: [5_000_000, 10_000_000, 50_000_000],
  defaultAge: 25,
  retireAge: 60,

  // 직업별 1990년 월급 (원) — 매년 1월 물가상승률 + 승진 가산만큼 인상
  jobs: {
    office: { name: "회사원", salary: 700_000, promo: 0.02, vol: 0.05 },
    civil: { name: "공무원", salary: 550_000, promo: 0.015, vol: 0 },
    self: { name: "자영업", salary: 750_000, promo: 0.01, vol: 0.4 },
  },
  livingCost: 350_000,      // 1990년 월 생활비, 물가지수에 맞춰 증가

  // 대출
  creditLimitYears: 1.5,    // 신용대출 한도 = 연봉 × 1.5
  creditSpread: 4,          // 신용대출 금리 = 예금 금리 + 4%p
  mortgageSpread: 2,        // 주택담보대출 금리 = 예금 금리 + 2%p
  ltv: [["1990-01", 0.6], ["2003-10", 0.5], ["2017-08", 0.4], ["2023-01", 0.5]],

  bondDuration: 2.7,        // 국고채 3년물 펀드 듀레이션 (금리 1%p 상승 → 약 2.7% 하락)
  rentYield: 0.003,         // 아파트 월세 수익률 (월, 가격 대비)

  titles: [                 // 순자산 기준 (1990년 금액, 물가에 맞춰 함께 오름)
    { name: "신용불량", max: 0 },
    { name: "서민", max: 100_000_000 },
    { name: "중산층", max: 500_000_000 },
    { name: "자산가", max: 3_000_000_000 },
    { name: "부자", max: 10_000_000_000 },
    { name: "재벌", max: Infinity },
  ],
};

// ===== 부동산 =====
// 가격 = 1990년 기준가 × (전국 주택가격지수 변화)^beta × e^(drift × 경과 연수) × 개발 이벤트
const REGIONS = [
  { id: "gangnam", name: "서울 강남", base: 130_000_000, beta: 1.5, drift: 0.045, unlock: "1990-01" },
  { id: "gangbuk", name: "서울 강북", base: 80_000_000, beta: 1.1, drift: 0.012, unlock: "1990-01" },
  { id: "newtown", name: "1기 신도시(분당 등)", base: 90_000_000, beta: 1.2, drift: 0.018, unlock: "1991-09" },
  { id: "incheon", name: "인천", base: 50_000_000, beta: 1.0, drift: 0.005, unlock: "1990-01" },
  { id: "metro", name: "지방 광역시", base: 45_000_000, beta: 0.8, drift: 0, unlock: "1990-01" },
];
const PROPERTY_TYPES = [
  { id: "small", name: "소형 아파트", coef: 0.55, rent: true },
  { id: "mid", name: "중형 아파트", coef: 1, rent: true },
  { id: "large", name: "대형 아파트", coef: 1.7, rent: true },
  { id: "land", name: "토지", coef: 0.8, rent: false },
];
// 토지 개발 이벤트: 해당 달부터 그 지역 토지 가격에 배수 적용
const LAND_EVENTS = [
  { ym: "2001-03", region: "incheon", mult: 1.3, text: "인천국제공항 개항, 인천 토지 급등" },
  { ym: "2003-11", region: "gangbuk", mult: 1.2, text: "서울 강북 뉴타운 지정, 강북 토지 상승" },
  { ym: "2005-06", region: "metro", mult: 1.25, text: "공공기관 지방 이전·혁신도시 발표, 지방 토지 상승" },
  { ym: "2018-12", region: "newtown", mult: 1.2, text: "3기 신도시·GTX 계획 발표, 수도권 신도시 토지 상승" },
];

// ===== 뉴스 (월 → 기사). 가격은 실제 데이터를 따르므로 뉴스는 배경 설명 역할 =====
const NEWS = {
  "1990-01": "민정·민주·공화 3당 합당 발표",
  "1990-05": "증시 부양 위해 증시안정기금 설립",
  "1990-08": "이라크, 쿠웨이트 침공 · 국제 유가 급등",
  "1990-10": "동서독 통일",
  "1991-01": "걸프전 발발",
  "1991-09": "1기 신도시 분당 첫 입주 · 남북한 UN 동시 가입 (신도시 매물 해금)",
  "1991-12": "소련 해체",
  "1992-01": "증시 개방, 외국인 주식 직접투자 허용",
  "1992-08": "한중 수교",
  "1993-08": "긴급명령으로 금융실명제 전격 실시",
  "1995-01": "세계무역기구(WTO) 출범",
  "1995-07": "부동산실명제 시행",
  "1996-07": "코스닥 시장 개설",
  "1996-12": "한국, OECD 29번째 회원국으로 가입",
  "1997-01": "한보철강 부도, 재벌 연쇄 부도 우려",
  "1997-07": "태국 바트화 폭락, 아시아 외환위기 시작 · 기아그룹 부도유예",
  "1997-11": "정부, IMF에 구제금융 공식 요청",
  "1997-12": "환율·금리 폭등, 대출 이자 부담 급증",
  "1998-01": "전국에서 '금 모으기 운동' 확산",
  "1998-06": "부실 은행 5곳 퇴출 발표",
  "1999-07": "대우그룹 유동성 위기",
  "1999-12": "벤처·코스닥 열풍 절정",
  "2000-03": "미국 나스닥 정점 후 급락, IT 버블 붕괴 시작",
  "2000-06": "남북정상회담 개최",
  "2001-08": "IMF 구제금융 차입금 조기 상환 완료",
  "2001-09": "미국 9·11 테러, 세계 증시 급락",
  "2002-06": "한일 월드컵 개최, 한국 4강 진출",
  "2003-03": "신용카드 대란 · 미국 이라크 침공",
  "2003-10": "10·29 부동산 대책: 주택담보대출 LTV 50%로 강화",
  "2004-04": "KTX 개통",
  "2005-08": "8·31 부동산 대책 발표",
  "2008-09": "리먼 브라더스 파산, 글로벌 금융위기",
  "2013-04": "국내 첫 비트코인 거래소(코빗) 개설 · 코인 탭 해금",
  "2010-11": "G20 서울 정상회의 개최",
  "2011-08": "미국 국가신용등급 강등, 세계 증시 급락",
  "2016-06": "영국, 국민투표로 EU 탈퇴(브렉시트) 결정",
  "2017-08": "8·2 부동산 대책: 주택담보대출 LTV 40%로 강화",
  "2017-12": "가상화폐 투자 열풍, 비트코인 급등",
  "2018-01": "정부, 가상화폐 거래 실명제 등 규제 발표",
  "2020-03": "코로나19 세계적 대유행, 증시 폭락",
  "2021-01": "동학개미 열풍, 코스피 3,000 돌파",
  "2021-11": "대출 규제(DSR) 강화: 신용대출 한도 연봉 수준으로 축소",
  "2022-05": "테라·루나 폭락, 코인 시장 급랭",
  "2022-06": "미국 연준 '자이언트 스텝' 금리 인상, 채권·부동산 하락",
  "2022-10": "레고랜드 사태, 채권시장 경색",
  "2023-01": "부동산 규제지역 대거 해제, LTV 50%로 완화",
  "2024-03": "비트코인 현물 ETF 효과로 비트코인 1억 원 돌파",
  "2024-12": "비상계엄 선포·해제, 금융시장 출렁",
};
// 신용대출 한도 규제 (연봉 배수)
const CREDIT_LIMIT_RULES = [["1990-01", 1.5], ["2021-11", 1.0]];

// ===== 월별 데이터 정리 =====
function ymKey(y, m) { return `${y}-${String(m).padStart(2, "0")}`; }
function ymIndex(key) {
  const [y, m] = key.split("-").map(Number);
  return (y - SETTINGS.startYear) * 12 + (m - SETTINGS.startMonth);
}

const TOTAL_TURNS =
  (SETTINGS.endYear - SETTINGS.startYear) * 12 + (SETTINGS.endMonth - SETTINGS.startMonth) + 1;

// {"199001": 값, ...} → 턴별 배열 (시작 전은 null, 빠진 달은 직전 값 유지)
function toSeries(byMonth, round) {
  const out = [];
  let last = null;
  for (let i = 0; i < TOTAL_TURNS; i++) {
    const y = SETTINGS.startYear + Math.floor((SETTINGS.startMonth - 1 + i) / 12);
    const m = ((SETTINGS.startMonth - 1 + i) % 12) + 1;
    const v = byMonth[`${y}${String(m).padStart(2, "0")}`];
    if (v != null) last = round ? Math.max(1, Math.round(v)) : v;
    out.push(last);
  }
  return out;
}

// 날짜 순 규칙표 [["YYYY-MM", 값], ...]에서 t 시점 값
function ruleAt(rules, t) {
  let v = rules[0][1];
  for (const [ym, x] of rules) if (ymIndex(ym) <= t) v = x;
  return v;
}

const MARKET = (() => {
  const D = MARKET_DATA;
  const kospi = toSeries(STOCK_DATA.kospi, false);
  const depositRate = toSeries(D.deposit, false);
  const bondYield = toSeries(D.bond, false);
  const cpi = toSeries(D.cpi, false);
  const usdkrw = toSeries(D.usdkrw, false);
  const house = toSeries(D.house, false);
  const goldUsd = toSeries(D.goldUsd, false);
  const btcUsd = toSeries(D.btcUsd, false);
  const goldGram = goldUsd.map((g, i) => Math.round((g * usdkrw[i]) / 31.1035));
  const btc = btcUsd.map((b, i) => (b == null ? null : Math.round(b * usdkrw[i])));
  // 국고채 3년 펀드 가격 지수 (세후 이자 + 금리 변동에 따른 가격 변화)
  const bondIndex = [10000];
  for (let i = 1; i < TOTAL_TURNS; i++) {
    const carry = (bondYield[i - 1] / 1200) * (1 - SETTINGS.interestTax);
    const priceMove = (-SETTINGS.bondDuration * (bondYield[i] - bondYield[i - 1])) / 100;
    bondIndex.push(bondIndex[i - 1] * (1 + carry + priceMove));
  }
  return { kospi, depositRate, bondYield, cpi, usdkrw, house, goldGram, btc, bondIndex };
})();

// 코인 해금: 국내 거래소가 생긴 2013년 4월 (가격 데이터는 2010년부터 있지만 그때는 국내에서 사기 어려웠음)
const COIN_UNLOCK = Math.max(MARKET.btc.findIndex((v) => v != null), ymIndex("2013-04"));

function propertyPrice(regionId, typeId, t) {
  const r = REGIONS.find((x) => x.id === regionId);
  const ty = PROPERTY_TYPES.find((x) => x.id === typeId);
  let p = r.base * ty.coef * Math.pow(MARKET.house[t] / MARKET.house[0], r.beta) * Math.exp(r.drift * (t / 12));
  if (typeId === "land") {
    for (const e of LAND_EVENTS) if (e.region === regionId && ymIndex(e.ym) <= t) p *= e.mult;
  }
  return Math.round(p / 100_000) * 100_000;
}

// 매매 가능한 주식 목록. 코스피 인덱스는 1좌 = 지수 × 1,000원
const ITEMS = [
  { code: "KOSPI", name: "코스피 인덱스", sector: "지수", series: MARKET.kospi.map((v) => Math.round(v * 1000)) },
  ...STOCK_DATA.stocks.map((s) => ({ code: s.code, name: s.name, sector: s.sector, series: toSeries(s.prices, true) })),
];
const ITEM_BY_CODE = Object.fromEntries(ITEMS.map((it) => [it.code, it]));
