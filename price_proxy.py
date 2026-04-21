import json
import re
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import requests
import yfinance as yf
from difflib import SequenceMatcher


def candidate_tickers(ticker: str):
    t = ticker.strip().upper()
    cands = [t]
    if t == "OLA.NS":
        cands.extend(["OLAELEC.NS", "OLAELEC.BO"])
    if t.endswith(".NS"):
        cands.append(t.replace(".NS", ".BO"))
    return list(dict.fromkeys(cands))


def build_price_rows(ticker: str, from_date: str, to_date: str):
    end_exclusive = (datetime.strptime(to_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    data = yf.download(ticker, start=from_date, end=end_exclusive, interval="1d", progress=False, auto_adjust=False)
    if data.empty:
        # Fallback path: sometimes Ticker.history works when download fails.
        data = yf.Ticker(ticker).history(start=from_date, end=end_exclusive, interval="1d", auto_adjust=False)
    if data.empty:
        return []

    out = []
    for idx, row in data.iterrows():
        open_v = float(row["Open"])
        close_v = float(row["Close"])
        if open_v == 0:
            continue
        out.append(
            {
                "date": idx.strftime("%Y-%m-%d"),
                "open": round(open_v, 2),
                "close": round(close_v, 2),
                "changePct": round(((close_v - open_v) / open_v) * 100, 2),
            }
        )
    return out


def resolve_best_ticker(query: str):
    q = (query or "").strip()
    if not q:
        return None
    q_norm = re.sub(r"[^a-z0-9]+", " ", q.lower()).strip()
    # Primary: NSE/BSE API search (no auth).
    try:
        nse_url = "https://nse-api-ruby.vercel.app/search"
        nse_resp = requests.get(nse_url, params={"q": q}, timeout=20)
        nse_resp.raise_for_status()
        nse_data = nse_resp.json()
        results = nse_data.get("results") or []
        if results:
            best_result = None
            best_score = -1.0
            for r in results:
                name = (r.get("company_name") or r.get("symbol") or "").lower()
                name_norm = re.sub(r"[^a-z0-9]+", " ", name).strip()
                score = SequenceMatcher(None, q_norm, name_norm).ratio()
                if score > best_score:
                    best_score = score
                    best_result = r
            r0 = best_result or results[0]
            symbol = (r0.get("symbol") or "").strip().upper()
            if symbol:
                return {
                    "symbol": f"{symbol}.NS",
                    "shortname": r0.get("company_name") or symbol,
                    "exchDisp": "NSE",
                    "score": round(best_score * 100, 2) if best_score >= 0 else 100,
                    "source": "nse_api_ruby",
                }
    except Exception:
        pass

    # Fallback: Yahoo finance search.
    url = "https://query2.finance.yahoo.com/v1/finance/search"
    params = {"q": q, "quotesCount": 15, "newsCount": 0}
    r = requests.get(
        url,
        params=params,
        timeout=20,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
        },
    )
    r.raise_for_status()
    data = r.json()
    quotes = data.get("quotes") or []
    if not quotes:
        return None

    ranked = []
    for x in quotes:
        sym = x.get("symbol")
        if not sym:
            continue
        exch = (x.get("exchDisp") or "").upper()
        name = (x.get("shortname") or x.get("longname") or "").lower()
        name_norm = re.sub(r"[^a-z0-9]+", " ", name).strip()
        fuzzy = SequenceMatcher(None, q_norm, name_norm).ratio()
        score = 0
        if sym.endswith(".NS"):
            score += 6
        if sym.endswith(".BO"):
            score += 5
        if "NSE" in exch:
            score += 4
        if "BSE" in exch:
            score += 3
        if q.lower() in name:
            score += 2
        score += fuzzy * 3
        ranked.append(
            {
                "symbol": sym,
                "shortname": x.get("shortname") or x.get("longname") or "",
                "exchDisp": x.get("exchDisp") or "",
                "score": score,
            }
        )

    ranked.sort(key=lambda item: item["score"], reverse=True)
    if not ranked:
        return None
    best = ranked[0]
    best["source"] = "yahoo_search"
    return best


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/resolve_ticker":
            qs = parse_qs(parsed.query)
            query = (qs.get("query", [""])[0] or "").strip()
            if not query:
                self._send(400, {"error": "Required query param: query"})
                return
            try:
                best = resolve_best_ticker(query)
                self._send(200, {"query": query, "best": best})
            except Exception as e:
                self._send(500, {"error": str(e)})
            return

        if parsed.path != "/price":
            self._send(404, {"error": "Not found"})
            return

        qs = parse_qs(parsed.query)
        ticker = (qs.get("ticker", [""])[0] or "").strip()
        from_date = (qs.get("fromDate", [""])[0] or "").strip()
        to_date = (qs.get("toDate", [""])[0] or "").strip()

        if not ticker or not from_date or not to_date:
            self._send(400, {"error": "Required query params: ticker, fromDate, toDate"})
            return

        try:
            chosen = ticker
            prices = []
            latest_price = None
            for cand in candidate_tickers(ticker):
                rows = build_price_rows(cand, from_date, to_date)
                t = yf.Ticker(cand)
                # Optional latest quote fallback for better debugging/validation.
                try:
                    hist = t.history(period="5d", interval="1d", auto_adjust=False)
                    if not hist.empty:
                        latest_price = round(float(hist["Close"].iloc[-1]), 2)
                except Exception:
                    pass
                if rows:
                    chosen = cand
                    prices = rows
                    break
            self._send(
                200,
                {
                    "ticker": chosen,
                    "requestedTicker": ticker,
                    "totalDays": len(prices),
                    "prices": prices,
                    "latestPrice": latest_price,
                    "source": "local_yfinance",
                },
            )
        except Exception as e:
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 8788), Handler)
    print("Price proxy listening on http://127.0.0.1:8788")
    server.serve_forever()
