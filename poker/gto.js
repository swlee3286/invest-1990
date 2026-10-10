// ===== AI (임시 자리표시 버전) =====
// GTO 기반 AI로 교체될 예정. API만 맞춰 둔다:
//   PokerAI.decide(m, seat, opts?) → { action, to, mix: [{action, to, freq}], info }
//   PokerAI.describeMix(decision) → Claude 프롬프트용 짧은 영어 설명
// 자기 카드(m.hand.hole[seat])와 공개 정보만 쓴다. 다른 사람 카드·덱은 읽지 않는다.
(function (root) {
const isNode = typeof module !== "undefined" && typeof require === "function";
const PK = isNode ? require("./engine.js") : root;
const PT = isNode ? require("./table.js") : root.PokerTable;

function decide(m, seat, opts = {}) {
  const rng = opts.rng || Math.random;
  const h = m.hand, L = PT.legal(m, seat);
  const opponents = PT.aliveSeats(h).length - 1;
  // 무작위 손패 상대 승률을 상대 수만큼 거듭제곱해 대충 다자간 승률로 쓴다
  const eq = Math.pow(PK.equity(h.hole[seat], h.board, 600), Math.max(1, opponents * 0.85));
  const pot = PT.potTotal(h);
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
  return { action: pick.action, to: pick.to, mix, info: { equity: eq, potOdds: odds } };
}

function describeMix(d) {
  const parts = d.mix.map((x) => `${x.action}${x.to ? ` to ${x.to}` : ""} ${Math.round(x.freq * 100)}%`);
  return `Engine suggestion: ${parts.join(", ")}. Estimated equity ${Math.round(d.info.equity * 100)}%, pot odds ${Math.round(d.info.potOdds * 100)}%.`;
}

const api = { decide, describeMix };
if (isNode) module.exports = api;
else root.PokerAI = api;
})(globalThis);
