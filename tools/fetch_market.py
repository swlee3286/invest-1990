"""금리·물가·환율·금·주택가격·비트코인 월별 데이터를 받아 market.js로 저장한다.

실행:  python tools/fetch_market.py
출처:  DBnomics(IMF IFS·IMF PCPS·BIS 원자료 중계), blockchain.info(비트코인)
결과:  market.js  — {지표: {"YYYYMM": 값}}, 1990.01 ~ 2026.10
       빠진 달은 직전 값으로 채우고, 발표 전 최근 구간은 마지막 값을 유지한다(추정 구간은 estFrom에 기록).
"""
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

START, END = (1990, 1), (2026, 10)

DBNOMICS = {
    "deposit": "IMF/IFS/M.KR.FIDR_PA",           # 예금 금리 (연 %)
    "bond": "IMF/IFS/M.KR.FIGB_PA",              # 국채 수익률 (연 %)
    "cpi": "IMF/IFS/M.KR.PCPI_IX",               # 소비자물가지수
    "usdkrw": "IMF/IFS/M.KR.ENDA_XDC_USD_RATE",  # 원/달러 (월말)
    "goldUsd": "IMF/PCPS/M.W00.PGOLD.USD",       # 금 (달러/트로이온스)
    "house": "BIS/WS_SPP/Q.KR.N.628",            # 주택가격지수 (분기 → 월 보간)
}


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(req, timeout=90).read().decode("utf-8"))


def months():
    y, m = START
    while (y, m) <= END:
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def parse_period(p):
    """'1990-01' / '1990-Q1' → (y, m)  (분기는 분기 마지막 달)"""
    if "-Q" in p:
        y, q = p.split("-Q")
        return int(y), int(q) * 3
    y, m = p.split("-")[:2]
    return int(y), int(m)


def fetch_dbnomics(sid):
    doc = get_json(f"https://api.db.nomics.world/v22/series/{sid}?observations=1")["series"]["docs"][0]
    out = {}
    for p, v in zip(doc["period"], doc["value"]):
        if isinstance(v, (int, float)):
            out[parse_period(p)] = float(v)
    return out


def fetch_bitcoin():
    d = get_json("https://api.blockchain.info/charts/market-price?timespan=all&format=json&sampled=false")
    out = {}
    for pt in d["values"]:
        if pt["y"] > 0:
            t = datetime.fromtimestamp(pt["x"], tz=timezone.utc)
            out[(t.year, t.month)] = pt["y"]  # 같은 달이면 마지막 값(월말)이 남음
    return out


def fetch_yahoo(symbol):
    d = get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=max&interval=1mo")
    r = d["chart"]["result"][0]
    out = {}
    for ts, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]):
        if c:
            t = datetime.fromtimestamp(ts, tz=timezone.utc)
            out[(t.year, t.month)] = c
    return out


# IMF 자료가 끝난 뒤 최근 구간을 채울 보조 출처
YAHOO_TAIL = {"goldUsd": "GC=F", "usdkrw": "KRW=X"}

# IMF 예금 금리는 1996.07부터 있음 → 그 전은 근사치(규제금리 시대 1년 정기예금 약 10%)
DEPOSIT_BEFORE_1996_07 = 10.0


def to_monthly(raw, interpolate=False):
    """월 단위로 맞추기. interpolate=True면 관측점 사이를 선형 보간(분기 자료용)."""
    keys = sorted(raw)
    res, est_from = {}, None
    if interpolate:
        idx = lambda ym: ym[0] * 12 + ym[1]
        for a, b in zip(keys, keys[1:]):
            for i in range(idx(a), idx(b) + 1):
                ym = ((i - 1) // 12, (i - 1) % 12 + 1)
                t = (i - idx(a)) / (idx(b) - idx(a))
                raw.setdefault(ym, raw[a] + (raw[b] - raw[a]) * t)
        keys = sorted(raw)
    last = None
    first_known = keys[0] if keys else None
    for ym in months():
        if ym in raw:
            last = raw[ym]
        elif last is None:
            continue  # 데이터 시작 전
        elif ym > keys[-1] and est_from is None:
            est_from = ym
        res[f"{ym[0]}{ym[1]:02d}"] = round(last, 4)
    return res, first_known, est_from


def main():
    data, meta = {}, {}
    for name, sid in DBNOMICS.items():
        raw = fetch_dbnomics(sid)
        if name in YAHOO_TAIL:
            last = max(raw)
            raw.update({ym: v for ym, v in fetch_yahoo(YAHOO_TAIL[name]).items() if ym > last})
        if name == "deposit":
            for ym in months():
                if ym < (1996, 7):
                    raw.setdefault(ym, DEPOSIT_BEFORE_1996_07)
        series, first, est = to_monthly(raw, interpolate=name == "house")
        data[name] = series
        meta[name] = {"source": sid, "from": f"{first[0]}-{first[1]:02d}" if first else None,
                      "estFrom": f"{est[0]}-{est[1]:02d}" if est else None}
        print(f"{name:8s} {sid:34s} 시작 {meta[name]['from']}  추정 시작 {meta[name]['estFrom']}")
        time.sleep(0.5)

    btc, first, est = to_monthly(fetch_bitcoin())
    data["btcUsd"] = btc
    meta["btcUsd"] = {"source": "blockchain.info market-price", "from": f"{first[0]}-{first[1]:02d}",
                      "estFrom": f"{est[0]}-{est[1]:02d}" if est else None}
    print(f"btcUsd   blockchain.info                    시작 {meta['btcUsd']['from']}  추정 시작 {meta['btcUsd']['estFrom']}")

    path = Path(__file__).resolve().parent.parent / "market.js"
    path.write_text(
        "// 자동 생성 파일: tools/fetch_market.py\n"
        "const MARKET_META = " + json.dumps(meta, ensure_ascii=False) + ";\n"
        "const MARKET_DATA = " + json.dumps(data) + ";\n",
        encoding="utf-8",
    )
    print(f"저장: {path}")


if __name__ == "__main__":
    main()
