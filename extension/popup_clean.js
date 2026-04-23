const traceEl = document.getElementById("trace");
const finalEl = document.getElementById("final");
const runBtn = document.getElementById("runBtn");
const testYahooBtn = document.getElementById("testYahooBtn");
const copyTraceBtn = document.getElementById("copyTraceBtn");
const fetchFromPageBtn = document.getElementById("fetchFromPageBtn");
const companyEl = document.getElementById("company");
const tickerEl = document.getElementById("ticker");
const GEMINI_API_KEY =
  typeof window.ENV_GEMINI_API_KEY === "string" ? window.ENV_GEMINI_API_KEY.trim() : "";

function fmt(obj) {
  return JSON.stringify(obj, null, 2);
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fuzzyRatio(a, b) {
  const s1 = normalizeText(a);
  const s2 = normalizeText(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.9;
  const w1 = new Set(s1.split(" ").filter(Boolean));
  const w2 = new Set(s2.split(" ").filter(Boolean));
  let inter = 0;
  for (const x of w1) if (w2.has(x)) inter += 1;
  return inter / Math.max(w1.size, w2.size, 1);
}

function on(el, event, handler) {
  if (el) el.addEventListener(event, handler);
}

function getDateRange() {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - 30);
  return { fromDate: from.toISOString().slice(0, 10), toDate: now.toISOString().slice(0, 10) };
}

async function toolGetNews(companyName, fromDate, toDate) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${companyName} when:30d`)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url);
  const xmlText = await res.text();
  const xml = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = [...xml.querySelectorAll("item")];
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const news = [];
  for (const item of items) {
    const title = item.querySelector("title")?.textContent || "";
    const link = item.querySelector("link")?.textContent || "";
    const pubDate = new Date(item.querySelector("pubDate")?.textContent || "");
    if (Number.isNaN(pubDate.getTime())) continue;
    if (pubDate >= from && pubDate <= new Date(to.getTime() + 86400000)) {
      news.push({ title, link, date: pubDate.toISOString().slice(0, 10) });
    }
  }
  return { companyName, totalNews: news.length, news: news.slice(0, 12) };
}

async function fetchDirectYahooPrices(ticker, fromDate, toDate) {
  const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
  const period2 = Math.floor((new Date(toDate).getTime() + 86400000) / 1000);
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=3mo&interval=1d&events=history&includeAdjustedClose=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      ticker
    )}?range=3mo&interval=1d&events=history&includeAdjustedClose=true`
  ];

  let json = null;
  let lastStatus = 0;
  let lastError = null;
  for (const url of urls) {
    let res = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      res = await fetch(url);
      if (res.ok) break;
      if (res.status !== 429 || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 800));
    }
    lastStatus = res.status;
    if (!res.ok) {
      continue;
    }
    json = await res.json();
    const result = json?.chart?.result?.[0];
    if (result) break;
    lastError = json?.chart?.error?.description || "No chart result";
    json = null;
  }

  if (!json) {
    return {
      ticker,
      totalDays: 0,
      prices: [],
      error: `Price API failed (${lastStatus}). ${lastError || "Yahoo endpoint unavailable for this symbol/date."}`
    };
  }

  const result = json?.chart?.result?.[0];
  if (!result) return { ticker, totalDays: 0, prices: [], error: json?.chart?.error?.description || null };
  const prices = [];
  const timestamps = result.timestamp || [];
  const opens = result.indicators?.quote?.[0]?.open || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = opens[i];
    const close = closes[i];
    if (open == null || close == null || open === 0) continue;
    prices.push({
      date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      close: Number(close.toFixed(2)),
      changePct: Number((((close - open) / open) * 100).toFixed(2))
    });
  }
  return { ticker, totalDays: prices.length, prices, source: "yahoo_direct" };
}

async function toolGetStockPrices(ticker, fromDate, toDate) {
  // Direct market data path only (no local proxy dependency).
  return fetchDirectYahooPrices(ticker, fromDate, toDate);
}

async function toolLinkNewsWithPrice(newsItems, prices) {
  const safeNews = Array.isArray(newsItems) ? newsItems : [];
  const safePrices = Array.isArray(prices) ? prices : [];
  const byDate = {};
  for (const p of safePrices) byDate[p.date] = p;
  const linkedEvents = safeNews.map((n) => {
    const p = byDate[n.date];
    return {
      newsDate: n.date,
      headline: n.title,
      stockMoveSameDayPct: p ? p.changePct : null,
      open: p ? p.open : null,
      close: p ? p.close : null,
      link: n.link
    };
  });
  return { totalLinked: linkedEvents.length, linkedEvents };
}

const TOOLS = {
  get_news: toolGetNews,
  get_stock_prices: toolGetStockPrices,
  link_news_price: toolLinkNewsWithPrice
};

async function callLLM(apiKey, history, query) {
  const prompt = [
    "You are a planning assistant.",
    "Return JSON only with keys: reasoning, tool_name, tool_args.",
    "Allowed tool_name: get_news, get_stock_prices, link_news_price.",
    "Include only one tool per response.",
    "",
    "ALL_PAST_INTERACTIONS:",
    JSON.stringify(history),
    "",
    "CURRENT_QUERY:",
    query
  ].join("\n");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gemini request failed");
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}

function addStep(step) {
  traceEl.textContent += `${fmt(step)}\n\n`;
}

function extractJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e2) {
      return null;
    }
  }
}

function normalizeStockToolArgs(baseArgs, llmArgs = {}) {
  return {
    ticker: llmArgs.ticker || llmArgs.stock_ticker || llmArgs.stock_symbol || baseArgs.ticker,
    fromDate: llmArgs.fromDate || llmArgs.start_date || baseArgs.fromDate,
    toDate: llmArgs.toDate || llmArgs.end_date || baseArgs.toDate
  };
}

function detectTickerFromText(text) {
  if (!text) return null;
  const upper = text.toUpperCase();
  const blocked = new Set([
    "NSE",
    "BSE",
    "FUTURE",
    "FUTURES",
    "OPTION",
    "OPTIONS",
    "FORECAST",
    "NEWS",
    "LIVE",
    "QUOTE",
    "QUOTES"
  ]);
  const patterns = [
    /\b([A-Z]{2,15}\.NS)\b/,
    /\b([A-Z]{2,15}\.BO)\b/,
    /\bNSE[:\s-]+([A-Z0-9]{2,15})\b/,
    /\bBSE[:\s-]+([A-Z0-9]{2,15})\b/
  ];
  for (const re of patterns) {
    const m = upper.match(re);
    if (!m) continue;
    const sym = m[1];
    if (blocked.has(sym)) continue;
    if (re.source.includes("\\.NS") || re.source.includes("\\.BO")) return sym;
    if (re.source.includes("NSE")) return `${sym}.NS`;
    if (re.source.includes("BSE")) return `${sym}.BO`;
  }
  return null;
}

function detectCompanyFromText(text) {
  if (!text) return null;
  const known = ["Ola", "Tata Motors", "Reliance", "Infosys", "HDFC Bank", "ICICI Bank"];
  for (const c of known) {
    if (text.toLowerCase().includes(c.toLowerCase())) return c;
  }
  const m = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(share|stock|price)\b/i);
  return m ? m[1] : null;
}

function detectCompanyFromTitle(title) {
  if (!title) return null;
  // Typical finance page title format:
  // "<Company> Share Price, ... - Moneycontrol.com"
  const m = title.match(/^(.+?)\s+Share Price/i);
  if (m?.[1]) return m[1].trim();
  return detectCompanyFromText(title);
}

function toTitleCaseSlug(slug) {
  if (!slug) return null;
  // Handle collapsed slugs like "asianpaints" -> "Asian Paints"
  const specialSlugNames = {
    asianpaints: "Asian Paints",
    hindustanunilever: "Hindustan Unilever",
    tatamotors: "Tata Motors",
    hcltechnologies: "HCL Technologies",
    bajajfinserv: "Bajaj Finserv",
    bajajauto: "Bajaj Auto"
  };
  const normalized = slug.toLowerCase();
  if (specialSlugNames[normalized]) return specialSlugNames[normalized];

  return slug
    .split("-")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

function inferFromUrl(url) {
  if (!url) return { ticker: null, company: null };

  const out = { ticker: null, company: null };

  // Moneycontrol URL pattern:
  // /stockpricequote/<sector>/<company-slug>/<mc-code>
  const mc = url.match(/stockpricequote\/[^/]+\/([^/]+)\/([^/?#]+)/i);
  if (mc) {
    const companySlug = mc[1];
    const company = toTitleCaseSlug(companySlug);
    out.company = company;

    const slugAliasMap = {
      asianpaints: "ASIANPAINT.NS",
      hindustanunilever: "HINDUNILVR.NS",
      tatamotors: "TATAMOTORS.NS",
      infosys: "INFY.NS",
      relianceindustries: "RELIANCE.NS",
      hcltechnologies: "HCLTECH.NS",
      bajajfinserv: "BAJAJFINSV.NS",
      bajajauto: "BAJAJ-AUTO.NS"
    };
    const slugKey = (companySlug || "").toLowerCase();
    if (slugAliasMap[slugKey]) out.ticker = slugAliasMap[slugKey];

    const aliasMap = {
      "hindustan unilever": "HINDUNILVR.NS",
      "reliance industries": "RELIANCE.NS",
      "tata motors": "TATAMOTORS.NS",
      infosys: "INFY.NS",
      "asian paints": "ASIANPAINT.NS",
      "hcl technologies": "HCLTECH.NS",
      "bajaj finserv": "BAJAJFINSV.NS",
      "bajaj auto": "BAJAJ-AUTO.NS",
      bajajauto: "BAJAJ-AUTO.NS"
    };
    const key = (company || "").toLowerCase();
    if (aliasMap[key]) out.ticker = aliasMap[key];
  }

  return out;
}

async function resolveBestTicker(queryText) {
  const q = (queryText || "").trim();
  if (!q) return null;

  // First try NSE/BSE resolver API directly.
  try {
    const nseUrl = `https://nse-api-ruby.vercel.app/search?q=${encodeURIComponent(q)}`;
    const nseRes = await fetch(nseUrl);
    if (nseRes.ok) {
      const nseJson = await nseRes.json();
      const first = Array.isArray(nseJson?.results) ? nseJson.results[0] : null;
      const results = Array.isArray(nseJson?.results) ? nseJson.results : [];
      if (results.length) {
        let best = results[0];
        let bestScore = -1;
        for (const item of results) {
          const score = fuzzyRatio(q, item.company_name || item.symbol || "");
          if (score > bestScore) {
            best = item;
            bestScore = score;
          }
        }
        if (!best?.symbol) return null;
        return {
          symbol: `${String(best.symbol).toUpperCase()}.NS`,
          shortname: best.company_name || best.symbol,
          exchDisp: "NSE",
          score: Number((bestScore * 100).toFixed(2)),
          resolver: "nse_api_ruby"
        };
      }
    }
  } catch (e) {
    // fallback chain continues
  }

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      q
    )}&quotesCount=15&newsCount=0`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
    if (!quotes.length) return null;

    // Prefer Indian exchange tickers first.
    const ranked = quotes
      .map((x) => ({
        symbol: x.symbol,
        shortname: x.shortname || x.longname || "",
        exchDisp: (x.exchDisp || "").toUpperCase(),
        score:
          (x.symbol?.endsWith(".NS") ? 6 : 0) +
          (x.symbol?.endsWith(".BO") ? 5 : 0) +
          ((x.exchDisp || "").includes("NSE") ? 4 : 0) +
          ((x.exchDisp || "").includes("BSE") ? 3 : 0) +
          ((x.shortname || x.longname || "").toLowerCase().includes(q.toLowerCase()) ? 2 : 0)
      }))
      .filter((x) => typeof x.symbol === "string" && x.symbol.length > 1)
      .sort((a, b) => b.score - a.score);

    return ranked[0] ? { ...ranked[0], resolver: "yahoo_direct" } : null;
  } catch (e) {
    return null;
  }
}

async function extractFromActivePage() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("No active tab found.");

  if (!chrome.scripting?.executeScript) {
    // Fallback path when scripting API is unavailable.
    return { title: tab.title || "", url: tab.url || "", text: `${tab.title || ""}\n${tab.url || ""}` };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const title = document.title || "";
      const h1 = document.querySelector("h1")?.textContent || "";
      const fullText = document.body?.innerText || "";
      const blocked = new Set([
        "NSE",
        "BSE",
        "FUTURE",
        "FUTURES",
        "OPTION",
        "OPTIONS",
        "FORECAST",
        "NEWS",
        "LIVE",
        "QUOTE",
        "QUOTES"
      ]);
      const nseMatch = fullText.match(/\bNSE\s*[:\-]?\s*([A-Z0-9]{2,15})\b/i);
      const bseMatch = fullText.match(/\bBSE\s*[:\-]?\s*([A-Z0-9]{2,15})\b/i);
      const nseSym = nseMatch?.[1] ? nseMatch[1].toUpperCase() : null;
      const bseSym = bseMatch?.[1] ? bseMatch[1].toUpperCase() : null;
      const detectedTicker = nseSym && !blocked.has(nseSym) ? `${nseSym}.NS` : bseSym && !blocked.has(bseSym) ? `${bseSym}.BO` : null;

      // Keep preview short for UI/debug payload.
      const bodyText = fullText.slice(0, 8000);
      return { title, h1, url: location.href, text: `${title}\n${h1}\n${bodyText}`, detectedTicker };
    }
  });
  return results?.[0]?.result || { title: tab.title || "", url: tab.url || "", text: tab.title || "" };
}

async function runFlow() {
  const company = companyEl.value.trim();
  const ticker = tickerEl.value.trim();
  if (!GEMINI_API_KEY) {
    throw new Error("Gemini key missing. Run: export GEMINI_API_KEY='AIza...' && bash scripts/set_gemini_key.sh");
  }
  if (!company || !ticker) throw new Error("Please enter company and ticker.");

  const { fromDate, toDate } = getDateRange();
  const history = [];
  const reasoning_chain = [];

  // Run independent tools together for faster execution.
  const q1 = `Query1: find news for ${company} between ${fromDate} and ${toDate}`;
  const q2 = `Query2: fetch prices for ${ticker} between ${fromDate} and ${toDate}`;
  const [r1, r2] = await Promise.all([
    callLLM(GEMINI_API_KEY, history, q1),
    callLLM(GEMINI_API_KEY, history, q2)
  ]);
  const o1 = JSON.parse(r1);
  const o2 = JSON.parse(r2);

  const a1 = { companyName: company, fromDate, toDate, ...(o1.tool_args || {}) };
  const n1 = o1.tool_name || "get_news";
  const a2 = normalizeStockToolArgs({ ticker, fromDate, toDate }, o2.tool_args || {});
  const n2 = o2.tool_name || "get_stock_prices";

  const [t1, t2] = await Promise.all([
    TOOLS[n1](a1.companyName, a1.fromDate, a1.toDate),
    TOOLS[n2](a2.ticker, a2.fromDate, a2.toDate)
  ]);

  const s1 = { query: q1, llm_response: o1, tool_call: { name: n1, args: a1 }, tool_result: t1, parallel_group: "news+price" };
  const s2 = { query: q2, llm_response: o2, tool_call: { name: n2, args: a2 }, tool_result: t2, parallel_group: "news+price" };
  reasoning_chain.push(s1, s2);
  addStep(s1);
  addStep(s2);
  history.push(
    { role: "user", content: q1 },
    { role: "assistant", content: r1 },
    { role: "tool", content: JSON.stringify(t1) },
    { role: "user", content: q2 },
    { role: "assistant", content: r2 },
    { role: "tool", content: JSON.stringify(t2) }
  );

  const q3 = "Query3: link news dates with stock movement";
  const r3 = await callLLM(GEMINI_API_KEY, history, q3);
  const o3 = JSON.parse(r3);
  const llmA3 = o3.tool_args || {};
  const a3 = {
    newsItems: Array.isArray(llmA3.newsItems) ? llmA3.newsItems : t1.news || [],
    prices: Array.isArray(llmA3.prices) ? llmA3.prices : t2.prices || []
  };
  const n3 = o3.tool_name || "link_news_price";
  const t3 = await TOOLS[n3](a3.newsItems, a3.prices);
  const s3 = { query: q3, llm_response: o3, tool_call: { name: n3, args: a3 }, tool_result: t3 };
  reasoning_chain.push(s3);
  addStep(s3);
  history.push({ role: "user", content: q3 }, { role: "assistant", content: r3 }, { role: "tool", content: JSON.stringify(t3) });

  const final_answer = await callLLM(
    GEMINI_API_KEY,
    history,
    [
      "Final decision task for NEXT 1 MONTH only.",
      "Return JSON only with keys:",
      "verdict (exactly one of: GOOD_TO_BUY, NOT_GOOD_TO_BUY),",
      "reason (max 20 words),",
      "confidence (0 to 1)."
    ].join(" ")
  );
  const parsedFinal = extractJsonObject(final_answer) || {
    verdict: "NOT_GOOD_TO_BUY",
    reason: "Could not confidently parse final model output.",
    confidence: 0.3
  };
  return { reasoning_chain, final_answer: parsedFinal };
}

on(runBtn, "click", async () => {
  traceEl.textContent = "";
  finalEl.textContent = "Running...";
  runBtn.disabled = true;
  try {
    const result = await runFlow();
    const verdictLabel =
      result.final_answer?.verdict === "GOOD_TO_BUY" ? "Good stock to buy for next 1 month" : "Not a good stock to buy for next 1 month";
    finalEl.textContent = `${verdictLabel}\nReason: ${result.final_answer?.reason || "N/A"}\nConfidence: ${result.final_answer?.confidence ?? "N/A"}`;
  } catch (e) {
    finalEl.textContent = e.message || String(e);
  } finally {
    runBtn.disabled = false;
  }
});

on(testYahooBtn, "click", async () => {
  const ticker = tickerEl.value.trim();
  const { fromDate, toDate } = getDateRange();
  finalEl.textContent = "Testing direct Yahoo API...";
  try {
    const result = await fetchDirectYahooPrices(ticker, fromDate, toDate);
    finalEl.textContent = fmt({
      test: "fetchDirectYahooPrices",
      input: { ticker, fromDate, toDate },
      output: result
    });
  } catch (e) {
    finalEl.textContent = `Direct Yahoo test failed: ${e.message || String(e)}`;
  }
});

on(copyTraceBtn, "click", async () => {
  try {
    await navigator.clipboard.writeText(traceEl.textContent || "");
    finalEl.textContent = "Reasoning chain copied to clipboard.";
  } catch (e) {
    finalEl.textContent = `Copy failed: ${e.message || String(e)}`;
  }
});

on(fetchFromPageBtn, "click", async () => {
  finalEl.textContent = "Reading stock from current website...";
  try {
    const page = await extractFromActivePage();
    const merged = `${page.url}\n${page.text}`;
    const fromUrl = inferFromUrl(page.url || "");
    const regexTicker = page.detectedTicker || detectTickerFromText(merged);
    const titleCompany = detectCompanyFromTitle(page.title || "");
    const detectedCompany = fromUrl.company || titleCompany || detectCompanyFromText(merged);
    const resolverQuery = detectedCompany || titleCompany || tickerEl.value.trim() || companyEl.value.trim() || page.title || "";
    const resolved = await resolveBestTicker(resolverQuery);
    const detectedTicker = fromUrl.ticker || (resolved && resolved.symbol) || regexTicker;

    if (detectedTicker) tickerEl.value = detectedTicker;
    if (detectedCompany) companyEl.value = detectedCompany;

    finalEl.textContent = fmt({
      fromWebsite: true,
      detectedTicker: detectedTicker || null,
      detectedCompany: detectedCompany || null,
      titleCompany: titleCompany || null,
      pageTitle: page.title,
      fallbackMode: !chrome.scripting?.executeScript,
      tickerSource: fromUrl.ticker ? "url_alias" : resolved?.symbol ? "yahoo_search_api" : page.detectedTicker ? "page_text_nse_bse" : "regex_fallback",
      resolverCandidate: resolved || null
    });
  } catch (e) {
    finalEl.textContent = `Could not read website stock: ${e.message || String(e)}`;
  }
});

