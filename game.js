// ===== 상태 =====
const SAVE_KEY = "invest1990-save";
let state = null;

function newGame(capital, age, job) {
  state = {
    turn: 0,               // 0 = 1990년 1월
    startCapital: capital,
    startAge: age,
    job,
    salary: SETTINGS.jobs[job].salary,   // 기본 월급 (자영업은 매달 이 값 기준으로 변동)
    cash: capital,
    deposit: 0,
    bondUnits: 0, bondCost: 0,           // 국고채 펀드
    goldGrams: 0, goldCost: 0,
    btc: 0, btcCost: 0,
    holdings: {},          // 주식 { 종목코드: { qty, cost } }
    properties: [],        // 부동산 [{ id, region, type, cost, turn }]
    creditLoan: 0,
    mortgage: 0,
    sel: "KOSPI",          // 주식 탭에서 선택한 종목
    region: "gangnam",     // 땅 탭에서 선택한 지역
    history: [],           // 매 턴 순자산
    news: [],
    lastFlow: null,        // 지난달 현금 흐름
    nextPropId: 1,
    rng: (Math.random() * 2 ** 31) | 0,
    tab: "mine",
    ended: false,
    bankrupt: false,
  };
  recordTurn();
  save();
  render();
}

// ===== 계산 =====
const T = () => state.turn;
const priceOf = (code, t = T()) => ITEM_BY_CODE[code].series[t];
const changeOf = (series, t = T()) => {
  const prev = t > 0 ? series[t - 1] : null;
  return prev ? series[t] / prev - 1 : 0;
};
const listedItems = () => ITEMS.filter((it) => it.series[T()] != null);
const stockValue = () =>
  Object.entries(state.holdings).reduce((sum, [code, h]) => sum + h.qty * priceOf(code), 0);
const bondValue = () => state.bondUnits * MARKET.bondIndex[T()];
const goldValue = () => state.goldGrams * MARKET.goldGram[T()];
const coinValue = () => (state.btc ? state.btc * MARKET.btc[T()] : 0);
const propValue = (p, t = T()) => propertyPrice(p.region, p.type, t);
const propertyValue = () => state.properties.reduce((s, p) => s + propValue(p), 0);
const totalAssets = () =>
  state.cash + state.deposit + stockValue() + bondValue() + goldValue() + coinValue() + propertyValue();
const debt = () => state.creditLoan + state.mortgage;
const netWorth = () => totalAssets() - debt();

const dateOf = (t) => {
  const i = SETTINGS.startMonth - 1 + t;
  return { y: SETTINGS.startYear + Math.floor(i / 12), m: (i % 12) + 1 };
};
const ageOf = (t) => state.startAge + Math.floor((SETTINGS.startMonth - 1 + t) / 12);
const retired = (t = T()) => ageOf(t) >= SETTINGS.retireAge;
const cpiRatio = (t = T()) => MARKET.cpi[t] / MARKET.cpi[0];
const titleOf = (nw, t = T()) => SETTINGS.titles.find((x) => nw < x.max * cpiRatio(t))?.name ?? "재벌";
const depositRate = (t = T()) => MARKET.depositRate[t];
const creditRate = () => depositRate() + SETTINGS.creditSpread;
const mortgageRate = () => depositRate() + SETTINGS.mortgageSpread;
const creditLimit = () => (retired() ? 0 : state.salary * 12 * ruleAt(CREDIT_LIMIT_RULES, T()));
const mortgageLimit = () => propertyValue() * ruleAt(SETTINGS.ltv, T());
const livingCost = (t = T()) => Math.round(SETTINGS.livingCost * cpiRatio(t));
const coinUnlocked = () => COIN_UNLOCK >= 0 && T() >= COIN_UNLOCK;
const regionUnlocked = (r) => T() >= ymIndex(r.unlock);

function won(n) {
  const sign = n < 0 ? "-" : "";
  n = Math.round(Math.abs(n));
  const jo = Math.floor(n / 1e12), eok = Math.floor((n % 1e12) / 1e8), man = Math.floor((n % 1e8) / 1e4);
  if (jo) return `${sign}${jo.toLocaleString()}조${eok ? " " + eok.toLocaleString() + "억" : ""} 원`;
  if (eok) return `${sign}${eok.toLocaleString()}억${man ? " " + man.toLocaleString() + "만" : ""} 원`;
  if (man) return `${sign}${man.toLocaleString()}만 원`;
  return `${sign}${n.toLocaleString()} 원`;
}
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");

// 시드 고정 난수 (저장/불러오기 후에도 이어짐)
function rand() {
  let x = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

// ===== 턴 진행 =====
function addNews(text, t = T()) { state.news.unshift({ turn: t, text }); }

function recordTurn() {
  const t = T();
  state.history[t] = netWorth();
  const { y, m } = dateOf(t);
  const key = ymKey(y, m);
  if (NEWS[key]) addNews(NEWS[key]);
  for (const e of LAND_EVENTS) if (e.ym === key) addNews(e.text);
  if (t > 0) {
    ITEMS.filter((it) => it.series[t] != null && it.series[t - 1] == null)
      .forEach((it) => addNews(`${it.name} 신규 상장 (${it.sector}) · 첫 달 종가 ${won(it.series[t])}`));
    // 시장 데이터에서 자동으로 만드는 속보
    const k = MARKET.kospi, kc = changeOf(k, t);
    for (const lvl of [1000, 2000, 4000, 5000]) {
      if (k[t] >= lvl && Math.max(...k.slice(0, t)) < lvl) addNews(`코스피 사상 처음 ${lvl.toLocaleString()} 돌파`);
    }
    if (kc <= -0.15) addNews(`코스피 한 달 새 ${pct(kc)} 폭락`);
    if (Math.abs(changeOf(MARKET.usdkrw, t)) >= 0.1) addNews(`원/달러 환율 ${pct(changeOf(MARKET.usdkrw, t))} 급변, ${Math.round(MARKET.usdkrw[t]).toLocaleString()}원`);
    if (ageOf(t) === SETTINGS.retireAge && ageOf(t - 1) < SETTINGS.retireAge) addNews(`${SETTINGS.retireAge}세 은퇴 · 이제 월급이 없습니다`);
  }
}

function nextMonth() {
  if (state.ended) return;
  if (T() >= TOTAL_TURNS - 1) { endGame(); return; }
  const t = T();
  const flow = { salary: 0, living: 0, interestIn: 0, rent: 0, loanInterest: 0, autoLoan: 0, autoSold: [] };

  // 1) 월급 (자영업은 매달 변동)
  if (!retired(t)) {
    const job = SETTINGS.jobs[state.job];
    flow.salary = Math.round(state.salary * Math.max(0, 1 + job.vol * (rand() + rand() - 1) * 1.7));
  }
  // 2) 생활비
  flow.living = livingCost(t);
  // 3) 예금 이자 (세후, 예금에 복리로 붙음)
  flow.interestIn = state.deposit * (depositRate(t) / 1200) * (1 - SETTINGS.interestTax);
  state.deposit += flow.interestIn;
  // 4) 월세 수입
  flow.rent = state.properties.reduce((s, p) =>
    s + (PROPERTY_TYPES.find((x) => x.id === p.type).rent ? propValue(p, t) * SETTINGS.rentYield : 0), 0);
  // 5) 대출 이자
  flow.loanInterest = state.creditLoan * (creditRate() / 1200) + state.mortgage * (mortgageRate() / 1200);

  state.cash += flow.salary + flow.rent - flow.living - flow.loanInterest;

  state.turn++;
  // 매년 1월 월급 인상: 물가상승률 + 승진 가산
  if (dateOf(T()).m === 1 && T() >= 12) {
    const inflation = MARKET.cpi[T()] / MARKET.cpi[T() - 12] - 1;
    state.salary = Math.round(state.salary * (1 + inflation + SETTINGS.jobs[state.job].promo));
  }

  // 6) 현금이 모자라면: 자동 신용대출 → 자산 자동 매각 → 그래도 안 되면 파산
  if (state.cash < 0) coverShortfall(flow);
  state.lastFlow = flow;
  recordTurn();
  if (state.cash < 0) { bankrupt(); return; }
  save();
  render();
}

function coverShortfall(flow) {
  const room = Math.max(0, creditLimit() - state.creditLoan);
  const borrow = Math.min(room, -state.cash);
  if (borrow > 0) {
    state.creditLoan += borrow; state.cash += borrow; flow.autoLoan = borrow;
    addNews(`현금 부족으로 신용대출 ${won(borrow)} 자동 실행`);
  }
  const steps = [
    ["예금", () => state.deposit, (a) => { state.deposit -= a; state.cash += a; }],
    ["채권", bondValue, (a) => sellBond(a, true)],
    ["금", goldValue, (a) => sellGold(Math.ceil(a / MARKET.goldGram[T()]), true)],
    ["코인", coinValue, (a) => sellCoin(a, true)],
    ["주식", stockValue, () => {
      for (const code of Object.keys(state.holdings)) {
        if (state.cash >= 0) break;
        sellStock(code, state.holdings[code].qty, true);
      }
    }],
  ];
  for (const [name, value, sell] of steps) {
    if (state.cash >= 0) break;
    const v = value();
    if (v <= 0) continue;
    sell(Math.min(v, -state.cash));
    flow.autoSold.push(name);
    addNews(`현금 부족으로 ${name} 자동 처분`);
  }
  // 마지막 수단: 부동산 (가장 싼 것부터)
  while (state.cash < 0 && state.properties.length) {
    const p = [...state.properties].sort((a, b) => propValue(a) - propValue(b))[0];
    sellProperty(p.id, true);
    flow.autoSold.push("부동산");
    addNews(`현금 부족으로 부동산 강제 매각`);
  }
}

// ===== 매매 =====
function parseAmount(id) {
  const v = Number(String(document.getElementById(id).value).replace(/[^\d.]/g, ""));
  return Number.isFinite(v) ? v : 0;
}
function setMsg(text, ok = true) {
  const el = document.getElementById("msg");
  if (el) { el.textContent = text; el.className = "msg " + (ok ? "" : "up"); }
}
function afterTrade(text) {
  state.history[T()] = netWorth();
  save();
  render();
  setMsg(text);
}

// 주식
const maxBuyQty = (code) => Math.floor(Math.max(0, state.cash) / (priceOf(code) * (1 + SETTINGS.fees.stock)));
function buyStock(code, qty) {
  if (!(qty > 0) || qty % 1) return setMsg("수량(정수)을 입력하세요.", false);
  const cost = qty * priceOf(code) * (1 + SETTINGS.fees.stock);
  if (cost > state.cash) return setMsg(`현금이 부족합니다. (최대 ${maxBuyQty(code).toLocaleString()}주)`, false);
  const h = (state.holdings[code] ??= { qty: 0, cost: 0 });
  state.cash -= cost; h.qty += qty; h.cost += cost;
  afterTrade(`${ITEM_BY_CODE[code].name} ${qty.toLocaleString()}주 매수 (수수료 포함 ${won(cost)})`);
}
function sellStock(code, qty, auto = false) {
  const h = state.holdings[code];
  if (!(qty > 0) || qty % 1) return setMsg("수량(정수)을 입력하세요.", false);
  if (!h || qty > h.qty) return setMsg(`보유 수량보다 많습니다. (보유 ${(h?.qty ?? 0).toLocaleString()}주)`, false);
  const gross = qty * priceOf(code);
  const net = gross * (1 - SETTINGS.fees.stock - SETTINGS.stockSellTax);
  h.cost -= h.cost * (qty / h.qty); h.qty -= qty;
  if (h.qty === 0) delete state.holdings[code];
  state.cash += net;
  if (auto) return net;
  afterTrade(`${ITEM_BY_CODE[code].name} ${qty.toLocaleString()}주 매도 (수수료·세금 뺀 ${won(net)})`);
}

// 예금
function depositIn(a) {
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  if (a > state.cash) return setMsg("현금이 부족합니다.", false);
  state.cash -= a; state.deposit += a;
  afterTrade(`${won(a)} 예금`);
}
function depositOut(a) {
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  if (a > state.deposit + 1) return setMsg("예금 잔액보다 많습니다.", false);
  a = Math.min(a, state.deposit);
  state.deposit -= a; state.cash += a;
  afterTrade(`${won(a)} 인출`);
}

// 대출
function borrow(kind, a) {
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  const room = kind === "credit" ? creditLimit() - state.creditLoan : mortgageLimit() - state.mortgage;
  if (a > room + 1) return setMsg(`한도를 넘습니다. (남은 한도 ${won(Math.max(0, room))})`, false);
  if (kind === "credit") state.creditLoan += a; else state.mortgage += a;
  state.cash += a;
  afterTrade(`${kind === "credit" ? "신용대출" : "주택담보대출"} ${won(a)} 실행`);
}
function repay(kind, a) {
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  const bal = kind === "credit" ? state.creditLoan : state.mortgage;
  a = Math.min(a, bal);
  if (a > state.cash) return setMsg("현금이 부족합니다.", false);
  if (kind === "credit") state.creditLoan -= a; else state.mortgage -= a;
  state.cash -= a;
  afterTrade(`${won(a)} 상환`);
}

// 채권 (국고채 3년 펀드, 금액 단위)
function buyBond(a) {
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  const cost = a * (1 + SETTINGS.fees.bond);
  if (cost > state.cash) return setMsg("현금이 부족합니다.", false);
  state.cash -= cost; state.bondUnits += a / MARKET.bondIndex[T()]; state.bondCost += cost;
  afterTrade(`채권 ${won(a)} 매수`);
}
function sellBond(a, auto = false) {
  const v = bondValue();
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  if (a > v + 1) return setMsg("보유 평가액보다 많습니다.", false);
  a = Math.min(a, v);
  const r = a / v;
  state.bondUnits -= state.bondUnits * r; state.bondCost -= state.bondCost * r;
  if (state.bondUnits * MARKET.bondIndex[T()] < 1) { state.bondUnits = 0; state.bondCost = 0; }
  const net = a * (1 - SETTINGS.fees.bond);
  state.cash += net;
  if (auto) return net;
  afterTrade(`채권 ${won(a)} 매도`);
}

// 금 (그램 단위)
function buyGold(g) {
  if (!(g > 0) || g % 1) return setMsg("그램 수(정수)를 입력하세요.", false);
  const cost = g * MARKET.goldGram[T()] * (1 + SETTINGS.fees.gold);
  if (cost > state.cash) return setMsg("현금이 부족합니다.", false);
  state.cash -= cost; state.goldGrams += g; state.goldCost += cost;
  afterTrade(`금 ${g.toLocaleString()}g 매수 (${won(cost)})`);
}
function sellGold(g, auto = false) {
  if (!(g > 0) || g % 1) return setMsg("그램 수(정수)를 입력하세요.", false);
  g = Math.min(g, state.goldGrams);
  if (!g) return setMsg("보유한 금이 없습니다.", false);
  const net = g * MARKET.goldGram[T()] * (1 - SETTINGS.fees.gold);
  state.goldCost -= state.goldCost * (g / state.goldGrams); state.goldGrams -= g;
  state.cash += net;
  if (auto) return net;
  afterTrade(`금 ${g.toLocaleString()}g 매도 (${won(net)})`);
}

// 코인 (금액 단위, 소수점 비트코인)
function buyCoin(a) {
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  const cost = a * (1 + SETTINGS.fees.coin);
  if (cost > state.cash) return setMsg("현금이 부족합니다.", false);
  state.cash -= cost; state.btc += a / MARKET.btc[T()]; state.btcCost += cost;
  afterTrade(`비트코인 ${won(a)} 매수`);
}
function sellCoin(a, auto = false) {
  const v = coinValue();
  if (!(a > 0)) return setMsg("금액을 입력하세요.", false);
  if (a > v + 1) return setMsg("보유 평가액보다 많습니다.", false);
  a = Math.min(a, v);
  const r = a / v, costPart = state.btcCost * r;
  const gain = Math.max(0, a - costPart);
  const net = a * (1 - SETTINGS.fees.coin) - gain * SETTINGS.coinGainTax;
  state.btc -= state.btc * r; state.btcCost -= costPart;
  if (state.btc < 1e-9) { state.btc = 0; state.btcCost = 0; }
  state.cash += net;
  if (auto) return net;
  afterTrade(`비트코인 ${won(a)} 매도`);
}

// 부동산
function buyProperty(region, type) {
  const price = propertyPrice(region, type, T());
  const cost = price * (1 + SETTINGS.propertyBuyTax + SETTINGS.fees.property);
  if (cost > state.cash) return setMsg(`현금이 부족합니다. (취득세·중개수수료 포함 ${won(cost)})`, false);
  state.cash -= cost;
  state.properties.push({ id: state.nextPropId++, region, type, cost, turn: T() });
  const r = REGIONS.find((x) => x.id === region), ty = PROPERTY_TYPES.find((x) => x.id === type);
  afterTrade(`${r.name} ${ty.name} 매수 (${won(cost)})`);
}
function sellProperty(id, auto = false) {
  const p = state.properties.find((x) => x.id === id);
  if (!p) return;
  const price = propValue(p);
  const gain = Math.max(0, price - p.cost);
  const net = price * (1 - SETTINGS.fees.property) - gain * SETTINGS.propertyGainTax;
  state.properties = state.properties.filter((x) => x.id !== id);
  state.cash += net;
  // 담보가 줄면 한도 초과분은 매각 대금으로 먼저 상환
  const over = state.mortgage - mortgageLimit();
  if (over > 0) { state.mortgage -= over; state.cash -= over; }
  if (auto) return net;
  afterTrade(`부동산 매도 (세금·수수료 뺀 ${won(net)}${over > 0 ? `, 담보대출 ${won(over)} 상환` : ""})`);
}

// ===== 저장 / 불러오기 =====
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) { /* 저장 불가 환경 */ }
}
function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return null; }
}
function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* 무시 */ }
}

// ===== 렌더링 =====
const $ = (id) => document.getElementById(id);

function render() {
  const { y, m } = dateOf(T());
  $("s-cash").textContent = won(state.cash);
  $("s-assets").textContent = won(totalAssets());
  $("s-debt").textContent = won(debt());
  $("s-title").textContent = titleOf(netWorth());
  $("t-date").textContent = `${y}년 ${m}월`;
  $("t-age").textContent = `${ageOf(T())}세 · ${SETTINGS.jobs[state.job].name}${retired() ? "(은퇴)" : ""}`;
  $("t-progress").style.width = `${((T() + 1) / TOTAL_TURNS) * 100}%`;
  $("next-btn").textContent = T() >= TOTAL_TURNS - 1 ? "결산 보기 ▶" : "다음 달 ▶";
  $("next-btn").disabled = state.ended;

  const fresh = state.news.filter((n) => n.turn === T());
  $("ticker").innerHTML = fresh.length ? `<b>속보</b>${fresh.map((n) => n.text).join(" · ")}` : "";

  document.querySelectorAll("#tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.tab);
    b.classList.toggle("is-locked", b.dataset.tab === "coin" && !coinUnlocked());
    if (b.dataset.tab === "coin") b.textContent = coinUnlocked() ? "코인" : "코인 🔒";
  });
  renderInfo();
  renderChart();
}

function quickChips(target, base, step = 1) {
  return [0.1, 0.25, 0.5, 1]
    .map((r) => `<button class="chip" data-fill="${target}" data-v="${Math.floor((base * r) / step) * step}">${r === 1 ? "전부" : r * 100 + "%"}</button>`)
    .join("");
}
const row = (label, value, c = "") => `<div class="row"><span>${label}</span><b class="${c}">${value}</b></div>`;
const tradeBox = (placeholder, buyLabel, sellLabel) => `
  <div class="trade">
    <input id="amt" inputmode="numeric" placeholder="${placeholder}">
    <button class="btn-buy" id="buy">${buyLabel}</button>
    <button class="btn-sell" id="sell">${sellLabel}</button>
  </div>`;
const pnlText = (val, cost) => (cost ? `${won(val - cost)} (${pct(val / cost - 1)})` : "-");

function renderInfo() {
  const el = $("info");
  const t = state.tab;
  const views = { stock: viewStock, land: viewLand, coin: viewCoin, bond: viewBond, gold: viewGold, bank: viewBank, news: viewNews, mine: viewMine };
  el.innerHTML = views[t]();
  bindInfo(t);
  el.querySelectorAll("[data-fill]").forEach((b) => {
    b.onclick = () => { $(b.dataset.fill).value = Number(b.dataset.v).toLocaleString(); };
  });
}

function viewStock() {
  const code = state.sel, it = ITEM_BY_CODE[code];
  const p = priceOf(code), chg = changeOf(it.series);
  const h = state.holdings[code];
  const rows = listedItems().map((x) => {
    const c = changeOf(x.series), q = state.holdings[x.code]?.qty;
    return `<tr data-code="${x.code}" class="${x.code === code ? "sel" : ""}">
      <td>${x.name}</td><td class="sector">${x.sector}</td>
      <td class="num">${priceOf(x.code).toLocaleString()}</td>
      <td class="num ${cls(c)}">${pct(c)}</td>
      <td class="num">${q ? q.toLocaleString() + "주" : ""}</td></tr>`;
  }).join("");
  return `
    <div class="split">
      <div>
        <h3>${it.name} <small class="sector">${it.sector}</small></h3>
        ${row("현재가", `${won(p)} (${pct(chg)})`, cls(chg))}
        ${row("보유", h ? `${h.qty.toLocaleString()}주 · 평균 ${won(h.cost / h.qty)}` : "-")}
        ${row("평가액 · 손익", h ? `${won(h.qty * p)} · ${pnlText(h.qty * p, h.cost)}` : "-", h ? cls(h.qty * p - h.cost) : "")}
        ${tradeBox("수량(주)", "매수", "매도")}
        <div class="trade">매수: ${quickChips("amt", maxBuyQty(code))}</div>
        <div class="trade">매도: ${quickChips("amt", h?.qty ?? 0)}</div>
        <div class="msg" id="msg"></div>
        <p class="note">수수료 ${SETTINGS.fees.stock * 100}% · 매도 거래세 ${SETTINGS.stockSellTax * 100}%</p>
      </div>
      <table class="list">
        <thead><tr><th>종목</th><th>업종</th><th class="num">현재가</th><th class="num">전월비</th><th class="num">보유</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function viewLand() {
  const r = REGIONS.find((x) => x.id === state.region);
  const regionChips = REGIONS.map((x) => {
    const open = regionUnlocked(x);
    return `<button class="chip ${x.id === r.id ? "on" : ""}" data-region="${x.id}" ${open ? "" : "disabled"}>${x.name}${open ? "" : " 🔒"}</button>`;
  }).join("");
  const unlocked = regionUnlocked(r);
  const rows = PROPERTY_TYPES.map((ty) => {
    const p = propertyPrice(r.id, ty.id, T());
    const prev = T() >= 12 ? propertyPrice(r.id, ty.id, T() - 12) : null;
    const yoy = prev ? p / prev - 1 : 0;
    return `<tr><td>${ty.name}</td><td class="num">${won(p)}</td><td class="num ${cls(yoy)}">${prev ? pct(yoy) : "-"}</td>
      <td class="num">${ty.rent ? won(p * SETTINGS.rentYield) : "없음"}</td>
      <td class="num"><button class="btn-buy small" data-buyprop="${ty.id}" ${unlocked ? "" : "disabled"}>매수</button></td></tr>`;
  }).join("");
  const mine = state.properties.map((p) => {
    const rr = REGIONS.find((x) => x.id === p.region), ty = PROPERTY_TYPES.find((x) => x.id === p.type);
    const v = propValue(p), d = dateOf(p.turn);
    return `<tr><td>${rr.name} ${ty.name}<br><small class="sector">${d.y}.${String(d.m).padStart(2, "0")} 매수</small></td>
      <td class="num">${won(v)}</td><td class="num ${cls(v - p.cost)}">${pnlText(v, p.cost)}</td>
      <td class="num"><button class="btn-sell small" data-sellprop="${p.id}">매도</button></td></tr>`;
  }).join("");
  return `
    <div class="opts">${regionChips}</div>
    <div class="split">
      <div>
        <h3>${r.name} 매물</h3>
        <table class="list"><thead><tr><th>유형</th><th class="num">가격</th><th class="num">1년 전 대비</th><th class="num">월세</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div class="msg" id="msg"></div>
        <p class="note">취득세 ${SETTINGS.propertyBuyTax * 100}% · 중개수수료 ${SETTINGS.fees.property * 100}% · 양도차익세 ${SETTINGS.propertyGainTax * 100}%. 토지는 월세가 없지만 개발 소식에 급등할 수 있습니다. 담보대출은 은행 탭에서.</p>
      </div>
      <div>
        <h3>내 부동산</h3>
        ${mine ? `<table class="list"><tbody>${mine}</tbody></table>` : `<p class="note">보유한 부동산이 없습니다.</p>`}
      </div>
    </div>`;
}

function viewCoin() {
  if (!coinUnlocked()) {
    const d = dateOf(COIN_UNLOCK);
    return `<div class="locked"><div class="big">🔒</div><p>코인은 ${d.y}년 ${d.m}월에 해금됩니다.</p></div>`;
  }
  const p = MARKET.btc[T()], chg = changeOf(MARKET.btc), v = coinValue();
  return `
    <h3>비트코인 <small class="sector">BTC</small></h3>
    ${row("1 BTC 가격", `${won(p)} (${pct(chg)})`, cls(chg))}
    ${row("보유", state.btc ? `${state.btc.toFixed(6)} BTC` : "-")}
    ${row("평가액 · 손익", state.btc ? `${won(v)} · ${pnlText(v, state.btcCost)}` : "-", cls(v - state.btcCost))}
    ${tradeBox("금액(원)", "매수", "매도")}
    <div class="trade">매수: ${quickChips("amt", Math.max(0, state.cash) / (1 + SETTINGS.fees.coin))}</div>
    <div class="trade">매도: ${quickChips("amt", v)}</div>
    <div class="msg" id="msg"></div>
    <p class="note">수수료 ${SETTINGS.fees.coin * 100}% · 현재 비과세. 가격 = blockchain.info 달러 시세 × 원/달러 환율.</p>`;
}

function viewBond() {
  const y = MARKET.bondYield[T()], v = bondValue();
  const chg = changeOf(MARKET.bondIndex);
  return `
    <h3>국고채 3년 펀드 <small class="sector">금리 ${y.toFixed(2)}%</small></h3>
    ${row("펀드 기준가", `${MARKET.bondIndex[T()].toFixed(1)} (${pct(chg)})`, cls(chg))}
    ${row("평가액 · 손익", state.bondUnits ? `${won(v)} · ${pnlText(v, state.bondCost)}` : "-", cls(v - state.bondCost))}
    ${tradeBox("금액(원)", "매수", "매도")}
    <div class="trade">매수: ${quickChips("amt", Math.max(0, state.cash) / (1 + SETTINGS.fees.bond))}</div>
    <div class="trade">매도: ${quickChips("amt", v)}</div>
    <div class="msg" id="msg"></div>
    <p class="note">매달 국채 금리만큼 이자(세후)가 쌓이고, 금리가 1%p 오르면 약 ${SETTINGS.bondDuration}% 떨어집니다. 만기 없이 굴리는 채권 펀드 방식.</p>`;
}

function viewGold() {
  const p = MARKET.goldGram[T()], chg = changeOf(MARKET.goldGram), v = goldValue();
  const maxG = Math.floor(Math.max(0, state.cash) / (p * (1 + SETTINGS.fees.gold)));
  return `
    <h3>금 <small class="sector">1g 기준</small></h3>
    ${row("1g 가격", `${won(p)} (${pct(chg)})`, cls(chg))}
    ${row("보유", state.goldGrams ? `${state.goldGrams.toLocaleString()}g (${(state.goldGrams / 3.75).toFixed(1)}돈)` : "-")}
    ${row("평가액 · 손익", state.goldGrams ? `${won(v)} · ${pnlText(v, state.goldCost)}` : "-", cls(v - state.goldCost))}
    ${tradeBox("그램(g)", "매수", "매도")}
    <div class="trade">매수: ${quickChips("amt", maxG)}</div>
    <div class="trade">매도: ${quickChips("amt", state.goldGrams)}</div>
    <div class="msg" id="msg"></div>
    <p class="note">매매 수수료 ${SETTINGS.fees.gold * 100}%. 가격 = 국제 금 시세 × 원/달러 환율 (현재 ${Math.round(MARKET.usdkrw[T()]).toLocaleString()}원).</p>`;
}

function viewBank() {
  const rate = depositRate();
  return `
    <div class="split">
      <div>
        <h3>예금 · 연 ${rate.toFixed(2)}%</h3>
        ${row("예금 잔액", won(state.deposit))}
        ${row("이번 달 이자(세후)", won(state.deposit * rate / 1200 * (1 - SETTINGS.interestTax)))}
        ${tradeBox("금액(원)", "예금", "인출")}
        <div class="trade">예금: ${quickChips("amt", Math.max(0, state.cash))}</div>
        <div class="trade">인출: ${quickChips("amt", state.deposit)}</div>
        <div class="msg" id="msg"></div>
      </div>
      <div>
        <h3>대출</h3>
        ${row(`신용대출 · 연 ${creditRate().toFixed(2)}%`, `${won(state.creditLoan)} / 한도 ${won(creditLimit())}`)}
        ${row(`주택담보대출 · 연 ${mortgageRate().toFixed(2)}%`, `${won(state.mortgage)} / 한도 ${won(mortgageLimit())}`)}
        ${row("이번 달 이자", won(state.creditLoan * creditRate() / 1200 + state.mortgage * mortgageRate() / 1200), "up")}
        <div class="trade">
          <input id="loan" inputmode="numeric" placeholder="금액(원)">
          <select id="loan-kind"><option value="credit">신용대출</option><option value="mortgage">주택담보대출</option></select>
          <button class="btn-buy" id="borrow">대출</button>
          <button class="btn-sell" id="repay">상환</button>
        </div>
        <p class="note">신용대출 한도 = 연봉 × ${ruleAt(CREDIT_LIMIT_RULES, T())} (은퇴 후 0) · 담보대출 한도 = 부동산 가치 × LTV ${Math.round(ruleAt(SETTINGS.ltv, T()) * 100)}%. 현금이 모자라면 신용대출이 자동 실행되고, 한도를 넘으면 자산이 자동 매각됩니다.</p>
      </div>
    </div>`;
}

function viewNews() {
  return `<h3>뉴스</h3>` + (state.news.length
    ? state.news.map((n) => { const d = dateOf(n.turn); return `<div class="news-item"><small>${d.y}.${String(d.m).padStart(2, "0")}</small>${n.text}</div>`; }).join("")
    : `<p class="note">아직 뉴스가 없습니다.</p>`);
}

function viewMine() {
  const nw = netWorth(), ret = nw / state.startCapital - 1;
  const me = titleOf(nw);
  let lo = -Infinity;
  const ranks = SETTINGS.titles.map((x) => {
    const mx = x.max * cpiRatio();
    const range = x.max === 0 ? "0원 미만" : x.max === Infinity ? `${won(lo)} 이상` : lo <= 0 ? `${won(mx)} 미만` : `${won(lo)} ~ ${won(mx)}`;
    lo = mx;
    return `<tr class="${x.name === me ? "me" : ""}"><td>${x.name}</td><td class="num">${range}</td></tr>`;
  }).join("");
  const holdings = Object.entries(state.holdings).map(([c, h]) => {
    const v = h.qty * priceOf(c);
    return `<div class="row sub"><span>· ${ITEM_BY_CODE[c].name} ${h.qty.toLocaleString()}주</span><b>${won(v)} <small class="${cls(v - h.cost)}">${pct(v / h.cost - 1)}</small></b></div>`;
  }).join("");
  const f = state.lastFlow;
  const flowNet = f ? f.salary + f.rent - f.living - f.loanInterest : 0;
  return `
    <div class="split">
      <div>
        <h3>내 자산</h3>
        ${row("현금", won(state.cash))}
        ${row("예금", won(state.deposit))}
        ${row("주식", won(stockValue()))}${holdings}
        ${row("채권", won(bondValue()))}
        ${row("금", won(goldValue()))}
        ${row("코인", won(coinValue()))}
        ${row("부동산", `${won(propertyValue())} (${state.properties.length}채)`)}
        ${row("부채", won(debt()), debt() ? "down" : "")}
        ${row("순자산", won(nw))}
        ${row("시작 자금 대비", pct(ret), cls(ret))}
      </div>
      <div>
        <h3>지난달 현금 흐름</h3>
        ${f ? `
          ${row("월급", won(f.salary), "up")}
          ${row("월세 수입", won(f.rent), "up")}
          ${row("생활비", "-" + won(f.living), "down")}
          ${row("대출 이자", "-" + won(f.loanInterest), "down")}
          ${row("합계", won(flowNet), cls(flowNet))}
          ${f.autoLoan ? row("자동 신용대출", won(f.autoLoan), "up") : ""}
          ${f.autoSold.length ? row("자동 매각", f.autoSold.join(", "), "up") : ""}` : `<p class="note">"다음 달"을 누르면 표시됩니다.</p>`}
        <p class="note">현재 기본 월급 ${won(state.salary)} · 생활비 ${won(livingCost())}</p>
        <h3 style="margin-top:14px">사회적 위치 <small class="sector">기준은 물가에 맞춰 오름</small></h3>
        <table class="ranks">${ranks}</table>
        <div class="trade"><button class="chip" id="restart">처음부터 다시 하기</button></div>
      </div>
    </div>`;
}

// 두 번 눌러 확인 (아티팩트 화면에서는 confirm() 창이 뜨지 않음)
function confirmClick(btn, label, action) {
  if (btn.dataset.armed) { action(); return; }
  btn.dataset.armed = "1";
  const old = btn.textContent;
  btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 3000);
}

function bindInfo(t) {
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  const amt = () => parseAmount("amt");
  if (t === "stock") {
    on("buy", () => buyStock(state.sel, amt()));
    on("sell", () => sellStock(state.sel, amt()));
    document.querySelectorAll("tr[data-code]").forEach((tr) => (tr.onclick = () => { state.sel = tr.dataset.code; render(); }));
  } else if (t === "land") {
    document.querySelectorAll("[data-region]").forEach((b) => (b.onclick = () => { state.region = b.dataset.region; render(); }));
    document.querySelectorAll("[data-buyprop]").forEach((b) => (b.onclick = () => buyProperty(state.region, b.dataset.buyprop)));
    document.querySelectorAll("[data-sellprop]").forEach((b) => (b.onclick = () => {
      confirmClick(b, "확인", () => sellProperty(Number(b.dataset.sellprop)));
    }));
  } else if (t === "coin") {
    on("buy", () => buyCoin(amt())); on("sell", () => sellCoin(amt()));
  } else if (t === "bond") {
    on("buy", () => buyBond(amt())); on("sell", () => sellBond(amt()));
  } else if (t === "gold") {
    on("buy", () => buyGold(amt())); on("sell", () => sellGold(amt()));
  } else if (t === "bank") {
    on("buy", () => depositIn(amt())); on("sell", () => depositOut(amt()));
    on("borrow", () => borrow($("loan-kind").value, parseAmount("loan")));
    on("repay", () => repay($("loan-kind").value, parseAmount("loan")));
  } else if (t === "mine") {
    on("restart", () => confirmClick($("restart"), "한 번 더 누르면 지금 게임이 지워집니다", () => { clearSave(); showStart(); }));
  }
}

// ===== 그래프 (미래 데이터는 보여주지 않음) =====
function chartSpec() {
  const n = T() + 1;
  const from = (series) => Math.max(0, series.findIndex((v) => v != null));
  const mk = (title, series, fmt) => { const o = from(series); return { title, data: series.slice(o, n), offset: o, fmt }; };
  const num = (u) => (v) => Math.round(v).toLocaleString() + u;
  switch (state.tab) {
    case "stock": { const it = ITEM_BY_CODE[state.sel]; return mk(`${it.name} 주가`, it.series, num("원")); }
    case "bank": return mk("예금 금리 (연 %)", MARKET.depositRate, (v) => v.toFixed(2) + "%");
    case "bond": return mk("국고채 금리 (연 %)", MARKET.bondYield, (v) => v.toFixed(2) + "%");
    case "gold": return mk("금 1g 가격", MARKET.goldGram, num("원"));
    case "coin": if (coinUnlocked()) return mk("비트코인 가격", MARKET.btc, won); break;
    case "land": {
      const r = REGIONS.find((x) => x.id === state.region);
      const s = MARKET.house.map((_, i) => (i >= ymIndex(r.unlock) ? propertyPrice(r.id, "mid", i) : null));
      return mk(`${r.name} 중형 아파트 가격`, s, won);
    }
  }
  return { title: "내 순자산 추이", data: state.history.slice(0, n), offset: 0, fmt: won };
}

function renderChart() {
  const spec = chartSpec();
  $("chart-title").textContent = spec.title;
  const cv = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const c = (k) => css.getPropertyValue(k).trim();

  const pad = { l: 8, r: 110, t: 10, b: 20 };
  const span = TOTAL_TURNS;   // x축은 전체 기간 고정 → 진행도가 보임
  const d = spec.data;
  if (!d.length) return;
  let min = Math.min(...d), max = Math.max(...d);
  if (min === max) { min = min * 0.9 - 1; max = max * 1.1 + 1; }
  const xa = (i) => pad.l + (i / (span - 1)) * (W - pad.l - pad.r);
  const x = (i) => xa(i + spec.offset);
  const yy = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  ctx.font = "11px sans-serif"; ctx.fillStyle = c("--muted"); ctx.strokeStyle = c("--line"); ctx.lineWidth = 1;
  for (let i = 0; i < span; i += 60) {
    ctx.beginPath(); ctx.moveTo(xa(i), pad.t); ctx.lineTo(xa(i), H - pad.b); ctx.stroke();
    ctx.fillText(String(dateOf(i).y), xa(i) + 2, H - 5);
  }
  if (min < 0 && max > 0) {   // 0 기준선
    ctx.strokeStyle = c("--muted"); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(pad.l, yy(0)); ctx.lineTo(W - pad.r, yy(0)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = c("--accent"); ctx.lineWidth = 2; ctx.lineJoin = "round";
  ctx.beginPath();
  d.forEach((v, i) => (i ? ctx.lineTo(x(i), yy(v)) : ctx.moveTo(x(i), yy(v))));
  ctx.stroke();
  const li = d.length - 1;
  ctx.fillStyle = c("--accent");
  ctx.beginPath(); ctx.arc(x(li), yy(d[li]), 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = c("--ink"); ctx.font = "bold 12px sans-serif";
  ctx.fillText(spec.fmt(d[li]), Math.min(x(li) + 8, W - pad.r + 4), yy(d[li]) + 4);
  ctx.fillStyle = c("--muted"); ctx.font = "11px sans-serif";
  ctx.fillText("최고 " + spec.fmt(max), W - pad.r + 4, pad.t + 10);
  ctx.fillText("최저 " + spec.fmt(min), W - pad.r + 4, H - pad.b);
}

// ===== 시작 / 결산 / 파산 =====
function showStart() {
  let job = "office";
  const saved = loadSave();
  const card = $("modal-card");
  const ages = Array.from({ length: 21 }, (_, i) => 20 + i)
    .map((a) => `<option ${a === SETTINGS.defaultAge ? "selected" : ""}>${a}</option>`).join("");
  const sd = saved && !saved.ended ? dateOf(saved.turn) : null;
  card.innerHTML = `
    <h2>1990년 1월로 돌아갑니다</h2>
    <p class="sub">2026년 10월까지, 실제 역사 속에서 자산을 불려 보세요.</p>
    ${sd ? `<button class="primary" id="continue">이어하기 · ${sd.y}년 ${sd.m}월 (${SETTINGS.jobs[saved.job].name})</button><hr>` : ""}
    <p class="sub">모아 둔 돈 ${won(SETTINGS.startCapital)}으로 시작합니다.</p>
    <label>직업</label>
    <div class="opts" id="job-opts">
      ${Object.entries(SETTINGS.jobs).map(([k, j]) => `<button class="chip" data-job="${k}">${j.name} · 월 ${won(j.salary)}${j.vol >= 0.2 ? " (변동 큼)" : ""}</button>`).join("")}
    </div>
    <label>시작 나이 (${SETTINGS.retireAge}세에 은퇴)</label>
    <select id="age">${ages}</select>
    <button class="primary" id="start">새로 시작하기</button>`;
  const mark = () =>
    card.querySelectorAll("#job-opts .chip").forEach((b) => b.classList.toggle("on", b.dataset.job === job));
  card.querySelectorAll("#job-opts .chip").forEach((b) => (b.onclick = () => { job = b.dataset.job; mark(); }));
  mark();
  $("start").onclick = () => { $("modal").hidden = true; newGame(SETTINGS.startCapital, Number($("age").value), job); };
  if (sd) $("continue").onclick = () => { state = saved; $("modal").hidden = true; render(); };
  $("modal").hidden = false;
}

function summaryRows() {
  const nw = netWorth(), t = T();
  const ret = nw / state.startCapital - 1;
  const real = (nw / cpiRatio(t)) / state.startCapital - 1;
  const kospiRet = MARKET.kospi[t] / MARKET.kospi[0] - 1;
  let dep = 1;
  for (let i = 0; i < t; i++) dep *= 1 + (MARKET.depositRate[i] / 1200) * (1 - SETTINGS.interestTax);
  const best = Math.max(...state.history.slice(0, t + 1));
  return `
    ${row("시작 자금", won(state.startCapital))}
    ${row("최종 순자산", won(nw))}
    ${row("내 수익률", pct(ret), cls(ret))}
    ${row("물가 반영 실질 수익률", pct(real), cls(real))}
    ${row("코스피만 들고 있었다면", pct(kospiRet), cls(kospiRet))}
    ${row("예금만 넣어 뒀다면 (세후)", pct(dep - 1), cls(dep - 1))}
    ${row("최고 순자산", won(best))}
    ${row("최종 칭호 · 나이", `${titleOf(nw)} · ${ageOf(t)}세`)}
    <p class="note">시작 자금 기준 수익률이라 월급으로 모은 돈도 포함됩니다.</p>`;
}

function endGame() {
  state.ended = true;
  save();
  render();
  $("modal-card").innerHTML = `
    <h2>최종 결산 · ${SETTINGS.endYear}년 ${SETTINGS.endMonth}월</h2>
    ${summaryRows()}
    <button class="primary" id="again">다시 하기</button>`;
  $("again").onclick = () => { clearSave(); showStart(); };
  $("modal").hidden = false;
}

function bankrupt() {
  state.ended = true;
  state.bankrupt = true;
  clearSave();
  render();
  const d = dateOf(T());
  $("modal-card").innerHTML = `
    <h2>파산 · ${d.y}년 ${d.m}월</h2>
    <p class="sub">모든 자산을 팔고 대출 한도까지 썼지만 이번 달 생활비와 이자를 낼 수 없습니다.</p>
    ${summaryRows()}
    <button class="primary" id="again">다시 하기</button>`;
  $("again").onclick = showStart;
  $("modal").hidden = false;
}

// ===== 이벤트 연결 =====
$("next-btn").onclick = nextMonth;
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b || !state) return;
  state.tab = state.tab === b.dataset.tab ? "mine" : b.dataset.tab;
  render();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target === document.body && state && $("modal").hidden) nextMonth();
});
window.addEventListener("resize", () => state && renderChart());
// 시스템 밝은/어두운 모드가 바뀌면 그래프 색도 다시 칠함 (캔버스는 CSS 변수를 그릴 때만 읽음)
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => state && renderChart());
new MutationObserver(() => state && renderChart()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// 아티팩트로 열려 있을 때 새 버전이 배포돼도 진행 중인 게임을 이어감 (로컬에서는 window.claude가 없음)
window.claude?.hot?.snapshot?.(() => ({ state }));
function boot(data) {
  if (data?.state) { state = data.state; $("modal").hidden = true; render(); }
  else showStart();
}
if (window.claude?.hot?.ready) window.claude.hot.ready(boot); else boot(window.claude?.hot?.data ?? {});
