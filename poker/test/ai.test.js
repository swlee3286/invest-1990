// GTO AI 테스트: node poker/test/ai.test.js  (실패하면 종료 코드 1)
// a) 합법성·견고성  b) 속도  c) 정보 위생  d) 프리플롭 빈도  e) 포스트플롭 기본기  f) 실력(bb/100)
const T = require("../table.js");
const E = require("../engine.js");
const AI = require("../gto.js");

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL:", msg); } };
const pct = (x) => (100 * x).toFixed(1) + "%";

// ===== 시드 난수 =====
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = mulberry32(20261010);
Math.random = mulberry32(777); // 자리표시 AI(engine.equity)도 재현 가능하게
function deck(rng = R) {
  const d = [...Array(52).keys()];
  for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
const C = (str) => str.split(" ").filter(Boolean).map((t) => E.RANKS.indexOf(t[0]) * 4 + E.SUITS.indexOf(t[1]));
const LEVELS = [[10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000]];

function newMatch(n, { stack = 2000, levels = LEVELS, perLevel = 10, button = 0 } = {}) {
  const m = T.createMatch({ players: Array.from({ length: n }, (_, i) => ({ name: "P" + i, kind: i ? "bot" : "human" })), startStack: stack, levels, handsPerLevel: perLevel });
  const live = T.liveSeats(m);
  m.button = live[(live.indexOf(button) - 1 + live.length) % live.length]; // 다음 핸드에서 button이 버튼
  return m;
}
// 딜 순서(버튼 왼쪽부터 두 바퀴, 그다음 번·보드)대로 pop 되도록 덱을 만든다. holes[seat] = "As Kd" (빈 자리는 무작위)
function deckFor(m, holes, board, rng = R) {
  const live = T.liveSeats(m), button = T.nextIn(live, m.button);
  const order = [];
  for (let s = T.nextIn(live, button), k = 0; k < live.length; k++, s = T.nextIn(live, s)) order.push(s);
  const fixed = {}, used = new Set();
  for (const s of live) if (holes[s]) { fixed[s] = C(holes[s]); fixed[s].forEach((c) => used.add(c)); }
  const b = board ? C(board) : [];
  b.forEach((c) => used.add(c));
  const spare = deck(rng).filter((c) => !used.has(c));
  for (const s of live) if (!fixed[s]) fixed[s] = [spare.pop(), spare.pop()];
  while (b.length < 5) b.push(spare.pop());
  const seq = [];
  for (let r = 0; r < 2; r++) for (const s of order) seq.push(fixed[s][r]);
  seq.push(spare.pop(), b[0], b[1], b[2], spare.pop(), b[3], spare.pop(), b[4]);
  return [...spare, ...seq.reverse()];
}

// 결정이 규칙상 가능한지
function checkDecision(m, s, d, where) {
  const L = T.legal(m, s);
  const legalOne = (x) => {
    if (x.action === "fold") return L.toCall > 0;
    if (x.action === "check") return L.toCall === 0;
    if (x.action === "call") return L.toCall > 0;
    if (x.action === "raise") return L.canRaise && Number.isFinite(x.to) && x.to >= L.minTo && x.to <= L.maxTo &&
      (x.to % m.hand.sb === 0 || x.to === L.minTo || x.to === L.maxTo);
    return false;
  };
  let good = legalOne(d) && Array.isArray(d.mix) && d.mix.length > 0;
  const sum = d.mix.reduce((t, x) => t + x.freq, 0);
  good = good && Math.abs(sum - 1) < 1e-6 && d.mix.every((x) => legalOne(x) && x.freq >= 0.0099);
  good = good && d.mix.some((x) => x.action === d.action && x.to === d.to);
  const keys = new Set(d.mix.map((x) => x.action + ":" + x.to));
  good = good && keys.size === d.mix.length;
  const i = d.info || {};
  good = good && i.equity >= 0 && i.equity <= 1 && i.potOdds >= 0 && i.potOdds < 1 && typeof i.position === "string" &&
    typeof i.spot === "string" && i.spot.length > 0 && /^[2-9TJQKA]{2}[so]?$/.test(i.handClass) && i.effBB >= 0 && !i.error;
  if (!good) ok(false, `${where}: 잘못된 결정 ${JSON.stringify({ d: { action: d.action, to: d.to, mix: d.mix, info: d.info }, L })}`);
  return good;
}

// ===== a) 합법성·견고성 + b) 속도 =====
function randomAction(m, s, rng) {
  const L = T.legal(m, s), r = rng();
  if (L.toCall > 0 && r < 0.2) return { action: "fold" };
  if (L.canRaise && r < 0.45) return { action: "raise", to: rng() < 0.3 ? L.maxTo : L.minTo + Math.floor(rng() * (L.maxTo - L.minTo + 1)) };
  return { action: L.toCall > 0 ? "call" : "check" };
}
const times = [], times6 = [];
let decisions = 0, aaPre = 0, aaFold = 0;
const hygieneSpots = [];
{
  let hands = 0, matches = 0;
  for (let n = 2; n <= 6; n++) {
    for (let g = 0; g < 16; g++) {
      const mixed = g % 2 === 1; // 홀수 매치는 무작위 행동 좌석을 섞는다
      const m = newMatch(n, { button: g % n });
      const randomSeat = (s) => mixed && s % 2 === 1;
      while (!m.over && m.handNo < 150) {
        T.startHand(m, deck());
        hands++;
        const h = m.hand;
        let steps = 0;
        while (h.phase !== "done") {
          if (++steps > 400) { ok(false, "핸드가 끝나지 않음"); break; }
          if (h.phase === "runout") { T.runoutStep(m); continue; }
          const s = h.toAct;
          let d;
          if (randomSeat(s)) d = randomAction(m, s, R);
          else {
            const t0 = performance.now();
            try { d = AI.decide(m, s, { rng: R }); } catch (e) { ok(false, "decide가 예외를 던짐: " + e.message); d = { action: "fold" }; }
            times.push(performance.now() - t0);
            if (h.seats.length === 6) times6.push(times[times.length - 1]);
            decisions++;
            if (!checkDecision(m, s, d, `n=${n} hand ${h.no}`)) d = randomAction(m, s, R);
            if (h.street === 0 && d.info && d.info.handClass === "AA") { aaPre++; if (d.mix.some((x) => x.action === "fold")) aaFold++; }
            if (decisions % 23 === 0 && hygieneSpots.length < 400) hygieneSpots.push(JSON.stringify(m) + "|" + s);
          }
          T.act(m, s, d.action, d.to);
        }
      }
      matches++;
    }
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`a) ${matches} matches, ${hands} hands, ${decisions} AI decisions — all legal checks done`);
  console.log(`b) timing: avg ${avg.toFixed(2)} ms, p50 ${sorted[sorted.length >> 1].toFixed(2)} ms, p99 ${sorted[Math.floor(sorted.length * 0.99)].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms`);
  const avg6 = times6.reduce((a, b) => a + b, 0) / times6.length;
  console.log(`   6-handed spots: ${times6.length} decisions, avg ${avg6.toFixed(2)} ms, max ${Math.max(...times6).toFixed(1)} ms`);
  ok(hands >= 2000, "핸드 수 " + hands);
  ok(sorted[sorted.length - 1] < 250, "최대 결정 시간 " + sorted[sorted.length - 1]);
  ok(avg < 60, "평균 결정 시간 " + avg);
  ok(aaFold === 0, `AA 프리플롭 폴드 ${aaFold}/${aaPre}`);
  ok(AI._internal.STATS.trackErrors === 0, "레인지 추적 오류 " + AI._internal.STATS.trackErrors + " " + AI._internal.STATS.lastError);
}

// ===== c) 정보 위생: 다른 사람 카드·덱을 바꿔도 결정이 같고, 읽지도 않는다 =====
{
  let same = 0, touched = 0;
  for (const spot of hygieneSpots) {
    const bar = spot.lastIndexOf("|");
    const json = spot.slice(0, bar), s = +spot.slice(bar + 1);
    const a = JSON.parse(json), b = JSON.parse(json);
    // b: 내 카드·보드는 그대로, 나머지 카드(다른 손패 + 덱)를 섞어 다시 나눈다
    const hb = b.hand, keep = new Set([...hb.hole[s], ...hb.board]);
    const pool = deck().filter((c) => !keep.has(c));
    for (const o of hb.seats) if (o !== s && hb.hole[o]) hb.hole[o] = [pool.pop(), pool.pop()];
    hb.deck = pool.slice(0, hb.deck.length);
    // 읽기 감시: 다른 좌석 hole, deck, result에 접근하면 기록
    const realHole = hb.hole, realDeck = hb.deck;
    hb.hole = new Proxy(realHole, { get(t, k) { if (/^\d+$/.test(String(k)) && +k !== s) touched++; return t[k]; } });
    Object.defineProperty(hb, "deck", { get() { touched++; return realDeck; }, enumerable: true });
    Object.defineProperty(hb, "result", { get() { touched++; return null; }, enumerable: true });
    const da = AI.decide(a, s, { rng: mulberry32(5) }), db = AI.decide(b, s, { rng: mulberry32(5) });
    if (da.action === db.action && da.to === db.to && JSON.stringify(da.mix) === JSON.stringify(db.mix) && da.info.equity === db.info.equity) same++;
    else ok(false, "정보 위생: 결정이 달라짐 " + JSON.stringify([da.mix, db.mix, da.info.spot]));
  }
  console.log(`c) hygiene: ${same}/${hygieneSpots.length} spots identical after scrambling hidden cards; forbidden reads: ${touched}`);
  ok(hygieneSpots.length >= 200 && same === hygieneSpots.length, "위생 스팟 " + hygieneSpots.length);
  ok(touched === 0, "다른 좌석 카드·덱·결과를 읽음: " + touched);
}

// ===== d) 프리플롭: 앞사람이 모두 폴드했을 때 포지션별 오픈 빈도 =====
function firstIn(n, pos, deals, holes) {
  let raise = 0, call = 0, cnt = 0;
  for (let i = 0; i < deals; i++) {
    const m = newMatch(n, { levels: [[10, 20]], perLevel: 1e9, button: 0 });
    const posNames = T.POSITION_NAMES[n];
    const hero = posNames.indexOf(pos); // 버튼 0에서 시계 방향 = 좌석 번호
    const hh = {};
    if (holes) hh[hero] = holes[i % holes.length];
    T.startHand(m, deckFor(m, hh));
    const h = m.hand;
    while (h.toAct !== hero) T.act(m, h.toAct, "fold");
    const d = AI.decide(m, hero, { rng: R });
    checkDecision(m, hero, d, "firstIn " + pos);
    cnt++;
    if (d.action === "raise") raise++;
    if (d.action === "call") call++;
  }
  return { pfr: raise / cnt, vpip: (raise + call) / cnt, cnt };
}
{
  const targets = { UTG: 0.17, HJ: 0.21, CO: 0.28, BTN: 0.44, SB: 0.40 };
  console.log("d) 6-max 100bb first-in (folded to hero):");
  console.log("   pos   VPIP    PFR    target");
  for (const pos of Object.keys(targets)) {
    const r = firstIn(6, pos, 1500);
    console.log(`   ${pos.padEnd(4)} ${pct(r.vpip).padStart(6)} ${pct(r.pfr).padStart(6)}   ${pct(targets[pos])}  (n=${r.cnt})`);
    ok(Math.abs(r.pfr - targets[pos]) <= 0.05 && Math.abs(r.vpip - targets[pos]) <= 0.05, `${pos} 오픈 빈도 ${pct(r.pfr)} (목표 ${pct(targets[pos])})`);
  }
  const hu = firstIn(2, "BTN", 1200);
  console.log(`   HU BTN open ${pct(hu.pfr)} (n=${hu.cnt})`);
  ok(hu.pfr >= 0.7 && hu.pfr <= 0.9, "헤즈업 BTN 오픈 " + pct(hu.pfr));
  const trash = firstIn(6, "UTG", 40, ["7c 2d", "7h 2s", "7d 2c"]);
  ok(trash.vpip === 0, "UTG 72o는 폴드 " + pct(trash.vpip));
  const aces = ["UTG", "HJ", "CO", "BTN", "SB"].map((p) => firstIn(6, p, 20, ["As Ah", "Kd Kc"]).pfr);
  ok(aces.every((x) => x === 1), "AA/KK 오픈 100% " + aces);

  // AA는 어떤 프리플롭 상황에서도 폴드하지 않는다: 오픈 → 3벳 → 4벳 → 올인 사슬을 직접 만든다
  let aaSpots = 0, aaFolds = 0;
  for (let i = 0; i < 60; i++) {
    const n = 2 + (i % 5), deep = i % 3 === 0 ? 2000 : i % 3 === 1 ? 600 : 240;
    const m = newMatch(n, { stack: deep, levels: [[10, 20]], perLevel: 1e9, button: 0 });
    const hero = i % n;
    T.startHand(m, deckFor(m, { [hero]: i % 2 ? "As Ad" : "Ah Ac" }));
    const h = m.hand;
    let guard = 0;
    while (h.phase === "bet" && h.street === 0 && guard++ < 40) {
      const s = h.toAct, L = T.legal(m, s);
      if (s === hero) {
        const d = AI.decide(m, s, { rng: R });
        aaSpots++;
        if (d.mix.some((x) => x.action === "fold")) { aaFolds++; console.log("   AA fold spot:", d.info.spot, JSON.stringify(d.mix)); }
        T.act(m, s, d.action, d.to);
      } else if (L.canRaise && R() < 0.6) T.act(m, s, "raise", R() < 0.3 ? L.maxTo : Math.min(L.maxTo, Math.max(L.minTo, L.maxBet * 3)));
      else T.act(m, s, L.toCall > 0 ? (R() < 0.5 ? "call" : "fold") : "check");
    }
  }
  console.log(`   AA/AA preflop spots vs aggressive villains: ${aaSpots}, folds ${aaFolds}`);
  ok(aaSpots >= 60 && aaFolds === 0, "AA 폴드 " + aaFolds);
}

// ===== e) 포스트플롭 기본기 =====
// 헤즈업에서 스크립트대로 진행한 뒤 hero의 리버 결정을 본다
function riverSpot({ hero, villain, board, heroIsBtn, script }) {
  const m = newMatch(2, { levels: [[10, 20]], perLevel: 1e9, button: 0 }); // 좌석 0이 버튼
  const hs = heroIsBtn ? 0 : 1, vs = 1 - hs;
  T.startHand(m, deckFor(m, { [hs]: hero, [vs]: villain }, board));
  const h = m.hand;
  for (const [who, type, frac] of script) {
    const s = who === "h" ? hs : vs;
    if (h.toAct !== s) return null;
    const L = T.legal(m, s);
    if (type === "raise") T.act(m, s, "raise", frac === "allin" ? L.maxTo : Math.max(L.minTo, Math.round(T.potTotal(h) * frac / 10) * 10));
    else T.act(m, s, type);
  }
  if (h.toAct !== hs || h.street !== 3) return null;
  return { m, s: hs, d: AI.decide(m, hs, { rng: R }) };
}
{
  // 리버 넛: 어떤 크기의 벳을 맞아도 폴드하지 않는다
  const nutSpots = [
    ["As Ks", "Qd Qc", "Qs Js Ts 2h 3d"],   // 로열
    ["9h 8h", "Ac Kc", "7h 6h 5h Kd 2c"],    // 스트레이트 플러시
    ["Ad Ac", "Kh Kd", "As 7c 2d Ah 9s"],    // 포카드
    ["Jc Tc", "As Ad", "9d 8s 2h Qc 3h"],    // 넛 스트레이트
    ["Ah 2h", "Kd Kc", "Kh 7h 3c 9h 4s"],    // 넛 플러시
  ];
  let spots = 0, folds = 0;
  for (const [hero, villain, board] of nutSpots) {
    for (const heroIsBtn of [true, false]) {
      for (const size of [0.5, 1, 2, "allin"]) {
        // 프리플롭 오픈·콜, 플롭·턴 체크, 리버에 상대가 벳
        const pre = heroIsBtn ? [["h", "raise", 0.5], ["v", "call"]] : [["v", "raise", 0.5], ["h", "call"]];
        const chk = heroIsBtn ? [["v", "check"], ["h", "check"]] : [["h", "check"], ["v", "check"]];
        const riv = heroIsBtn ? [["v", "raise", size]] : [["h", "check"], ["v", "raise", size]];
        const r = riverSpot({ hero, villain, board, heroIsBtn, script: [...pre, ...chk, ...chk, ...riv] });
        if (!r) { ok(false, "넛 스팟 구성 실패 " + board); continue; }
        spots++;
        checkDecision(r.m, r.s, r.d, "nut river");
        if (r.d.mix.some((x) => x.action === "fold")) { folds++; console.log("   nut fold:", board, size, JSON.stringify(r.d.mix)); }
      }
    }
  }
  console.log(`e) river nuts facing bets: ${spots} spots, folds ${folds}`);
  ok(spots === 40 && folds === 0, "리버 넛 폴드 " + folds);

  // 공격자로서 리버에서 체크를 받은 에어: 가끔(항상은 아니게) 블러프
  let n = 0, bluffFreq = 0, sampledBet = 0, sampledCheck = 0;
  const airHands = ["7c 6c", "5d 4d", "Jh 9h", "8s 7s", "6h 5h", "Ts 8s", "4c 3c", "9d 7d"];
  for (let i = 0; i < 80; i++) {
    // 높은 카드 보드에서 hero(BTN, 오픈)가 플롭·턴 벳, 상대 콜, 리버 체크. hero는 아무것도 못 맞춤
    const air = airHands[i % airHands.length];
    const used = new Set(C(air));
    const pool = deck().filter((c) => !used.has(c));
    let board = null;
    for (let tries = 0; tries < 200 && !board; tries++) {
      const b = pool.slice(tries * 5 % 40, tries * 5 % 40 + 5);
      const sc = E.evaluate([...C(air), ...b]);
      const boardSc = E.evaluate(b);
      if (E.categoryOf(sc) === 0 && E.categoryOf(boardSc) === 0 && Math.max(...b.map((c) => c >> 2)) >= 9) board = b;
      else pool.push(pool.shift());
    }
    if (!board) continue;
    const bstr = board.map((c) => E.cardCode(c)).join(" ");
    const villain = pool.filter((c) => !board.includes(c)).slice(0, 2).map((c) => E.cardCode(c)).join(" ");
    const r = riverSpot({ hero: air, villain, board: bstr, heroIsBtn: true,
      script: [["h", "raise", 0.5], ["v", "call"], ["v", "check"], ["h", "raise", 0.33], ["v", "call"], ["v", "check"], ["h", "raise", 0.66], ["v", "call"], ["v", "check"]] });
    if (!r) continue;
    checkDecision(r.m, r.s, r.d, "river air");
    n++;
    const b = r.d.mix.filter((x) => x.action === "raise").reduce((t, x) => t + x.freq, 0);
    bluffFreq += b;
    if (r.d.action === "raise") sampledBet++; else sampledCheck++;
  }
  bluffFreq /= Math.max(n, 1);
  console.log(`   river air as aggressor (checked to): ${n} spots, avg bluff freq ${pct(bluffFreq)}, sampled bets ${sampledBet} / checks ${sampledCheck}`);
  ok(n >= 50 && bluffFreq > 0.08 && bluffFreq < 0.9 && sampledBet > 0 && sampledCheck > 0, "리버 에어 블러프 빈도 " + pct(bluffFreq));
}

// ===== f) 실력: 콜링 스테이션·자리표시 AI 상대 (듀플리케이트: 같은 덱으로 자리를 바꿔 두 번) =====
// 자리표시 AI(이전 버전)를 그대로 옮겨 둔 기준선
function placeholderDecide(m, seat, rng) {
  const h = m.hand, L = T.legal(m, seat);
  const opponents = T.aliveSeats(h).length - 1;
  const eq = Math.pow(E.equity(h.hole[seat], h.board, 600), Math.max(1, opponents * 0.85));
  const pot = T.potTotal(h);
  const odds = L.toCall ? L.toCall / (pot + L.toCall) : 0;
  const sized = (f) => Math.min(Math.max(Math.round((L.maxBet + (pot + L.toCall) * f) / h.sb) * h.sb, L.minTo), L.maxTo);
  const mix = [];
  if (L.canRaise && eq > 0.62) mix.push({ action: "raise", to: sized(0.7), freq: 0.7 });
  if (L.toCall === 0) mix.push({ action: "check", freq: 1 });
  else if (eq >= odds + 0.05) mix.push({ action: "call", freq: 1 });
  else mix.push({ action: "fold", freq: 1 });
  const total = mix.reduce((t, x) => t + x.freq, 0);
  mix.forEach((x) => { x.freq /= total; });
  let r = rng(), pick = mix[mix.length - 1];
  for (const x of mix) { if ((r -= x.freq) < 0) { pick = x; break; } }
  return pick;
}
const BOTS = {
  gto: (m, s) => AI.decide(m, s, { rng: R }),
  station: (m, s) => ({ action: T.legal(m, s).toCall > 0 ? "call" : "check" }),
  placeholder: (m, s) => placeholderDecide(m, s, R),
};
function playOne(kinds, dk, button, stackBB) {
  const n = kinds.length;
  const m = newMatch(n, { stack: 20 * stackBB, levels: [[10, 20]], perLevel: 1e9, button });
  T.startHand(m, dk);
  const h = m.hand;
  while (h.phase !== "done") {
    if (h.phase === "runout") { T.runoutStep(m); continue; }
    const s = h.toAct, d = BOTS[kinds[s]](m, s);
    T.act(m, s, d.action, d.to);
  }
  return m.players.map((p) => p.stack - 20 * stackBB);
}
function duel(opp, n, deals, stackBB = 100) {
  let net = 0, sq = 0, gtoHands = 0;
  for (let i = 0; i < deals; i++) {
    const d = deck(), btn = i % n;
    const A = Array.from({ length: n }, (_, s) => (s % 2 ? opp : "gto")), B = A.map((k) => (k === "gto" ? opp : "gto"));
    let x = 0;
    for (const kinds of [A, B]) playOne(kinds, d.slice(), btn, stackBB).forEach((v, s) => { if (kinds[s] === "gto") x += v / 20; });
    net += x; sq += x * x; gtoHands += n;
  }
  const mean = net / deals, sd = Math.sqrt(Math.max(0, sq / deals - mean * mean));
  return { bb100: (net / gtoHands) * 100, se: (sd / Math.sqrt(deals)) * deals / gtoHands * 100, hands: gtoHands * 1, deals };
}
{
  console.log("f) strength (duplicate deals, GTO seats' net, 100bb unless noted):");
  const rows = [
    ["station", 2, 600], ["placeholder", 2, 600],
    ["station", 6, 150], ["placeholder", 6, 600],
    ["placeholder", 2, 500, 25],
  ];
  for (const [opp, n, deals, bb = 100] of rows) {
    const t0 = Date.now(), r = duel(opp, n, deals, bb);
    console.log(`   vs ${opp.padEnd(11)} ${n === 2 ? "heads-up" : "6-max   "} ${String(bb).padStart(3)}bb: ${r.bb100.toFixed(1).padStart(6)} bb/100 ±${r.se.toFixed(1)} (${r.hands} GTO seat-hands, ${deals * 2} games, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    ok(r.bb100 > 0, `vs ${opp} n=${n} ${bb}bb: ${r.bb100.toFixed(1)} bb/100`); // 표본: 기대값 대비 표준오차 3배 이상 여유
  }
}

// ===== 설명 문자열 =====
{
  const m = newMatch(6, { levels: [[10, 20]], perLevel: 1e9, button: 0 });
  T.startHand(m, deckFor(m, { 5: "Ah Jc" }));
  while (m.hand.toAct !== 5) T.act(m, m.hand.toAct, "fold");
  const d = AI.decide(m, 5, { rng: () => 0.5 });
  const txt = AI.describeMix(d);
  console.log("   describeMix:", txt);
  ok(/^GTO engine \(CO, RFI, AJo\): /.test(txt) && /Equity vs ranges \d+%/.test(txt) && /effective 100bb/.test(txt), "describeMix 형식 " + txt);
}

console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
