// ===== 여러 명(2~6) 노리밋 홀덤 규칙 =====
// 화면과 무관한 규칙 엔진. 매치 상태(m)는 JSON으로 저장할 수 있는 순수 데이터이고, 아래 함수들이 그 상태를 바꾼다.
// 좌석 번호 = m.players 인덱스. 번호가 커지는 방향이 시계 방향(행동 순서)이다. 0번이 사람.
// engine.js(카드·족보)에 의존한다: 브라우저에서는 전역 함수, node에서는 require.
// 브라우저에서는 전역 PokerTable 하나만 만든다 (다른 스크립트와 이름이 겹치지 않게).
(function (root) {
const PK = typeof module !== "undefined" && typeof require === "function" ? require("./engine.js") : root;

// 버튼부터 시계 방향으로 붙는 포지션 이름 (남은 인원별). 빈 자리는 버튼에 가까운 이름이 남는다
const POSITION_NAMES = {
  2: ["BTN", "BB"], // 헤즈업: 버튼이 스몰 블라인드
  3: ["BTN", "SB", "BB"],
  4: ["BTN", "SB", "BB", "CO"],
  5: ["BTN", "SB", "BB", "HJ", "CO"],
  6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
};

function createMatch({ players, startStack = 2000, levels, handsPerLevel = 10 }) {
  return {
    v: 2,
    players: players.map((p) => ({ name: p.name, kind: p.kind, stack: startStack, out: false, place: 0 })),
    startStack, levels, handsPerLevel,
    button: -1,
    handNo: 0,
    hand: null,
    over: false,
  };
}

const liveSeats = (m) => m.players.map((_, i) => i).filter((i) => !m.players[i].out);

// list(오름차순 좌석 목록)에서 seat 다음 좌석 (seat 자신은 목록에 없어도 된다)
function nextIn(list, seat) {
  for (const s of list) if (s > seat) return s;
  return list[0];
}

// list에서 seat 앞 좌석 (시계 반대 방향)
function prevIn(list, seat) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i] < seat) return list[i];
  return list[list.length - 1];
}

function blindsAt(m, handNo) {
  return m.levels[Math.min(Math.floor((handNo - 1) / m.handsPerLevel), m.levels.length - 1)];
}

// 새 핸드: 버튼을 옮기고, 블라인드를 내고, 카드를 나눈다. deck은 테스트용 (pop 순서로 딜)
function startHand(m, deck = PK.shuffledDeck()) {
  const live = liveSeats(m), N = m.players.length;
  if (live.length < 2) throw new Error("not enough players");
  m.handNo++;
  const [sb, bb] = blindsAt(m, m.handNo);
  // BB는 탈락자가 생겨도 직전 BB 다음의 살아 있는 사람에게 넘어간다 (BB를 건너뛰거나 두 번 연속 내는 사람이 없게).
  // SB·버튼은 BB에서 거꾸로 살아 있는 자리로 정한다. 첫 핸드는 버튼에서 시작
  const prevBB = m.hand ? m.hand.bbSeat : -1;
  let sbSeat, bbSeat;
  if (prevBB < 0) {
    m.button = m.button < 0 ? live[PK.randInt(live.length)] : nextIn(live, m.button);
    sbSeat = live.length === 2 ? m.button : nextIn(live, m.button);
    bbSeat = nextIn(live, sbSeat);
  } else {
    bbSeat = nextIn(live, prevBB);
    sbSeat = prevIn(live, bbSeat);
    m.button = live.length === 2 ? sbSeat : prevIn(live, sbSeat);
  }
  const arr = (v) => Array.from({ length: N }, () => v);
  const h = {
    no: m.handNo, sb, bb,
    button: m.button, sbSeat, bbSeat,
    seats: live,                        // 이번 핸드 참가 좌석 (오름차순)
    deck,
    hole: arr(null),
    board: [], street: 0,               // 0 프리플롭 · 1 플롭 · 2 턴 · 3 리버
    bets: arr(0),                       // 이번 스트리트에 낸 칩
    contrib: arr(0),                    // 이번 핸드에 낸 칩 전체
    folded: m.players.map((p) => p.out),
    actedOn: arr(null),                 // 이번 스트리트에 마지막으로 행동한 직후의 최고 베팅 (행동 안 했으면 null)
    lastRaise: bb,                      // 최소 레이즈 폭 (마지막 '완전한' 레이즈 크기)
    aggressor: [-1, -1, -1, -1],        // 스트리트별 마지막 벳/레이즈 좌석
    toAct: -1,
    phase: "bet",                       // bet | runout | done
    shown: arr(false),                  // 카드 공개 여부
    start: m.players.map((p) => p.stack),
    actions: [],
    result: null,
  };
  m.hand = h;
  // 버튼 왼쪽부터 한 장씩 두 바퀴
  const order = [];
  for (let s = nextIn(live, m.button), k = 0; k < live.length; k++, s = nextIn(live, s)) order.push(s);
  for (let r = 0; r < 2; r++) for (const s of order) (h.hole[s] ??= []).push(deck.pop());
  post(m, sbSeat, sb, "sb");
  post(m, bbSeat, bb, "bb");
  h.toAct = findNext(m, bbSeat); // BB 다음부터: 헤즈업이면 버튼(SB), 아니면 UTG
  if (h.toAct < 0) endRound(m);
  return h;
}

function post(m, seat, amount, type) {
  const h = m.hand, a = Math.min(amount, m.players[seat].stack);
  pay(m, seat, a);
  h.actions.push({ street: 0, seat, type, amount: a, allin: m.players[seat].stack === 0 });
}

function pay(m, seat, a) {
  const h = m.hand;
  m.players[seat].stack -= a;
  h.bets[seat] += a;
  h.contrib[seat] += a;
}

const maxBet = (h) => Math.max(...h.seats.map((s) => h.bets[s]));
// 지금 맞춰야 하는 베팅: 프리플롭은 BB가 모자라게 올인했어도 BB 전액이 기준 (최소 레이즈도 2BB부터)
const curBet = (h) => (h.street === 0 ? Math.max(maxBet(h), h.bb) : maxBet(h));
const potTotal = (h) => h.seats.reduce((t, s) => t + h.contrib[s], 0);
const aliveSeats = (h) => h.seats.filter((s) => !h.folded[s]);

// seat이 지금 할 수 있는 것
function legal(m, seat) {
  const h = m.hand, stack = m.players[seat].stack, mb = curBet(h);
  let cap = 0, othersCanAct = false;
  for (const s of h.seats) {
    if (s === seat || h.folded[s]) continue;
    cap = Math.max(cap, h.bets[s] + m.players[s].stack); // 아무도 받을 수 없는 금액까지는 올리지 않는다
    if (m.players[s].stack > 0) othersCanAct = true;
  }
  // 짧은 BB만 남아 BB 전액을 받을 사람이 없으면, 실제로 나온 최고 베팅(또는 받을 수 있는 만큼)까지만 맞춘다
  const toCall = Math.min(Math.min(mb, Math.max(maxBet(h), cap)) - h.bets[seat], stack);
  const maxTo = Math.min(h.bets[seat] + stack, cap);
  const minInc = Math.max(h.lastRaise, h.bb);
  // 이미 행동한 사람은 그 뒤로 '완전한 레이즈' 만큼 올라왔을 때만 다시 레이즈할 수 있다 (모자란 올인은 재개하지 않음)
  const reopened = h.actedOn[seat] === null || mb - h.actedOn[seat] >= minInc;
  const canRaise = reopened && othersCanAct && stack > toCall && maxTo > mb;
  const minTo = Math.min(mb + minInc, maxTo);
  return { toCall, canCheck: toCall === 0, canRaise, minTo, maxTo, maxBet: mb, isBet: mb === 0 };
}

// 행동. type: fold | check | call | raise (raise는 to = 이번 스트리트 총 베팅액)
function act(m, seat, type, to) {
  const h = m.hand;
  if (h.phase !== "bet" || h.toAct !== seat) throw new Error(`not seat ${seat}'s turn`);
  const L = legal(m, seat), rec = { street: h.street, seat, type };
  if (type === "call" && L.toCall === 0) rec.type = type = "check";
  if (type === "check") {
    if (L.toCall > 0) throw new Error("cannot check facing a bet");
  } else if (type === "call") {
    rec.amount = L.toCall;
    pay(m, seat, L.toCall);
  } else if (type === "raise") {
    if (!L.canRaise) throw new Error("cannot raise");
    to = Math.min(Math.max(Math.round(Number(to)) || 0, L.minTo), L.maxTo);
    const inc = to - L.maxBet, full = inc >= Math.max(h.lastRaise, h.bb);
    if (full) h.lastRaise = inc;
    pay(m, seat, to - h.bets[seat]);
    rec.type = L.isBet ? "bet" : "raise";
    rec.to = to;
    rec.full = full;
    h.aggressor[h.street] = seat;
  } else if (type === "fold") {
    h.folded[seat] = true;
  } else {
    throw new Error(`unknown action ${type}`);
  }
  rec.allin = type !== "fold" && m.players[seat].stack === 0;
  h.actedOn[seat] = curBet(h);
  h.actions.push(rec);
  afterAction(m, seat);
  return rec;
}

// seat이 이번 라운드에 아직 행동해야 하는가
function needsToAct(m, s) {
  const h = m.hand;
  if (h.folded[s] || m.players[s].stack === 0) return false;
  const L = legal(m, s);
  if (L.toCall > 0) return true;
  if (h.actedOn[s] !== null) return false;
  return L.canRaise; // 맞춰져 있고 아직 행동 전: 올릴 수 있을 때만 (체크만 남았으면 건너뜀)
}

function findNext(m, from) {
  const h = m.hand;
  for (let s = nextIn(h.seats, from), k = 0; k < h.seats.length; k++, s = nextIn(h.seats, s)) {
    if (needsToAct(m, s)) return s;
  }
  return -1;
}

function afterAction(m, seat) {
  const h = m.hand, alive = aliveSeats(h);
  if (alive.length === 1) {
    returnUncalled(m);
    return awardFold(m, alive[0]);
  }
  const next = findNext(m, seat);
  if (next >= 0) h.toAct = next;
  else endRound(m);
}

// 아무도 받지 않은 베팅은 돌려준다
function returnUncalled(m) {
  const h = m.hand;
  const order = h.seats.slice().sort((a, b) => h.bets[b] - h.bets[a]);
  const top = order[0], extra = h.bets[top] - (order.length > 1 ? h.bets[order[1]] : 0);
  if (extra <= 0) return;
  m.players[top].stack += extra;
  h.bets[top] -= extra;
  h.contrib[top] -= extra;
  h.actions.push({ street: h.street, seat: top, type: "return", amount: extra });
}

function endRound(m) {
  const h = m.hand;
  returnUncalled(m);
  h.bets = h.bets.map(() => 0);
  h.toAct = -1;
  const alive = aliveSeats(h);
  if (h.street === 3) return showdown(m);
  if (alive.filter((s) => m.players[s].stack > 0).length <= 1) {
    h.phase = "runout"; // 더 베팅할 사람이 없다: 남은 카드를 펼친다
    for (const s of alive) h.shown[s] = true;
    return;
  }
  dealStreet(m);
  h.toAct = findNext(m, h.button); // 플롭부터는 버튼 왼쪽부터
  if (h.toAct < 0) endRound(m);
}

function dealStreet(m) {
  const h = m.hand;
  h.street++;
  h.deck.pop(); // 번
  const n = h.street === 1 ? 3 : 1;
  for (let i = 0; i < n; i++) h.board.push(h.deck.pop());
  h.actedOn = h.actedOn.map(() => null);
  h.lastRaise = h.bb;
}

// runout 단계에서 한 장(또는 플롭 세 장)씩 펼친다. 다 펼치면 쇼다운. 끝났으면 false
function runoutStep(m) {
  const h = m.hand;
  if (h.phase !== "runout") return false;
  if (h.street < 3) dealStreet(m);
  else showdown(m);
  return h.phase === "runout";
}

// 사이드 팟: 살아 있는 사람들의 낸 금액 단계별로 나눈다
function buildPots(h) {
  const alive = aliveSeats(h);
  const levels = [...new Set(alive.map((s) => h.contrib[s]))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lv of levels) {
    let amount = 0;
    for (const s of h.seats) amount += Math.max(0, Math.min(h.contrib[s], lv) - prev);
    const eligible = alive.filter((s) => h.contrib[s] >= lv);
    const last = pots[pots.length - 1];
    if (last && last.eligible.join() === eligible.join()) last.amount += amount;
    else if (amount > 0) pots.push({ amount, eligible });
    prev = lv;
  }
  // 폴드한 사람이 살아 있는 사람보다 많이 낸 몫(정상 진행에선 생기지 않음)은 마지막 팟에 넣는다
  const total = potTotal(h), counted = pots.reduce((t, p) => t + p.amount, 0);
  if (pots.length && total > counted) pots[pots.length - 1].amount += total - counted;
  return pots;
}

function showdown(m) {
  const h = m.hand, alive = aliveSeats(h);
  const byseat = {};
  for (const s of alive) {
    const b = PK.bestFive([...h.hole[s], ...h.board]);
    byseat[s] = { score: b.score, best: b.cards, label: PK.describe(b.score) };
    h.shown[s] = true;
  }
  const won = m.players.map(() => 0);
  const pots = buildPots(h).map((p) => {
    const top = Math.max(...p.eligible.map((s) => byseat[s].score));
    const winners = p.eligible.filter((s) => byseat[s].score === top);
    const share = Math.floor(p.amount / winners.length);
    let odd = p.amount - share * winners.length;
    for (const s of winners) won[s] += share;
    // 나머지 칩은 버튼 왼쪽에서 가장 가까운 승자부터
    for (let s = nextIn(h.seats, h.button), k = 0; odd > 0 && k < h.seats.length; k++, s = nextIn(h.seats, s)) {
      if (winners.includes(s)) { won[s]++; odd--; }
    }
    return { amount: p.amount, eligible: p.eligible, winners };
  });
  for (const s of h.seats) m.players[s].stack += won[s];
  h.result = { showdown: true, pots, won, hands: m.players.map((_, s) => byseat[s] ?? null) };
  finishHand(m);
}

function awardFold(m, winner) {
  const h = m.hand, amount = potTotal(h);
  h.bets = h.bets.map(() => 0);
  const won = m.players.map(() => 0);
  won[winner] = amount;
  m.players[winner].stack += amount;
  h.result = { showdown: false, pots: [{ amount, eligible: [winner], winners: [winner] }], won, hands: m.players.map(() => null) };
  finishHand(m);
}

// 핸드 끝: 칩이 없는 사람은 탈락 (같은 핸드에 여럿이면 시작 칩이 많았던 쪽이 높은 순위)
function finishHand(m) {
  const h = m.hand;
  h.phase = "done";
  h.toAct = -1;
  const busted = h.seats.filter((s) => m.players[s].stack === 0).sort((a, b) => h.start[b] - h.start[a]);
  const remaining = liveSeats(m).length - busted.length;
  busted.forEach((s, i) => { m.players[s].out = true; m.players[s].place = remaining + 1 + i; });
  const live = liveSeats(m);
  if (live.length <= 1) {
    m.over = true;
    if (live.length === 1) m.players[live[0]].place = 1;
  }
}

// 이번 핸드의 좌석별 포지션 이름 (참가하지 않은 좌석은 null)
function positionsOf(h) {
  const names = POSITION_NAMES[h.seats.length], out = [];
  for (let s = h.button, k = 0; k < h.seats.length; k++, s = nextIn(h.seats, s)) out[s] = names[k];
  return out;
}

const api = {
  POSITION_NAMES, createMatch, startHand, legal, act, runoutStep, buildPots, positionsOf,
  liveSeats, aliveSeats, nextIn, prevIn, blindsAt, maxBet, curBet, potTotal, needsToAct,
};
if (typeof module !== "undefined") module.exports = api;
else root.PokerTable = api;
})(globalThis);
