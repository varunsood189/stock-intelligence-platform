import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List

import requests
import yfinance as yf
from openai import OpenAI


# -----------------------------
# Custom tool functions (>= 3)
# -----------------------------
def tool_get_news_rss(company_name: str, from_date: str, to_date: str, limit: int = 10) -> Dict[str, Any]:
    """Fetch news headlines from Google News RSS for a company in date window."""
    url = (
        "https://news.google.com/rss/search"
        f"?q={company_name}%20when:30d&hl=en-IN&gl=IN&ceid=IN:en"
    )
    response = requests.get(url, timeout=20)
    response.raise_for_status()
    text = response.text

    # Minimal XML parsing to keep this assignment simple.
    items = text.split("<item>")[1:]
    parsed = []
    dt_from = datetime.strptime(from_date, "%Y-%m-%d")
    dt_to = datetime.strptime(to_date, "%Y-%m-%d")

    for raw in items:
        try:
            title = raw.split("<title>")[1].split("</title>")[0]
            pub_date = raw.split("<pubDate>")[1].split("</pubDate>")[0]
            link = raw.split("<link>")[1].split("</link>")[0]
            # Example: Tue, 16 Apr 2026 08:10:00 GMT
            dt = datetime.strptime(pub_date, "%a, %d %b %Y %H:%M:%S %Z")
            if dt_from <= dt <= dt_to + timedelta(days=1):
                parsed.append(
                    {
                        "title": title,
                        "date": dt.strftime("%Y-%m-%d"),
                        "link": link,
                    }
                )
        except Exception:
            continue

    return {"company": company_name, "news": parsed[:limit], "total_found": len(parsed)}


def tool_get_stock_prices(ticker: str, from_date: str, to_date: str) -> Dict[str, Any]:
    """Fetch daily stock OHLC using yfinance."""
    data = yf.download(ticker, start=from_date, end=to_date, interval="1d", progress=False)
    if data.empty:
        return {"ticker": ticker, "prices": [], "total_days": 0}

    rows = []
    for idx, row in data.iterrows():
        rows.append(
            {
                "date": idx.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 2),
                "close": round(float(row["Close"]), 2),
                "change_pct": round(((float(row["Close"]) - float(row["Open"])) / float(row["Open"])) * 100, 2),
            }
        )
    return {"ticker": ticker, "prices": rows, "total_days": len(rows)}


def tool_link_news_with_price(news_items: List[Dict[str, Any]], prices: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Join news date to same-day stock move."""
    price_by_date = {p["date"]: p for p in prices}
    linked = []
    for n in news_items:
        p = price_by_date.get(n["date"])
        linked.append(
            {
                "news_date": n["date"],
                "headline": n["title"],
                "stock_move_same_day_pct": None if not p else p["change_pct"],
                "open": None if not p else p["open"],
                "close": None if not p else p["close"],
                "link": n["link"],
            }
        )
    return {"linked_events": linked, "total_linked": len(linked)}


TOOLS: Dict[str, Callable[..., Dict[str, Any]]] = {
    "get_news_rss": tool_get_news_rss,
    "get_stock_prices": tool_get_stock_prices,
    "link_news_with_price": tool_link_news_with_price,
}


@dataclass
class StepTrace:
    query: str
    llm_response: str
    tool_call: Dict[str, Any]
    tool_result: Dict[str, Any]


def call_llm(client: OpenAI, full_history: List[Dict[str, Any]], query: str) -> str:
    """
    Important for assignment: each query includes ALL past interactions.
    We pass full_history every time.
    """
    msgs = [
        {
            "role": "system",
            "content": (
                "You are a research assistant. Return strict JSON only with keys: "
                "reasoning, tool_name, tool_args. Pick one tool at a time."
            ),
        }
    ]
    msgs.extend(full_history)
    msgs.append({"role": "user", "content": query})

    out = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=msgs,
        temperature=0.1,
    )
    return out.choices[0].message.content or "{}"


def run_assignment_flow(company_name: str, ticker: str) -> Dict[str, Any]:
    client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    today = datetime.utcnow().date()
    from_date = (today - timedelta(days=30)).strftime("%Y-%m-%d")
    to_date = today.strftime("%Y-%m-%d")

    # Stores ALL past interactions (queries + llm + tools)
    history: List[Dict[str, Any]] = []
    traces: List[StepTrace] = []

    # Step 1
    q1 = (
        "Query1: Get latest company news in last 1 month.\n"
        f"Company={company_name}, from_date={from_date}, to_date={to_date}.\n"
        "Return a tool call."
    )
    r1 = call_llm(client, history, q1)
    obj1 = json.loads(r1)
    t1_name = obj1["tool_name"]
    t1_args = obj1["tool_args"]
    t1_result = TOOLS[t1_name](**t1_args)
    traces.append(StepTrace(query=q1, llm_response=r1, tool_call={"name": t1_name, "args": t1_args}, tool_result=t1_result))
    history.extend(
        [
            {"role": "user", "content": q1},
            {"role": "assistant", "content": r1},
            {"role": "tool", "content": json.dumps({"name": t1_name, "result": t1_result})},
        ]
    )

    # Step 2
    q2 = (
        "Query2: Get stock daily prices in same date window.\n"
        f"Ticker={ticker}, from_date={from_date}, to_date={to_date}.\n"
        "Return a tool call."
    )
    r2 = call_llm(client, history, q2)
    obj2 = json.loads(r2)
    t2_name = obj2["tool_name"]
    t2_args = obj2["tool_args"]
    t2_result = TOOLS[t2_name](**t2_args)
    traces.append(StepTrace(query=q2, llm_response=r2, tool_call={"name": t2_name, "args": t2_args}, tool_result=t2_result))
    history.extend(
        [
            {"role": "user", "content": q2},
            {"role": "assistant", "content": r2},
            {"role": "tool", "content": json.dumps({"name": t2_name, "result": t2_result})},
        ]
    )

    # Step 3
    q3 = (
        "Query3: Link each news date with stock movement for that date.\n"
        "Use previous tool results. Return a tool call."
    )
    r3 = call_llm(client, history, q3)
    obj3 = json.loads(r3)
    t3_name = obj3["tool_name"]
    t3_args = obj3["tool_args"]
    # inject previous data if LLM omitted it
    if t3_name == "link_news_with_price":
        t3_args.setdefault("news_items", t1_result.get("news", []))
        t3_args.setdefault("prices", t2_result.get("prices", []))
    t3_result = TOOLS[t3_name](**t3_args)
    traces.append(StepTrace(query=q3, llm_response=r3, tool_call={"name": t3_name, "args": t3_args}, tool_result=t3_result))
    history.extend(
        [
            {"role": "user", "content": q3},
            {"role": "assistant", "content": r3},
            {"role": "tool", "content": json.dumps({"name": t3_name, "result": t3_result})},
        ]
    )

    final_query = "Final: Summarize top linked events and what likely impacted stock."
    final_answer = call_llm(client, history, final_query)

    return {
        "reasoning_chain": [asdict(t) for t in traces],  # required: show chain
        "final_answer": final_answer,
    }


if __name__ == "__main__":
    # Example requested in assignment prompt
    result = run_assignment_flow(company_name="Ola", ticker="OLA.NS")
    print(json.dumps(result, indent=2))
