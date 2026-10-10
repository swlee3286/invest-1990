// 규칙 엔진 테스트: node poker/test/table.test.js
const T = require("../table.js");
const E = require("../engine.js");

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log("FAIL:", msg); } };
const C = (str) => str.split(" ").filter(Boolean).map((t) => E.RANKS.indexOf(t[0]) * 4 + E.SUITS.indexOf(t[1]));
const LEVELS = [[10, 20], [15, 30], [20, 40], [30, 60], [50, 100], [100, 200], [200, 400], [400, 800]];

function match(n, stacks, button) {
  const m = T.createMatch({ players: Array.from({ length: n }, (_, i) => ({ name: "P" + i, kind: i ? "bot" : "human" })), startStack: 1000, levels: LEVELS, handsPerLevel: 1000 });
  if (stacks) stacks.forEach((s, i) => { m.players[i].stack = s; });
  if (button != null) { const live = T.liveSeats(m); m.button = live[(live.indexOf(button) - 1 + live.length) % live.length]; }
  return m;
}

// holes: 좌석별 "As Kd" 문자열, board: 5장. 딜 순서대로 pop 되도록 덱을 만든다
function deckFor(m, holes, board, button) {
  const live = T.liveSeats(m);
  const order = [];
  for (let s = T.nextIn(live, button), k = 0; k < live.length; k++, s = T.nextIn(live, s)) order.push(s);
  const seq = [];
  const hc = {};
  for (const s of live) hc[s] = C(holes[s]);
  for (let r = 0; r < 2; r++) for (const s of order) seq.push(hc[s][r]);
  const b = C(board);
  const used = new Set([...seq, ...b]);
  const spare = [...Array(52).keys()].filter((c) => !used.has(c));
  const burn = () => spare.pop();
  seq.push(burn(), b[0], b[1], b[2], burn(), b[3], burn(), b[4]);
  return [...spare, ...seq.reverse()];
}

const total = (m) => m.players.reduce((t, p) => t + p.stack, 0) + (m.hand && m.hand.phase !== "done" ? T.potTotal(m.hand) : 0);
function finish(m) { while (m.hand.phase === "runout") T.runoutStep(m); }

// ---- 1. 3인 올인 사이드 팟 ----
{
  const m = match(3, [100, 300, 500], 0); // 버튼 0, SB 1, BB 2, 먼저 0
  T.startHand(m, deckFor(m, ["As Ad", "Ks Kd", "2c 7h"], "Qh 9c 5d 3s Jh", 0));
  const h = m.hand;
  ok(h.button === 0 && h.sbSeat === 1 && h.bbSeat === 2 && h.toAct === 0, "3인 버튼/블라인드/첫 행동 " + JSON.stringify([h.button, h.sbSeat, h.bbSeat, h.toAct]));
  T.act(m, 0, "raise", 100); // 0 올인 100
  ok(m.players[0].stack === 0, "0 올인");
  T.act(m, 1, "raise", 300); // 1 올인 300
  T.act(m, 2, "call");       // 2 콜 300
  ok(h.phase === "runout", "러너웃 단계");
  finish(m);
  ok(h.phase === "done", "끝");
  const pots = h.result.pots.map((p) => [p.amount, p.eligible.join(""), p.winners.join("")].join("/"));
  ok(JSON.stringify(pots) === JSON.stringify(["300/012/0", "400/12/1"]), "사이드 팟 " + JSON.stringify(pots));
  ok(m.players[0].stack === 300 && m.players[1].stack === 400 && m.players[2].stack === 200, "정산 " + m.players.map((p) => p.stack));
  ok(m.players[2].out === false && m.players[0].out === false, "탈락 없음");
}

// ---- 2. 모자란 올인 레이즈는 이미 행동한 사람에게 레이즈를 다시 열지 않는다 ----
{
  const m = match(3, [1000, 1000, 130], 0);
  T.startHand(m, deckFor(m, ["As Ad", "Ks Kd", "Qs Qd"], "2h 3c 8d 9s Jh", 0));
  T.act(m, 0, "raise", 100);
  T.act(m, 1, "call");
  ok(m.hand.toAct === 2, "BB 차례");
  T.act(m, 2, "raise", 999); // 올인 130 (모자란 레이즈)
  ok(m.hand.actions.at(-1).to === 130 && m.hand.actions.at(-1).full === false, "모자란 레이즈 기록");
  ok(m.hand.toAct === 0 && T.legal(m, 0).canRaise === false && T.legal(m, 0).toCall === 30, "0은 콜/폴드만");
  T.act(m, 0, "call");
  ok(T.legal(m, 1).canRaise === false, "1도 레이즈 불가");
  T.act(m, 1, "call");
  ok(m.hand.street === 1 && m.hand.toAct === 1, "플롭, SB부터 " + m.hand.toAct);
  ok(total(m) === 2130, "칩 보존");
}

// ---- 3. 모자란 올인이 쌓여 완전한 레이즈 크기가 되면 다시 열린다 ----
{
  const m = match(4, [150, 210, 1000, 1000], 0); // 버튼 0, SB 1, BB 2, UTG 3
  T.startHand(m, deckFor(m, ["As Ad", "Ks Kd", "Qs Qd", "Js Jd"], "2h 3c 8d 9s 4h", 0));
  ok(m.hand.toAct === 3, "UTG 먼저");
  T.act(m, 3, "raise", 100);           // +80
  T.act(m, 0, "raise", 150);           // 올인 +50 (모자람)
  T.act(m, 1, "raise", 210);           // 올인 +60 (모자람)
  ok(m.hand.toAct === 2 && T.legal(m, 2).canRaise, "BB는 아직 행동 전이라 레이즈 가능");
  T.act(m, 2, "call");
  ok(m.hand.toAct === 3 && T.legal(m, 3).canRaise, "UTG: 100→210 (110 ≥ 80) 이라 레이즈 가능");
  T.act(m, 3, "call");
  ok(m.hand.street === 1, "플롭으로");
  ok(total(m) === 2360, "칩 보존");
}

// ---- 4. 헤즈업 순서, 짧은 BB의 받지 않은 칩 반환 ----
{
  const m = match(2, [1000, 1000], 0);
  T.startHand(m, deckFor(m, ["As Ad", "Ks Kd"], "2h 3c 8d 9s 4h", 0));
  ok(m.hand.sbSeat === 0 && m.hand.bbSeat === 1 && m.hand.toAct === 0, "헤즈업: 버튼이 SB, 먼저 행동");
  T.act(m, 0, "call");
  ok(m.hand.toAct === 1 && T.legal(m, 1).canRaise, "BB 옵션");
  T.act(m, 1, "check");
  ok(m.hand.street === 1 && m.hand.toAct === 1, "플롭은 BB 먼저");
  T.act(m, 1, "check"); T.act(m, 0, "raise", 40); T.act(m, 1, "fold");
  ok(m.players[0].stack === 1020 && m.players[1].stack === 980, "폴드 승리 정산 " + m.players.map((p) => p.stack));

  const m2 = match(2, [1000, 5], 0);
  T.startHand(m2, deckFor(m2, ["As Ad", "Ks Kd"], "2h 3c 8d 9s 4h", 0));
  ok(m2.hand.phase === "runout" || m2.hand.phase === "done", "BB 올인으로 바로 러너웃");
  finish(m2);
  ok(m2.players[0].stack === 1005 && m2.players[1].stack === 0 && m2.players[1].out && m2.over, "짧은 BB 반환·탈락 " + m2.players.map((p) => p.stack));
  ok(m2.players[0].place === 1 && m2.players[1].place === 2, "순위");
}

// ---- 5. 무승부 나누기, 나머지 칩 ----
{
  const m = match(3, [1000, 1000, 1000], 0);
  T.startHand(m, deckFor(m, ["2c 3d", "2d 3c", "4h 5h"], "As Ks Qs Js Ts", 0)); // 보드 로열 → 셋 다 무승부
  T.act(m, 0, "raise", 55); T.act(m, 1, "call"); T.act(m, 2, "fold");
  // 팟 = 55 + 55 + 20 = 130 → 65씩
  while (m.hand.phase === "bet") T.act(m, m.hand.toAct, "check");
  ok(m.players[0].stack === 1010 && m.players[1].stack === 1010, "무승부 정산 " + m.players.map((p) => p.stack));
}

// ---- 6. 탈락자 건너뛰기: 버튼·블라인드 ----
{
  const m = match(4, [1000, 1000, 1000, 1000], 0);
  m.players[1].out = true; m.players[1].stack = 0;
  T.startHand(m, deckFor(m, ["As Ad", null, "Ks Kd", "Qs Qd"].map((x) => x || "2c 2d"), "2h 3c 8d 9s 4h", 0));
  ok(m.hand.button === 0 && m.hand.sbSeat === 2 && m.hand.bbSeat === 3 && m.hand.toAct === 0, "탈락자 건너뜀 " + [m.hand.button, m.hand.sbSeat, m.hand.bbSeat, m.hand.toAct]);
  ok(T.positionsOf(m.hand)[0] === "BTN" && T.positionsOf(m.hand)[3] === "BB" && T.positionsOf(m.hand)[1] === undefined, "포지션 이름");
}

// ---- 8. BB가 모자라게 올인하면: 들어오는 사람은 BB 전액, 최소 레이즈는 2BB ----
{
  const m = match(3, [1000, 1000, 5], 0); // 버튼 0, SB 1, BB 2 (5칩 올인)
  T.startHand(m, deckFor(m, ["As Ad", "Ks Kd", "2c 7h"], "Qh 9c 5d 3s Jh", 0));
  let L = T.legal(m, 0);
  ok(L.toCall === 20 && L.minTo === 40 && L.maxBet === 20, "짧은 BB(5): 콜 20, 최소 레이즈 40 " + JSON.stringify(L));
  T.act(m, 0, "call");
  L = T.legal(m, 1);
  ok(m.hand.toAct === 1 && L.toCall === 10 && L.minTo === 40, "SB는 10을 더 내야 함 " + JSON.stringify(L));
  T.act(m, 1, "call");
  ok(m.hand.street === 1 && T.potTotal(m.hand) === 45 && total(m) === 2005, "플롭으로, 팟 45 " + T.potTotal(m.hand));

  const m2 = match(3, [1000, 1000, 15], 0); // BB 15 (SB보다 많고 BB보다 적음)
  T.startHand(m2, deckFor(m2, ["As Ad", "Ks Kd", "2c 7h"], "Qh 9c 5d 3s Jh", 0));
  L = T.legal(m2, 0);
  ok(L.toCall === 20 && L.minTo === 40, "짧은 BB(15): 콜 20, 최소 레이즈 40 " + JSON.stringify(L));
  T.act(m2, 0, "raise", 40);
  ok(T.legal(m2, 1).toCall === 30 && T.legal(m2, 1).minTo === 60, "2BB 레이즈 뒤 SB " + JSON.stringify(T.legal(m2, 1)));

  // 버튼이 폴드하면 SB는 맞출 사람이 없으니 행동 없이 넘어간다 (넘친 5는 돌려받음)
  const m3 = match(3, [1000, 1000, 5], 0);
  T.startHand(m3, deckFor(m3, ["As Ad", "Ks Kd", "2c 7h"], "Qh 9c 5d 3s Jh", 0));
  T.act(m3, 0, "fold");
  ok(m3.hand.phase === "runout", "SB 행동 없이 러너웃 " + m3.hand.phase + " " + m3.hand.toAct);
  finish(m3);
  ok(m3.players[1].stack === 1005 && m3.players[2].stack === 0 && total(m3) === 2005, "SB 승리 정산 " + m3.players.map((p) => p.stack));

  // 헤즈업: 짧은 BB(15)에는 15까지만 맞추면 된다 (더 내도 돌려받으니)
  const m4 = match(2, [1000, 15], 0);
  T.startHand(m4, deckFor(m4, ["As Ad", "Ks Kd"], "2h 3c 8d 9s 4h", 0));
  L = T.legal(m4, 0);
  ok(m4.hand.toAct === 0 && L.toCall === 5 && !L.canRaise, "헤즈업 짧은 BB: 콜 5만 " + JSON.stringify(L));
}

// ---- 9. 탈락이 생겨도 BB는 한 자리씩 돈다 (건너뛰거나 두 번 연속 내는 사람 없음) ----
{
  // 3인 → 헤즈업: 직전 BB(2)가 다시 BB를 내면 안 된다
  const m = match(3, [300, 1000, 1000], 0);
  T.startHand(m, deckFor(m, ["2c 7h", "Ks Kd", "As Ad"], "Qh 9c 5d 3s Jh", 0));
  ok(m.hand.bbSeat === 2, "1핸드 BB 2");
  T.act(m, 0, "raise", 300); T.act(m, 1, "fold"); T.act(m, 2, "call"); finish(m);
  ok(m.players[0].out, "0 탈락");
  T.startHand(m);
  ok(m.hand.bbSeat === 1 && m.hand.button === 2 && m.hand.sbSeat === 2, "헤즈업 전환: BB 1, 버튼·SB 2 " + [m.hand.button, m.hand.sbSeat, m.hand.bbSeat]);

  // 4인: 직전 BB(2)가 탈락하면 다음 BB는 그다음 사람(3). 3이 BB를 건너뛰면 안 된다
  const m2 = match(4, [1000, 1000, 300, 1000], 0); // 버튼 0, SB 1, BB 2, UTG 3
  T.startHand(m2, deckFor(m2, ["2s 2d", "3s 3d", "7c 2h", "As Ad"], "Qh 9c 5d 3h Jh", 0));
  T.act(m2, 3, "raise", 1000); T.act(m2, 0, "fold"); T.act(m2, 1, "fold"); T.act(m2, 2, "call"); finish(m2);
  ok(m2.players[2].out, "2 탈락");
  T.startHand(m2);
  const h2 = m2.hand;
  ok(h2.bbSeat === 3 && h2.sbSeat === 1 && h2.button === 0, "BB는 3으로 " + [h2.button, h2.sbSeat, h2.bbSeat]);
  ok(T.positionsOf(h2)[0] === "BTN" && T.positionsOf(h2)[1] === "SB" && T.positionsOf(h2)[3] === "BB", "포지션 이름 " + T.positionsOf(h2));
}

// ---- 7. 무작위 대량 시뮬레이션: 칩 보존·규칙 불변식 ----
function randomPolicy(m, s) {
  const L = T.legal(m, s), r = Math.random();
  if (L.toCall > 0 && r < 0.18) return ["fold"];
  if (L.canRaise && r < 0.42) {
    const allin = Math.random() < 0.25;
    return ["raise", allin ? L.maxTo : L.minTo + Math.floor(Math.random() * (L.maxTo - L.minTo + 1))];
  }
  return [L.toCall > 0 ? "call" : "check"];
}
let hands = 0, matches = 0, showdowns = 0, sidepots = 0;
for (let n = 2; n <= 6; n++) {
  for (let g = 0; g < 60; g++) {
    const m = T.createMatch({ players: Array.from({ length: n }, (_, i) => ({ name: "P" + i, kind: "bot" })), startStack: 1000, levels: LEVELS, handsPerLevel: 6 });
    const T0 = n * 1000;
    let guard = 0, prevBB = -1;
    while (!m.over && guard++ < 3000) {
      T.startHand(m);
      hands++;
      const h = m.hand;
      if (prevBB >= 0 && h.bbSeat !== T.nextIn(h.seats, prevBB)) ok(false, `BB가 한 자리씩 돌지 않음 ${prevBB} → ${h.bbSeat} (${h.seats})`);
      if (h.seats.length > 2 && !(T.nextIn(h.seats, h.button) === h.sbSeat && T.nextIn(h.seats, h.sbSeat) === h.bbSeat)) ok(false, "버튼·SB·BB 순서");
      prevBB = h.bbSeat;
      let steps = 0;
      while (h.phase !== "done") {
        if (++steps > 500) { ok(false, "핸드가 끝나지 않음"); break; }
        if (h.phase === "runout") { T.runoutStep(m); continue; }
        const s = h.toAct;
        if (!(s >= 0 && !h.folded[s] && m.players[s].stack > 0)) { ok(false, "잘못된 차례 " + s); break; }
        const L = T.legal(m, s);
        if (!(L.toCall >= 0 && L.minTo <= L.maxTo && (!L.canRaise || L.minTo > L.maxBet))) ok(false, "legal 불변식 " + JSON.stringify(L));
        const [type, to] = randomPolicy(m, s);
        const street = h.street;
        T.act(m, s, type, to);
        if (total(m) !== T0) { ok(false, `칩 보존 실패 n=${n} ${total(m)}`); break; }
        if (m.players.some((p) => p.stack < 0)) ok(false, "음수 스택");
        if (h.phase === "bet" && h.street !== street) {
          // 새 스트리트: 베팅 0, 차례는 버튼 왼쪽 첫 행동 가능자
          ok(h.seats.every((x) => h.bets[x] === 0), "새 스트리트 베팅 초기화");
        }
      }
      if (h.result?.showdown) { showdowns++; if (h.result.pots.length > 1) sidepots++; }
      const won = h.result.won.reduce((a, b) => a + b, 0);
      ok(won === T.potTotal(h), "팟 전부 지급 " + won + " " + T.potTotal(h));
    }
    ok(m.over, "매치가 끝나야 함");
    const places = m.players.map((p) => p.place).sort();
    ok(JSON.stringify(places) === JSON.stringify(Array.from({ length: n }, (_, i) => i + 1)), "순위 1..n " + places);
    matches++;
  }
}
console.log(`random: ${matches} matches, ${hands} hands, ${showdowns} showdowns, ${sidepots} with side pots`);
console.log(fails ? `${fails} FAILED` : "ALL OK");
process.exit(fails ? 1 : 0);
