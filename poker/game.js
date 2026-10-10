// ===== 설정 =====
// 2~6인 노리밋 홀덤 화면. 규칙은 table.js(PokerTable), AI는 gto.js(PokerAI), 카드·족보는 engine.js
const SAVE_KEY = "holdem-table-v2";
const HINT_KEY = "holdem-table-v2-hint";
const START_STACK = 2000;
const HANDS_PER_LEVEL = 10;
const LEVELS = [[10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [750, 1500], [1000, 2000]];
const YOU = 0, CLAUDE = 1;
// 좌석 0 = 나, 1 = Claude, 2~5 = AI 플레이어
const ROSTER = [
  { name: "나", kind: "human", initial: "나", color: "var(--ivory)" },
  { name: "Claude", kind: "claude", initial: "C", color: "var(--clay)" },
  { name: "민지", kind: "bot", initial: "민", color: "#7fa7c4" },
  { name: "준호", kind: "bot", initial: "준", color: "#a593c8" },
  { name: "서윤", kind: "bot", initial: "서", color: "#8fbf9a" },
  { name: "태현", kind: "bot", initial: "태", color: "#c98f9f" },
];
const STREET_KO = ["프리플롭", "플롭", "턴", "리버"];
const STREET_EN = ["Preflop", "Flop", "Turn", "River"];
const PT = PokerTable;

// ===== 자리 배치 =====
// 테이블 상자 기준 % 좌표. seat = 명패 가운데, bet = 베팅 칩 · 행동 표시 자리
// 나는 아래 가운데, 좌석 번호가 커지는 방향(시계 방향) = 아래 → 왼쪽 → 위 → 오른쪽
// wide = 가로로 긴 테이블(넓은 화면), tall = 세로로 긴 테이블(폰)
// bubble = Claude 말풍선 위치 (기본: 명패 오른쪽, 오른쪽 자리면 왼쪽)
const LAYOUT = {
  wide: {
    2: { seat: [[50, 100], [50, 0]], bet: [[50, 70], [50, 27]] },
    3: { seat: [[50, 100], [15, 11], [85, 11]], bet: [[50, 70], [28, 31], [72, 31]] },
    4: { seat: [[50, 100], [3, 50], [50, 0], [97, 50]], bet: [[50, 70], [20, 50], [50, 27], [80, 50]], bubble: "above" },
    5: { seat: [[50, 100], [4, 70], [20, 6], [80, 6], [96, 70]], bet: [[50, 70], [22, 58], [29, 30], [71, 30], [79, 63]] },
    6: { seat: [[50, 100], [4, 72], [12, 14], [50, 0], [88, 14], [96, 72]], bet: [[50, 70], [22, 59], [25, 31], [50, 27], [75, 31], [79, 64]] },
  },
  tall: {
    2: { seat: [[50, 100], [50, 0]], bet: [[50, 76], [50, 31]], bubble: "below" },
    3: { seat: [[50, 100], [13, 16], [87, 16]], bet: [[50, 76], [27, 33], [73, 33]] },
    4: { seat: [[50, 100], [13, 27], [50, 0], [87, 27]], bet: [[50, 76], [37, 35], [50, 19], [63, 35]] },
    5: { seat: [[50, 100], [13, 70], [15, 18], [85, 18], [87, 70]], bet: [[50, 64], [29, 62], [36, 34], [64, 34], [71, 62]] },
    6: { seat: [[50, 100], [13, 72], [13, 27], [50, 0], [87, 27], [87, 72]], bet: [[50, 64], [29, 63], [37, 35], [50, 19], [63, 35], [71, 63]] },
  },
};

let S = null;          // 매치 상태 + 화면 기록 (localStorage에 저장)
let sampleFn = null;   // claude.use("sample") — Claude에게 수를 묻는 함수
let link = "checking"; // checking | live | paused | offline
let thinking = null;   // Claude 차례 진행 중: { hand, ctl, n }
let timer = 0;         // 봇 차례 · 카드 펼치기 타이머
let endTimer = 0;      // 탈락 · 우승 창 타이머
let sayTimer = 0;      // 말풍선 감추기 타이머
let fast = false;      // 빨리 감기 (내가 핸드에서 빠졌을 때)
let hintOn = false;    // GTO 힌트 표시
let hint = { key: "", d: null };
let controlsKey = "", logKey = "", tableKey = "";
let turnKey = "", turnAt = 0; // 내 차례 버튼이 새로 나타난 때: 더블클릭·연타가 새 버튼을 누르지 않게 잠깐 막는다
const INPUT_LOCK_MS = 350;
let setup = { n: 6, claude: true }; // 설정 창에서 고른 값
const tallMQ = window.matchMedia("(max-width: 600px)");

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("ko-KR");
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const nm = (s) => (s === YOU ? "나" : S.m.players[s].name);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");

try { hintOn = localStorage.getItem(HINT_KEY) === "1"; } catch {}

// 이 화면이 Claude를 부를 수 있는지 (아티팩트 안에서만 가능, 로컬 파일은 GTO 엔진이 대신)
const sampleReady = (async () => {
  try {
    sampleFn = window.claude?.use ? await window.claude.use("sample") : null;
  } catch {
    sampleFn = null;
  }
  link = sampleFn ? "live" : "offline";
  renderTop();
  return sampleFn;
})();

// ===== 매치 =====
function newMatch(n, claudeOn) {
  stopAll();
  const players = ROSTER.slice(0, n).map((r) => ({ name: r.name, kind: r.kind }));
  S = {
    v: 2,
    m: PT.createMatch({ players, startStack: START_STACK, levels: LEVELS, handsPerLevel: HANDS_PER_LEVEL }),
    claudeOn: !!claudeOn,
    depth: S?.depth === "default" ? "default" : "quick",
    stats: { hands: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, facedBet: 0, foldedToBet: 0, showdowns: [] }, // 내 성향 (Claude가 참고)
    history: [],   // 끝난 핸드 기록 (최근 30개)
    log: [],       // 지금 핸드 기록
    logAt: null,   // 기록에 옮긴 위치
    say: null,     // Claude 말풍선 { text, note }
    track: null,   // 이번 핸드 VPIP/PFR 집계 여부
    biggestPot: 0,
    doneNo: 0,     // 마무리 처리한 핸드 번호
    ended: "",     // "" | bust(탈락 창 봄) | over(최종 결과 창 봄)
    watched: false, // 탈락 뒤 계속 지켜봤는지
  };
  fast = false;
  tableKey = controlsKey = logKey = turnKey = "";
  startHand();
}

function startHand() {
  const m = S.m;
  if (m.over || (m.hand && m.hand.phase !== "done")) return;
  stopAll();
  PT.startHand(m);
  const h = m.hand;
  S.log = [];
  S.logAt = { a: 0, street: 0, shown: false, done: false };
  S.say = null;
  S.track = { vpip: false, pfr: false };
  if (!m.players[YOU].out) fast = false;
  addLog(`블라인드 ${h.sb}/${h.bb} · 버튼 ${esc(nm(h.button))} · ${h.seats.length}명`);
  if (h.seats.includes(YOU)) {
    S.stats.hands++;
    addLog(`내 카드 ${cardsHtml(h.hole[YOU])} · ${PT.positionsOf(h)[YOU]}`);
  }
  advance();
}

function stopAll() {
  clearTimeout(timer);
  clearTimeout(endTimer);
  if (thinking) { thinking.stopped = true; thinking.ctl.abort(); } // 멈춤(설정 창 등): 이 수는 두지 않고, 이어하면 다시 묻는다
  thinking = null;
}

// 상태가 바뀔 때마다: 기록 · 저장 · 그리기, 그리고 다음 차례를 예약한다
function advance() {
  if (!S) return;
  const m = S.m, h = m.hand;
  clearTimeout(timer);
  syncLog();
  if (h.phase === "done") {
    handDone(h);
    // 탈락 · 우승 창 (설정 창 등으로 멈췄다 이어해도 다시 예약)
    if (needsEndModal()) {
      clearTimeout(endTimer);
      endTimer = setTimeout(showEnd, 1600);
    }
  }
  save();
  render();
  if (h.phase === "runout") {
    timer = setTimeout(() => {
      if (!S || S.m !== m || m.hand !== h || h.phase !== "runout") return;
      PT.runoutStep(m);
      advance();
    }, fast ? 80 : 900);
  } else if (h.phase === "bet") {
    const seat = h.toAct;
    if (seat === YOU) return;
    if (seat === CLAUDE && claudeWanted(h)) {
      if (link === "checking") {
        sampleReady.then(() => { if (S && S.m === m && m.hand === h && h.toAct === seat && !thinking) advance(); });
        return;
      }
      if (link === "live" && sampleFn) { claudeTurn(h); return; }
    }
    timer = setTimeout(() => botTurn(m, h, seat), fast ? 80 : 450 + Math.random() * 450);
  }
}

// Claude에게 직접 물을지: 내가 이 핸드에서 아직 베팅할 수 있을 때만 (Claude 사용량 아끼기)
function claudeWanted(h) {
  const me = S.m.players[YOU];
  return S.claudeOn && h.seats.includes(YOU) && !h.folded[YOU] && me.stack > 0;
}

function botTurn(m, h, seat) {
  if (!S || S.m !== m || m.hand !== h || h.phase !== "bet" || h.toAct !== seat) return;
  const mv = engineMove(m, seat);
  doAct(seat, mv.action, mv.to);
}

// 누구의 수든 여기로: 성향 집계 · 말 기록 → 규칙 엔진 → 다음
function doAct(seat, type, to, say) {
  const m = S.m, h = m.hand, L = PT.legal(m, seat);
  if (seat === YOU) trackHuman(h, type, L);
  if (say) addLog(`<span class="said">${esc(nm(seat))}: “${esc(say)}”</span>`);
  try {
    PT.act(m, seat, type, to);
  } catch {
    PT.act(m, seat, L.toCall === 0 ? "check" : "fold"); // 규칙상 안 되는 수가 들어오면 체크 또는 폴드
  }
  advance();
}

// 핸드가 끝났을 때 한 번만
function handDone(h) {
  if (S.doneNo === h.no) return;
  S.doneNo = h.no;
  const m = S.m, r = h.result;
  S.biggestPot = Math.max(S.biggestPot, r.pots.reduce((t, p) => t + p.amount, 0));
  if (r.showdown && r.hands[YOU]) {
    S.stats.showdowns = [...S.stats.showdowns, {
      cards: h.hole[YOU].map(cardCode).join(""), hand: describeEn(r.hands[YOU].score), board: h.board.map(cardCode).join(" "),
    }].slice(-4);
  }
  const net = h.seats.includes(YOU) ? m.players[YOU].stack - h.start[YOU] : null;
  S.history = [{ no: h.no, net, log: S.log.slice() }, ...S.history].slice(0, 30);
}

const needsEndModal = () => (S.m.over && S.ended !== "over") || (S.m.players[YOU].out && !S.ended);

function showEnd() {
  if (!S || !$("modal").hidden) return;
  if (S.m.over) S.ended = "over";
  else if (S.m.players[YOU].out) S.ended = "bust";
  else return;
  save();
  controlsKey = "";
  render();
  openModal(endHtml());
}

// ===== 내 성향 기록 (Claude 프롬프트에 들어간다) =====
function trackHuman(h, type, L) {
  const st = S.stats, t = S.track;
  if (h.street === 0) {
    if (((type === "call" && L.toCall > 0) || type === "raise") && !t.vpip) { st.vpip++; t.vpip = true; }
    if (type === "raise" && !t.pfr) { st.pfr++; t.pfr = true; }
    return;
  }
  if (type === "raise") st.aggr++;
  else if (type === "call" && L.toCall > 0) st.calls++;
  if (L.toCall > 0) {
    st.facedBet++;
    if (type === "fold") st.foldedToBet++;
  }
}

// ===== AI =====
// GTO 엔진의 수를 실제로 둘 수 있는 수로 맞춘다
function engineMove(m, seat) {
  const L = PT.legal(m, seat);
  let d = null;
  try { d = PokerAI.decide(m, seat, { rng: Math.random }); } catch { d = null; }
  const c = d && normalize(d.action, d.to, L);
  if (c) return { ...c, d };
  // 엔진이 답하지 못하면: 공짜면 체크, 싸면 콜, 아니면 폴드
  const pot = PT.potTotal(m.hand);
  return { action: L.toCall === 0 ? "check" : L.toCall * 3 <= pot ? "call" : "fold", d };
}

function normalize(action, to, L) {
  action = String(action ?? "").toLowerCase().replace(/[^a-z]/g, "");
  to = Math.round(Number(to));
  if (action === "bet") action = "raise";
  if (action === "allin" || action === "shove") {
    if (L.canRaise) { action = "raise"; to = L.maxTo; } else action = L.toCall > 0 ? "call" : "check";
  }
  if ((action === "fold" || action === "call") && L.toCall === 0) action = "check";
  if (action === "check" && L.toCall > 0) return null;
  if (action === "raise") {
    if (!L.canRaise) action = L.toCall > 0 ? "call" : "check";
    else if (!Number.isFinite(to)) return null;
    else to = clamp(to, L.minTo, L.maxTo);
  }
  if (!["fold", "check", "call", "raise"].includes(action)) return null;
  return { action, to: action === "raise" ? to : undefined };
}

function mixText(d) {
  try { return PokerAI.describeMix(d); } catch { return ""; }
}

// ===== Claude 차례 =====
async function claudeTurn(h) {
  const m = S.m, seat = CLAUDE;
  if (thinking && thinking.hand === h) return;
  const L = PT.legal(m, seat);
  const eng = engineMove(m, seat);
  const ctl = new AbortController();
  const me = { hand: h, ctl, n: h.actions.length };
  thinking = me;
  S.say = null;
  render();
  let choice = null, note = "";
  try {
    const ask = sampleFn.json(buildPrompt(h, seat, L, eng), { modelTier: S.depth, cache: false, signal: ctl.signal });
    const reply = await untilAbort(ask, ctl.signal);
    choice = parseChoice(reply, L);
    if (!choice) note = "답을 읽지 못해 이번 수는 GTO 엔진이 뒀어요";
  } catch (e) {
    note = sampleErrorNote(e?.code);
  }
  const stale = me.stopped || thinking !== me;
  if (!stale) thinking = null;
  // 멈췄거나(설정 창 · 새 게임) 그 사이 새 핸드가 시작됐거나 차례가 바뀌었으면 버린다. 건너뛰기만 엔진 수로 둔다
  if (stale || !S || S.m !== m || m.hand !== h || h.phase !== "bet" || h.toAct !== seat || h.actions.length !== me.n) {
    if (S) render();
    return;
  }
  if (!choice) choice = { action: eng.action, to: eng.to, say: "" };
  S.say = { text: choice.say || "", note, at: Date.now() };
  renderTop();
  doAct(seat, choice.action, choice.to, choice.say);
}

// 건너뛰기를 누르면 답을 기다리지 않는다
function untilAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject({ code: "cancelled" });
    signal.addEventListener("abort", () => reject({ code: "cancelled" }), { once: true });
    promise.then(resolve, reject);
  });
}

function sampleErrorNote(code) {
  switch (code) {
    case "cancelled":
      return "건너뛰어서 이번 수는 GTO 엔진이 뒀어요";
    case "rate_limited":
      link = "paused";
      return "Claude 요청 한도에 걸렸어요. 잠시 뒤 위의 ‘다시 연결’을 눌러주세요";
    case "session_expired":
      link = "paused";
      return "다시 로그인해야 Claude가 둘 수 있어요";
    case "not_granted": case "sampling_disabled": case "not_declared": case "capability_disabled": case "capability_removed":
      link = "offline";
      return "Claude 사용이 허용되지 않아 GTO 엔진으로 바꿨어요";
    default:
      return "Claude 응답에 문제가 있어 이번 수는 GTO 엔진이 뒀어요";
  }
}

// Claude의 JSON 답을 실제로 둘 수 있는 수로 바꾼다. 못 읽으면 null
function parseChoice(r, L) {
  if (!r || typeof r !== "object") return null;
  const c = normalize(r.action, r.to ?? r.amount, L);
  if (!c) return null;
  const say = typeof r.say === "string" ? r.say.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return { ...c, say };
}

const cardsEn = (cs) => cs.map(cardCode).join(" ");

function buildPrompt(h, seat, L, eng) {
  const m = S.m, P = m.players, pos = PT.positionsOf(h), st = S.stats, bb = h.bb;
  const pot = PT.potTotal(h), me = P[seat];
  const bbs = (x) => `${(x / bb).toFixed(1)} bb`;
  const who = (s) => (s === seat ? "You (Claude)" : s === YOU ? "Human" : `${P[s].name} (bot)`);
  const order = [];
  for (let s = PT.nextIn(h.seats, h.button), k = 0; k < h.seats.length; k++, s = PT.nextIn(h.seats, s)) order.push(s);
  const seats = order.map((s) => {
    const state = h.folded[s] ? "folded" : P[s].stack === 0 ? "all-in" : "in";
    return `- ${pos[s]}: ${who(s)} — ${P[s].stack} chips behind (${bbs(P[s].stack)}), bet this street ${h.bets[s]}, ${state}`;
  });
  const options = [];
  if (L.toCall > 0) options.push(`"fold"`, `"call" (costs ${L.toCall}${L.toCall >= me.stack ? ", all-in" : ""})`);
  else options.push(`"check"`);
  if (L.canRaise) {
    const top = L.maxTo === h.bets[seat] + me.stack ? "all-in" : "covers every opponent still in";
    options.push(`"raise" with "to" from ${L.minTo} to ${L.maxTo} (${L.maxTo} = ${top})${L.isBet ? "; on this street that is an opening bet" : ""}`);
  }
  const showdowns = st.showdowns.length
    ? ` Their recent showdown hands: ${st.showdowns.map((s) => `${s.cards} (${s.hand} on ${s.board})`).join("; ")}.`
    : " No showdowns yet.";
  const live = PT.liveSeats(m).length;
  const opponents = PT.aliveSeats(h).length - 1;
  return [
    `You are Claude, sitting at a ${m.players.length}-handed No-Limit Texas Hold'em tournament table (play chips) with the person viewing this page ("Human") and AI bot players. Play to win. You can see only your own hole cards.`,
    "",
    `Match: hand #${h.no}, blinds ${h.sb}/${h.bb}, blinds rise every ${HANDS_PER_LEVEL} hands; ${live} players left; the last player with chips wins.`,
    `Seats in this hand (clockwise from the seat left of the button; heads-up the button is the small blind):`,
    ...seats,
    `Your position: ${pos[seat]}. Your hole cards: ${cardsEn(h.hole[seat])}`,
    `Board: ${h.board.length ? cardsEn(h.board) : "none yet"} (street: ${STREET_EN[h.street]}); ${opponents} opponent${opponents === 1 ? "" : "s"} still in the hand.`,
    `Pot including bets on this street: ${pot} (${bbs(pot)})`,
    `To call: ${L.toCall}${L.toCall ? ` (pot odds ${Math.round((100 * L.toCall) / (pot + L.toCall))}%)` : ""}`,
    "",
    "Action so far this hand:",
    historyEn(h, seat, pos, who),
    "",
    `GTO engine advice for exactly this spot: ${mixText(eng.d) || `engine picks ${eng.action}${eng.to ? ` to ${eng.to}` : ""}`}`,
    "",
    `Human this match (${st.hands} hands dealt in): voluntarily puts money in preflop ${pct(st.vpip, st.hands)} (VPIP), raises preflop ${pct(st.pfr, st.hands)} (PFR); after the flop ${st.aggr} bets/raises vs ${st.calls} calls; folded to a bet or raise ${st.foldedToBet} of ${st.facedBet} times.${showdowns}`,
    "The bot players follow the GTO engine closely.",
    "",
    `Your legal actions now: ${options.join("; ")}.`,
    `"to" is your TOTAL bet on this street after raising, not the increment.`,
    "Default to the engine's mixed strategy: pick among its actions roughly in its frequencies and use its sizes. Deviate only when you have a concrete exploitative reason from the Human's tendencies or this hand's action (for example, they fold to bets far too often, or they almost never bluff).",
    "",
    'Reply with only a JSON object: {"action": "<fold|check|call|raise>", "to": <number, only for raise>, "say": "<table talk>"}.',
    '"say" is one short line you say at the table, in casual, friendly Korean (반말), at most 30 characters. It may tease or bluff lightly, but never state or hint your actual hole cards. Use "" when you have nothing to say.',
  ].join("\n");
}

function historyEn(h, seat, pos, who) {
  const verb = (a) => {
    const tail = a.allin ? " (all-in)" : "";
    switch (a.type) {
      case "sb": return `posts small blind ${a.amount}${tail}`;
      case "bb": return `posts big blind ${a.amount}${tail}`;
      case "fold": return "folds";
      case "check": return "checks";
      case "call": return `calls ${a.amount}${tail}`;
      case "bet": return `bets ${a.to}${tail}`;
      case "return": return `gets back uncalled ${a.amount}`;
      default: return `raises to ${a.to}${tail}`;
    }
  };
  const lines = [];
  for (let s = 0; s <= h.street; s++) {
    const acts = h.actions.filter((a) => a.street === s).map((a) => `${pos[a.seat]} ${who(a.seat)} ${verb(a)}`);
    const label = s === 0 ? "Preflop" : `${STREET_EN[s]} [${cardsEn(h.board.slice(0, s + 2))}]`;
    lines.push(`${label}: ${acts.join(", ") || "no action yet"}`);
  }
  return lines.join("\n");
}

// ===== 내 수 =====
function userAct(type, to) {
  const h = S?.m.hand;
  if (!h || h.phase !== "bet" || h.toAct !== YOU) return;
  if (performance.now() - turnAt < INPUT_LOCK_MS) return; // 버튼이 방금 바뀌었다: 앞 수의 두 번째 클릭·키로 본다
  const L = PT.legal(S.m, YOU);
  if (type === "fold" && L.toCall === 0) return;
  if (type === "raise" && !L.canRaise) return;
  if (type === "call" && L.toCall === 0) type = "check";
  doAct(YOU, type, to);
}

function raiseAmount() {
  const v = Number($("amt")?.value);
  return Number.isFinite(v) ? v : 0;
}

// ===== 기록 =====
function addLog(html) {
  S.log.push(html);
}

function actionKo(a, short) {
  if (short && a.allin && a.type !== "fold") return "올인";
  const tail = a.allin ? " (올인)" : "";
  switch (a.type) {
    case "fold": return "폴드";
    case "check": return "체크";
    case "call": return `콜 ${fmt(a.amount)}${tail}`;
    case "bet": return `벳 ${fmt(a.to)}${tail}`;
    default: return `레이즈 → ${fmt(a.to)}${tail}`;
  }
}

function cardsHtml(cs) {
  return cs.map((c) => `<span class="lc${isRed(c) ? " red" : ""}">${cardLabel(c)}</span>`).join(" ");
}

// 규칙 엔진의 행동 목록을 따라가며 아직 옮기지 않은 줄을 기록에 더한다
function syncLog() {
  const h = S.m.hand, at = S.logAt;
  const streetLine = (to) => {
    while (at.street < to) {
      at.street++;
      addLog(`<span class="street-line"><span class="street">${STREET_KO[at.street]}</span> ${cardsHtml(h.board.slice(0, at.street + 2))}</span>`);
    }
  };
  while (at.a < h.actions.length) {
    const a = h.actions[at.a++];
    streetLine(a.street);
    const who = `<b>${esc(nm(a.seat))}</b>`;
    if (a.type === "sb" || a.type === "bb") addLog(`${who} ${a.type === "sb" ? "스몰" : "빅"} 블라인드 ${fmt(a.amount)}${a.allin ? " (올인)" : ""}`);
    else if (a.type === "return") addLog(`${who} 받지 않은 ${fmt(a.amount)} 돌려받음`);
    else addLog(`${who} ${actionKo(a)}`);
  }
  if (h.phase === "runout" && !at.shown) {
    at.shown = true;
    const shown = h.seats.filter((s) => h.shown[s]).map((s) => `${esc(nm(s))} ${cardsHtml(h.hole[s])}`);
    addLog(`올인 — 카드 공개: ${shown.join(" · ")}`);
  }
  streetLine(h.street);
  if (h.phase === "done" && !at.done) {
    at.done = true;
    const r = h.result;
    if (r.showdown) {
      for (const s of h.seats) {
        const hand = r.hands[s];
        if (hand) addLog(`${esc(nm(s))} ${cardsHtml(h.hole[s])} — ${esc(hand.label)}`);
      }
    }
    r.pots.forEach((p, i) => {
      const title = r.pots.length === 1 ? "팟" : i === 0 ? "메인 팟" : `사이드 팟 ${i}`;
      const names = p.winners.map((s) => `<b>${esc(nm(s))}</b>`).join("·");
      addLog(`${names} ${title} ${fmt(p.amount)} ${p.winners.length > 1 ? "나눔" : "획득"}`);
    });
  }
}

// ===== 저장 =====
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch {}
}

function load() {
  try {
    const g = JSON.parse(localStorage.getItem(SAVE_KEY));
    const m = g?.m;
    // 끝난 매치는 최종 결과 창을 아직 못 봤을 때만 되살린다
    if (!g || g.v !== 2 || !m || m.v !== 2 || !Array.isArray(m.players) || !m.hand || (m.over && g.ended === "over")) return null;
    if (m.players.length < 2 || m.players.length > 6 || !g.stats || !Array.isArray(g.history) || !Array.isArray(g.log) || !g.logAt) return null;
    return g;
  } catch {
    return null;
  }
}

// ===== 화면 =====
function render() {
  if (!S) return;
  buildTable(S.m.players.length);
  renderTop();
  renderSeats();
  renderCenter();
  renderBubble();
  renderControls();
  renderLog();
}

function renderTop() {
  const dot = $("link-dot");
  if (!dot) return;
  const on = !S || S.claudeOn;
  const state = link === "live" && !on ? "engine" : link;
  dot.className = "dot " + state;
  $("link-text").textContent = {
    checking: "Claude 연결 확인 중",
    live: "Claude가 직접 둡니다",
    paused: "Claude 쉬는 중 · 엔진이 대신",
    offline: "Claude 자리: GTO 엔진",
    engine: "Claude 자리: GTO 엔진",
  }[state];
  $("link-short").textContent = { checking: "확인 중", live: "Claude", paused: "쉬는 중", offline: "엔진", engine: "엔진" }[state];
  $("link").title = link === "offline"
    ? "이 화면에서는 Claude를 부를 수 없어서 Claude 자리도 GTO 엔진이 둡니다. claude.ai 아티팩트로 열면 Claude가 직접 둬요."
    : !on ? "새 게임 설정에서 ‘Claude 직접 판단’을 끄면 Claude 자리도 GTO 엔진이 둡니다."
    : "Claude는 GTO 엔진의 조언과 공개된 정보, 자기 카드만 보고 판단합니다. 다른 사람 카드는 보지 못해요. 내가 핸드에서 빠지면 엔진이 대신 둡니다.";
  const seg = $("depth");
  seg.hidden = !(link === "live" && on);
  $("retry").hidden = link !== "paused";
  for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.depth === (S?.depth ?? "quick")));
  const lv = $("level");
  if (!S) {
    lv.innerHTML = `블라인드 <b>10/20</b> · <span>${setup.n}명</span>`;
    return;
  }
  const m = S.m, h = m.hand, left = HANDS_PER_LEVEL - ((m.handNo - 1) % HANDS_PER_LEVEL);
  const [nsb, nbb] = PT.blindsAt(m, m.handNo + left);
  lv.innerHTML = `핸드 <b>#${m.handNo}</b> · 블라인드 <b>${h.sb}/${h.bb}</b>` +
    (nbb !== h.bb ? ` · <span>${left}핸드 뒤 ${nsb}/${nbb}</span>` : "") +
    ` · <em>${PT.liveSeats(m).length}/${m.players.length}명 남음</em>`;
}

// 인원 · 화면 모양이 바뀔 때만 자리를 새로 만든다
function buildTable(n) {
  const mode = tallMQ.matches ? "tall" : "wide", key = `${n}|${mode}`;
  if (key === tableKey) return;
  tableKey = key;
  const lay = LAYOUT[mode][n];
  let html = "";
  for (let s = 0; s < n; s++) {
    const r = ROSTER[s], [x, y] = lay.seat[s], [bx, by] = lay.bet[s];
    const cls = ["seat", s === YOU ? "me" : "", s === CLAUDE ? "claude" : "", y < 45 ? "below" : "", x < 30 ? "west" : x > 70 ? "east" : ""].filter(Boolean).join(" ");
    html += `
      <div class="${cls}" id="seat-${s}" style="left:${x}%;top:${y}%">
        <div class="hole" id="hole-${s}"></div>
        <div class="plate">
          <span class="avatar" style="--av:${r.color}" aria-hidden="true">${r.initial}</span>
          <span class="who"><span class="nm"><b>${esc(r.name)}</b><i class="pos" id="pos-${s}"></i></span><span class="stack" id="stack-${s}">${fmt(START_STACK)}</span></span>
          <span class="dealer" id="dealer-${s}" hidden>D</span>
        </div>
        ${s === YOU ? `<span class="made" id="made"></span>` : ""}
        ${s === CLAUDE ? `<div class="bubble${lay.bubble ? ` ${lay.bubble}` : x > 60 ? " to-left" : ""}" id="bubble" aria-live="polite"></div>` : ""}
      </div>
      <div class="bet${y < 45 ? " up" : ""}" id="bet-${s}" style="left:${bx}%;top:${by}%"></div>`;
  }
  $("seats").innerHTML = html;
  const t = $("table");
  t.dataset.n = n;
  t.dataset.mode = mode;
  controlsKey = "";
}

// 설정 창 뒤에 보이는 빈 테이블
function renderPreview(n) {
  tableKey = "";
  buildTable(n);
  $("print").textContent = printLabel(n);
  renderCards($("board"), ["slot", "slot", "slot", "slot", "slot"], () => "");
  $("pot").innerHTML = "";
  $("sidepots").textContent = "";
  renderTop();
}

const printLabel = (n) => `No Limit · ${n === 2 ? "Heads-Up" : `${n}-Handed`}`;

// 쇼다운에서 팟을 가져간 사람들의 최고 다섯 장
function winningCards(h) {
  const set = new Set();
  if (h.phase !== "done" || !h.result?.showdown) return set;
  for (const p of h.result.pots) for (const w of p.winners) for (const c of h.result.hands[w]?.best ?? []) set.add(c);
  return set;
}

function renderSeats() {
  const m = S.m, h = m.hand, pos = PT.positionsOf(h), done = h.phase === "done";
  const best = winningCards(h), sd = done && h.result.showdown;
  m.players.forEach((p, s) => {
    const el = $(`seat-${s}`);
    if (!el) return;
    const inHand = h.seats.includes(s), folded = inHand && h.folded[s];
    el.classList.toggle("turn", h.phase === "bet" && h.toAct === s);
    el.classList.toggle("folded", folded);
    el.classList.toggle("out", p.out && !inHand);
    el.classList.toggle("busted", p.out);
    el.classList.toggle("thinking", !!(thinking && thinking.hand === h && s === CLAUDE));
    el.classList.toggle("winner", done && h.result.won[s] > 0);
    $(`stack-${s}`).textContent = p.out && (done || !inHand) ? "탈락"
      : inHand && !folded && p.stack === 0 && !done ? "올인" : fmt(p.stack);
    $(`pos-${s}`).textContent = inHand ? pos[s] ?? "" : "";
    $(`dealer-${s}`).hidden = h.button !== s;
    let cards = [];
    if (inHand && (!folded || s === YOU)) cards = h.hole[s].map((c) => (s === YOU || h.shown[s] ? c : "back"));
    renderCards($(`hole-${s}`), cards, (c) => (c === "back" ? "" : folded ? "dim" : sd && h.shown[s] ? (best.has(c) ? "win" : "dim") : ""));
    renderBet(s, h, inHand);
  });
  // 지금 내 패 이름 (보드가 깔린 뒤)
  const made = $("made");
  if (made) {
    const mine = h.seats.includes(YOU) && !h.folded[YOU] && h.board.length >= 3 && h.phase !== "done"; // 끝나면 베팅 자리에 족보가 뜬다
    made.textContent = mine ? describe(evaluate([...h.hole[YOU], ...h.board])) : "";
  }
}

// 자리 앞 베팅 칩 · 행동 표시 (끝나면 족보 · 딴 칩)
function renderBet(s, h, inHand) {
  const el = $(`bet-${s}`);
  if (!el) return;
  let html = "";
  if (inHand && h.phase === "done") {
    const r = h.result, hand = r.hands[s], won = r.won[s];
    // 폰에서는 짧은 족보 이름만 (전체 이름은 결과 · 기록에)
    if (hand) html += `<span class="tag lbl${won ? " win" : ""}"><span class="lf">${esc(hand.label)}</span><span class="ls">${esc(CAT_KO[categoryOf(hand.score)])}</span></span>`;
    if (won > 0) html += `<span class="amt win"><i class="chip"></i>+${fmt(won)}</span>`;
  } else if (inHand) {
    let last = null;
    for (let i = h.actions.length - 1; i >= 0; i--) {
      const a = h.actions[i];
      if (a.street !== h.street) break;
      if (a.seat === s && a.type !== "sb" && a.type !== "bb" && a.type !== "return") { last = a; break; }
    }
    if (last && h.phase === "bet") html += `<span class="tag${last.allin ? " allin" : last.type === "fold" ? " fold" : ""}">${actionKo(last, true)}</span>`;
    if (h.bets[s] > 0) html += `<span class="amt"><i class="chip"></i>${fmt(h.bets[s])}</span>`;
  }
  if (el.dataset.h !== html) {
    el.dataset.h = html;
    el.innerHTML = html;
  }
  el.classList.toggle("fin", h.phase === "done");
}

function renderCenter() {
  const h = S.m.hand, best = winningCards(h), sd = h.phase === "done" && h.result.showdown;
  const slots = h.board.slice();
  while (slots.length < 5) slots.push("slot");
  renderCards($("board"), slots, (c) => (c !== "slot" && sd ? (best.has(c) ? "win" : "dim") : ""));
  $("pot").innerHTML = h.phase === "done" ? "" : `<i class="chip"></i>팟 <b>${fmt(PT.potTotal(h))}</b>`;
  // 올인한 사람이 있을 때만 사이드 팟을 나눠 보여준다
  const allin = h.phase !== "done" && PT.aliveSeats(h).some((s) => S.m.players[s].stack === 0);
  const pots = allin ? PT.buildPots(h) : [];
  $("sidepots").textContent = pots.length > 1
    ? pots.map((p, i) => `${i === 0 ? "메인" : `사이드 ${i}`} ${fmt(p.amount)}`).join(" · ")
    : "";
  $("print").textContent = printLabel(h.seats.length);
}

function renderBubble() {
  const b = $("bubble");
  if (!b) return;
  const h = S.m.hand;
  if (thinking && thinking.hand === h) {
    if (b.dataset.k !== "thinking") {
      b.dataset.k = "thinking";
      b.innerHTML = `<span class="dots">생각 중</span> <button id="skip" class="link-btn" type="button">건너뛰기</button>`;
    }
    b.classList.add("on");
    return;
  }
  // 말은 몇 초 보여주고 사라진다 (기록에는 남는다). 안내 문구는 조금 더 길게
  const life = S.say?.note ? 9000 : 6000;
  const age = S.say ? Date.now() - (S.say.at || 0) : Infinity;
  const say = age < life ? S.say : null, k = say ? `${say.text}|${say.note}|${say.at}` : "";
  clearTimeout(sayTimer);
  if (say) sayTimer = setTimeout(() => { if (S) renderBubble(); }, life - age + 50);
  b.classList.toggle("on", !!(say && (say.text || say.note)));
  if (b.dataset.k !== k) {
    b.dataset.k = k;
    b.textContent = "";
    if (say?.text) b.append(say.text);
    if (say?.note) {
      const small = document.createElement("small");
      small.textContent = say.note;
      b.append(small);
    }
  }
}

// 카드 목록을 그린다. 이미 같은 카드가 있으면 그대로 두고 새 카드만 애니메이션
function renderCards(el, list, extraClass) {
  list.forEach((c, i) => {
    const key = String(c);
    let node = el.children[i];
    if (!node || node.dataset.k !== key) {
      const fresh = cardNode(c);
      if (c !== "slot") fresh.classList.add(node?.dataset.k === "back" && c !== "back" ? "flip" : "deal");
      if (node) el.replaceChild(fresh, node);
      else el.appendChild(fresh);
      node = fresh;
    }
    node.classList.remove("win", "dim");
    const x = extraClass(c);
    if (x) node.classList.add(x);
  });
  while (el.children.length > list.length) el.lastChild.remove();
}

function cardNode(c) {
  const d = document.createElement("div");
  d.dataset.k = String(c);
  if (c === "slot") d.className = "card slot";
  else if (c === "back") d.className = "card back";
  else {
    d.className = "card" + (isRed(c) ? " red" : "");
    const rank = RANK_LABEL[rankOf(c)], suit = SUIT_SYMBOL[suitOf(c)];
    d.setAttribute("aria-label", cardLabel(c));
    d.innerHTML = `<span class="idx${rank === "10" ? " ten" : ""}">${rank}<i>${suit}</i></span><span class="pip">${suit}</span>`;
  }
  return d;
}

// ===== 조작판 =====
function renderControls() {
  const m = S.m, h = m.hand, box = $("controls");
  const key = [h.no, h.actions.length, h.phase, h.toAct, h.street, m.over, !!thinking, fast, hintOn, S.ended, m.players[YOU].out].join("|");
  if (key === controlsKey) return;
  controlsKey = key;
  box.classList.toggle("mine", h.phase === "bet" && h.toAct === YOU);
  if (h.phase === "done") box.innerHTML = doneHtml(h);
  else if (h.phase === "bet" && h.toAct === YOU) {
    const tk = `${m.handNo}|${h.actions.length}`;
    if (tk !== turnKey) { turnKey = tk; turnAt = performance.now(); }
    const L = PT.legal(m, YOU);
    box.innerHTML = myTurnHtml(h, L);
    syncRaiseLabel(L);
  } else box.innerHTML = waitHtml(h);
}

function waitHtml(h) {
  const m = S.m, out = !h.seats.includes(YOU) || h.folded[YOU] || m.players[YOU].stack === 0;
  let msg;
  if (h.phase === "runout") msg = "남은 카드를 펼치는 중…";
  else if (thinking && thinking.hand === h) msg = "Claude가 생각 중…";
  else msg = `${esc(nm(h.toAct))} 차례예요`;
  if (m.players[YOU].out) msg = `관전 중 · ${msg}`;
  const ff = out
    ? `<button class="btn ff${fast ? " on" : ""}" id="fast" type="button" aria-pressed="${fast}">${fast ? "빨리 감는 중" : "빨리 감기"} <span aria-hidden="true">»</span></button>`
    : "";
  return `<div class="waiting"><span>${msg}</span>${ff}</div>`;
}

function myTurnHtml(h, L) {
  const m = S.m, me = m.players[YOU], pot = PT.potTotal(h), pos = PT.positionsOf(h)[YOU];
  const callLabel = L.toCall === 0 ? "체크" : `콜 ${fmt(L.toCall)}${L.toCall >= me.stack ? " (올인)" : ""}`;
  const presets = [];
  if (L.canRaise) {
    if (h.street === 0 && L.maxBet <= h.bb) {
      for (const x of [2.5, 3, 4]) presets.push([`${x}BB`, h.bb * x]);
    } else {
      for (const [name, f] of [["½팟", 0.5], ["¾팟", 0.75], ["팟", 1]]) presets.push([name, L.maxBet + (pot + L.toCall) * f]);
    }
    presets.push(["올인", L.maxTo]);
  }
  const seen = new Set();
  const chips = presets
    .map(([name, v]) => [name, clamp(Math.round(v / h.sb) * h.sb, L.minTo, L.maxTo)])
    .filter(([name, v]) => (name === "올인" || v < L.maxTo) && !seen.has(v) && seen.add(v))
    .map(([name, v]) => `<button class="preset" type="button" data-to="${v}">${name}</button>`)
    .join("");
  const startTo = h.street === 0 && L.maxBet <= h.bb ? h.bb * 2.5 : L.isBet ? pot * 0.5 : L.maxBet + (pot + L.toCall) * 0.75;
  const start = L.canRaise ? clamp(Math.round(startTo / h.sb) * h.sb, L.minTo, L.maxTo) : 0;
  const onlyAllIn = L.canRaise && L.minTo === L.maxTo;
  const odds = L.toCall ? ` · 팟 오즈 ${Math.round((100 * L.toCall) / (pot + L.toCall))}%` : "";
  return `
    <div class="ctl-head">
      <span class="ctl-info"><b>내 차례</b> · ${pos} · 팟 ${fmt(pot)}${odds}</span>
      <button class="toggle" id="hint-toggle" type="button" aria-pressed="${hintOn}"><i aria-hidden="true"></i>GTO 힌트</button>
    </div>
    ${hintOn ? hintHtml(h, L) : ""}
    <div class="actions">
      <button class="btn fold" id="b-fold" type="button" ${L.toCall === 0 ? "disabled" : ""}>폴드 <kbd>F</kbd></button>
      <button class="btn call" id="b-call" type="button">${callLabel} <kbd>C</kbd></button>
      <button class="btn raise" id="b-raise" type="button" ${L.canRaise ? "" : "disabled"}></button>
    </div>
    ${L.canRaise && !onlyAllIn ? `
    <div class="sizer">
      <div class="presets">${chips}</div>
      <input type="range" id="slider" min="${L.minTo}" max="${L.maxTo}" step="${h.sb}" value="${start}" aria-label="레이즈 금액">
      <input type="number" id="amt" min="${L.minTo}" max="${L.maxTo}" step="${h.sb}" value="${start}" inputmode="numeric" aria-label="레이즈 금액 직접 입력">
    </div>` : `<input type="hidden" id="amt" value="${L.maxTo}">`}`;
}

// 내 자리에서 GTO 엔진이 고르는 비율 (내 카드는 내 정보이므로 써도 된다)
function hintHtml(h, L) {
  const key = `${S.m.handNo}|${h.actions.length}`;
  if (hint.key !== key) {
    let d = null;
    try { d = PokerAI.decide(S.m, YOU, { rng: Math.random }); } catch { d = null; }
    hint = { key, d };
  }
  const d = hint.d;
  if (!d || !Array.isArray(d.mix) || !d.mix.length) return `<div class="hint"><span class="hint-note">GTO 엔진이 이 자리를 계산하지 못했어요</span></div>`;
  const items = d.mix.filter((x) => x.freq >= 0.005).map((x) => {
    const c = normalize(x.action, x.to, L) ?? { action: x.action };
    let kind = c.action, label;
    if (c.action === "raise") {
      const sized = Number.isFinite(c.to);
      kind = sized && c.to >= L.maxTo ? "allin" : "raise";
      label = kind === "allin" ? "올인" : `${L.isBet ? "벳" : "레이즈"}${sized ? ` ${fmt(c.to)}` : ""}`;
    } else label = { fold: "폴드", check: "체크", call: "콜" }[c.action] ?? c.action;
    return { kind, label, freq: x.freq };
  });
  const eq = Number(d.info?.equity);
  return `
    <div class="hint" aria-label="GTO 엔진 추천 비율">
      <div class="hint-bar">${items.map((i) => `<i class="k-${i.kind}" style="flex-grow:${i.freq.toFixed(3)}"></i>`).join("")}</div>
      <div class="hint-legend">${items.map((i) => `<span><i class="sw k-${i.kind}"></i>${esc(i.label)} <b>${Math.round(i.freq * 100)}%</b></span>`).join("")}${Number.isFinite(eq) ? `<span class="hint-eq">추정 승률 ${Math.round(eq * 100)}%</span>` : ""}</div>
    </div>`;
}

function doneHtml(h) {
  const m = S.m, r = h.result;
  const rows = r.pots.map((p, i) => {
    const title = r.pots.length === 1 ? "팟" : i === 0 ? "메인 팟" : `사이드 팟 ${i}`;
    const names = p.winners.map((s) => esc(nm(s))).join("·") + (p.winners.length > 1 ? " 나눔" : "");
    const how = r.showdown ? esc(r.hands[p.winners[0]].label) : "모두 폴드";
    return `<li><span class="r-pot">${title} <b>${fmt(p.amount)}</b></span><span class="r-win">${names} <small>${how}</small></span></li>`;
  }).join("");
  let net;
  if (!h.seats.includes(YOU)) net = `<div class="net">관전</div>`;
  else {
    const v = m.players[YOU].stack - h.start[YOU];
    net = `<div class="net ${v > 0 ? "up" : v < 0 ? "down" : ""}">내 손익 <b>${v > 0 ? "+" : ""}${fmt(v)}</b></div>`;
  }
  const btn = m.over
    ? `<button class="btn primary" id="show-end" type="button">최종 결과 보기 <kbd>Enter</kbd></button>`
    : m.players[YOU].out && !S.ended
      ? `<button class="btn primary" id="show-end" type="button">결과 보기 <kbd>Enter</kbd></button>`
      : `<button class="btn primary" id="next" type="button">다음 핸드 <kbd>Enter</kbd></button>`;
  return `
    <div class="done">
      <ul class="result" aria-live="polite">${rows}</ul>
      ${net}
      ${btn}
    </div>`;
}

function syncRaiseLabel(L) {
  const btn = $("b-raise");
  if (!btn) return;
  if (!L.canRaise) { btn.innerHTML = "레이즈"; return; }
  const to = clamp(raiseAmount(), L.minTo, L.maxTo);
  const allin = to === L.maxTo;
  btn.innerHTML = `${allin ? "올인" : L.isBet ? "벳" : "레이즈"} ${fmt(to)} <kbd>R</kbd>`;
}

function renderLog() {
  const h = S.m.hand;
  const key = `${S.m.handNo}|${h.phase === "done"}|${S.log.length}|${S.history.length}`;
  if (key === logKey) return;
  logKey = key;
  const current = h.phase === "done" ? [] : [{ no: h.no, net: undefined, log: S.log }];
  const items = [...current, ...S.history].slice(0, 30);
  $("log").innerHTML = items.map((it, i) => {
    const net = it.net === undefined ? `<span class="live">진행 중</span>`
      : it.net === null ? `<span>관전</span>`
      : `<span class="${it.net > 0 ? "up" : it.net < 0 ? "down" : ""}">${it.net > 0 ? "+" : ""}${fmt(it.net)}</span>`;
    return `<li><details${i === 0 ? " open" : ""}><summary>핸드 #${it.no}${net}</summary><ul>${it.log.map((l) => `<li>${l}</li>`).join("")}</ul></details></li>`;
  }).join("");
}

// ===== 창 =====
function openModal(html) {
  $("modal-card").innerHTML = html;
  $("modal").hidden = false;
  const card = $("modal-card");
  (card.querySelector(".btn.primary") || card.querySelector("button"))?.focus();
}
const closeModal = () => {
  $("modal").hidden = true;
  turnAt = performance.now(); // 창 버튼을 두 번 눌러도 뒤의 내 차례 버튼이 눌리지 않게
};

function setupHtml(resume) {
  const n = setup.n;
  const counts = [2, 3, 4, 5, 6].map((k) =>
    `<button type="button" data-count="${k}" aria-pressed="${k === n}">${k}명</button>`).join("");
  const lineup = ROSTER.map((r, s) =>
    `<li class="${s < n ? "" : "off"}"><span class="avatar" style="--av:${r.color}" aria-hidden="true">${r.initial}</span>${esc(r.name)}</li>`).join("");
  const saved = resume && S && !S.m.over;
  return `
    <p class="eyebrow">노리밋 텍사스 홀덤 · 토너먼트</p>
    <h1>Claude와 한 테이블</h1>
    <div class="field">
      <span class="field-label" id="count-label">인원</span>
      <div class="seg count" role="group" aria-labelledby="count-label">${counts}</div>
    </div>
    <ul class="lineup">${lineup}</ul>
    <dl class="rules">
      <div><dt>시작 칩</dt><dd>각자 ${fmt(START_STACK)} (100BB)</dd></div>
      <div><dt>블라인드</dt><dd>10/20부터 ${HANDS_PER_LEVEL}핸드마다 오름</dd></div>
      <div><dt>끝</dt><dd>한 명 남을 때까지</dd></div>
    </dl>
    <label class="check">
      <input type="checkbox" id="m-claude" ${setup.claude ? "checked" : ""}>
      <span><b>Claude 직접 판단</b><small>Claude 자리는 GTO 엔진의 조언을 받아 Claude가 직접 둡니다. 내가 핸드에 남아 있을 때만 Claude를 부르고, 그때마다 Claude 사용량이 조금 쓰여요.</small></span>
    </label>
    <p class="fine">다른 AI 플레이어와, Claude를 부를 수 없을 때의 Claude 자리는 GTO 엔진이 둡니다. 모두 자기 카드와 공개된 정보만 보고 판단해요.</p>
    <div class="modal-actions">
      ${saved ? `<button class="btn primary" id="m-resume" type="button">이어하기 · 핸드 #${S.m.handNo}</button><button class="btn" id="m-start" type="button">${n}명으로 새 게임</button>`
              : `<button class="btn primary" id="m-start" type="button">${n}명으로 시작</button>`}
      ${S && !resume ? `<button class="btn" id="m-cancel" type="button">취소</button>` : ""}
    </div>`;
}

function standingsHtml() {
  // 아직 남은 사람(칩 순) → 순위가 정해진 사람(순위 순)
  const rows = S.m.players.map((p, s) => ({ s, p }));
  const alive = rows.filter((r) => !r.p.place).sort((a, b) => b.p.stack - a.p.stack);
  const placed = rows.filter((r) => r.p.place).sort((a, b) => a.p.place - b.p.place);
  return `<ol class="standings">${[...alive, ...placed].map(({ s, p }) =>
    `<li class="${s === YOU ? "me" : ""}"><span class="avatar" style="--av:${ROSTER[s].color}" aria-hidden="true">${ROSTER[s].initial}</span><b>${esc(nm(s))}</b><span>${p.place ? `${p.place}위` : `${fmt(p.stack)} 칩`}</span></li>`).join("")}</ol>`;
}

function endHtml() {
  const m = S.m, n = m.players.length, me = m.players[YOU], st = S.stats;
  const vpip = st.hands ? Math.round((100 * st.vpip) / st.hands) : 0;
  let eyebrow, title;
  if (me.place === 1) { eyebrow = `${m.handNo}핸드 만에 우승`; title = `우승 · ${n}명 중 1위`; }
  else if (m.over && S.watched) { eyebrow = `${m.handNo}핸드 만에 끝`; title = `최종 결과 · 나는 ${n}명 중 ${me.place}위`; }
  else { eyebrow = `${m.handNo}핸드 만에 탈락`; title = `탈락 · ${n}명 중 ${me.place}위`; }
  const watch = !m.over ? `<button class="btn" id="m-watch" type="button">계속 지켜보기</button>` : `<button class="btn" id="m-close" type="button">테이블 보기</button>`;
  return `
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <dl class="rules">
      <div><dt>가장 큰 팟</dt><dd>${fmt(S.biggestPot)}</dd></div>
      <div><dt>마지막 블라인드</dt><dd>${m.hand.sb}/${m.hand.bb}</dd></div>
      <div><dt>내 VPIP</dt><dd>${vpip}% · ${st.hands}핸드</dd></div>
    </dl>
    ${standingsHtml()}
    <div class="modal-actions">
      <button class="btn primary" id="m-again" type="button">다시 하기 · ${n}명</button>
      ${watch}
      <button class="btn" id="m-setup" type="button">인원 바꾸기</button>
    </div>`;
}

const confirmNewHtml = () => `
  <h1>새 게임을 시작할까요?</h1>
  <p>지금 매치(핸드 #${S.m.handNo})는 사라집니다.</p>
  <div class="modal-actions"><button class="btn primary" id="m-setup" type="button">새 게임 설정</button><button class="btn" id="m-close" type="button">계속하기</button></div>`;

function openSetup(resume) {
  if (S) stopAll();
  setup.n = S ? S.m.players.length : setup.n;
  setup.claude = S ? S.claudeOn : setup.claude;
  openModal(setupHtml(resume));
}

// 설정 창을 닫고 지금 매치로 돌아간다
function resumeMatch() {
  closeModal();
  tableKey = controlsKey = logKey = "";
  render();
  advance();
}

// ===== 입력 =====
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const h = S?.m.hand;
  switch (t.id) {
    case "m-start": closeModal(); newMatch(setup.n, setup.claude); return;
    case "m-resume": case "m-cancel": resumeMatch(); return;
    case "m-again": closeModal(); newMatch(S.m.players.length, S.claudeOn); return;
    case "m-setup": openSetup(false); return;
    case "m-watch": S.watched = true; save(); closeModal(); if (!thinking) advance(); return;
    case "m-close": closeModal(); if (S && !thinking) advance(); return;
    case "new-game":
      if (S && !S.m.over) { stopAll(); render(); openModal(confirmNewHtml()); } // 묻는 동안 게임을 멈춘다 (계속하기 → 이어서)
      else openSetup(false);
      return;
    case "next": startHand(); return;
    case "show-end": clearTimeout(endTimer); if (S.ended && S.m.over) openModal(endHtml()); else showEnd(); return;
    case "fast": fast = !fast; controlsKey = ""; if (h?.phase !== "done" && !thinking) advance(); else render(); return;
    case "hint-toggle":
      hintOn = !hintOn;
      try { localStorage.setItem(HINT_KEY, hintOn ? "1" : "0"); } catch {}
      controlsKey = "";
      renderControls();
      return;
    case "b-fold": userAct("fold"); return;
    case "b-call": userAct("call"); return;
    case "b-raise": userAct("raise", raiseAmount()); return;
    case "skip": thinking?.ctl.abort(); return;
    case "retry": link = "live"; renderTop(); return;
  }
  if (t.dataset.count) {
    setup.n = Number(t.dataset.count);
    const claude = $("m-claude");
    if (claude) setup.claude = claude.checked;
    const resume = !!$("m-resume");
    openModal(setupHtml(resume));
    $("modal-card").querySelector(`[data-count="${setup.n}"]`)?.focus();
    if (!S || S.m.over) renderPreview(setup.n);
  } else if (t.classList.contains("preset")) {
    setAmount(Number(t.dataset.to));
  } else if (t.dataset.depth) {
    if (S) { S.depth = t.dataset.depth; save(); }
    renderTop();
  }
});

function setAmount(v) {
  const L = PT.legal(S.m, YOU);
  v = clamp(Number.isFinite(v) ? v : L.minTo, L.minTo, L.maxTo);
  if ($("slider")) $("slider").value = v;
  if ($("amt")) $("amt").value = v;
  syncRaiseLabel(L);
}

document.addEventListener("input", (e) => {
  if (!S || S.m.hand.toAct !== YOU) return;
  if (e.target.id === "slider") setAmount(Number(e.target.value));
  else if (e.target.id === "amt") {
    if ($("slider")) $("slider").value = e.target.value;
    syncRaiseLabel(PT.legal(S.m, YOU));
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "m-claude") setup.claude = e.target.checked;
  else if (e.target.id === "amt" && S?.m.hand.toAct === YOU) setAmount(Number(e.target.value));
});

document.addEventListener("keydown", (e) => {
  if (!S || !$("modal").hidden || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return; // 누르고 있어 반복되는 키는 무시
  const typing = e.target.matches?.("input[type=number]");
  const h = S.m.hand, k = e.key.toLowerCase();
  if (e.key === "Enter") {
    if (typing) { e.preventDefault(); setAmount(raiseAmount()); userAct("raise", raiseAmount()); }
    else if (h.phase === "done" && !e.target.closest?.("button, summary, input")) { e.preventDefault(); ($("next") || $("show-end"))?.click(); }
    return;
  }
  if (typing || h.phase !== "bet" || h.toAct !== YOU) return;
  if (k === "f") $("b-fold")?.click();
  else if (k === "c") $("b-call")?.click();
  else if (k === "r") $("b-raise")?.click();
});

// 폰 ↔ 넓은 화면: 자리 배치를 바꾼다
tallMQ.addEventListener?.("change", () => {
  tableKey = "";
  if (S) render();
  else renderPreview(setup.n);
});

// ===== 시작 =====
function boot() {
  const saved = load();
  if (saved) {
    S = saved;
    setup = { n: S.m.players.length, claude: S.claudeOn };
    render(); // 저장할 때 진행 중이던 차례·카드 펼치기는 이어하기를 누르면 다시 시작된다
    if (S.m.over) showEnd(); // 마지막 핸드 뒤 결과 창을 보기 전에 닫았으면 결과부터
    else openModal(setupHtml(true));
  } else {
    renderPreview(setup.n);
    openModal(setupHtml(false));
  }
  renderTop();
}

boot();
