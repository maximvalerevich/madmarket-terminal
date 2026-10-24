# MadMarket (Mollybet) Low-Latency Courtsiding Terminal

A high-frequency, modular CLI execution terminal built on **Node.js** tailored for semi-automated sports betting on the **MadMarket** platform (powered by the **Mollybet API engine**). Engineered specifically for high-stress, time-critical trading environments such as **courtsiding** and **after-goal** execution.

---

## 1. Architectural Philosophy & Performance Constraints

1. **Zero Runtime Bloat**:
   - Built exclusively on native Node.js core modules (`node:http2`, `node:readline`, `node:crypto`, `node:perf_hooks`, `node:events`).
   - The only permitted external dependency is [`ws`](https://github.com/websockets/ws) for low-overhead Boost.Beast WebSocket streaming.
2. **Pre-Warmed HTTP/2 Multiplexing**:
   - Persistent `http2.connect` session maintained against `https://edge.madmarket.io`.
   - Background HTTP/2 `PING` frames dispatched every 15 seconds to keep connection warm and measure sub-millisecond RTT.
   - Order execution simply serializes a minimal JSON buffer into an already active HTTP/2 stream, achieving local package construction latency of **< 1 ms**.
3. **Adapter Design Pattern (`BaseAdapter` $\rightarrow$ `MollybetAdapter`)**:
   - Isolates broker-specific endpoints, headers, payload serializations, and bet-type resolvers.
   - Ready for plug-and-play direct broker connectors (Pinnacle Direct API, BetInAsia, Singbet, Betfair Exchange) without touching execution engine or UI core.
4. **Strict 3-Betslip Session Quota**:
   - Mollybet restricts accounts to a maximum of 3 concurrent active betslips per session.
   - The engine manages an intelligent pre-armed pool, actively closing unused slips via HTTP `DELETE /v1/betslips/<id>/` when switching matches or market modes.
5. **Tmux & SSH-Safe Raw Mode UI**:
   - Single-key instant trigger execution via `process.stdin.setRawMode(true)`.
   - Complete UTF-8 escape-code flicker-free differential HUD rendering.

---

## 2. Project File Structure

```text
├── config.json                     # Session tokens, instance ID, accounts, stakes & safety thresholds
├── package.json                    # Project definition (ESM module, test scripts)
├── index.js                        # System bootstrapper, lifecycle management, graceful shutdown
├── test-runner.js                  # 24 architectural unit tests validating all core components
├── logs.js                         # Standalone interactive log viewer utility
├── terminal.log                    # Append-only persistent execution and system audit log
└── src/
    ├── adapters/
    │   ├── baseAdapter.js          # Abstract broker adapter interface
    │   └── mollybetAdapter.js      # Mollybet REST HTTP/2 protocol adapter
    ├── network/
    │   ├── http2Client.js          # Pre-warmed HTTP/2 client with auto-reconnect & ping heartbeats
    │   └── wsFeed.js               # Boost.Beast WebSocket feed client (offers, betslips, balance)
    ├── core/
    │   ├── stateManager.js         # Reactive in-memory state, betslip cache, bookie filtering, odds store
    │   └── executionEngine.js      # Sub-millisecond combat trigger, debounce guard, order tracker
    ├── ui/
    │   └── terminalUI.js           # Multi-view terminal renderer (HUD, match picker, coupons pool, logs)
    └── utils/
        └── logger.js               # Zero-overhead timestamped console and file logger
```

---

## 3. Mollybet Protocol & API Specifications

### 3.1 Base Headers & Authentication
All HTTP/2 requests to `https://edge.madmarket.io` must transmit:
```http
:authority: edge.madmarket.io
:scheme: https
Session: <sessionToken>
Cookie: root-session=<sessionToken>; whitelabel=edgemadmarket; instance-id=<instanceId>
X-Molly-Client-Name: sonic
X-Molly-Client-Version: 2.5.160
X-Molly-Client-View: sportsbook
Content-Type: application/json
Origin: https://edge.madmarket.io
Referer: https://edge.madmarket.io/
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
```

### 3.2 Key Endpoints
1. **Pre-Arm Betslip**: `POST /v1/betslips/`
   ```json
   {
     "sport": "fb",
     "event_id": "<eventId>",
     "bet_type": "<betType>",
     "betslip_type": "normal",
     "equivalent_bets": true,
     "live_score": { "home": 0, "away": 0 }
   }
   ```
2. **Delete Betslip (Quota Release)**: `DELETE /v1/betslips/<betslipId>/`
   - Closes the slip on broker servers to stay within the 3-slip limit.
3. **Dispatch Combat Order**: `POST /v1/orders/`
   ```json
   {
     "betslip_id": "<betslipId>",
     "price": <limitPrice>,
     "stake": ["EUR", <stake>],
     "duration": 15,
     "keep_open_ir": false,
     "adaptive_bookies": ["pin88"],
     "accounts": [["pin88", "_85ce631d_"]],
     "exchange_mode": "make_and_take",
     "placer_type": "classic",
     "request_uuid": "<crypto.randomUUID()>"
   }
   ```
4. **Order Status Polling**: `GET /v1/orders/<orderId>/`
   - Returns `{ status: "done" | "in_flight" | "failed", closed: true, close_reason: "order_filled" | "timed_out", ... }`.

### 3.3 Bet-Type String Encoding Rules
Mollybet encodes handicap quarter-lines as integers multiplied by 4 (`lineIndex = Math.round(line * 4)`):

#### Football (`"fb"` / `"fb_ht"`)
- **Full-Time Total Over**: `for,ir,<h>,<a>,ahover,<lineIndex>` (e.g. Total Over 2.5 at 0-0 $\rightarrow$ `for,ir,0,0,ahover,10`)
- **Full-Time 1X2 Moneyline**: `for,h` (Home), `for,a` (Away)
- **Individual Team Totals (ITB)**:
  - ITB1 (Team 1 / Home Over): `for,ir,<h>,<a>,tahover,h,<lineIndex>`
  - ITB2 (Team 2 / Away Over): `for,ir,<h>,<a>,tahover,a,<lineIndex>`
- **1st Half (HT) Markets**:
  - Sent with `"sport": "fb_ht"`.
  - HT Total Over 0.5 at 0-0 $\rightarrow$ `for,ir,0,0,ahover,2`.

#### Ice Hockey (`"ih"`)
- Always sent with `"sport": "ih"` in `POST /v1/betslips/` (for both Regular Time 60m and Period markets), and **without** `ir,<h>,<a>` in `bet_type`:
- **Regular Time 60m (`FT`, prefix `tp,reg`)**:
  - `OVER` (Default line `5.5` $\rightarrow$ `22`): `for,tp,reg,ahover,<lineIndex>`
  - `HOME` / `AWAY` (1X2 60m): `for,tp,reg,wdw,h` / `for,tp,reg,wdw,a`
  - `ITB1` / `ITB2` (Default line `2.5` $\rightarrow$ `10`): `for,tp,reg,tahover,h,<lineIndex>` / `for,tp,reg,tahover,a,<lineIndex>`
- **Current Period $N \in \{1, 2, 3\}$ (`HT`, prefix `tperiod,<N>`)**:
  - Automatically tracks active period $N$ from `ir_status.period_scores`:
  - `HT_OVER` (Default line `1.5` $\rightarrow$ `6`): `for,tperiod,<N>,ahover,<lineIndex>`
  - `HT_HOME` / `HT_AWAY`: `for,tperiod,<N>,wdw,h` / `for,tperiod,<N>,wdw,a`
  - `HT_ITB1` / `HT_ITB2` (Default line `0.5` $\rightarrow$ `2`): `for,tperiod,<N>,tahover,h,<lineIndex>` / `for,tperiod,<N>,tahover,a,<lineIndex>`

---

## 4. Key Engineering Features & Fixes

### 4.1 Strict Bookmaker Filtering (`getAllowedBookies()`)
- **Problem**: Third-party aggregate bookmakers (such as Parimatch `pmk` or `betdex`) send distorted quotes (e.g. quote `93.257` with limit €1218 on closed lines). When using `Math.max()`, these quotes polluted Pinnacle's (`pin88`) real market prices.
- **Solution**: Both `MollybetAdapter` and `StateManager` strictly filter quotes using `getAllowedBookies()` derived from `config.accounts` and `config.adaptiveBookies`. Any PMM frame or `bookies_with_offers` item from non-configured bookmakers (`pmk`, `betdex`, `sbo`, etc.) is immediately rejected. Only `pin88` quotes and stake limits are accepted.

### 4.2 Honest Closed Line Reset & Zero-Price Display
- **Problem**: When a moneyline or total market was suspended or closed by Pinnacle (e.g. `1=0, 2=0` on blowout or danger moments), previous logic kept stale prices because it ignored zero values (`if (odds.winHome > 0)`).
- **Solution**:
  - `WsFeed` emits `updatedMarkets: { wdw, ahou, itb1, itb2 }`.
  - `StateManager.updateOdds()` explicitly zeroes out prices when the market has no offers.
  - `TerminalUI.formatSlipStatus()` displays closed lines in **bold bright red**: `0.00 (ЗАКРЫТО 38s)` or `0.00 (NO SLIP)`.
  - `ExecutionEngine.fire()` aborts instantly on closed lines (`livePrice <= 1.0`) with `[ABORT] Линия БК закрыта (кэф: 0.00)` to prevent failed orders.

### 4.3 Async Order Lifecycle Tracker
- When an order is placed, `ExecutionEngine.trackOrder(orderId, targetKey, result)` tracks its execution asynchronously without blocking the UI:
  - State `IN_FLIGHT`: Displayed in yellow in the permanent HUD combat banner.
  - State `DONE`: Displayed in green `[СТАВКА ПРИНЯТА (DONE) pin88] OVER @ кэф 1.35 | €5 | ID: 2290691511 (0.8s)`.
  - State `REJECTED` / `TIMED_OUT`: Displayed in red with rejection reason.
  - Sanitized stake output (`€5` instead of `€EUR,5`).

### 4.4 Market Modes & Quota Isolation
- **Mode `MAIN`**: Pre-arms `[OVER, HOME, AWAY]`.
- **Mode `ITB`**: Pre-arms `[OVER, ITB1, ITB2]`.
- Toggled seamlessly with key **`I`**. Unused slips are deleted from Mollybet via HTTP `DELETE` to remain strictly within the 3-slip limit.

### 4.5 Multi-Period Combat (FT vs HT)
- Toggled with key **`T`** between Full-Time (`FT`) and 1st Half (`HT`).
- Dedicated instant trigger keys: **`3`** (HT Over), **`4`** (HT Home/ITB1), **`5`** (HT Away/ITB2), **`6`** (Direct ITB1), **`7`** (Direct ITB2).

### 4.6 Bet History & Settlement Normalization
- Centralized tracking via `StateManager.getOrdersHistory(limit=200)` parsing `/v1/orders/`.
- `orderNormalizer.js` extracts partial fills, true stakes (`effStake`), true odds (`effPrice`), and actual PnL (profit/loss).
- Handles API quirks where Mollybet returns `close_reason: "order_filled"` on a `failed` bet.
- UI renders an interactive, scrollable History Modal (Key **`B`**) and a concise 3-bet preview block directly in the Combat HUD.

### 4.7 Smart ITB (Individual Total) Line Selection
- The system employs a `selectionMode` in `parseTotalMarket`.
- For Main Totals (`ahou`), it picks the line closest to `1.95` (even money) to offer the most balanced handicap.
- For Individual Totals (`tahou`), it uses `lowest` mode to automatically latch onto the lowest available line (e.g. `0.5`) with odds > 1.0, and holds it until suspended (sticky line).

### 4.8 Alphanumeric Match Searching & Multi-Sport Support (`FB` + `IH`)
- Supports **Football (`fb` / `fb_ht`)** and **Ice Hockey (`ih`)** simultaneously in the live feed and Match Selection Menu (`[FB]` green / `[IH]` cyan badges).
- Automatic period detection (`P1` / `P2` / `P3`) for Ice Hockey via `ir_status.period_scores`, with automatic betslip teardown and re-arming when a period ends and the next period begins (`P1 -> P2 -> P3`).
- In the Match Selection menu, direct typing triggers an instant local filter by home or away team name, while `H`/`Ctrl+H` and `F`/`Ctrl+F` filter by sport.


---

## 5. Configuration (`config.json`)

```json
{
  "baseUrl": "https://edge.madmarket.io",
  "wsUrl": "wss://edge.madmarket.io/cpricefeed/",
  "sessionToken": "d8a2f49a089977c420e9cf2431e99679",
  "instanceId": "f98999",
  "accounts": [["pin88", "_85ce631d_"]],
  "adaptiveBookies": ["pin88"],
  "defaultStake": 5.0,
  "stakeStep": 10.0,
  "defaultCurrency": "EUR",
  "slippagePct": 0.03,
  "defaultDuration": 15,
  "debounceMs": 2000,
  "dryRun": false
}
```

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `sessionToken` | `string` | Active Mollybet authentication token. |
| `instanceId` | `string` | Whitelabel routing instance identifier. |
| `accounts` | `Array<[string, string]>` | List of `[bookmaker, account_id]` credentials. |
| `adaptiveBookies` | `string[]` | Authorized bookmakers for pricing and routing (strictly `["pin88"]`). |
| `defaultStake` | `number` | Combat stake amount in active currency. |
| `stakeStep` | `number` | Incremental step when pressing `+` / `-`. |
| `slippagePct` | `number` | Max allowable price slippage (`0.03` = 3%). `limitPrice = livePrice * (1 - slippagePct)`. |
| `defaultDuration` | `number` | Order queue lifespan in seconds at Pinnacle. Default: `15`. |
| `debounceMs` | `number` | Hardware anti-double-click guard period (ms). |
| `dryRun` | `boolean` | When `true`, executes full pipeline locally without sending HTTP order frame. |

---

## 6. Keybindings Reference

### Combat HUD Mode (Default)
| Key | Action |
| :--- | :--- |
| **`SPACE`** | **FIRE TOTAL OVER** on active match & active period. |
| **`1`** | **FIRE HOME (П1)** in MAIN mode, or **FIRE ITB1** in ITB mode. |
| **`2`** | **FIRE AWAY (П2)** in MAIN mode, or **FIRE ITB2** in ITB mode. |
| **`6`** | **DIRECT FIRE ITB1** (Home Individual Total Over). |
| **`7`** | **DIRECT FIRE ITB2** (Away Individual Total Over). |
| **`3`** | **DIRECT FIRE 1st Half (HT) Total Over**. |
| **`4`** | **DIRECT FIRE 1st Half (HT) Home / ITB1**. |
| **`5`** | **DIRECT FIRE 1st Half (HT) Away / ITB2**. |
| **`I`** | **Toggle Market Mode**: `MAIN` (1X2 + Total) $\leftrightarrow$ `ITB` (ITB1 + ITB2 + Total). |
| **`T`** | **Toggle Active Period**: Full-Time (`FT`) $\leftrightarrow$ 1st Half (`HT`). |
| **`+` / `-`** | Increase / Decrease active stake by `stakeStep`. |
| **`S`** | Open manual stake entry modal (with broker max-limit enforcement). |
| **`[` / `]`** | Cycle between armed matches in the pool. |
| **`M`** | Open Live Match Selection Menu. |
| **`C`** | Open Pre-Armed Coupons & Matches Manager. |
| **`TAB`** | Toggle Full-screen Live Log Viewer (`terminal.log`). |
| **`D`** | Disarm and release betslips for active match. |
| **`Shift+D`** | Disarm ALL matches and purge betslip pool. |
| **`Q`** / **`Ctrl+C`** | Graceful shutdown and release of all resources. |

### Match Selection Menu (`M`)
| Key | Action |
| :--- | :--- |
| **`UP` / `DOWN`** | Navigate match list. |
| **`ENTER` / `SPACE`** | Select match and pre-arm 3 slips in combat pool. |
| **`H` / `Ctrl+H`** | Filter list: Toggle **Ice Hockey Only (`[IH]`)**. |
| **`F` / `Ctrl+F`** | Filter list: Toggle **Football Only (`[FB]`)**. |
| **`L` / `Ctrl+L`** | Filter list: Show **Live Only**. |
| **`A` / `Ctrl+A`** | Filter list: Show **All Matches** (all sports). |
| **`1-9` + `ENTER`** | Fast select by match row number. |
| **`ESC` / `M`** | Clear search query or return to Combat HUD. |

---

## 7. Verification & Architectural Unit Tests

Run the test suite:
```bash
npm test
```
Outputs:
```text
--- STARTING ARCHITECTURAL UNIT TESTS ---
✓ BaseAdapter abstract instantiation blocked
✓ MollybetAdapter headers conform to specification
✓ MollybetAdapter bet_type resolution accurate
✓ WsFeed event frame parsing verified
✓ WsFeed offers_hcap parsing verified
✓ StateManager stake management verified (+/- step & boundaries)
✓ ExecutionEngine fire('OVER') limitPrice=1.891 (expected: 1.891)
✓ ExecutionEngine debounce cooldown verified (2000ms guard)
✓ StateManager odds preservation verified (0-ticks do not wipe valid odds)
✓ Armed matches list verified (2 matches in pool)
✓ Cycle switching between armed matches verified (switchNext / switchPrev)
✓ disarmActiveEvent verified (auto-switched to remaining match)
✓ disarmAll verified (pool completely purged)
✓ MollybetAdapter bookie price & stake limits extraction verified (pin88 filtered)
✓ MollybetAdapter deleteBetslip verified (DELETE /v1/betslips/<betslipId>)
✓ MollybetAdapter 1st Half (HT) bet_type resolution verified
✓ StateManager period switching (FT <-> HT) and isolated odds store verified
✓ MollybetAdapter ITB bet_type resolution & getOrderStatus verified
✓ WsFeed tahou (ITB1 / ITB2) offers parsing verified
✓ StateManager Market Modes (MAIN <-> ITB) & 3-slip quota isolation verified
✓ ExecutionEngine async order lifecycle tracking (in-flight -> done / rejected) verified
✓ ExecutionEngine clamps stake to per-outcome limit (30 → 25.78) without touching configured stake
✓ ExecutionEngine partial fill recognized (€25 of €30 → DONE/partial)
✓ StateManager strict PMM bookmaker filtering verified (pmk discarded, pin88 accepted)
✓ StateManager closed market zero-reset verified (no stale odds kept)
✓ ExecutionEngine closed line shot abort verified (0.00 prevents bad bets)
✓ TerminalUI closed line bold red 0.00 display verified
✓ StateManager Total Line selection, cycling and manual overrides verified
✓ WsFeed soccer subscription verified (fb + fb_ht subscribed for fb_htft events)
✓ Half Time (HT) 4 markets pre-arming (Asian Total, 1X2, ITB1, ITB2) verified
✓ MollybetAdapter strict bookie filtering verified (refuses unallowed/raw broker prices)
✓ WsFeed sticky line hysteresis verified (prevents line jumping between 2.5 and 2.75)
✓ HT vs FT score isolation and phantom goal prevention verified
✓ Bookmaker PMM quote priority over generic ticker ticks verified
✓ Mollybet 4-betslip quota guard (pre-deletion & 403 backoff) verified
✓ Strict bookmaker (pin88) line closed protection verified (prevents shooting into empty air)
✓ getArmedBetslip strict context isolation (period & market mode) verified
✓ WsFeed cumulative spectrum registry and eviction verified
✓ Stale bookie quote protection against third-party ticker contamination verified
✓ PMM & Betslip WS-handlers period isolation verified
✓ Order normalizer logic verified for WON, LOST, VOID, REJECTED_GOAL, IN_PLAY, PENDING
✓ MollybetAdapter Ice Hockey ("ih") bet_type resolution (tp,reg & tperiod,1..3) and sport payload verified
✓ WsFeed Ice Hockey event frame parsing and period auto-detection verified
✓ WsFeed Ice Hockey offers_hcap parsing (nested [null,...] & dual FT/HT dispatch) verified
✓ StateManager automatic hockey period switch (P1 -> P2) & coupon re-arming verified
--- ALL ARCHITECTURAL TESTS PASSED SUCCESSFULLY ---
```

---

## 8. Guidelines for Future AI Assistants & Developers

Detailed rules and system constraints are documented in [ARCHITECTURE_CONSTRAINTS.md](file:///d:/Sites/Bookmaker/ARCHITECTURE_CONSTRAINTS.md). When making modifications or adding features:
1. **Preserve Zero-Dependency Execution**: Never add npm packages for networking, parsing, or terminal control. All features must rely on Node.js native libraries. Only `ws` is allowed.
2. **Never Exceed 3 Armed Slips (4-slip broker quota)**: Mollybet returns HTTP 403 `too_many_open_betslips` if slips accumulate. Any code that opens new betslips MUST invoke `deleteBetslip` on outgoing slips first.
3. **Strict Bookmaker Filtering (`pin88`)**: Never revert to global `Math.max()` across all bookies. Always check `getAllowedBookies()`. If the target bookie has no offers in betslip, set `currentPrice = 0` and `priceSource = 'CLOSED'`. Never let generic WS feed ticks overwrite a closed target bookie line.
4. **Never Guess or Resurrect Odds in UI**: In `TerminalUI.formatSlipStatus`, closed slips must show `0.00 (ЗАКРЫТО <TTL>s)`. Generic broker prices must never be displayed as green `OK` for a coupon bound to a strict bookie.
5. **Score & Period Isolation (FT vs HT)**: Keep `liveScoreFt` and `liveScoreHt` separated. Never propagate FT score changes to HT markets or vice versa.
6. **Always Run `npm test`**: Verify all 40 architectural tests pass before committing any changes.
