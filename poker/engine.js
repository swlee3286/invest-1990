// ===== 카드 · 족보 · 승률 계산 (화면과 무관한 순수 함수) =====
// 카드 = 0~51 정수. 랭크 = c >> 2 (0 = 2 … 12 = A), 무늬 = c & 3 (♠ ♥ ♦ ♣)
const RANKS = "23456789TJQKA";
const SUITS = "shdc";
const SUIT_SYMBOL = ["♠", "♥", "♦", "♣"];
const RANK_LABEL = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_EN = ["deuce", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "jack", "queen", "king", "ace"];

const rankOf = (c) => c >> 2;
const suitOf = (c) => c & 3;
const isRed = (c) => suitOf(c) === 1 || suitOf(c) === 2;
const cardCode = (c) => RANKS[rankOf(c)] + SUITS[suitOf(c)];           // "As", "Td" — Claude에게 보낼 표기
const cardLabel = (c) => RANK_LABEL[rankOf(c)] + SUIT_SYMBOL[suitOf(c)]; // "A♠", "10♦" — 화면 표기

// 셔플은 가능하면 crypto 난수로 (Math.random보다 고르게)
function randInt(n) {
  if (globalThis.crypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    do crypto.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

function shuffledDeck() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = d.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ===== 족보 =====
// 점수 = 족보 등급 × 16^5 + 비교용 랭크 5개(16진 한 자리씩). 클수록 강하다.
const CAT_KO = ["하이카드", "원페어", "투페어", "트리플", "스트레이트", "플러시", "풀하우스", "포카드", "스트레이트 플러시"];
const CAT_EN = ["high card", "one pair", "two pair", "three of a kind", "straight", "flush", "full house", "four of a kind", "straight flush"];
const BASE = 16 ** 5;

function pack(cat, ranks) {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 16 + Math.max(ranks[i] ?? 0, 0);
  return s;
}

// 비트마스크(랭크별 1비트)에서 가장 높은 스트레이트의 최고 랭크. 없으면 -1. A-2-3-4-5는 5 하이(랭크 3)
function straightHigh(mask) {
  for (let hi = 12; hi >= 4; hi--) if (((mask >> (hi - 4)) & 31) === 31) return hi;
  if ((mask & 0b1000000001111) === 0b1000000001111) return 3;
  return -1;
}

// 5~7장 중 가장 좋은 5장의 점수
function evaluate(cards) {
  const counts = new Array(13).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = c >> 2, s = c & 3;
    counts[r]++;
    suitMask[s] |= 1 << r;
    suitCount[s]++;
    mask |= 1 << r;
  }
  // 7장 이하에서 플러시가 있으면 포카드·풀하우스는 불가능하므로 바로 반환해도 된다
  for (let s = 0; s < 4; s++) {
    if (suitCount[s] < 5) continue;
    const sf = straightHigh(suitMask[s]);
    if (sf >= 0) return pack(8, [sf]);
    const top = [];
    for (let r = 12; r >= 0 && top.length < 5; r--) if (suitMask[s] & (1 << r)) top.push(r);
    return pack(5, top);
  }
  let quads = -1;
  const trips = [], pairs = [], singles = [];
  for (let r = 12; r >= 0; r--) {
    const n = counts[r];
    if (n === 4) quads = r;
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
    else if (n === 1) singles.push(r);
  }
  if (quads >= 0) return pack(7, [quads, Math.max(trips[0] ?? -1, pairs[0] ?? -1, singles[0] ?? -1)]);
  if (trips.length && (trips.length > 1 || pairs.length)) return pack(6, [trips[0], Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
  const st = straightHigh(mask);
  if (st >= 0) return pack(4, [st]);
  if (trips.length) return pack(3, [trips[0], ...singles.slice(0, 2)]);
  if (pairs.length >= 2) return pack(2, [pairs[0], pairs[1], Math.max(pairs[2] ?? -1, singles[0] ?? -1)]);
  if (pairs.length) return pack(1, [pairs[0], ...singles.slice(0, 3)]);
  return pack(0, singles.slice(0, 5));
}

const categoryOf = (score) => Math.floor(score / BASE);
const topRanks = (score) => [4, 3, 2, 1, 0].map((i) => Math.floor(score / 16 ** i) % 16);

// "투페어 K·7", "스트레이트 10 하이"
function describe(score) {
  const cat = categoryOf(score), [a, b] = topRanks(score), R = (r) => RANK_LABEL[r];
  switch (cat) {
    case 0: return `하이카드 ${R(a)}`;
    case 1: return `원페어 ${R(a)}`;
    case 2: return `투페어 ${R(a)}·${R(b)}`;
    case 3: return `트리플 ${R(a)}`;
    case 4: return `스트레이트 ${R(a)} 하이`;
    case 5: return `플러시 ${R(a)} 하이`;
    case 6: return `풀하우스 ${R(a)}·${R(b)}`;
    case 7: return `포카드 ${R(a)}`;
    default: return a === 12 ? "로열 플러시" : `스트레이트 플러시 ${R(a)} 하이`;
  }
}

function describeEn(score) {
  const cat = categoryOf(score), [a, b] = topRanks(score);
  const two = cat === 2 || cat === 6 ? `/${RANKS[b]}` : "";
  const high = [0, 4, 5, 8].includes(cat) ? "-high" : "";
  return `${CAT_EN[cat]} ${RANKS[a]}${two}${high}`;
}

// 5~7장 중 실제로 쓰인 5장 (쇼다운 하이라이트용)
function bestFive(cards) {
  let best = { score: -1, cards: [] };
  const pick = [];
  (function choose(start) {
    if (pick.length === 5) {
      const five = pick.map((i) => cards[i]);
      const s = evaluate(five);
      if (s > best.score) best = { score: s, cards: five };
      return;
    }
    for (let i = start; i <= cards.length - (5 - pick.length); i++) {
      pick.push(i);
      choose(i + 1);
      pick.pop();
    }
  })(0);
  return best;
}

// ===== 승률 =====
// 무작위 상대 손패 하나를 상대로 한 몬테카를로 승률 (비기면 반으로 친다)
function equity(hole, board, iters = 1500) {
  const used = new Set([...hole, ...board]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = 5 - board.length;
  const mine = [...hole, ...board], theirs = [0, 0, ...board];
  let score = 0;
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < need + 2; k++) {
      const j = k + Math.floor(Math.random() * (rest.length - k));
      [rest[k], rest[j]] = [rest[j], rest[k]];
    }
    theirs[0] = rest[0];
    theirs[1] = rest[1];
    const extra = rest.slice(2, 2 + need);
    const a = evaluate(mine.concat(extra)), b = evaluate(theirs.concat(extra));
    score += a > b ? 1 : a === b ? 0.5 : 0;
  }
  return score / iters;
}

if (typeof module !== "undefined") {
  module.exports = { evaluate, describe, describeEn, bestFive, equity, shuffledDeck, cardCode, cardLabel, categoryOf, RANKS, SUITS };
}
