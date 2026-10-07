// ===== 설정 =====
const SAVE_KEY = "holdem-vs-claude";
const START_STACK = 2000;
const HANDS_PER_LEVEL = 10;
const LEVELS = [[10, 20], [15, 30], [20, 40], [30, 60], [40, 80], [50, 100], [75, 150], [100, 200], [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000]];
const YOU = 0, CLAUDE = 1;
const NAME = ["나", "Claude"];
const STREET_KO = ["프리플롭", "플롭", "턴", "리버"];
const STREET_EN = ["Preflop", "Flop", "Turn", "River"];

let G = null;          // 매치 상태 (localStorage에 저장)
let depth = "quick";   // Claude 생각 깊이: quick(빠르게) | default(깊게)
let sampleFn = null;   // claude.use("sample") — Claude에게 수를 묻는 함수
let link = "checking"; // checking | live | paused | offline
let thinking = null;   // Claude 차례 진행 중: { hand, ctl }
let runoutTimer = 0;
let controlsKey = "";

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString("ko-KR");
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const other = (p) => 1 - p;

// 이 화면이 Claude를 부를 수 있는지 (아티팩트 안에서만 가능, 로컬 파일은 내장 봇)
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
function blindsFor(handNo) {
  return LEVELS[Math.min(Math.floor((handNo - 1) / HANDS_PER_LEVEL), LEVELS.length - 1)];
}

function newMatch() {
  clearTimeout(runoutTimer);
  thinking?.ctl.abort();
  thinking = null;
  G = {
    v: 1,
    stacks: [START_STACK, START_STACK],
    button: randInt(2),
    handNo: 0,
    hand: null,
    history: [],     // 끝난 핸드 기록 (최근 30개)
    over: false,
    depth,
    biggestPot: 0,
    stats: { hands: 0, vpip: 0, pfr: 0, aggr: 0, calls: 0, facedBet: 0, foldedToBet: 0, showdowns: [] }, // 내 성향 (Claude가 참고)
  };
  startHand();
}

function startHand() {
  if (G.hand) G.button = other(G.button); // 헤즈업: 매 핸드 버튼(=스몰 블라인드)이 바뀐다
  G.handNo++;
  const [sb, bb] = blindsFor(G.handNo);
  const deck = shuffledDeck();
  const h = {
    no: G.handNo, sb, bb, button: G.button, deck,
    hole: [[deck.pop(), deck.pop()], [deck.pop(), deck.pop()]],
    board: [], street: 0,
    bets: [0, 0],        // 이번 스트리트에 낸 칩
    contrib: [0, 0],     // 이번 핸드에 낸 칩 전체
    acted: [false, false],
    lastRaise: bb,       // 최소 레이즈 폭
    toAct: G.button,     // 프리플롭은 버튼이 먼저
    folded: -1,
    phase: "bet",        // bet | runout | done
    shown: false,        // Claude 카드 공개 여부
    start: G.stacks.slice(),
    actions: [],
    log: [],
    say: null,           // Claude 말풍선 { text, note }
    result: null,
    userVpip: false, userPfr: false,
  };
  G.hand = h;
  G.stats.hands++;
  addLog(`블라인드 ${sb}/${bb} · 딜러 ${NAME[h.button]}`);
  post(h.button, sb, "sb");
  post(other(h.button), bb, "bb");
  addLog(`내 카드 ${cardsHtml(h.hole[YOU])}`);
  advance();
}

function post(p, amount, type) {
  const h = G.hand, a = Math.min(amount, G.stacks[p]);
  move(p, a);
  h.actions.push({ street: 0, p, type, amount: a, allin: G.stacks[p] === 0 });
  addLog(`${NAME[p]} ${type === "sb" ? "스몰" : "빅"} 블라인드 ${fmt(a)}${G.stacks[p] === 0 ? " (올인)" : ""}`);
}

function move(p, a) {
  const h = G.hand;
  G.stacks[p] -= a;
  h.bets[p] += a;
  h.contrib[p] += a;
}

// p가 지금 할 수 있는 것
function legal(h, p) {
  const o = other(p), maxBet = Math.max(h.bets[0], h.bets[1]);
  const toCall = Math.min(maxBet - h.bets[p], G.stacks[p]);
  const maxTo = Math.min(h.bets[p] + G.stacks[p], h.bets[o] + G.stacks[o]); // 상대가 받을 수 있는 만큼까지만
  const canRaise = G.stacks[p] > toCall && G.stacks[o] > 0 && maxTo > maxBet;
  const minTo = Math.min(maxBet + Math.max(h.lastRaise, h.bb), maxTo);
  return { toCall, canRaise, minTo, maxTo, maxBet, isBet: maxBet === 0 };
}

function act(p, type, to) {
  const h = G.hand, o = other(p), L = legal(h, p);
  const rec = { street: h.street, p, type };
  if (type === "fold") {
    h.folded = p;
  } else if (type === "call") {
    rec.amount = L.toCall;
    move(p, L.toCall);
  } else if (type === "raise") {
    to = clamp(Math.round(to), L.minTo, L.maxTo);
    if (to - L.maxBet >= Math.max(h.lastRaise, h.bb)) h.lastRaise = to - L.maxBet; // 모자란 올인 레이즈는 최소 레이즈 폭을 바꾸지 않는다
    move(p, to - h.bets[p]);
    rec.type = L.isBet ? "bet" : "raise";
    rec.to = to;
    h.acted[o] = false;
  }
  rec.allin = G.stacks[p] === 0 && type !== "fold";
  h.acted[p] = true;
  h.actions.push(rec);
  trackStats(h, rec, L);
  addLog(`${NAME[p]} ${actionKo(rec)}`);
  if (h.folded >= 0) return finishFold();
  if (roundDone(h)) return endStreet();
  h.toAct = o;
  advance();
}

function roundDone(h) {
  const settled = (p) => h.acted[p] || G.stacks[p] === 0;
  const even = h.bets[0] === h.bets[1] || G.stacks[h.bets[0] < h.bets[1] ? 0 : 1] === 0;
  return settled(0) && settled(1) && even;
}

function endStreet() {
  const h = G.hand;
  // 상대가 못 받는 만큼 더 낸 칩은 돌려준다 (짧은 스택이 블라인드로 올인한 경우 등)
  const hi = h.bets[0] > h.bets[1] ? 0 : 1, extra = h.bets[hi] - h.bets[other(hi)];
  if (extra > 0) {
    G.stacks[hi] += extra;
    h.bets[hi] -= extra;
    h.contrib[hi] -= extra;
    addLog(`${NAME[hi]} 받지 않은 ${fmt(extra)} 돌려받음`);
  }
  if (h.street === 3) return showdown();
  if (G.stacks[0] === 0 || G.stacks[1] === 0) {
    h.phase = "runout";
    h.shown = true;
    addLog(`올인 — 카드 공개: Claude ${cardsHtml(h.hole[CLAUDE])}`);
    return advance();
  }
  nextStreet(h);
  h.toAct = other(h.button); // 플롭부터는 빅 블라인드가 먼저
  advance();
}

function nextStreet(h) {
  h.street++;
  h.deck.pop(); // 번
  const n = h.street === 1 ? 3 : 1;
  for (let i = 0; i < n; i++) h.board.push(h.deck.pop());
  h.bets = [0, 0];
  h.acted = [false, false];
  h.lastRaise = h.bb;
  addLog(`<span class="street">${STREET_KO[h.street]}</span> ${cardsHtml(h.board)}`, true);
}

function runoutStep(h) {
  if (G.hand !== h || h.phase !== "runout") return;
  if (h.street < 3) {
    nextStreet(h);
    save();
    render();
    runoutTimer = setTimeout(() => runoutStep(h), 950);
  } else showdown();
}

function showdown() {
  const h = G.hand;
  h.shown = true;
  const best = [YOU, CLAUDE].map((p) => bestFive([...h.hole[p], ...h.board]));
  const pot = h.contrib[0] + h.contrib[1];
  const winner = best[0].score > best[1].score ? YOU : best[1].score > best[0].score ? CLAUDE : -1;
  if (winner >= 0) G.stacks[winner] += pot;
  else {
    const half = Math.floor(pot / 2);
    G.stacks[0] += half;
    G.stacks[1] += half;
    G.stacks[other(h.button)] += pot - half * 2; // 나머지 1칩은 버튼 반대편
  }
  h.result = {
    reason: "showdown", winner, pot,
    labels: best.map((b) => describe(b.score)),
    cards: winner >= 0 ? best[winner].cards : [...best[0].cards, ...best[1].cards],
  };
  if (!h.log.some((l) => l.includes("카드 공개"))) addLog(`쇼다운 — Claude ${cardsHtml(h.hole[CLAUDE])}`);
  addLog(`나 ${h.result.labels[0]} · Claude ${h.result.labels[1]}`);
  addLog(winner < 0 ? `무승부 — 팟 ${fmt(pot)} 나눔` : `<b>${NAME[winner]}</b> 팟 ${fmt(pot)} 획득`);
  G.stats.showdowns = [...G.stats.showdowns, { cards: h.hole[YOU].map(cardCode).join(""), hand: describeEn(best[0].score), board: h.board.map(cardCode).join(" ") }].slice(-4);
  finishHand();
}

function finishFold() {
  const h = G.hand, winner = other(h.folded), pot = h.contrib[0] + h.contrib[1];
  G.stacks[winner] += pot;
  h.result = { reason: "fold", winner, pot, labels: null, cards: [] };
  addLog(`<b>${NAME[winner]}</b> 팟 ${fmt(pot)} 획득`);
  finishHand();
}

function finishHand() {
  const h = G.hand;
  h.phase = "done";
  h.toAct = -1;
  h.bets = [0, 0];
  G.biggestPot = Math.max(G.biggestPot, h.result.pot);
  const net = G.stacks[YOU] - h.start[YOU];
  G.history = [{ no: h.no, net, log: h.log }, ...G.history].slice(0, 30);
  if (G.stacks[YOU] === 0 || G.stacks[CLAUDE] === 0) G.over = true;
  advance();
}

// 다음에 할 일: 할 게 없는 사람은 건너뛰고, Claude 차례면 Claude를 부른다
function advance() {
  const h = G.hand;
  while (h.phase === "bet") {
    const p = h.toAct, L = legal(h, p);
    if (G.stacks[p] > 0 && (L.toCall > 0 || L.canRaise)) break;
    h.acted[p] = true; // 올인했거나 상대가 올인이라 할 수 있는 게 없음
    if (roundDone(h)) return endStreet();
    h.toAct = other(p);
  }
  save();
  render();
  if (h.phase === "runout") {
    clearTimeout(runoutTimer);
    runoutTimer = setTimeout(() => runoutStep(h), 950);
  } else if (h.phase === "bet" && h.toAct === CLAUDE) {
    claudeTurn(h);
  }
}

// ===== 내 성향 기록 (Claude 프롬프트에 들어간다) =====
function trackStats(h, rec, L) {
  if (rec.p !== YOU) return;
  const st = G.stats;
  if (h.street === 0) {
    if ((rec.type === "call" || rec.type === "raise") && !h.userVpip) { st.vpip++; h.userVpip = true; }
    if (rec.type === "raise" && !h.userPfr) { st.pfr++; h.userPfr = true; }
    return;
  }
  if (rec.type === "bet" || rec.type === "raise") st.aggr++;
  if (rec.type === "call") st.calls++;
  if (L.toCall > 0) {
    st.facedBet++;
    if (rec.type === "fold") st.foldedToBet++;
  }
}

// ===== Claude 차례 =====
async function claudeTurn(h) {
  if (thinking) return;
  const ctl = new AbortController();
  thinking = { hand: h, ctl };
  h.say = null;
  render();
  const L = legal(h, CLAUDE);
  const eq = equity(h.hole[CLAUDE], h.board, 2000);
  let choice = null, note = "";
  const fn = await sampleReady;
  if (fn && link === "live") {
    try {
      const reply = await fn.json(buildPrompt(h, L, eq), { modelTier: depth, cache: false, signal: ctl.signal });
      choice = parseChoice(reply, L);
      if (!choice) note = "답을 읽지 못해 이번 수는 내장 봇이 뒀어요";
    } catch (e) {
      note = sampleErrorNote(e?.code);
    }
  } else {
    await wait(600 + Math.random() * 700);
  }
  if (thinking?.ctl === ctl) thinking = null;
  if (G.hand !== h || h.phase !== "bet" || h.toAct !== CLAUDE) return; // 그 사이 새 게임을 시작함
  if (!choice) choice = botChoice(h, L, eq);
  h.say = { text: choice.say || "", note };
  if (choice.say) addLog(`Claude: “${esc(choice.say)}”`);
  act(CLAUDE, choice.action, choice.to);
}

function sampleErrorNote(code) {
  switch (code) {
    case "cancelled":
      return "건너뛰어서 이번 수는 내장 봇이 뒀어요";
    case "rate_limited":
      link = "paused";
      return "Claude 요청 한도에 걸렸어요. 잠시 뒤 위의 ‘다시 연결’을 눌러주세요";
    case "session_expired":
      link = "paused";
      return "다시 로그인해야 Claude가 둘 수 있어요";
    case "not_granted": case "sampling_disabled": case "not_declared": case "capability_disabled": case "capability_removed":
      link = "offline";
      return "Claude 사용이 허용되지 않아 내장 봇으로 바꿨어요";
    default:
      return "Claude 응답에 문제가 있어 이번 수는 내장 봇이 뒀어요";
  }
}

const cardsEn = (cs) => cs.map(cardCode).join(" ");

function buildPrompt(h, L, eq) {
  const me = CLAUDE, opp = YOU, st = G.stats;
  const pot = h.contrib[0] + h.contrib[1];
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  const eff = Math.min(G.stacks[me] + h.bets[me], G.stacks[opp] + h.bets[opp]);
  const options = [];
  if (L.toCall > 0) options.push(`"fold"`, `"call" (costs ${L.toCall}${L.toCall >= G.stacks[me] ? ", all-in" : ""})`);
  else options.push(`"check"`);
  if (L.canRaise) {
    const top = L.maxTo === h.bets[me] + G.stacks[me] ? "all-in" : "puts the opponent all-in";
    options.push(`"raise" with "to" from ${L.minTo} to ${L.maxTo} (${L.maxTo} ${top})`);
  }
  const showdowns = st.showdowns.length
    ? ` Their recent showdown hands: ${st.showdowns.map((s) => `${s.cards} (${s.hand} on ${s.board})`).join("; ")}.`
    : "";
  return [
    "You are Claude, playing a heads-up No-Limit Texas Hold'em match against the person viewing this page. It is a friendly match for play chips, but play to win: solid, adaptive strategy. Value-bet strong hands, bluff and semi-bluff at sensible frequencies, fold when you are likely beaten, and exploit the opponent's tendencies listed below. You can see only your own hole cards.",
    "",
    `Match: hand #${h.no}, blinds ${h.sb}/${h.bb}; blinds rise every ${HANDS_PER_LEVEL} hands; the match ends when one player has no chips.`,
    `Your position: ${h.button === me ? "button / small blind (first to act preflop, last after the flop)" : "big blind (last to act preflop, first after the flop)"}.`,
    `Your hole cards: ${cardsEn(h.hole[me])}`,
    `Board: ${h.board.length ? cardsEn(h.board) : "none yet"} (street: ${STREET_EN[h.street]})`,
    `Pot, including bets on this street: ${pot}`,
    `Bets on this street: you ${h.bets[me]}, opponent ${h.bets[opp]}`,
    `Stacks behind: you ${G.stacks[me]}, opponent ${G.stacks[opp]} (effective stack ${(eff / h.bb).toFixed(1)} big blinds)`,
    `To call: ${L.toCall}${L.toCall ? ` (pot odds ${Math.round((100 * L.toCall) / (pot + L.toCall))}%)` : ""}`,
    `Your equity against a random hand: ${Math.round(eq * 100)}% (simulation). Against the range the opponent's betting suggests, it is usually lower when they bet or raise big.`,
    "",
    "Action so far this hand:",
    historyEn(h),
    "",
    `Opponent this match (${st.hands} hands): plays ${pct(st.vpip, st.hands)} of hands preflop, raises ${pct(st.pfr, st.hands)} preflop; after the flop they made ${st.aggr} bets/raises and ${st.calls} calls, and folded to your bets/raises ${st.foldedToBet} of ${st.facedBet} times.${showdowns}`,
    "",
    `Your legal actions now: ${options.join("; ")}.`,
    `"to" is your TOTAL bet on this street after raising, not the increment. An opening bet after the flop is also "raise".`,
    "",
    'Reply with only a JSON object: {"action": "<one legal action>", "to": <number, only for raise>, "say": "<table talk>"}.',
    '"say" is one short line you say to your opponent at the table, in casual, friendly Korean (반말), at most 30 characters. It may tease or bluff lightly, but never state your actual hole cards. Use "" when you have nothing to say.',
  ].join("\n");
}

function historyEn(h) {
  const who = (p) => (p === CLAUDE ? "You" : "Opponent");
  const verb = (a) => {
    const tail = a.allin ? " (all-in)" : "";
    switch (a.type) {
      case "sb": return `post small blind ${a.amount}${tail}`;
      case "bb": return `post big blind ${a.amount}${tail}`;
      case "fold": return "fold";
      case "check": return "check";
      case "call": return `call ${a.amount}${tail}`;
      case "bet": return `bet ${a.to}${tail}`;
      default: return `raise to ${a.to}${tail}`;
    }
  };
  const lines = [];
  for (let s = 0; s <= h.street; s++) {
    const acts = h.actions.filter((a) => a.street === s).map((a) => `${who(a.p)} ${verb(a)}`);
    const label = s === 0 ? "Preflop" : `${STREET_EN[s]} [${cardsEn(h.board.slice(0, s + 2))}]`;
    lines.push(`${label}: ${acts.join(", ") || "no action yet"}`);
  }
  return lines.join("\n");
}

// Claude의 JSON 답을 실제로 둘 수 있는 수로 바꾼다. 못 읽으면 null
function parseChoice(r, L) {
  if (!r || typeof r !== "object") return null;
  let action = String(r.action ?? "").toLowerCase().replace(/[^a-z]/g, "");
  let to = Math.round(Number(r.to ?? r.amount));
  const say = typeof r.say === "string" ? r.say.trim().slice(0, 60) : "";
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
  return { action, to, say };
}

// 내장 봇: 무작위 손패 상대 승률 + 팟 오즈 + 약간의 블러핑
function botChoice(h, L, eq) {
  const pot = h.contrib[0] + h.contrib[1], r = Math.random();
  const unit = h.sb;
  const sized = (to) => ({ action: "raise", to: clamp(Math.round(to / unit) * unit, L.minTo, L.maxTo) });
  const potRaise = (f) => sized(L.maxBet + (pot + L.toCall) * f);
  const check = { action: L.toCall > 0 ? "fold" : "check" };
  if (h.street === 0 && L.maxBet <= h.bb) { // 아무도 레이즈하지 않은 프리플롭
    if (L.canRaise && (eq > 0.58 || (eq > 0.46 && r < 0.6))) return sized(h.bb * (r < 0.5 ? 2.5 : 3));
    if (L.toCall === 0) return { action: "check" };
    return eq > 0.38 ? { action: "call" } : check;
  }
  if (L.toCall === 0) {
    if (L.canRaise && eq > 0.72 && r < 0.85) return potRaise(0.75);
    if (L.canRaise && eq > 0.55 && r < 0.55) return potRaise(0.5);
    if (L.canRaise && r < 0.14) return potRaise(0.6);
    return { action: "check" };
  }
  const odds = L.toCall / (pot + L.toCall);
  const pressure = Math.min(L.toCall / Math.max(pot - L.toCall, 1), 2);
  if (L.canRaise && eq > 0.78 && r < 0.6) return potRaise(0.8);
  if (eq >= odds + 0.06 + 0.08 * pressure) return { action: "call" };
  if (L.canRaise && h.street < 3 && r < 0.05) return potRaise(0.7);
  return check;
}

// ===== 내 수 =====
function userAct(type, to) {
  const h = G.hand;
  if (!h || h.phase !== "bet" || h.toAct !== YOU) return;
  const L = legal(h, YOU);
  if (type === "fold" && L.toCall === 0) return;
  if (type === "raise" && !L.canRaise) return;
  h.say = null;
  act(YOU, type, to);
}

function raiseAmount() {
  const v = Number($("amt")?.value);
  return Number.isFinite(v) ? v : 0;
}

// ===== 기록 =====
function addLog(html, isStreet) {
  G.hand.log.push(isStreet ? `<span class="street-line">${html}</span>` : html);
}

function actionKo(a) {
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

// ===== 저장 =====
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch {}
}

function load() {
  try {
    const g = JSON.parse(localStorage.getItem(SAVE_KEY));
    return g && g.v === 1 && Array.isArray(g.stacks) && g.hand ? g : null;
  } catch {
    return null;
  }
}

// ===== 화면 =====
function render() {
  if (!G) return;
  renderTop();
  renderSeat(YOU);
  renderSeat(CLAUDE);
  renderCenter();
  renderControls();
  renderLog();
}

function renderTop() {
  const dot = $("link-dot"), text = $("link-text"), seg = $("depth"), retry = $("retry");
  if (!dot) return;
  dot.className = "dot " + link;
  text.textContent = {
    checking: "Claude 연결 확인 중",
    live: "Claude가 직접 둡니다",
    paused: "Claude 쉬는 중 · 내장 봇이 대신",
    offline: "내장 봇이 둡니다",
  }[link];
  $("link").title = link === "offline"
    ? "이 화면에서는 Claude를 부를 수 없어서 게임에 들어 있는 봇이 둡니다. claude.ai 아티팩트로 열면 Claude가 직접 둬요."
    : "Claude는 자기 카드와 보드, 베팅 기록만 보고 판단합니다. 당신 카드는 보지 못해요.";
  seg.hidden = link !== "live";
  retry.hidden = link !== "paused";
  for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.depth === depth));
  if (!G) return;
  const h = G.hand, left = HANDS_PER_LEVEL - ((G.handNo - 1) % HANDS_PER_LEVEL);
  const [nsb, nbb] = blindsFor(G.handNo + left);
  $("level").innerHTML = `핸드 <b>#${G.handNo}</b> · 블라인드 <b>${h.sb}/${h.bb}</b>` +
    (nbb !== h.bb ? ` · <span>${left}핸드 뒤 ${nsb}/${nbb}</span>` : "");
}

function renderSeat(p) {
  const h = G.hand, seat = $(`seat-${p}`);
  seat.classList.toggle("turn", h.phase === "bet" && h.toAct === p);
  seat.classList.toggle("folded", h.folded === p);
  $(`stack-${p}`).textContent = fmt(G.stacks[p]);
  $(`dealer-${p}`).hidden = h.button !== p;

  const show = p === YOU || h.shown;
  const hi = h.result?.cards ?? [];
  renderCards($(`hole-${p}`), h.hole[p].map((c) => (show ? c : "back")), (c) =>
    h.result?.reason === "showdown" ? (hi.includes(c) ? "win" : "dim") : "");

  const bet = $(`bet-${p}`);
  bet.innerHTML = h.bets[p] > 0 ? `<i class="chip"></i>${fmt(h.bets[p])}` : "";

  // 이번 스트리트의 마지막 행동
  const last = [...h.actions].reverse().find((a) => a.p === p && a.type !== "sb" && a.type !== "bb");
  const tag = $(`act-${p}`);
  const fresh = last && (last.street === h.street || h.phase !== "bet" || last.type === "fold");
  tag.textContent = fresh ? actionKo(last) : "";
  tag.className = "act" + (fresh && last.allin ? " allin" : "");

  // 지금 내 패 이름 (보드가 깔린 뒤)
  const label = $(`label-${p}`);
  if (h.result?.labels) label.textContent = h.result.labels[p];
  else if (show && h.board.length >= 3) label.textContent = describe(evaluate([...h.hole[p], ...h.board]));
  else label.textContent = "";
  label.classList.toggle("win", h.result?.labels != null && h.result.winner === p);

  if (p === CLAUDE) renderBubble(h);
}

function renderBubble(h) {
  const b = $("bubble");
  if (thinking && thinking.hand === h) {
    const skip = link === "live" ? ` <button id="skip" class="link-btn" type="button">건너뛰기</button>` : "";
    b.innerHTML = `<span class="dots">생각 중</span>${skip}`;
    b.classList.add("on");
    return;
  }
  const say = h.say;
  b.classList.toggle("on", !!(say && (say.text || say.note)));
  b.innerHTML = say ? `${say.text ? esc(say.text) : ""}${say.note ? `<small>${esc(say.note)}</small>` : ""}` : "";
}

function renderCenter() {
  const h = G.hand;
  const slots = h.board.slice();
  while (slots.length < 5) slots.push("slot");
  const hi = h.result?.cards ?? [];
  renderCards($("board"), slots, (c) => (h.result?.reason === "showdown" && c !== "slot" ? (hi.includes(c) ? "win" : "dim") : ""));
  const pot = h.contrib[0] + h.contrib[1];
  $("pot").innerHTML = h.phase === "done" ? "" : `<i class="chip"></i>팟 <b>${fmt(pot)}</b>`;
  const res = $("result");
  if (h.phase !== "done") {
    res.innerHTML = "";
    res.className = "result";
    return;
  }
  const r = h.result, net = G.stacks[YOU] - h.start[YOU];
  let text;
  if (r.winner < 0) text = `무승부 · 팟 ${fmt(r.pot)} 나눔`;
  else if (r.reason === "fold") text = `${r.winner === YOU ? "Claude 폴드 · 내가" : "내가 폴드 · Claude가"} 팟 ${fmt(r.pot)} 가져감`;
  else text = `${r.winner === YOU ? "내가" : "Claude가"} ${r.labels[r.winner]}로 팟 ${fmt(r.pot)} 가져감`;
  res.innerHTML = `${esc(text)}<b>${net > 0 ? "+" : ""}${fmt(net)}</b>`;
  res.className = "result " + (net > 0 ? "up" : net < 0 ? "down" : "");
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

function renderControls() {
  const h = G.hand, box = $("controls");
  const L = h.phase === "bet" && h.toAct === YOU ? legal(h, YOU) : null;
  const key = `${h.no}|${h.actions.length}|${h.phase}|${h.toAct}|${G.over}|${!!thinking}`;
  if (key === controlsKey) return;
  controlsKey = key;

  if (h.phase === "done") {
    box.innerHTML = G.over
      ? `<button class="btn primary wide" id="next" type="button">최종 결과 보기</button>`
      : `<button class="btn primary wide" id="next" type="button">다음 핸드 <kbd>Enter</kbd></button>`;
    return;
  }
  if (!L) {
    const msg = h.phase === "runout" ? "남은 카드를 펼치는 중…" : "Claude 차례예요";
    box.innerHTML = `<div class="waiting">${msg}</div>`;
    return;
  }

  const callLabel = L.toCall === 0 ? "체크" : `콜 ${fmt(L.toCall)}${L.toCall >= G.stacks[YOU] ? " (올인)" : ""}`;
  const pot = h.contrib[0] + h.contrib[1];
  const presets = [];
  if (L.canRaise) {
    if (h.street === 0 && L.maxBet <= h.bb) {
      for (const m of [2.5, 3, 4]) presets.push([`${m}BB`, h.bb * m]);
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
  const start = L.canRaise ? clamp(Math.round((L.isBet ? pot * 0.5 : L.maxBet * 2.5) / h.sb) * h.sb, L.minTo, L.maxTo) : 0;
  const onlyAllIn = L.canRaise && L.minTo === L.maxTo;

  box.innerHTML = `
    <div class="actions">
      <button class="btn fold" id="b-fold" type="button" ${L.toCall === 0 ? "disabled" : ""}>폴드 <kbd>F</kbd></button>
      <button class="btn call" id="b-call" type="button">${callLabel} <kbd>C</kbd></button>
      <button class="btn raise" id="b-raise" type="button" ${L.canRaise ? "" : "disabled"}></button>
    </div>
    ${L.canRaise && !onlyAllIn ? `
    <div class="sizer">
      <div class="presets">${chips}</div>
      <input type="range" id="slider" min="${L.minTo}" max="${L.maxTo}" step="${h.sb}" value="${start}" aria-label="레이즈 금액">
      <input type="number" id="amt" min="${L.minTo}" max="${L.maxTo}" step="${h.sb}" value="${start}" aria-label="레이즈 금액 직접 입력">
    </div>` : `<input type="hidden" id="amt" value="${L.maxTo}">`}`;
  syncRaiseLabel(L);
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
  const h = G.hand;
  const current = h.phase === "done" ? [] : [{ no: h.no, net: null, log: h.log }];
  const items = [...current, ...G.history].slice(0, 30);
  $("log").innerHTML = items.map((it, i) => {
    const net = it.net == null ? `<span class="live">진행 중</span>` :
      `<span class="${it.net > 0 ? "up" : it.net < 0 ? "down" : ""}">${it.net > 0 ? "+" : ""}${fmt(it.net)}</span>`;
    return `<li><details${i === 0 ? " open" : ""}><summary>핸드 #${it.no}${net}</summary><ul>${it.log.map((l) => `<li>${l}</li>`).join("")}</ul></details></li>`;
  }).join("");
}

// ===== 모달 =====
function openModal(html) {
  $("modal-card").innerHTML = html;
  $("modal").hidden = false;
  $("modal-card").querySelector("button")?.focus();
}
const closeModal = () => { $("modal").hidden = true; };

function introHtml(saved) {
  return `
    <p class="eyebrow">헤즈업 · 노리밋 텍사스 홀덤</p>
    <h1>Claude와 1:1 포커</h1>
    <dl class="rules">
      <div><dt>시작 칩</dt><dd>각자 ${fmt(START_STACK)}</dd></div>
      <div><dt>블라인드</dt><dd>10/20부터, ${HANDS_PER_LEVEL}핸드마다 오름</dd></div>
      <div><dt>끝</dt><dd>한쪽 칩이 바닥나면</dd></div>
    </dl>
    <p>상대는 Claude입니다. Claude는 자기 카드와 보드, 베팅 기록만 보고 판단해요. 당신 카드는 볼 수 없습니다.</p>
    <p class="fine">Claude가 수를 둘 때마다 당신 계정의 Claude 사용량이 조금 쓰이고, 처음 한 번 허용을 묻습니다. Claude를 부를 수 없는 곳에서는 게임에 들어 있는 봇이 대신 둡니다.</p>
    <div class="modal-actions">
      ${saved ? `<button class="btn primary" id="m-resume" type="button">이어하기 · 핸드 #${saved.handNo}</button><button class="btn" id="m-new" type="button">새 게임</button>`
              : `<button class="btn primary" id="m-new" type="button">게임 시작</button>`}
    </div>`;
}

function overHtml() {
  const won = G.stacks[YOU] > 0;
  return `
    <p class="eyebrow">${G.handNo}핸드 만에 끝</p>
    <h1>${won ? "당신이 이겼어요" : "Claude가 이겼어요"}</h1>
    <dl class="rules">
      <div><dt>가장 큰 팟</dt><dd>${fmt(G.biggestPot)}</dd></div>
      <div><dt>마지막 블라인드</dt><dd>${G.hand.sb}/${G.hand.bb}</dd></div>
      <div><dt>내 VPIP</dt><dd>${G.stats.hands ? Math.round((100 * G.stats.vpip) / G.stats.hands) : 0}%</dd></div>
    </dl>
    <div class="modal-actions"><button class="btn primary" id="m-new" type="button">다시 하기</button><button class="btn" id="m-close" type="button">테이블 보기</button></div>`;
}

const confirmNewHtml = () => `
  <h1>새 게임을 시작할까요?</h1>
  <p>지금 매치(핸드 #${G.handNo})는 사라집니다.</p>
  <div class="modal-actions"><button class="btn primary" id="m-new" type="button">새로 시작</button><button class="btn" id="m-close" type="button">계속하기</button></div>`;

// ===== 입력 =====
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  const h = G?.hand;
  switch (t.id) {
    case "m-new": closeModal(); controlsKey = ""; newMatch(); return;
    case "m-resume": closeModal(); controlsKey = ""; advance(); return;
    case "m-close": closeModal(); return;
    case "new-game": if (G) openModal(confirmNewHtml()); return;
    case "next": if (G.over) openModal(overHtml()); else startHand(); return;
    case "b-fold": userAct("fold"); return;
    case "b-call": userAct(legal(h, YOU).toCall === 0 ? "check" : "call"); return;
    case "b-raise": userAct("raise", raiseAmount()); return;
    case "skip": thinking?.ctl.abort(); return;
    case "retry": link = "live"; renderTop(); return;
  }
  if (t.classList.contains("preset")) {
    setAmount(Number(t.dataset.to));
  } else if (t.dataset.depth) {
    depth = t.dataset.depth;
    if (G) { G.depth = depth; save(); }
    renderTop();
  }
});

function setAmount(v) {
  const L = legal(G.hand, YOU);
  v = clamp(Number.isFinite(v) ? v : L.minTo, L.minTo, L.maxTo);
  if ($("slider")) $("slider").value = v;
  if ($("amt")) $("amt").value = v;
  syncRaiseLabel(L);
}

document.addEventListener("input", (e) => {
  if (e.target.id === "slider") setAmount(Number(e.target.value));
  else if (e.target.id === "amt") {
    if ($("slider")) $("slider").value = e.target.value;
    syncRaiseLabel(legal(G.hand, YOU));
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "amt") setAmount(Number(e.target.value));
});

document.addEventListener("keydown", (e) => {
  if (!G || !$("modal").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target.matches?.("input[type=number]");
  const h = G.hand, k = e.key.toLowerCase();
  if (e.key === "Enter") {
    if (typing) { e.preventDefault(); setAmount(raiseAmount()); userAct("raise", raiseAmount()); }
    else if (h.phase === "done" && !e.target.closest?.("button, summary")) { e.preventDefault(); $("next")?.click(); }
    return;
  }
  if (typing || h.phase !== "bet" || h.toAct !== YOU) return;
  if (k === "f") $("b-fold")?.click();
  else if (k === "c") $("b-call")?.click();
  else if (k === "r") $("b-raise")?.click();
});

// ===== 시작 =====
function boot() {
  const saved = load();
  if (saved && !saved.over) {
    G = saved;
    depth = saved.depth === "default" ? "default" : "quick";
    // 저장할 때 진행 중이던 Claude 차례·카드 펼치기는 이어하기를 누르면 다시 시작된다
    render();
    openModal(introHtml(saved));
  } else {
    G = null;
    openModal(introHtml(null));
  }
  renderTop();
}

boot();
