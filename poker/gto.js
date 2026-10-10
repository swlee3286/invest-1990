// ===== GTO 근사 포커 AI =====
// 공개 정보(보드·액션·베팅·스택·포지션·블라인드)와 자기 카드(m.hand.hole[seat])만 쓴다.
// 다른 좌석의 카드, 덱(m.hand.deck), 이번 핸드 결과(h.result)는 읽지 않는다.
//   PokerAI.decide(m, seat, {rng}) → { action, to, mix: [{action, to, freq}], info }
//   PokerAI.describeMix(decision) → Claude 프롬프트용 짧은 영어 설명
// 구성
//   1) 프리플롭: 포지션별 레인지 차트(표기법 파서) · 숏스택 푸시/폴드 · 스택 깊이별 사이즈
//   2) 레인지 추적: 이번 핸드의 액션을 같은 모델로 재생해 좌석별 1326 조합 가중치를 갱신 (바닥값으로 0이 되지 않게)
//   3) 플롭 이후: 레인지 기반 휴리스틱 (MDF, 레인지 우위, 밸류:블러프 비율, SPR)
//   4) 레인지 상대 승률: 몬테카를로(카드 제거 반영), 리버는 정확 계산
// 브라우저 전역 PokerAI 하나만 만든다. node에서는 require('./gto.js').
(function (root) {
"use strict";
const isNode = typeof module !== "undefined" && typeof require === "function";
const PK = isNode ? require("./engine.js") : root;
let PT = isNode ? require("./table.js") : root.PokerTable;
let evaluate = null, straightHigh = null;

function ensure() {
  if (!PT) PT = root.PokerTable;
  if (!evaluate) { evaluate = PK.evaluate; straightHigh = PK.straightHigh; }
}

// ===== 작은 도구 =====
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sig = (x) => 1 / (1 + Math.exp(-x));
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashInts(list) {
  let h = 2166136261;
  for (const v of list) { h ^= v & 0xffff; h = Math.imul(h, 16777619); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ===== 조합 1326개 · 핸드 클래스 169개 =====
const RANKS = "23456789TJQKA";
const NC = 1326, NCLS = 169, FLOOR = 0.04, JAM = 1e12;
const C1 = new Uint8Array(NC), C2 = new Uint8Array(NC), CLS = new Uint8Array(NC);
const CIDX = new Int16Array(52 * 52).fill(-1);
const CLS_SIZE = new Uint8Array(NCLS), CLS_NAME = [];
// 페어 r*13+r, 수딧 hi*13+lo, 오프수트 lo*13+hi
const clsId = (hi, lo, suited) => (hi === lo ? hi * 14 : suited ? hi * 13 + lo : lo * 13 + hi);
for (let hi = 0; hi < 13; hi++) for (let lo = 0; lo <= hi; lo++) {
  if (hi === lo) { CLS_NAME[clsId(hi, hi)] = RANKS[hi] + RANKS[hi]; CLS_SIZE[clsId(hi, hi)] = 6; continue; }
  CLS_NAME[clsId(hi, lo, true)] = RANKS[hi] + RANKS[lo] + "s"; CLS_SIZE[clsId(hi, lo, true)] = 4;
  CLS_NAME[clsId(hi, lo, false)] = RANKS[hi] + RANKS[lo] + "o"; CLS_SIZE[clsId(hi, lo, false)] = 12;
}
{
  let i = 0;
  for (let a = 1; a < 52; a++) for (let b = 0; b < a; b++) {
    C1[i] = a; C2[i] = b;
    CLS[i] = clsId(a >> 2, b >> 2, (a & 3) === (b & 3));
    CIDX[a * 52 + b] = CIDX[b * 52 + a] = i;
    i++;
  }
}
const comboOf = (x, y) => CIDX[x * 52 + y];
const UNIFORM = new Float64Array(NC).fill(1);

// ===== 레인지 표기법 파서 =====
// "22+, A2s+, KTs+, QJo, A5s:0.5, 76s-54s, K9s-K6s, AK" → 169 클래스 가중치. 뒤에 나온 항목이 앞을 덮어쓴다.
function parseHand(t) {
  const a = RANKS.indexOf(t[0]), b = RANKS.indexOf(t[1]);
  if (a < 0 || b < 0) throw new Error("bad hand " + t);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return { hi, lo, type: hi === lo ? "p" : t[2] === "s" ? "s" : t[2] === "o" ? "o" : "b" };
}
function setCls(out, hi, lo, type, w) {
  if (lo < 0 || lo > hi) return;
  if (type === "p" || hi === lo) { out[clsId(hi, hi)] = w; return; }
  if (type !== "o") out[clsId(hi, lo, true)] = w;
  if (type !== "s") out[clsId(hi, lo, false)] = w;
}
function parseRange(str) {
  const out = new Float32Array(NCLS);
  for (let tok of str.split(",")) {
    tok = tok.trim();
    if (!tok) continue;
    let w = 1;
    const ci = tok.indexOf(":");
    if (ci >= 0) { w = parseFloat(tok.slice(ci + 1)); tok = tok.slice(0, ci).trim(); }
    if (tok.includes("-")) {
      const [x, y] = tok.split("-").map((s) => parseHand(s.trim()));
      if (x.type === "p" && y.type === "p") {
        for (let r = Math.min(x.hi, y.hi); r <= Math.max(x.hi, y.hi); r++) setCls(out, r, r, "p", w);
      } else if (x.hi === y.hi) {
        for (let l = Math.min(x.lo, y.lo); l <= Math.max(x.lo, y.lo); l++) setCls(out, x.hi, l, x.type, w);
      } else {
        const gap = x.hi - x.lo; // 76s-54s: 간격을 유지한 채 함께 내려간다
        for (let h = Math.min(x.hi, y.hi); h <= Math.max(x.hi, y.hi); h++) setCls(out, h, h - gap, x.type, w);
      }
    } else if (tok.endsWith("+")) {
      const x = parseHand(tok.slice(0, -1));
      if (x.type === "p") for (let r = x.hi; r < 13; r++) setCls(out, r, r, "p", w);
      else for (let l = x.lo; l < x.hi; l++) setCls(out, x.hi, l, x.type, w);
    } else {
      const x = parseHand(tok);
      setCls(out, x.hi, x.lo, x.type, w);
    }
  }
  return out;
}
// 레인지가 차지하는 조합 비율 (0~1)
function rangePct(arr) {
  let t = 0;
  for (let c = 0; c < NCLS; c++) t += arr[c] * CLS_SIZE[c];
  return t / NC;
}

// ===== 핸드 순위 (랜덤 핸드 상대 올인 승률 순) — 푸시/폴드·상위 x% 레인지에 쓴다 =====
const RANKING = ("AA KK QQ JJ TT 99 88 AKs 77 AQs AJs AKo ATs AQo AJo KQs 66 A9s ATo KJs A8s KTs KQo A7s A9o KJo 55 QJs " +
  "K9s A5s A6s A8o KTo QTs A4s A7o K8s A3s QJo K9o A5o A6o Q9s K7s JTs A2s QTo 44 A4o K6s K8o Q8s A3o K5s J9s Q9o JTo " +
  "K7o A2o K4s Q7s K6o K3s T9s J8s 33 Q6s Q8o K5o J9o K2s Q5s T8s K4o J7s Q4s Q7o T9o J8o K3o Q6o Q3s 98s T7s J6s K2o 22 " +
  "Q2s Q5o J5s T8o J7o Q4o 97s J4s T6s J3s Q3o 98o 87s T7o J6o 96s J2s Q2o T5s J5o T4s 97o 86s J4o T6o 95s T3s 76s J3o " +
  "87o T2s 85s 96o J2o T5o 94s 75s T4o 93s 86o 65s 84s 95o T3o 92s 76o 74s T2o 54s 85o 64s 83s 94o 75o 82s 73s 93o 65o " +
  "53s 63s 84o 92o 43s 74o 72s 54o 64o 52s 62s 83o 42s 82o 73o 53o 63o 32s 43o 72o 52o 62o 42o 32o").split(" ");
const RANK_ORDER = RANKING.map((n) => CLS_NAME.indexOf(n));
const RANK_CUM = new Float32Array(NCLS); // 그 클래스보다 강한 조합 비율
{
  let cum = 0;
  for (const c of RANK_ORDER) { RANK_CUM[c] = cum / NC; cum += CLS_SIZE[c]; }
}
const TOP_CACHE = new Map();
// 상위 w 비율 레인지 (경계 클래스는 부분 가중치)
function rankTop(w) {
  const key = Math.round(clamp(w, 0, 1) * 2000);
  let out = TOP_CACHE.get(key);
  if (out) return out;
  out = new Float32Array(NCLS);
  const n = (key / 2000) * NC;
  for (let c = 0; c < NCLS; c++) out[c] = clamp((n - RANK_CUM[c] * NC) / CLS_SIZE[c], 0, 1);
  TOP_CACHE.set(key, out);
  return out;
}

// ===== 프리플롭 차트 (100bb 6맥스 기준, ":w"는 혼합 빈도) =====
// 오픈(RFI) — 목표: UTG ~17% · HJ ~21% · CO ~28% · BTN ~44% · SB ~40%(레이즈 or 폴드) · 헤즈업 BTN ~83%
const RFI_SRC = {
  UTG: "66+, 55:0.7, 44:0.5, 33:0.4, 22:0.4, A2s+, KTs+, K9s:0.5, QTs+, Q9s:0.5, JTs, J9s:0.5, T9s, 98s:0.5, 87s:0.3, 76s:0.3, 65s:0.3, AJo+, ATo:0.6, KQo, KJo:0.6, QJo:0.3",
  HJ: "22+, A2s+, K8s+, K7s:0.4, Q9s+, J9s+, T8s:0.5, T9s, 98s, 87s:0.7, 76s:0.6, 65s:0.5, 54s:0.3, ATo+, A9o:0.3, KJo+, KTo:0.4, QJo:0.7",
  CO: "22+, A2s+, K5s+, K4s:0.5, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s:0.5, 76s, 65s, 54s, A8o+, A7o:0.4, A5o:0.2, KTo+, QTo+, JTo",
  BTN: "22+, A2s+, K2s+, Q4s+, Q3s:0.5, J6s+, T6s+, 96s+, 85s+, 74s+, 64s+, 53s+, 43s:0.5, A2o+, K8o+, K7o:0.5, Q9o+, J9o+, T9o, T8o:0.4, 98o:0.4",
  SB: "22+, A2s+, K2s+, Q5s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, 53s:0.5, A2o+, K9o+, K8o:0.5, QTo+, Q9o:0.4, JTo, J9o:0.3, T9o:0.4",
  HU: "22+, A2s+, K2s+, Q2s+, J2s+, T2s+, 92s+, 82s+, 72s+, 62s+, 52s+, 42s+, 32s, A2o+, K2o+, Q2o+, J4o+, J3o:0.3, J2o:0.3, T6o+, T5o:0.5, 95o+, 85o+, 74o+, 64o+, 54o, 53o:0.3",
};
// 오픈에 대한 대응: [3벳, 콜]. 키 = 내 자리_오프너 그룹 (EP = UTG/HJ)
const DEF_SRC = {
  IP_EP: ["QQ+, AKs, AKo:0.7, JJ:0.3, AQs:0.4, A5s:0.5, A4s:0.4, KQs:0.3, KJs:0.15",
    "JJ:0.7, TT-66, 55:0.5, 44:0.4, 33:0.3, 22:0.3, AQs:0.6, AJs-ATs, A9s:0.3, KQs:0.7, KJs:0.85, KTs:0.5, QJs, QTs:0.5, JTs, T9s:0.6, 98s:0.4, AKo:0.3, AQo:0.6, AJo:0.2, KQo:0.3"],
  IP_CO: ["JJ+, TT:0.5, AQs+, AJs:0.5, AKo, AQo:0.6, AJo:0.3, KQo:0.4, A5s-A3s:0.6, A2s:0.3, KQs:0.5, KJs:0.4, K9s:0.3, QJs:0.3, 76s:0.3, 65s:0.3",
    "TT:0.5, 99-22, AJs:0.5, ATs-A6s, A5s-A3s:0.4, A2s:0.5, KQs:0.5, KJs:0.6, KTs, QJs:0.7, QTs, Q9s:0.5, JTs, J9s, T9s, T8s:0.5, 98s, 97s:0.4, 87s:0.7, 76s:0.7, 65s:0.5, AQo:0.4, AJo:0.6, ATo:0.5, KQo:0.6, KJo:0.4, QJo:0.3"],
  SB_EP: ["QQ+, AKs, AKo, JJ:0.8, TT:0.4, AQs:0.8, AJs:0.4, KQs:0.6, A5s:0.6, A4s:0.4, AQo:0.3, KJs:0.2",
    "JJ:0.2, TT:0.4, 99:0.5, 88:0.4, 77:0.3, AQs:0.2, AJs:0.3, KQs:0.3, QJs:0.2, JTs:0.2"],
  SB_CO: ["TT+, 99:0.6, 88:0.3, AJs+, ATs:0.7, A5s-A2s:0.6, KQs, KJs:0.8, KTs:0.5, QJs:0.6, QTs:0.3, JTs:0.4, AQo+, AJo:0.6, KQo:0.6, 76s:0.2, 65s:0.2",
    "99:0.3, 88:0.4, 77:0.4, 66:0.3, ATs:0.3, A9s:0.3, KTs:0.3, QJs:0.3, JTs:0.4, T9s:0.4, 98s:0.3"],
  SB_BTN: ["88+, 77:0.6, 66:0.4, ATs+, A9s:0.7, A8s:0.5, A5s-A2s:0.7, KTs+, K9s:0.5, QTs+, JTs, T9s:0.5, 98s:0.3, 87s:0.3, 76s:0.3, AJo+, ATo:0.6, KQo, KJo:0.5, QJo:0.3",
    "77:0.4, 66:0.5, 55:0.5, 44:0.4, A9s:0.3, A8s:0.4, A7s:0.5, A6s:0.5, K9s:0.4, Q9s:0.5, J9s:0.5, T9s:0.5, 98s:0.5, 87s:0.5, 76s:0.5, 65s:0.4"],
  BB_EP: ["QQ+, AKs, AKo:0.8, JJ:0.3, AQs:0.4, A5s:0.6, A4s:0.4, KQs:0.2, 65s:0.15, 54s:0.15",
    "JJ:0.7, TT-22, AQs:0.6, AJs-A6s, A5s:0.4, A4s:0.6, A3s-A2s, K9s+, KQs:0.8, Q9s+, J9s+, T8s+, 97s+, 86s+, 76s, 75s:0.5, 65s:0.85, 54s:0.85, 64s:0.4, K8s-K6s:0.5, Q8s:0.5, J8s:0.5, 96s:0.3, 85s:0.3, 53s:0.3, AQo, AKo:0.2, AJo, ATo:0.7, A9o:0.3, KQo, KJo:0.6, KTo:0.4, QJo:0.4, QTo:0.3, JTo:0.4"],
  BB_CO: ["JJ+, TT:0.5, AQs+, AJs:0.5, AKo, AQo:0.6, AJo:0.3, KJo:0.2, A5s-A2s:0.5, KQs:0.5, K9s:0.3, QJs:0.3, 76s:0.3, 65s:0.3, 54s:0.3",
    "TT:0.5, 99-22, AJs:0.5, ATs-A6s, A5s-A2s:0.5, KQs:0.5, KJs-K6s, K9s:0.7, K5s-K2s:0.5, QJs:0.7, QTs-Q7s, Q6s:0.5, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 76s:0.7, 65s:0.7, 54s:0.7, 53s:0.5, 43s:0.3, Q5s-Q4s:0.4, J6s:0.4, T6s:0.4, 95s:0.3, 84s:0.3, 74s:0.3, 63s:0.3, 52s:0.2, 42s:0.2, AQo:0.4, AJo:0.7, ATo-A8o, A7o:0.5, A6o:0.4, A5o:0.5, A4o-A2o:0.3, KTo+, KJo:0.8, K9o:0.8, K8o:0.3, QTo+, Q9o:0.6, JTo, J9o:0.6, T9o:0.6, T8o:0.3, 98o:0.4, 97o:0.2, 87o:0.3"],
  BB_BTN: ["TT+, 99:0.5, 88:0.3, ATs+, A9s:0.4, A5s-A2s:0.6, KJs+, KTs:0.6, K9s:0.4, K5s:0.3, QJs:0.6, QTs:0.4, Q9s:0.3, JTs:0.4, T9s:0.3, 76s:0.3, 65s:0.3, 54s:0.3, AJo+, ATo:0.5, KQo:0.6, KJo:0.3",
    "99:0.5, 88:0.7, 77-22, A9s:0.6, A8s-A6s, A5s-A2s:0.4, KTs:0.4, K9s:0.6, K8s-K6s, K5s:0.7, K4s-K2s, QJs:0.4, QTs:0.6, Q9s:0.7, Q8s-Q2s, JTs:0.6, J9s-J4s, T9s:0.7, T8s-T5s, 98s-95s, 87s-84s, 76s:0.7, 75s-73s, 65s:0.7, 64s-63s, 54s:0.7, 53s, 52s:0.5, 43s, 42s:0.3, ATo:0.5, A9o-A2o, KQo:0.4, KJo:0.7, KTo-K7o, K6o:0.6, K5o:0.4, QTo+, Q9o-Q8o, Q7o:0.4, JTo, J9o-J8o, J7o:0.3, T9o, T8o, T7o:0.3, 98o, 97o:0.4, 87o, 86o:0.3, 76o, 65o:0.4"],
  BB_SB: ["99+, 88:0.5, A9s+, A8s:0.5, A5s-A2s:0.7, KTs+, K9s:0.5, QTs+, JTs:0.6, T9s:0.4, 87s:0.3, 76s:0.3, 65s:0.3, AJo+, ATo:0.6, KQo, KJo:0.5, QJo:0.3",
    "88:0.5, 77-22, A8s:0.5, A7s-A6s, A5s-A2s:0.3, K9s:0.5, K8s-K2s, Q9s-Q4s, Q3s:0.5, JTs:0.4, J9s-J5s, T9s:0.6, T8s-T6s, 98s-96s, 87s:0.7, 86s-85s, 76s:0.7, 75s-74s, 65s:0.7, 64s, 54s, 53s:0.5, 43s:0.3, ATo:0.4, A9o-A2o, KJo:0.5, KTo-K8o, K7o:0.5, QJo:0.7, QTo-Q9o, Q8o:0.4, JTo, J9o, J8o:0.4, T9o, T8o:0.5, 98o, 97o:0.3, 87o:0.4, 76o:0.3"],
  HU_BB: ["77+, 66:0.5, A8s+, A7s:0.5, A5s-A2s:0.6, KTs+, K9s:0.5, K5s:0.3, QTs+, Q9s:0.2, JTs, T9s:0.5, 98s:0.3, 87s:0.3, 76s:0.3, ATo+, KJo+, KTo:0.4, QJo:0.4",
    "66:0.5, 55-22, A9o-A2o, A7s:0.5, A6s, A5s-A2s:0.4, K9s:0.5, K8s-K2s, K5s:0.7, KTo:0.6, K9o-K5o, K4o-K2o:0.5, Q9s:0.8, Q8s-Q2s, QJo:0.6, QTo-Q6o, Q5o:0.5, J9s-J2s, JTo-J7o, J6o:0.5, T9s:0.5, T8s-T3s, T9o-T7o, 98s:0.7, 97s-94s, 98o-97o, 87s:0.7, 86s-84s, 87o-86o, 76s:0.7, 75s-73s, 76o:0.6, 65s-63s, 65o:0.4, 54s-53s, 43s"],
};
// 3벳을 맞았을 때: [4벳, 콜]
const VS3_SRC = {
  OOP: ["KK+, AKs, QQ:0.5, AKo:0.5, A5s:0.3, A4s:0.2, KQs:0.1",
    "QQ:0.5, JJ-88, 77:0.5, 66:0.3, AKo:0.4, AQs, AJs, ATs:0.5, KQs:0.8, KJs:0.5, QJs:0.5, JTs:0.5, T9s:0.3, 98s:0.2, AQo:0.4, A5s:0.4, A4s:0.3"],
  OOP_LP: ["QQ+, AKs, AKo:0.7, JJ:0.3, AQs:0.3, A5s:0.4, A4s:0.3, KJs:0.1",
    "JJ:0.7, TT-77, 66:0.5, 55:0.3, AQs:0.7, AJs-ATs, A9s:0.5, KQs, KJs:0.8, KTs:0.6, QJs:0.8, QTs:0.4, JTs:0.8, T9s:0.6, 98s:0.4, 87s:0.3, AKo:0.3, AQo:0.6, AJo:0.2, KQo:0.3, A5s:0.4, A4s:0.4"],
  IP: ["QQ+, AKs, AKo:0.8, JJ:0.3, AQs:0.3, A5s:0.4, A4s:0.4, A3s:0.2, KJs:0.1",
    "JJ:0.7, TT-66, 55:0.6, 44:0.5, 33:0.5, 22:0.5, AQs:0.7, AJs-A9s, A8s:0.5, A5s:0.4, A4s:0.4, A3s:0.3, KQs, KJs:0.9, KTs, K9s:0.5, K8s:0.5, QJs, QTs, Q9s:0.4, Q8s:0.3, JTs, J9s:0.5, J8s:0.4, T9s, T8s:0.5, 98s:0.7, 97s:0.4, 87s:0.6, 86s:0.3, 76s:0.5, 75s:0.3, 65s:0.4, 54s:0.4, AKo:0.2, AQo:0.8, AJo:0.5, ATo:0.4, KQo:0.6, KJo:0.4, QJo:0.3"],
  SB: ["QQ+, AKs, AKo:0.7, JJ:0.3, A5s:0.4, A4s:0.3",
    "JJ:0.7, TT-55, AQs-A8s, KTs+, QTs+, JTs, T9s, 98s:0.5, 87s:0.4, AKo:0.3, AQo, AJo:0.5, KQo:0.5, A5s:0.4, A4s:0.3"],
  HU: ["QQ+, AKs, AKo, JJ:0.4, AQs:0.4, A5s-A4s:0.4, A3s:0.3, K9s:0.1",
    "JJ:0.6, TT-22, AQs:0.6, AJs-A6s, A5s-A4s:0.5, A3s-A2s:0.7, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 53s+, A2o+, K9o+, Q9o+, J9o+, T9o, 98o:0.5"],
  SQZ: ["KK+, AKs, QQ:0.4", "QQ:0.6, JJ-99, 88:0.5, AKo, AQs, AJs:0.6, KQs:0.6, JTs:0.4, T9s:0.3, 77-22:0.25"],
  COLD: ["KK+, AKs:0.7, QQ:0.4, A5s:0.1", "QQ:0.5, JJ:0.4, AKs:0.3, AKo:0.4, TT:0.2"],
};
// 4벳 이상을 맞았을 때: [올인, 콜]
const VS4_SRC = {
  B4: ["KK+, AKs, QQ:0.5, AKo:0.5, A5s:0.15, A4s:0.1", "QQ:0.5, JJ:0.5, AKo:0.3, AQs:0.3, TT:0.2, KQs:0.1, AJs:0.1"],
  COLD4: ["KK+, AKs:0.5", "QQ:0.2"],
  B5: ["AA, KK:0.5", "KK:0.5, QQ, AKs, AKo:0.7, JJ:0.4"],
};
// 림프 팟: [아이솔레이션 레이즈, 오버림프·컴플리트(BB는 체크)]
const LIMP_SRC = {
  ISO: ["77+, A9s+, ATo+, KTs+, KJo+, QTs+, JTs, A5s-A4s:0.5", "66-22:0.5, T9s:0.4, 98s:0.4, 87s:0.4, 76s:0.4, 65s:0.4, A8s-A6s:0.3"],
  SB: ["88+, ATs+, AJo+, KJs+, KQo, A5s:0.4",
    "77-22, A9s-A2s, K9s-K2s:0.6, KTs:0.6, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 64s+, 54s, ATo:0.5, A9o-A2o:0.5, KJo:0.6, KTo-K8o:0.5, QTo+, JTo, T9o:0.6, 98o:0.4"],
  BB: ["88+, ATs+, AJo+, KQs, KJs:0.6, KQo:0.6, A5s:0.4", ""],
  HU_BB: ["55+, A2s+, K8s+, Q9s+, J9s+, T9s, A7o+, KTo+, QJo, 98s:0.5, 87s:0.5, 76s:0.5, 65s:0.4, A5o-A2o:0.4", ""], // 블라인드 대 블라인드에도 쓴다
};
// 푸시/폴드: 10bb 기준 올인 비율 (앤티 없음), 스택이 얕을수록 넓힌다
const PUSH10 = { UTG: 0.12, HJ: 0.15, CO: 0.2, BTN: 0.3, SB: 0.52, HU: 0.58 };
const PUSH_BB = 13, MID_BB = 25;

function pairChart([r, c]) {
  const R = parseRange(r), Cc = parseRange(c);
  for (let i = 0; i < NCLS; i++) Cc[i] = Math.min(Cc[i], Math.max(0, 1 - R[i]));
  const out = { r: R, c: Cc };
  out.def = rangePct(R) + rangePct(Cc);
  return out;
}
const mapObj = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
const RFI = mapObj(RFI_SRC, parseRange);
const DEF = mapObj(DEF_SRC, pairChart);
const VS3 = mapObj(VS3_SRC, pairChart);
const VS4 = mapObj(VS4_SRC, pairChart);
const LIMP = mapObj(LIMP_SRC, pairChart);
const ZERO = new Float32Array(NCLS);

const mulArr = (a, k) => a.map((v) => v * k);
const oneMinus = (a) => a.map((v) => Math.max(0, 1 - v));
function widen(r, c, w) { // BB가 싼 가격에 콜을 넓힌다
  const t = rankTop(w), out = new Float32Array(NCLS);
  for (let i = 0; i < NCLS; i++) out[i] = clamp(Math.max(c[i], t[i] - r[i]), 0, Math.max(0, 1 - r[i]));
  return out;
}
const rangeWidth = (W) => { let t = 0; for (let i = 0; i < NC; i++) t += W[i]; return t / NC; };
// 레인지 R(클래스 가중치) 안에서 RANKING 순 상위 q 비율에 드는 몫 (경계 클래스는 부분)
function topShare(R, q) {
  let need = 0;
  for (let c = 0; c < NCLS; c++) need += R[c] * CLS_SIZE[c];
  need *= q;
  const out = new Float32Array(NCLS);
  for (const c of RANK_ORDER) {
    if (need <= 0) break;
    const m = R[c] * CLS_SIZE[c];
    if (m <= 0) continue;
    out[c] = Math.min(1, need / m);
    need -= m;
  }
  return out;
}
// 추적 레인지(조합 가중치)를 바닥값을 걷어낸 클래스 가중치로: 내 레인지가 실제로 어땠는지
function ownRange(W) {
  let mx = 0;
  for (let i = 0; i < NC; i++) if (W[i] > mx) mx = W[i];
  const sum = new Float64Array(NCLS), out = new Float32Array(NCLS);
  for (let i = 0; i < NC; i++) sum[CLS[i]] += W[i];
  for (let c = 0; c < NCLS; c++) out[c] = mx > 0 ? clamp((sum[c] / (CLS_SIZE[c] * mx) - 0.045) / 0.955, 0, 1) : 0;
  return out;
}

// ===== 액션 재생 (공개 정보만) =====
// 좌석별 레인지(W), 스택·베팅, 프리플롭 레이즈 기록, 스트리트별 마지막 공격자를 재구성한다.
const CACHE = new WeakMap();
const STATS = { trackErrors: 0, lastError: "" };
function newReplay(h) {
  const N = h.start.length;
  const inHand = new Array(N).fill(false);
  for (const s of h.seats) inHand[s] = true;
  const st = {
    no: h.no, N, seats: h.seats.slice(), button: h.button, sb: h.sb, bb: h.bb,
    pos: PT.positionsOf(h),
    stack: h.start.slice(), bets: new Array(N).fill(0), contrib: new Array(N).fill(0),
    folded: inHand.map((x) => !x),
    street: 0, maxBet: 0, nBets: 0,
    raises: [], limpers: [], callers: [], preActs: new Array(N).fill(0),
    aggr: [-1, -1, -1, -1],
    acted: new Array(N).fill(false),
    W: inHand.map((x) => (x ? new Float64Array(NC).fill(1) : null)),
    idx: 0,
  };
  st.ord = [];
  const n = st.seats.length, bi = st.seats.indexOf(st.button);
  st.seats.forEach((s, i) => { st.ord[s] = (i - bi - 1 + 2 * n) % n; });
  return st;
}
function advanceStreet(st, k) {
  while (st.street < k) {
    st.street++;
    st.bets.fill(0);
    st.maxBet = 0;
    st.nBets = 0;
    st.acted.fill(false);
  }
}
function payIn(st, s, a) { st.stack[s] -= a; st.bets[s] += a; st.contrib[s] += a; }

function stepReplay(st, h, a) {
  if (a.street > st.street) advanceStreet(st, a.street);
  const s = a.seat;
  if (a.type === "sb" || a.type === "bb") {
    payIn(st, s, a.amount);
    st.maxBet = Math.max(st.maxBet, st.bets[s]);
    return;
  }
  if (a.type === "return") {
    st.stack[s] += a.amount; st.bets[s] -= a.amount; st.contrib[s] -= a.amount;
    st.maxBet = Math.max(0, ...st.seats.map((x) => st.bets[x]));
    return;
  }
  const kind = a.type === "fold" ? 0 : a.type === "check" || a.type === "call" ? 1 : 2;
  if (st.W[s]) {
    try { observe(st, h, s, kind, a); } catch (e) { STATS.trackErrors++; STATS.lastError = String(e && e.stack || e); } // 레인지 갱신 실패는 건너뛴다
  }
  if (a.type === "fold") st.folded[s] = true;
  else if (a.type === "call") {
    payIn(st, s, a.amount);
    if (st.street === 0) (st.raises.length ? st.callers : st.limpers).push(s);
  } else if (a.type === "bet" || a.type === "raise") {
    const from = st.bets[s];
    payIn(st, s, a.to - st.bets[s]);
    st.maxBet = Math.max(st.maxBet, a.to);
    st.aggr[st.street] = s;
    st.nBets++;
    if (st.street === 0) {
      let n = 0; // 이 레이즈를 마주하는(칩이 남은) 사람 수
      for (const o of st.seats) if (o !== s && !st.folded[o] && st.stack[o] > 0) n++;
      st.raises.push({ seat: s, to: a.to, from, n, allin: !!a.allin });
      st.callers = [];
    }
  }
  st.acted[s] = true;
  if (st.street === 0) st.preActs[s]++;
}

// 같은 모델로 계산한 '그 액션을 할 확률'을 곱해 레인지를 좁힌다
function observe(st, h, s, kind, a) {
  const W = st.W[s];
  if (st.street === 0) {
    const x = preCtx(st, s), S = preStrat(x);
    const canR = x.canRaise;
    const allin = kind === 2 && !!(a && a.allin);
    // 모델이 올인하지 않는 깊이에서 올인했다: 일반 레이즈 차트 대신 크기에 맞춘 좁은 올인 레인지로 본다
    let jamR = null;
    if (allin && S.to !== JAM && x.effBB > PUSH_BB) {
      const key = x.hu ? "HU" : PUSH10[x.pos] ? x.pos : "BTN";
      jamR = rankTop(clamp(x.raises.length ? 0.5 * rangePct(S.r) : pushWidth(key, x.effBB), 0.02, 1));
    }
    const fl = allin ? 0.004 : FLOOR; // 올인은 바닥값을 낮춰 좁은 레인지가 쓰레기 패로 부풀지 않게
    const lik = new Float32Array(NCLS);
    for (let c = 0; c < NCLS; c++) {
      let r = jamR ? jamR[c] : S.r[c], cc = S.c[c];
      if (!canR) { cc = Math.min(1, cc + r); r = 0; }
      const v = kind === 2 ? r : kind === 1 ? cc : 1 - r - cc;
      lik[c] = v > fl ? v : fl;
    }
    for (let i = 0; i < NC; i++) W[i] *= lik[CLS[i]];
  } else {
    const E = postEval(st, s, h.board.slice(0, st.street + 2));
    const blocked = E.tab.blocked;
    for (let i = 0; i < NC; i++) {
      if (blocked[i] || W[i] === 0) continue;
      const v = comboProbs(E.plan, i, E.e[i])[kind];
      W[i] *= v > FLOOR ? v : FLOOR;
    }
  }
  let mx = 0;
  for (let i = 0; i < NC; i++) if (W[i] > mx) mx = W[i];
  if (mx > 0 && mx < 1e-200) for (let i = 0; i < NC; i++) W[i] /= mx;
}

function tracked(h) {
  let st = CACHE.get(h);
  if (!st || st.no !== h.no || st.idx > h.actions.length) { st = newReplay(h); CACHE.set(h, st); }
  while (st.idx < h.actions.length) stepReplay(st, h, h.actions[st.idx++]);
  if (h.street > st.street) advanceStreet(st, h.street);
  return st;
}

// ===== 프리플롭 =====
function preCtx(st, s) {
  const alive = st.seats.filter((o) => !st.folded[o]);
  let pot = 0;
  for (const o of st.seats) pot += st.contrib[o];
  let maxOther = 0, othersCanAct = false;
  for (const o of alive) if (o !== s) { maxOther = Math.max(maxOther, st.stack[o] + st.bets[o]); if (st.stack[o] > 0) othersCanAct = true; }
  const eff = Math.min(st.stack[s] + st.bets[s], maxOther);
  const toCall = Math.max(0, Math.min(st.maxBet - st.bets[s], st.stack[s]));
  return {
    st, s, pos: st.pos[s], n: st.seats.length, hu: st.seats.length === 2, alive,
    raises: st.raises, limpers: st.limpers, callers: st.callers, acted: st.preActs[s] > 0,
    toCall, pot, eff, effBB: eff / st.bb, bb: st.bb, sb: st.sb,
    myBet: st.bets[s], myStack: st.stack[s], maxBet: st.maxBet,
    canRaise: othersCanAct && st.stack[s] > toCall,
  };
}
const capJam = (x, to) => (to - x.myBet >= 0.4 * (x.myStack) ? JAM : to);
const grp = (pos) => (pos === "UTG" || pos === "HJ" ? "EP" : pos);
function defKey(heroPos, oPos) {
  const og = grp(oPos);
  let k;
  if (heroPos === "BB") k = "BB_" + og;
  else if (heroPos === "SB") k = "SB_" + (og === "SB" ? "BTN" : og);
  else k = og === "EP" ? "IP_EP" : "IP_CO";
  // 블라인드가 림프 팟에서 올린 경우 등 차트가 없는 조합은 가장 보수적인 차트로
  return DEF[k] ? k : heroPos === "BB" ? "BB_EP" : heroPos === "SB" ? "SB_EP" : "IP_EP";
}

// 프리플롭 전략: 클래스별 레이즈(r)·콜(c) 확률과 레이즈 목표액(to). 폴드 = 나머지
function preStrat(x) {
  const nR = x.raises.length;
  if (nR === 0) return x.limpers.length ? limpStrat(x) : rfiStrat(x);
  const last = x.raises[nR - 1];
  if (last.allin || x.toCall >= 0.45 * x.myStack) return jamStrat(x, last);
  if (nR === 1) return openStrat(x);
  if (nR === 2) return threeBetStrat(x);
  if (nR === 3) {
    const own = x.raises[1].seat === x.s;
    const ch = own ? VS4.B4 : VS4.COLD4;
    let r = ch.r, c = x.effBB < 60 ? mulArr(ch.c, 0.6) : ch.c;
    if (own) { // 내 3벳 레인지 기준: 상위 ~18%는 올인, 상위 ~45%까지는 계속한다 (고정 차트만 쓰면 4벳에 너무 많이 접는다)
      const R = ownRange(x.st.W[x.s]), jam = topShare(R, 0.18), cont = topShare(R, 0.45);
      r = r.map((v, i) => Math.max(v, jam[i]));
      c = c.map((v, i) => clamp(Math.max(v, cont[i] - r[i]), 0, 1 - r[i]));
    }
    return { r, c, to: JAM, spot: own ? "facing 4bet" : "cold vs 4bet" };
  }
  return { r: VS4.B5.r, c: VS4.B5.c, to: JAM, spot: "facing 5bet+" };
}
function pushWidth(key, effBB, k = 1) {
  return clamp(PUSH10[key] * k * Math.pow(10 / Math.max(effBB, 0.5), 0.65), 0.02, 1);
}
function rfiStrat(x) {
  const key = x.hu ? "HU" : RFI[x.pos] ? x.pos : "BTN";
  if (x.effBB <= PUSH_BB) return { r: rankTop(pushWidth(key, x.effBB)), c: ZERO, to: JAM, spot: "RFI push/fold" };
  let mult = x.effBB >= 60 ? 2.5 : x.effBB >= 35 ? 2.2 : 2.0;
  if (x.pos === "SB" && !x.hu) mult += 0.5;
  return { r: RFI[key], c: ZERO, to: capJam(x, mult * x.bb), spot: "RFI" };
}
function limpStrat(x) {
  const nL = x.limpers.length, bb = x.bb;
  // 블라인드 대 블라인드(SB 혼자 림프)는 팟 안의 사람 수로 보면 헤즈업과 같다
  const bvb = x.hu || (x.pos === "BB" && nL === 1 && x.st.pos[x.limpers[0]] === "SB");
  if (x.effBB <= PUSH_BB) {
    const r = rankTop(pushWidth(bvb ? "HU" : PUSH10[x.pos] ? x.pos : "BTN", x.effBB, 0.75));
    return { r, c: x.pos === "BB" ? oneMinus(r) : ZERO, to: JAM, spot: "vs limp push/fold" };
  }
  if (x.pos === "BB") {
    const ch = bvb ? LIMP.HU_BB : LIMP.BB;
    return { r: ch.r, c: oneMinus(ch.r), to: capJam(x, (bvb ? 3.5 : 3.5 + nL) * bb), spot: "BB vs limp" };
  }
  if (x.pos === "SB") return { r: LIMP.SB.r, c: LIMP.SB.c, to: capJam(x, (4 + nL) * bb), spot: "SB vs limp" };
  return { r: LIMP.ISO.r, c: LIMP.ISO.c, to: capJam(x, (3 + nL) * bb), spot: `vs ${nL} limper${nL > 1 ? "s" : ""}` };
}
function openStrat(x) {
  const st = x.st, op = x.raises[0], oPos = st.pos[op.seat], ncall = x.callers.length;
  const z = op.to / x.bb;
  const ch = DEF[x.hu ? "HU_BB" : defKey(x.pos, oPos)];
  const label = `vs open (${oPos})`;
  if (x.effBB <= PUSH_BB) {
    const ow = rangeWidth(st.W[op.seat]);
    const r = rankTop(clamp(ow * 0.55 * Math.pow(PUSH_BB / Math.max(x.effBB, 1), 0.3) * Math.pow(0.7, ncall), 0.02, 0.8));
    let c = ZERO;
    if (x.pos === "BB" && z <= 2.6 && ncall === 0) c = ch.c.map((v, i) => clamp(v * 0.6, 0, 1 - r[i]));
    return { r, c, to: JAM, spot: label + " jam/fold" };
  }
  let r = ch.r, c = ch.c;
  if (z > 3.2) { // 큰 오픈엔 더 좁게
    r = mulArr(r, clamp(1 - (z - 3.2) * 0.06, 0.6, 1));
    c = mulArr(c, clamp(1 - (z - 3.2) * 0.15, 0.3, 1));
  }
  if (x.pos === "BB" && ncall === 0 && z < 2.5) c = widen(r, c, ch.def + (2.5 - z) * 0.2);
  if (ncall > 0) { // 스퀴즈: 밸류 위주, 콜은 줄인다
    const top = rankTop(0.06);
    r = r.map((v, i) => v * (top[i] > 0.5 ? 1 : 0.5));
    c = mulArr(c, x.pos === "BB" ? 0.9 : 0.6);
  }
  if (x.acted) { // 림프했다가 레이즈를 맞음: 레이즈는 최상위만
    const top = rankTop(0.04);
    c = c.map((v, i) => Math.min(1, v + r[i] * (1 - top[i])));
    r = r.map((v, i) => v * top[i]);
  }
  if (x.effBB <= MID_BB) { // 15~25bb: 3벳 = 올인 (차트의 밸류 + 오프너 레인지 폭에 맞춘 상위 핸드), 콜은 줄인다
    const ow = rangeWidth(st.W[op.seat]);
    const jt = rankTop(clamp(ow * 0.2 * Math.pow(MID_BB / x.effBB, 0.4) * Math.pow(0.7, ncall), 0.03, 0.4));
    const vt = rankTop(0.12), keep = x.pos === "BB" ? 0.75 : 0.45;
    const r2 = new Float32Array(NCLS), c2 = new Float32Array(NCLS);
    for (let i = 0; i < NCLS; i++) { r2[i] = Math.max(r[i] * vt[i], jt[i]); c2[i] = Math.min(c[i], 1 - r2[i]) * keep; }
    return { r: r2, c: c2, to: JAM, spot: label + " jam/call" };
  }
  const ip = st.ord[x.s] > st.ord[op.seat];
  const mult = ip ? 3 : x.hu ? 3.6 : 4;
  const to = capJam(x, op.to * (mult + (ncall ? 0.5 : 0)) + ncall * op.to);
  const spot = ncall ? `squeeze vs open (${oPos}) + ${ncall} caller${ncall > 1 ? "s" : ""}` : `${label} 3bet/call`;
  return { r, c, to, spot };
}
function threeBetStrat(x) {
  const st = x.st, [o, t] = x.raises;
  let key;
  if (o.seat === x.s) {
    const lp = grp(x.pos) !== "EP", ipv = st.ord[x.s] > st.ord[t.seat];
    key = x.hu ? "HU" : x.pos === "SB" ? "SB" : ipv ? (lp ? "IP" : "OOP_LP") : lp ? "OOP_LP" : "OOP";
  }
  else key = x.acted ? "SQZ" : "COLD";
  const ch = VS3[key];
  const ip3 = st.ord[x.s] > st.ord[t.seat];
  const spot = key === "SQZ" ? "facing squeeze" : key === "COLD" ? "cold vs 3bet" : ip3 ? "facing 3bet IP" : "facing 3bet OOP";
  let r = ch.r, c = ch.c;
  if (o.seat === x.s && st.preActs[x.s] === 1) { // 내가 오픈했다: 내 오픈 레인지의 상위 q는 계속한다 (공용 차트만 쓰면 넓은 오픈이 3벳에 너무 많이 접는다)
    const q = x.hu ? 0.6 : ip3 ? 0.55 : 0.5;
    const cont = topShare(ownRange(st.W[x.s]), q);
    c = c.map((v, i) => clamp(Math.max(v, cont[i] - r[i]), 0, 1 - r[i]));
  }
  const ratio = t.to / Math.max(o.to, 1);
  if (ratio > 4.5) c = mulArr(c, clamp(1 - (ratio - 4.5) * 0.12, 0.5, 1));
  if (x.callers.length) c = mulArr(c, 0.7);
  if (x.effBB <= MID_BB + 15) { // 40bb 이하: 4벳은 올인(3벳터 레인지 폭에 맞춘 상위 핸드), 플랫은 거의 안 한다
    const jt = rankTop(clamp(rangeWidth(st.W[t.seat]) * 0.9, 0.03, 0.3)), vt = rankTop(0.1);
    const keep = x.effBB <= 30 ? 0.15 : 0.4;
    const r2 = r.map((v, i) => Math.max(v * vt[i], jt[i]));
    c = c.map((v, i) => Math.min(v, 1 - r2[i]) * keep);
    r = r2;
  }
  const ip = st.ord[x.s] > st.ord[t.seat];
  return { r, c, to: capJam(x, t.to * (ip ? 2.2 : 2.5)), spot };
}
function jamStrat(x, last) {
  const st = x.st, jammer = last.seat;
  const jw = Math.max(0.02, rangeWidth(st.W[jammer]));
  const po = x.toCall / (x.pot + x.toCall);
  let cw = jw * (0.65 + 1.5 * (0.45 - po)) * Math.pow(0.6, x.callers.length);
  cw = clamp(cw, 0.015, 1);
  let behind = 0;
  for (const o of x.alive) if (o !== x.s && o !== jammer && !x.callers.includes(o) && st.stack[o] > 0 && st.bets[o] < st.maxBet) behind++;
  const canRe = !last.allin && x.myStack > x.toCall && x.canRaise;
  // 최소 방어: 쓰레기 패(콜 레인지 상대 승률 ~33%)의 올인이 폴드보다 이득이 되지 않을 만큼은 내 레인지 상위로 계속한다.
  // 상대 레인지를 좁게 읽어도 '아무 패나 올인'에 무너지지 않게 하는 장치. 앞에서 이미 누가 콜했으면 필요 없다
  let fl = null;
  if (!x.callers.length && last.from != null) {
    const inc = last.to - last.from, J = Math.min(last.to, x.myBet + x.myStack) - last.from;
    const P0 = x.pot - inc, L = J - 0.33 * (P0 + J + x.toCall);
    const dmin = L > 0 ? P0 / (P0 + L) : 1;
    const d = 1 - Math.pow(1 - clamp(dmin, 0, 1), 1 / Math.max(1, last.n || 1));
    if (d > 0) fl = topShare(ownRange(st.W[x.s]), d);
  }
  let top = rankTop(cw);
  if (fl) top = top.map((v, i) => Math.max(v, fl[i]));
  return {
    r: canRe ? top : ZERO, c: canRe ? ZERO : top, to: JAM, eqMode: true, canRe, fl,
    po, margin: 0.005 + 0.025 * behind, rel: [jammer, ...x.callers.filter((o) => !st.folded[o])],
    spot: `${last.allin ? "vs all-in" : "vs big raise"} (${st.pos[jammer]})`,
  };
}

// ===== 보드 테이블: 조합별 족보 점수 · 드로우 잠재력 =====
const BOARDS = new Map();
function texture(board) {
  const sc = [0, 0, 0, 0];
  let mask = 0, paired = false;
  for (const c of board) { sc[c & 3]++; const r = c >> 2; if ((mask >> r) & 1) paired = true; mask |= 1 << r; }
  const ms = Math.max(...sc);
  let wet = ms >= 3 ? 0.45 : ms === 2 ? 0.2 : 0;
  const ext = (mask << 1) | ((mask >> 12) & 1); // A를 1로도 센다
  let maxIn = 0;
  for (let lo = 0; lo <= 9; lo++) {
    let w = (ext >> lo) & 31, n = 0;
    while (w) { n += w & 1; w >>= 1; }
    maxIn = Math.max(maxIn, n);
  }
  wet += maxIn >= 3 ? 0.35 : maxIn === 2 ? 0.12 : 0;
  if (paired) wet -= 0.12;
  return clamp(wet, 0, 1);
}
// 플롭·턴에서 좋아질 확률 (플러시·스트레이트 드로우, 오버카드, 백도어)
function drawPot(a, b, nb, cat, bMask, bSuit, bMax, bPaired) {
  if (cat >= 4) return 0;
  const sa = a & 3, sb = b & 3, ra = a >> 2, rb = b >> 2;
  let fd = false, bdfd = false;
  for (let s = 0; s < 4; s++) {
    const own = (sa === s ? 1 : 0) + (sb === s ? 1 : 0);
    if (!own) continue;
    const cnt = bSuit[s] + own;
    if (cnt === 4) fd = true;
    else if (cnt === 3 && nb === 3) bdfd = true;
  }
  const mask = bMask | (1 << ra) | (1 << rb);
  let sOuts = 0;
  for (let r = 0; r < 13; r++) {
    if ((mask >> r) & 1) continue;
    const sh = straightHigh(mask | (1 << r));
    if (sh >= 0 && straightHigh(bMask | (1 << r)) < sh) sOuts++;
  }
  const so = sOuts >= 2 ? 8 : sOuts === 1 ? 4 : 0;
  let outs = (fd ? 9 : 0) + so - (fd && so ? 2 : 0);
  if (cat === 0) outs += ((ra > bMax ? 1 : 0) + (rb > bMax ? 1 : 0)) * 1.5;
  if (bPaired) outs *= 0.75;
  let p = nb === 3 ? 1 - (1 - outs / 47) * (1 - outs / 46) : outs / 46;
  if (nb === 3 && bdfd && !fd) p += 0.04;
  return Math.min(0.6, p);
}
function boardTable(board) {
  const key = board.join(",");
  let t = BOARDS.get(key);
  if (t) return t;
  const nb = board.length;
  const blocked = new Uint8Array(NC), score = new Int32Array(NC), ppot = new Float32Array(NC);
  const used = new Uint8Array(52), bSuit = [0, 0, 0, 0];
  let bMask = 0, bMax = 0, bPaired = false;
  for (const c of board) {
    used[c] = 1; bSuit[c & 3]++;
    const r = c >> 2;
    if ((bMask >> r) & 1) bPaired = true;
    bMask |= 1 << r; bMax = Math.max(bMax, r);
  }
  const cards = [0, 0, ...board], list = [];
  for (let i = 0; i < NC; i++) {
    const a = C1[i], b = C2[i];
    if (used[a] || used[b]) { blocked[i] = 1; continue; }
    cards[0] = a; cards[1] = b;
    const sc = evaluate(cards);
    score[i] = sc;
    list.push(i);
    if (nb < 5) ppot[i] = drawPot(a, b, nb, Math.floor(sc / 1048576), bMask, bSuit, bMax, bPaired);
  }
  list.sort((x, y) => score[x] - score[y]);
  t = { key, blocked, score, ppot, order: Int16Array.from(list), wet: texture(board) };
  BOARDS.set(key, t);
  if (BOARDS.size > 32) BOARDS.delete(BOARDS.keys().next().value);
  return t;
}
// 상대 레인지(가중치 합 opp) 대비 현재 족보 강도: 이기는 비율 + 비기는 비율/2
function strengthVs(tab, opp, out) {
  const order = tab.order, score = tab.score, n = order.length;
  let total = 0;
  for (let j = 0; j < n; j++) total += opp[order[j]];
  if (total <= 0) { for (let j = 0; j < n; j++) out[order[j]] = 0.5; return; }
  let cum = 0, j = 0;
  while (j < n) {
    const sc = score[order[j]];
    let k = j, gw = 0;
    while (k < n && score[order[k]] === sc) { gw += opp[order[k]]; k++; }
    const v = (cum + 0.5 * gw) / total;
    for (let q = j; q < k; q++) out[order[q]] = v;
    cum += gw;
    j = k;
  }
}
// 자기 레인지 안에서의 백분위 (0 = 가장 약함, 1 = 가장 강함)
function percentile(e, W, blocked, tw) {
  const NB = 256, hist = new Float64Array(NB + 1), below = new Float64Array(NB + 1), p = new Float32Array(NC);
  for (let i = 0; i < NC; i++) if (!blocked[i]) hist[(e[i] * NB) | 0] += W[i];
  let c = 0;
  for (let b = 0; b <= NB; b++) { below[b] = c; c += hist[b]; }
  const inv = tw > 0 ? 1 / tw : 0;
  for (let i = 0; i < NC; i++) if (!blocked[i]) { const b = (e[i] * NB) | 0; p[i] = (below[b] + 0.5 * hist[b]) * inv; }
  return p;
}

// ===== 플롭 이후 =====
function postCtx(st, s) {
  const alive = [], opps = [];
  for (const o of st.seats) if (!st.folded[o]) { alive.push(o); if (o !== s) opps.push(o); }
  let pot = 0;
  for (const o of st.seats) pot += st.contrib[o];
  const toCall = Math.max(0, Math.min(st.maxBet - st.bets[s], st.stack[s]));
  const me = st.ord[s];
  const ip = opps.every((o) => st.stack[o] === 0 || st.ord[o] < me);
  const street = st.street, prev = st.aggr[street - 1];
  const prevLive = prev >= 0 && prev !== s && !st.folded[prev] && st.stack[prev] > 0;
  let role;
  if (prev === s) role = "cbet";
  else if (prevLive && !st.acted[prev]) role = "donk";
  else if (prevLive || opps.some((o) => st.acted[o])) role = "stab";
  else role = street >= 2 && prev < 0 ? "probe" : "lead";
  let maxOther = 0, othersCanAct = false;
  for (const o of opps) { maxOther = Math.max(maxOther, st.stack[o] + st.bets[o]); if (st.stack[o] > 0) othersCanAct = true; }
  const effRem = Math.max(0, Math.min(st.stack[s] + st.bets[s], maxOther) - st.bets[s]);
  const agg = st.aggr[street];
  let kResp = 0;
  for (const o of alive) if (o !== agg && st.stack[o] > 0 && st.bets[o] < st.maxBet) kResp++;
  return {
    s, street, alive, opps, k: opps.length, pot, toCall, maxBet: st.maxBet, myBet: st.bets[s], ip, role,
    nBets: st.nBets, effRem, spr: effRem / Math.max(pot, 1), kResp: Math.max(1, kResp),
    canRaise: othersCanAct && st.stack[s] > toCall, bb: st.bb,
  };
}

// 행동하는 좌석의 레인지 전체에 대해 강도·백분위·전략 계획을 계산한다 (공개 정보만)
function postEval(st, s, board) {
  const tab = boardTable(board), x = postCtx(st, s), blocked = tab.blocked;
  const opp = new Float64Array(NC);
  for (const o of x.opps) {
    const W = st.W[o];
    let t = 0;
    for (let i = 0; i < NC; i++) if (!blocked[i]) t += W[i];
    if (t <= 0) continue;
    const k = 1 / t;
    for (let i = 0; i < NC; i++) if (!blocked[i]) opp[i] += W[i] * k;
  }
  const hs = new Float32Array(NC), e = new Float32Array(NC);
  strengthVs(tab, opp, hs);
  const k = x.k, ppot = tab.ppot, dk = board.length < 5 ? 0.85 : 0, W = st.W[s];
  let tw = 0, ra = 0;
  for (let i = 0; i < NC; i++) {
    if (blocked[i]) continue;
    const h0 = hs[i], eh = h0 + (1 - h0) * ppot[i] * dk;
    e[i] = k > 1 ? Math.pow(eh, k) : eh;
    tw += W[i];
    ra += W[i] * h0; // 레인지 우위는 지금 만들어진 족보로만 잰다 (드로우 잠재력은 양쪽 모두에게 더해져 대칭이 깨진다)
  }
  x.ra = tw > 0 ? ra / tw : 0.5;
  const p = percentile(e, W, blocked, tw);
  const plan = postPlan(x, W, e, p, tab, tw);
  return { tab, x, e, p, plan };
}

// 체크/벳 상황의 (벳 크기, 목표 벳 빈도)
function betParams(x, wet) {
  const st = x.street, role = x.role;
  if (st === 1) {
    if (role === "cbet") {
      if (x.ip) return wet < 0.35 ? [0.33, 0.7] : wet < 0.6 ? [0.5, 0.55] : [0.7, 0.45];
      return wet < 0.35 ? [0.33, 0.45] : wet < 0.6 ? [0.5, 0.38] : [0.7, 0.32];
    }
    if (role === "donk") return [0.5, 0.06];
    if (role === "stab") return [0.5, x.ip ? 0.5 : 0.35];
    return [0.5, 0.3];
  }
  if (st === 2) {
    if (role === "cbet") return [wet > 0.6 ? 0.75 : 0.7, 0.5];
    if (role === "donk") return [0.6, 0.07];
    if (role === "probe") return [0.6, 0.38];
    if (role === "stab") return [0.6, x.ip ? 0.45 : 0.33];
    return [0.6, 0.3];
  }
  if (role === "cbet") return [0.75, 0.42];
  if (role === "donk") return [0.6, 0.08];
  if (role === "probe") return [0.66, 0.35];
  if (role === "stab") return [0.66, x.ip ? 0.42 : 0.3];
  return [0.66, 0.3];
}

function postPlan(x, W, e, p, tab, tw) {
  const st = x.street, blocked = tab.blocked, ppot = tab.ppot;
  const P = { facing: x.toCall > 0, street: st, p, ppot, canRaise: x.canRaise };
  const inv = tw > 0 ? 1 / tw : 0;
  const mass = (thr) => { let m = 0; for (let i = 0; i < NC; i++) if (!blocked[i] && e[i] >= thr) m += W[i]; return m * inv; };
  if (P.facing) {
    // MDF: 베팅이 블러프로 본전이 되려면 alpha만큼 폴드해야 한다. 여러 명이면 각자 alpha^(1/k)
    const alpha = clamp(x.maxBet / Math.max(x.pot, 1), 0.05, 0.85);
    let d = 1 - Math.pow(alpha, 1 / x.kResp);
    if (x.nBets >= 2) d *= 0.85;
    P.mdf = d;
    P.thrD = 1 - d;
    P.po = x.toCall / (x.pot + x.toCall);
    P.R = st === 3 ? 1 : st === 2 ? (x.ip ? 1 : 0.92) : x.ip ? 0.95 : 0.85; // 승률 실현 계수
    const re = x.nBets >= 2;
    P.rthr = [0, 0.75, 0.8, 0.88][st] + (re ? 0.07 : 0);
    P.rvm = Math.min([0, 0.12, 0.09, 0.06][st] * (re ? 0.4 : 1), mass(P.rthr));
    P.thrR = 1 - P.rvm;
    P.fr = 0;
    if (st < 3 && !re && P.rvm > 0) { // 세미블러프 레이즈: 밸류 레이즈에 비례
      let D = 0;
      for (let i = 0; i < NC; i++) if (!blocked[i] && e[i] < P.rthr && ppot[i] >= 0.2) D += W[i] * Math.min(1, ppot[i] / 0.35);
      D *= inv;
      P.fr = D > 0 ? Math.min(0.7, (P.rvm * (st === 1 ? 0.6 : 0.4)) / D) : 0;
    }
    P.lowSpr = x.effRem - x.toCall < 0.6 * (x.pot + x.toCall);
    P.raiseFrac = 0.6;
    return P;
  }
  // 체크 또는 벳: 레인지 우위로 빈도, 보드 질감으로 크기, alpha = b/(P+2b)로 블러프 비율
  let [size, B] = betParams(x, tab.wet);
  // 리버에서 넛 비중이 높은(폴라) 공격자 레인지는 오버벳
  if (st === 3 && x.role === "cbet" && x.k === 1 && mass(0.9) >= 0.25) size = 1.25;
  B *= clamp(1 + 2.5 * (x.ra - 0.5), 0.45, 1.6);
  let beta = st === 3 ? size / (1 + 2 * size) : st === 2 ? Math.min(0.45, (1.3 * size) / (1 + 2 * size)) : size <= 0.4 ? 0.45 : 0.4;
  if (x.role === "donk") beta = 0.2;
  if (x.k >= 2) { B *= x.k === 2 ? 0.55 : 0.4; beta *= 0.5; }
  B = clamp(B, 0.02, 0.9);
  const vt = st === 1 ? (size <= 0.4 ? 0.52 : 0.58) : st === 2 ? 0.62 : 0.64;
  const trap = st === 1 ? (x.ip ? 0.1 : 0.18) : st === 2 ? 0.08 : 0.03;
  const V = Math.min(B * (1 - beta), mass(vt));
  Object.assign(P, { V, thrV: 1 - V, vt, trap, size, B, beta, jam: x.spr < 1.3 });
  const Bl = (V * beta) / (1 - beta);
  let D = 0, A = 0;
  for (let i = 0; i < NC; i++) {
    if (blocked[i]) continue;
    const val = V > 0 && e[i] >= vt - 0.04 ? sig((p[i] - P.thrV) / 0.02) * (1 - trap) : 0;
    if (st < 3) {
      D += W[i] * Math.min(1, ppot[i] / 0.3) * (1 - val);
      if (e[i] < 0.3 && ppot[i] < 0.08) A += W[i] * (1 - val);
    } else if (e[i] < 0.25) A += W[i] * (1 - val);
  }
  D *= inv; A *= inv;
  if (D >= Bl) { P.fd = D > 0 ? Bl / D : 0; P.fa = 0; } else { P.fd = 1; P.fa = A > 0 ? Math.min(1, (Bl - D) / A) : 0; }
  P.fm = 0;
  if (st === 1 && size <= 0.4) { // 작은 플롭 벳: 밸류·드로우·에어로 목표 빈도에 못 미치면 중간 강도 핸드로 채운다
    let M = 0;
    for (let i = 0; i < NC; i++) if (!blocked[i] && e[i] < vt - 0.04 && !(e[i] < 0.3 && ppot[i] < 0.08) && ppot[i] < 0.3) M += W[i];
    M *= inv;
    const short = B - (V + Math.min(D, Bl) + Math.min(A * P.fa, Math.max(0, Bl - D)));
    if (short > 0 && M > 0) P.fm = Math.min(1, short / M);
  }
  return P;
}

// 조합 하나의 [폴드, 체크·콜, 벳·레이즈] 확률 (e = 그 조합의 승률 추정)
const CP = [0, 0, 0];
function comboProbs(P, i, e) {
  const p = P.p[i], pp = P.ppot[i];
  if (P.facing) {
    let cont = e >= 0.93 ? 1 : sig((0.45 * (p - P.thrD) + 0.55 * (e * P.R - P.po)) / 0.05);
    // 직접 오즈가 맞는 드로우는 접지 않는다 (레인지 안 순위만 보면 드로우가 약한 메이드 핸드보다 아래로 밀린다)
    if (P.street < 3 && pp >= 0.2 && e * P.R > P.po) cont = Math.max(cont, sig((e * P.R - P.po) / 0.02));
    const vr = P.rvm > 0 && e >= P.rthr - 0.04 ? sig((p - P.thrR) / 0.02) : 0;
    const sbw = pp >= 0.2 && e < P.rthr ? Math.min(1, pp / 0.35) : 0;
    let raise = P.canRaise ? Math.min(1, vr + P.fr * sbw) : 0;
    if (P.canRaise && P.lowSpr && e >= 0.68) raise = Math.max(raise, cont); // 남는 칩이 적으면 강한 패는 올인
    const call = Math.max(0, cont - raise);
    CP[0] = Math.max(0, 1 - raise - call); CP[1] = call; CP[2] = raise;
    return CP;
  }
  const val = P.V > 0 && e >= P.vt - 0.04 ? sig((p - P.thrV) / 0.02) * (1 - P.trap) : 0;
  let sbw = 0, air = 0;
  if (P.street < 3) { sbw = Math.min(1, pp / 0.3); air = e < 0.3 && pp < 0.08 ? 1 : 0; }
  else air = e < 0.25 ? 1 : 0;
  const mid = P.fm > 0 && e < P.vt - 0.04 && !air && pp < 0.3 ? P.fm : 0;
  let bet = val + (1 - val) * Math.min(1, sbw * P.fd + air * P.fa + mid);
  if (!P.canRaise) bet = 0;
  CP[0] = 0; CP[1] = 1 - bet; CP[2] = bet;
  return CP;
}

// ===== 승률 =====
// 상대 레인지(가중치)에서 손패를 뽑아 남은 보드를 깔아 본다. 내 카드·보드와 겹치는 조합은 제외
function mcEquity(hole, board, ranges, iters, rng) {
  const dead = new Uint8Array(52);
  for (const c of hole) dead[c] = 1;
  for (const c of board) dead[c] = 1;
  const cums = ranges.map((W) => {
    const cum = new Float64Array(NC);
    let t = 0;
    for (let i = 0; i < NC; i++) { if (!dead[C1[i]] && !dead[C2[i]]) t += W[i]; cum[i] = t; }
    if (t <= 0) { t = 0; for (let i = 0; i < NC; i++) { if (!dead[C1[i]] && !dead[C2[i]]) t += 1; cum[i] = t; } }
    return { cum, t };
  });
  const deck = [];
  for (let c = 0; c < 52; c++) if (!dead[c]) deck.push(c);
  const nb = board.length, need = 5 - nb, k = cums.length;
  const bd = board.slice(), hv = [hole[0], hole[1], 0, 0, 0, 0, 0], ov = [0, 0, 0, 0, 0, 0, 0];
  const used = new Int32Array(52), pick = new Int32Array(k);
  let win = 0, n = 0;
  for (let it = 1; it <= iters; it++) {
    let ok = true;
    for (let j = 0; j < k && ok; j++) {
      const { cum, t } = cums[j];
      let tries = 0, idx = -1;
      while (tries++ < 12) {
        const r = rng() * t;
        let lo = 0, hi = NC - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > r) hi = mid; else lo = mid + 1; }
        if (used[C1[lo]] !== it && used[C2[lo]] !== it) { idx = lo; break; }
      }
      if (idx < 0) ok = false;
      else { pick[j] = idx; used[C1[idx]] = it; used[C2[idx]] = it; }
    }
    if (!ok) continue;
    for (let j = 0; j < need; j++) {
      let c;
      do c = deck[(rng() * deck.length) | 0]; while (used[c] === it);
      used[c] = it;
      bd[nb + j] = c;
    }
    for (let j = 0; j < 5; j++) { hv[2 + j] = bd[j]; ov[2 + j] = bd[j]; }
    const hsc = evaluate(hv);
    let best = -1, ties = 0;
    for (let j = 0; j < k; j++) {
      ov[0] = C1[pick[j]]; ov[1] = C2[pick[j]];
      const sc = evaluate(ov);
      if (sc > best) { best = sc; ties = 1; } else if (sc === best) ties++;
    }
    if (hsc > best) win += 1;
    else if (hsc === best) win += 1 / (ties + 1);
    n++;
  }
  return n ? win / n : 0.5;
}
// 리버: 상대마다 정확히 계산하고 곱한다 (다자간은 근사)
function riverEquity(hole, tab, ranges) {
  const hs = tab.score[comboOf(hole[0], hole[1])];
  let eq = 1;
  for (const W of ranges) {
    let win = 0, tot = 0;
    for (let i = 0; i < NC; i++) {
      if (tab.blocked[i] || !W[i]) continue;
      const a = C1[i], b = C2[i];
      if (a === hole[0] || a === hole[1] || b === hole[0] || b === hole[1]) continue;
      tot += W[i];
      const sc = tab.score[i];
      if (sc < hs) win += W[i]; else if (sc === hs) win += 0.5 * W[i];
    }
    eq *= tot > 0 ? win / tot : 0.5;
  }
  return eq;
}

// 지금 보드에서 내 패를 이기는 조합이 하나도 없으면 넛
function isNuts(tab, hole) {
  const hs = tab.score[comboOf(hole[0], hole[1])], o = tab.order;
  for (let j = o.length - 1; j >= 0; j--) {
    const i = o[j];
    if (tab.score[i] <= hs) return true;
    const a = C1[i], b = C2[i];
    if (a !== hole[0] && a !== hole[1] && b !== hole[0] && b !== hole[1]) return false;
  }
  return true;
}

// ===== 결정 =====
const STREET = ["preflop", "flop", "turn", "river"];

// 포스트플롭 벳·레이즈 금액. 뒤에 남는 칩이 너무 적으면 올인
function postSize(L, pot, frac, myBet, myStack) {
  let to = L.isBet ? frac * pot : L.maxBet + frac * (pot + L.toCall);
  const add = to - myBet, left = myStack - add;
  const potAfter = pot + add + Math.max(0, to - L.maxBet);
  if (left <= 0.3 * potAfter) to = JAM;
  return to;
}

function finalize(L, entries, sb, bb) {
  const out = [];
  for (const en of entries) {
    if (!(en.freq > 0)) continue;
    let { action, to } = en;
    if (action === "raise" && !L.canRaise) action = "call";
    if (action === "fold" && L.toCall === 0) action = "check";
    if (action === "call" && L.toCall === 0) action = "check";
    if (action === "check" && L.toCall > 0) action = "call";
    if (action === "raise") {
      let t = to >= JAM ? L.maxTo : Math.round(to / sb) * sb;
      if (!Number.isFinite(t)) t = L.minTo;
      if (L.maxTo - t <= Math.max(bb, 0.1 * L.maxTo)) t = L.maxTo;
      to = clamp(t, L.minTo, L.maxTo);
    } else to = undefined;
    const same = out.find((x) => x.action === action && x.to === to);
    if (same) same.freq += en.freq;
    else out.push(to === undefined ? { action, freq: en.freq } : { action, to, freq: en.freq });
  }
  let tot = out.reduce((t, x) => t + x.freq, 0);
  let mix = out.filter((x) => x.freq / tot >= 0.01);
  tot = mix.reduce((t, x) => t + x.freq, 0);
  if (!mix.length || !(tot > 0)) mix = [{ action: L.toCall > 0 ? "fold" : "check", freq: 1 }];
  else mix.forEach((x) => { x.freq = x.freq / tot; });
  const order = { fold: 0, check: 1, call: 1, raise: 2 };
  mix.sort((a, b) => order[a.action] - order[b.action] || (a.to || 0) - (b.to || 0));
  return mix;
}

function decideInner(m, seat, opts) {
  ensure();
  const rng = opts.rng || Math.random;
  const h = m.hand, L = PT.legal(m, seat), hole = h.hole[seat];
  const st = tracked(h);
  const hc = comboOf(hole[0], hole[1]), cls = CLS[hc];
  const pot = PT.potTotal(h), sb = h.sb, bb = h.bb;
  const myStack = m.players[seat].stack, myBet = h.bets[seat];
  const po = L.toCall > 0 ? L.toCall / (pot + L.toCall) : 0;
  const mrng = mulberry32(hashInts([h.no, h.actions.length, seat, hole[0], hole[1], ...h.board]));
  const pos = st.pos[seat];
  let maxOther = 0;
  for (const o of st.seats) if (o !== seat && !st.folded[o]) maxOther = Math.max(maxOther, st.stack[o] + st.bets[o]);
  const effBB = Math.min(myStack + myBet, maxOther) / bb;
  const info = { equity: 0.5, potOdds: po, position: pos, spot: "", handClass: CLS_NAME[cls], effBB, street: STREET[h.street], isBet: L.isBet, toCall: L.toCall, pot, maxTo: L.maxTo };
  let entries;
  if (h.street === 0) {
    const x = preCtx(st, seat), S = preStrat(x);
    let r = S.r[cls], c = S.c[cls];
    // 승률 계산 상대: 자발적으로 칩을 넣은 사람들 (없으면 랜덤 핸드 하나)
    const rel = S.rel || x.alive.filter((o) => o !== seat && st.preActs[o] > 0);
    const ranges = rel.length ? rel.map((o) => st.W[o]) : [UNIFORM];
    const iters = clamp(Math.round(2400 / (1 + ranges.length)), 300, 1200);
    const eq = mcEquity(hole, [], ranges, iters, mrng);
    info.equity = eq;
    info.opponents = rel.length;
    if (S.eqMode) { // 올인(또는 큰 레이즈)에 대한 콜/폴드는 레인지 상대 승률로
      const want = Math.max(sig((eq - S.po - S.margin) / 0.02), S.fl ? S.fl[cls] : 0);
      if (S.canRe) { r = want; c = 0; } else { c = want; r = 0; }
    } else if (x.pos === "BB" && x.raises.length === 1 && L.toCall > 0) { // BB 가격 방어
      const want = sig((eq * 0.7 - po - 0.01) / 0.02);
      if (r + c < want) c = want - r;
    }
    info.spot = S.spot;
    if (!x.raises.length) info.potOdds = 0; // 오픈 전(림프 포함)에는 팟 오즈를 보여 주지 않는다
    entries = [
      { action: "fold", freq: Math.max(0, 1 - r - c) },
      { action: "call", freq: c },
      { action: "raise", to: S.to, freq: r },
    ];
  } else {
    const board = h.board, E = postEval(st, seat, board), P = E.plan, x = E.x;
    const ranges = x.opps.map((o) => st.W[o]);
    let eq;
    if (h.street === 3) eq = riverEquity(hole, E.tab, ranges);
    else eq = mcEquity(hole, board, ranges, clamp(Math.round(3000 / (1 + ranges.length)), 400, 1500), mrng);
    info.equity = eq;
    info.opponents = x.k;
    info.percentile = E.p[hc];
    info.made = PK.describeEn(E.tab.score[hc]);
    info.boardWet = E.tab.wet;
    let [f, c, r] = comboProbs(P, hc, eq).slice();
    if (isNuts(E.tab, hole)) { // 넛은 절대 폴드하지 않는다. 리버에선 주로 레이즈
      info.nuts = true;
      c += f; f = 0;
      if (P.facing && h.street === 3 && L.canRaise && r < 0.6) { c = Math.max(0, c - (0.6 - r)); r = 0.6; }
    }
    const way = x.k >= 2 ? `${x.k + 1}-way` : "HU";
    const sName = STREET[h.street];
    let to;
    if (P.facing) {
      info.mdf = P.mdf;
      info.spot = `facing ${sName} ${x.nBets >= 3 ? "3bet+" : x.nBets === 2 ? "raise" : "bet"}${x.k >= 2 ? " " + way : ""}`;
      to = postSize(L, pot, P.raiseFrac, myBet, myStack);
      if (P.lowSpr) to = JAM;
    } else {
      const sideTxt = x.ip ? "IP" : "OOP";
      const roleTxt = x.role === "cbet" ? (h.street === 1 ? "c-bet" : "barrel") : x.role === "stab" ? "stab (checked to)" : x.role;
      info.spot = `${sName} ${roleTxt} ${sideTxt} ${way}`;
      info.betSize = P.size;
      to = P.jam && eq >= 0.6 ? JAM : postSize(L, pot, P.size, myBet, myStack);
    }
    entries = [
      { action: "fold", freq: f },
      { action: L.toCall > 0 ? "call" : "check", freq: c },
      { action: "raise", to, freq: r },
    ];
  }
  const mix = finalize(L, entries, sb, bb);
  let u = rng(), pick = mix[mix.length - 1];
  for (const x of mix) { if ((u -= x.freq) < 0) { pick = x; break; } }
  return pick.to === undefined ? { action: pick.action, mix, info } : { action: pick.action, to: pick.to, mix, info };
}

// 문제가 생겨도 던지지 않는다: 체크 가능하면 체크, 아니면 폴드
function safeDecision(m, seat, err) {
  let L = null;
  try { L = PT.legal(m, seat); } catch (e) { /* 무시 */ }
  const action = L && L.toCall > 0 ? "fold" : "check";
  return { action, mix: [{ action, freq: 1 }], info: { equity: 0.5, potOdds: 0, position: "?", spot: "fallback", handClass: "?", effBB: 0, error: String(err && err.message || err) } };
}

function decide(m, seat, opts = {}) {
  try { return decideInner(m, seat, opts || {}); } catch (e) { return safeDecision(m, seat, e); }
}

function describeMix(d) {
  const i = (d && d.info) || {};
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  const parts = ((d && d.mix) || []).map((x) => {
    let a = x.action;
    if (a === "raise") a = `${i.isBet ? "bet" : "raise to"} ${x.to}${x.to === i.maxTo ? " (all-in)" : ""}`;
    return `${a} ${pct(x.freq)}`;
  });
  const hand = i.made ? `${i.handClass}, ${i.made}` : i.handClass;
  let extra = i.mdf != null ? `, MDF ${pct(i.mdf)}` : "";
  if (i.percentile != null) extra += `, own-range percentile ${Math.round(i.percentile * 100)} (100 = strongest)`;
  return `GTO engine (${i.position || "?"}, ${i.spot || "?"}, ${hand || "?"}): ${parts.join(", ") || "no suggestion"}. ` +
    `Equity vs ranges ${pct(i.equity)}, pot odds ${i.potOdds ? pct(i.potOdds) : "-"}${extra}, effective ${Math.round(i.effBB || 0)}bb.`;
}

const api = {
  decide, describeMix,
  // 테스트·디버그용
  _internal: { postEval, preCtx, preStrat, comboProbs, topShare, ownRange, STATS, parseRange, rangePct, RFI, DEF, VS3, VS4, LIMP, CLS_NAME, CLS, comboOf, rankTop, tracked, boardTable, texture, mcEquity },
};
if (isNode) module.exports = api;
else root.PokerAI = api;
})(globalThis);
