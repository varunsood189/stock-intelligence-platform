# Stock News + Price Linking Agent (Chrome Side Panel)

This project is a Chrome Side Panel extension for multi-step stock research:

1. fetch latest company news,
2. fetch stock prices for the same window,
3. link news dates with price moves,
4. return a 1-month buy/not-buy decision,
5. show reasoning chain + tool calls + tool results.

It is built for assignment-style agent workflows with visible traceability.

---

## 1) Running Components

### A) Chrome Extension (`extension/`)

- Persistent Side Panel UI
- Gemini orchestration (`gemini-2.5-flash-lite`)
- Tool execution + trace rendering
- Website-based company/ticker auto-detection

### B) Direct Market Data (Extension Runtime)

- Direct Yahoo chart/search API access from extension
- NSE/BSE resolver endpoint with fuzzy ranking
- No local proxy dependency

### C) Config Bootstrap (`scripts/set_gemini_key.sh`)

- Reads `.env`
- Generates `extension/config.js`
- Keeps API key out of source-controlled extension code

---

## 2) Architecture Diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│                         Chrome Side Panel                      │
│  UI + Agent Flow (popup_clean.js)                             │
│  - Get Stock From Website                                     │
│  - Run Multi-step Research                                    │
│  - Test Direct Yahoo                                          │
│  - Copy Trace                                                 │
└───────────────┬───────────────────────────────┬───────────────┘
                │                               │
                │                               │
                ▼                               ▼
     ┌───────────────────────┐        ┌──────────────────────────┐
     │ Gemini API            │        │ External Market/News APIs │
     │ (generateContent)     │        │ - Google News RSS         │
     │ model: 2.5-flash-lite │        │ - Yahoo chart/search      │
     └───────────────────────┘        └──────────────────────────┘
                │
                │ (tool orchestration + history)
                ▼
    ┌────────────────────────────────────────────────────────────┐
    │ Direct Data Path in popup_clean.js                        │
    │ get_stock_prices -> Yahoo chart APIs                      │
    │ resolve_ticker   -> NSE/BSE API + Yahoo fallback + fuzzy  │
    └────────────────────────────────────────────────────────────┘
```

---

## 3) Service Flow Chart

```text
User clicks "Run Multi-step Research"
        │
        ├─► Build last-30-days date range
        │
        ├─► Query1 + Query2 planned by Gemini (parallel)
        │      ├─► Tool: get_news(company, from, to)
        │      └─► Tool: get_stock_prices(ticker, from, to)
        │             └─► direct Yahoo chart API
        │
        ├─► Query3 planned by Gemini
        │      └─► Tool: link_news_price(news, prices)
        │
        ├─► Final Gemini decision (1 month only)
        │      └─► GOOD_TO_BUY or NOT_GOOD_TO_BUY + reason + confidence
        │
        └─► Render:
               - Reasoning Chain + Tool Trace
               - Final concise verdict
```

---

## 4) Tooling (Custom Tools)

### 1. `get_news`

- Source: Google News RSS
- Output: `[{ title, link, date }]`

### 2. `get_stock_prices`

- Source: direct Yahoo chart API
- Output: `[{ date, open, close, changePct }]`

### 3. `link_news_price`

- Joins news date with same-day OHLC/move.
- Output: linked events list for final inference.

---

## 5) Ticker Resolution Strategy

Used by **Get Stock From Website**:

1. URL alias extraction (Moneycontrol patterns)
2. `nse-api-ruby` search
3. direct Yahoo search fallback
4. regex fallback from page text (`NSE:`, `BSE:` patterns)

Includes fuzzy matching so near-name variations still resolve.

---

## 6) Setup

### Step 1: Python environment

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Step 2: Configure Gemini key

```bash
cp .env.example .env
```

Edit `.env`:

```env
GEMINI_API_KEY=AIza...
```

Keep secrets local:

- `.env` and `extension/config.js` are gitignored.
- `extension/config.example.js` remains the tracked template file.

Generate extension config:

```bash
bash scripts/set_gemini_key.sh
```

## 7) Load & Run

### Load extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Choose `stock-market-predictor/extension`
5. Click extension icon to open side panel

### Use extension

1. Click **Get Stock From Website** (or fill company/ticker manually)
2. Optional: click **Test Direct Yahoo**
3. Click **Run Multi-step Research**
4. Click **Copy Trace** for assignment logs

---

## 8) API Endpoints Used

### External

- Gemini generate content API
- Google News RSS search
- Yahoo chart/search APIs
- NSE/BSE search API (`nse-api-ruby.vercel.app/search`)

---

## 9) Troubleshooting

### Gemini key error

- Verify `.env` has `GEMINI_API_KEY`
- Re-run `bash scripts/set_gemini_key.sh`
- Reload extension

### Ticker not detected

- Ensure page is fully loaded before clicking **Get Stock From Website**
- Check debug payload fields:
  - `tickerSource`
  - `resolverCandidate`
  - `titleCompany`

### Price empty or inconsistent

- Verify ticker uses exchange suffix (`.NS` / `.BO`)
- Compare with **Test Direct Yahoo** to isolate source issues

### Extension changes not visible

- Reload extension in `chrome://extensions`
- If manifest changed, full reload is required

---

## 10) Notes

- Decision output is educational and for assignment/demo use.
- Not investment advice.
