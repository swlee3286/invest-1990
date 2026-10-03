"""네이버 금융에서 월별 주가(수정주가)를 받아 stocks.js로 저장한다.

실행:  python tools/fetch_stocks.py
결과:  stocks.js  (KOSPI 지수 + 종목별 월말 종가, 1990.01 ~ 2026.10)
"""
import ast
import json
import time
import urllib.request
from pathlib import Path

START, END = "19900101", "20261031"

# (코드, 이름, 업종)
STOCKS = [
    ("005930", "삼성전자", "전자"),
    ("006400", "삼성SDI", "전자"),
    ("000660", "SK하이닉스(현대전자)", "반도체"),
    ("005380", "현대차", "자동차"),
    ("000270", "기아", "자동차"),
    ("010140", "삼성중공업", "조선·중공업"),
    ("000720", "현대건설", "건설"),
    ("000210", "대림산업(DL)", "건설"),
    ("006800", "대우증권(미래에셋증권)", "은행·증권"),
    ("016360", "삼성증권", "은행·증권"),
    ("010950", "S-Oil", "화학·정유"),
    ("009830", "한화솔루션(한양화학)", "화학·정유"),
    ("004170", "신세계", "유통"),
    ("017670", "SK텔레콤(한국이동통신)", "통신"),
    ("030200", "KT", "통신"),
    ("035720", "다음(카카오)", "인터넷·게임"),
    ("036570", "엔씨소프트", "인터넷·게임"),
    ("000100", "유한양행", "바이오·제약"),
    ("006280", "녹십자", "바이오·제약"),
    ("041510", "SM엔터테인먼트", "엔터테인먼트"),
]


def fetch(symbol):
    url = (
        "https://api.finance.naver.com/siseJson.naver"
        f"?symbol={symbol}&requestType=1&startTime={START}&endTime={END}&timeframe=month"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=20).read().decode("euc-kr", "replace")
    rows = ast.literal_eval(raw.strip())[1:]
    return [(str(r[0])[:6], float(r[4])) for r in rows if r[4]]  # (YYYYMM, 종가)


def clean(series):
    """수정주가 반영이 덜 된 구간(앞뒤 달 사이 8배 이상 차이)을 뒤쪽 기준으로 맞춘다."""
    vals = [v for _, v in series]
    for i in range(len(vals) - 1, 0, -1):
        ratio = vals[i - 1] / vals[i]
        if ratio > 8 or ratio < 1 / 8:
            factor = vals[i] / vals[i - 1]
            for j in range(i):
                vals[j] *= factor
    return [(ym, round(v, 2)) for (ym, _), v in zip(series, vals)]


def main():
    out = {"start": "1990-01", "kospi": None, "stocks": []}
    kospi = fetch("KOSPI")
    out["kospi"] = {ym: v for ym, v in kospi}
    print(f"KOSPI: {kospi[0][0]} ~ {kospi[-1][0]} ({len(kospi)}개월)")
    for code, name, sector in STOCKS:
        s = clean(fetch(code))
        # 네이버 데이터의 1990년 1~2월은 수정주가 미반영인 종목이 있어 3월 가격과 지수 변동으로 대체
        prices = dict(s)
        if "199003" in prices:
            for ym in ("199001", "199002"):
                if ym in prices:
                    prices[ym] = round(prices["199003"] * out["kospi"][ym] / out["kospi"]["199003"], 2)
            s = [(ym, prices[ym]) for ym, _ in s]
        time.sleep(0.3)
        if not s:
            print(f"  ! {name}: 데이터 없음")
            continue
        out["stocks"].append({
            "code": code, "name": name, "sector": sector,
            "prices": {ym: v for ym, v in s},
        })
        print(f"  {name}: {s[0][0]} ~ {s[-1][0]} ({len(s)}개월)")

    path = Path(__file__).resolve().parent.parent / "stocks.js"
    path.write_text(
        "// 자동 생성 파일: tools/fetch_stocks.py (출처: 네이버 금융 월말 수정종가)\n"
        "const STOCK_DATA = " + json.dumps(out, ensure_ascii=False) + ";\n",
        encoding="utf-8",
    )
    print(f"저장: {path}")


if __name__ == "__main__":
    main()
