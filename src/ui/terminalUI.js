import readline from 'node:readline';
import { logger } from '../utils/logger.js';

// ANSI color and styling helpers
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgWhite: '\x1b[47m',
  clearLine: '\x1b[2K\r',
  cursorHome: '\x1b[H',
  clearScreen: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h'
};

/**
 * TerminalUI
 * High-performance terminal HUD, match selection menu, and built-in diagnostic log viewer.
 * Fully compatible with tmux, rawMode single-keystroke captures,
 * on-the-fly stake adjustments, and fast access to pre-armed betslips.
 */
export class TerminalUI {
  /**
   * @param {Object} options
   * @param {import('../core/stateManager.js').StateManager} options.stateManager
   * @param {import('../core/executionEngine.js').ExecutionEngine} options.executionEngine
   * @param {import('../network/http2Client.js').Http2Client} options.http2Client
   * @param {import('../network/wsFeed.js').WsFeed} options.wsFeed
   * @param {Object} options.config
   */
  constructor(options) {
    this.stateManager = options.stateManager;
    this.executionEngine = options.executionEngine;
    this.http2Client = options.http2Client;
    this.wsFeed = options.wsFeed;
    this.config = options.config;

    /** @type {'HUD' | 'MENU' | 'COUPONS' | 'LOGS' | 'LINES' | 'INPUT_STAKE'} */
    this.mode = 'HUD';

    /** @type {'LIVE' | 'ALL'} */
    this.menuFilterMode = 'LIVE';

    this.menuSelectedIndex = 0;
    this.menuMatches = [];
    this.menuInputBuffer = '';

    this.couponsSelectedIndex = 0;
    this.linesSelectedIndex = 0;

    this.stakeInputBuffer = '';

    this.lastLogMessage = '';
    this.lastLogLevel = 'info';
    this.lastLogTimestamp = '';

    /** @type {Object | null} Persistent combat order result (never overwritten by ticks) */
    this.lastExecutionResult = null;

    this.renderInterval = null;
    this.isRawModeActive = false;
    this.needsRender = true;

    /** @type {string[]} Cached log entries for in-memory log viewer */
    this.logEntries = [];
    this.maxLogEntries = 30;

    this.onKeypress = this.handleKeypress.bind(this);
  }

  /**
   * Initializes terminal, hooks up listeners, and starts rendering loop.
   */
  start() {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      this.isRawModeActive = true;
    }
    process.stdin.resume();
    process.stdin.on('keypress', this.onKeypress);

    process.stdout.write(C.hideCursor);
    process.stdout.write(C.clearScreen);

    // Listen to logger entries for real-time status output and log cache
    logger.on('entry', ({ level, message, timestamp, raw }) => {
      const time = timestamp.split('T')[1].slice(0, 8);
      this.lastLogLevel = level;
      this.lastLogTimestamp = time;
      this.lastLogMessage = message;
      // Cache for in-memory log viewer
      if (raw) {
        this.logEntries.push(raw);
        if (this.logEntries.length > this.maxLogEntries) this.logEntries.shift();
      }
    });

    // Listen to combat execution results to guarantee order status is NEVER overwritten by ticks/logs
    this.executionEngine.on('execution_result', (result) => {
      this.lastExecutionResult = result;
      if (this.mode === 'HUD') {
        this.needsRender = true;
      }
    });

    // Subscribe to state updates (dirty-flag, not immediate render)
    this.stateManager.on('state_updated', () => {
      if (this.mode === 'HUD') {
        this.needsRender = true;
      }
    });

    // Render loop at ~10 FPS (only when dirty)
    this.renderInterval = setInterval(() => {
      if (this.needsRender) {
        this.needsRender = false;
        this.render();
      }
    }, 100);

    this.render();
  }

  /**
   * Records a manual log entry.
   * @param {'info' | 'success' | 'warn' | 'error'} level
   * @param {string} message
   */
  setLog(level, message) {
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    this.lastLogLevel = level;
    this.lastLogTimestamp = time;
    this.lastLogMessage = message;
  }

  /**
   * Formats a betslip status badge.
   * In 'ttl' mode shows seconds until betslip expiry, in 'limit' mode shows the per-outcome
   * stake limit instead (freshness is still conveyed by color: green → yellow → red).
   * @param {Object} slip
   * @param {number} livePrice
   * @param {'ttl' | 'limit'} [display='ttl']
   * @returns {string}
   */
  formatSlipStatus(slip, livePrice, display = 'ttl') {
    const allowed = this.stateManager?.getAllowedBookies ? this.stateManager.getAllowedBookies() : null;
    const hasStrictAllowed = allowed && allowed.size > 0;

    let effPrice = 0;
    if (slip) {
      if (slip.priceSource === 'CLOSED' || (hasStrictAllowed && !slip.bookiePrice && slip.currentPrice <= 1.0)) {
        effPrice = 0;
      } else if (typeof slip.currentPrice === 'number' && slip.currentPrice > 1.0) {
        effPrice = slip.currentPrice;
      } else if (typeof slip.bookiePrice === 'number' && slip.bookiePrice > 1.0) {
        effPrice = slip.bookiePrice;
      } else if (!hasStrictAllowed && typeof livePrice === 'number' && livePrice > 1.0) {
        effPrice = livePrice;
      } else if (typeof slip.price === 'number' && slip.price > 1.0) {
        effPrice = slip.price;
      }
    } else if (typeof livePrice === 'number') {
      effPrice = (!hasStrictAllowed && livePrice > 1.0) ? livePrice : 0;
    }
    const priceStr = effPrice > 0 ? effPrice.toFixed(2) : '0.00';

    if (slip && slip.isArming) {
      const armStr = effPrice > 1.0 ? priceStr : `${C.bold}${C.red}0.00${C.yellow}`;
      return `${C.yellow}${armStr} (Взведение...)${C.reset}`;
    }

    if (!slip) {
      return `${C.bold}${C.red}${priceStr} (NO SLIP)${C.reset}`;
    }

    if (slip.betslipId) {
      const now = Date.now();
      const remainingSec = Math.max(0, Math.round((slip.expiryTs - now) / 1000));
      const isLimitMode = display === 'limit';

      if (effPrice <= 1.0) {
        return isLimitMode
          ? `${C.bold}${C.red}0.00 (ЗАКРЫТО)${C.reset}`
          : `${C.bold}${C.red}0.00 (ЗАКРЫТО ${remainingSec}s)${C.reset}`;
      }

      let color;
      let ttlTag;
      if (remainingSec > 5) {
        color = C.green;
        ttlTag = `OK ${remainingSec}s`;
      } else if (remainingSec > 0) {
        color = C.yellow;
        ttlTag = `WARN ${remainingSec}s`;
      } else {
        return `${C.red}${priceStr} (EXPIRED)${C.reset}`;
      }

      if (isLimitMode) {
        return `${color}${priceStr} (${this.formatOutcomeLimit(slip)}${color})${C.reset}`;
      }
      return `${color}${priceStr} (${ttlTag})${C.reset}`;
    }

    return `${C.bold}${C.red}${priceStr} (NO SLIP)${C.reset}`;
  }

  /**
   * Formats per-outcome stake limit. Highlighted when the current stake exceeds it
   * (the stake will be cut down to this limit on fire).
   * @param {Object} slip
   * @returns {string}
   */
  formatOutcomeLimit(slip) {
    const limit = slip && typeof slip.maxStake === 'number' && slip.maxStake > 0 ? slip.maxStake : 0;
    if (limit <= 0) {
      return `${C.dim}лимит —${C.reset}`;
    }
    const limitStr = `€${Math.floor(limit)}`;
    const stake = this.stateManager?.activeStake || 0;
    return stake > limit
      ? `${C.bold}${C.bgYellow}${C.black}${limitStr}↓${C.reset}`
      : limitStr;
  }

  /**
   * Main render dispatch method.
   */
  render() {
    if (this.mode === 'HUD') {
      this.renderHud();
    } else if (this.mode === 'MENU') {
      this.renderMenu();
    } else if (this.mode === 'COUPONS') {
      this.renderCouponsMenu();
    } else if (this.mode === 'LINES') {
      this.renderLinesMenu();
    } else if (this.mode === 'LOGS') {
      this.renderLogs();
    } else if (this.mode === 'INPUT_STAKE') {
      this.renderStakeInput();
    } else if (this.mode === 'HISTORY') {
      this.renderHistory();
    }
  }

  /**
   * Renders combat duty HUD (flicker-free multi-line layout with permanent order banner).
   */
  renderHud() {
    const activeEvent = this.stateManager.getActiveEvent();
    const score = this.stateManager.liveScore;
    const stake = this.stateManager.activeStake;
    const currency = this.config.defaultCurrency || 'EUR';
    const maxLimit = this.stateManager.getMaxStakeLimit();

    const armedList = this.stateManager.getArmedMatchesList();
    const armedCount = armedList.length;
    let armedIndex = 0;
    if (armedCount > 0 && this.stateManager.activeEventId) {
      const idx = armedList.findIndex(m => m.eventId === this.stateManager.activeEventId);
      if (idx !== -1) armedIndex = idx + 1;
    }

    // 1. Period Badge, Market Mode Badge, and Match Badge
    const periodBadge = this.stateManager.activePeriod === 'HT'
      ? `${C.bold}${C.bgYellow}${C.black} [1-Й ТАЙМ (HT)] ${C.reset}`
      : `${C.bold}${C.bgGreen}${C.black} [ВЕСЬ МАТЧ (FT)] ${C.reset}`;

    const modeBadge = this.stateManager.activeMarketMode === 'ITB'
      ? `${C.bold}${C.bgMagenta}${C.white} [ИТБ ХОЗ/ГОС] ${C.reset}`
      : `${C.bold}${C.bgBlue}${C.white} [1X2 + ТОТАЛ] ${C.reset}`;

    let matchBadge;
    if (activeEvent && activeEvent.homeTeam && activeEvent.homeTeam !== 'Home') {
      const min = activeEvent.minute ? ` ${activeEvent.minute}` : '';
      const poolTag = armedCount > 1 ? ` (${armedIndex}/${armedCount})` : '';
      matchBadge = `${C.bold}${C.bgBlue} ARMED${poolTag}: ${activeEvent.homeTeam} ${score.home}-${score.away} ${activeEvent.awayTeam}${min} ${C.reset} ${periodBadge} ${modeBadge}`;
    } else {
      matchBadge = `${C.bold}${C.bgRed} NO MATCH SELECTED (Press 'M' for menu) ${C.reset} ${periodBadge} ${modeBadge}`;
    }

    // 2. Slip status for active combat period & market mode
    const overSlip = this.stateManager.armedBetslips.OVER;
    const activeLine = this.stateManager.liveOdds.totalLine;
    const lineLabel = this.stateManager.activePeriod === 'HT' ? `HT_O(${activeLine})` : `O(${activeLine})`;
    const overStatus = this.formatSlipStatus(overSlip, this.stateManager.liveOdds.totalOver, 'limit');

    let slot2Label = '1';
    let slot2Status = '';
    let slot3Label = '2';
    let slot3Status = '';

    if (this.stateManager.activeMarketMode === 'ITB') {
      const itb1Slip = this.stateManager.armedBetslips.ITB1;
      const itb2Slip = this.stateManager.armedBetslips.ITB2;
      const itb1Line = this.stateManager.liveOdds.itb1Line || (this.stateManager.activePeriod === 'HT' ? '0.5' : '1.5');
      const itb2Line = this.stateManager.liveOdds.itb2Line || (this.stateManager.activePeriod === 'HT' ? '0.5' : '1.5');
      slot2Label = `ИТБ1(${itb1Line})`;
      slot2Status = this.formatSlipStatus(itb1Slip, this.stateManager.liveOdds.itb1Over, 'limit');
      slot3Label = `ИТБ2(${itb2Line})`;
      slot3Status = this.formatSlipStatus(itb2Slip, this.stateManager.liveOdds.itb2Over, 'limit');
    } else {
      const homeSlip = this.stateManager.armedBetslips.HOME;
      const awaySlip = this.stateManager.armedBetslips.AWAY;
      slot2Label = '1 (П1)';
      slot2Status = this.formatSlipStatus(homeSlip, this.stateManager.liveOdds.winHome, 'limit');
      slot3Label = '2 (П2)';
      slot3Status = this.formatSlipStatus(awaySlip, this.stateManager.liveOdds.winAway, 'limit');
    }

    // 3. Network health badges
    const h2Rtt = this.http2Client.lastPingRttMs;
    const h2Badge = this.http2Client.isConnected
      ? `${C.green}H2: ${h2Rtt}ms${C.reset}`
      : `${C.red}H2: OFF${C.reset}`;

    const wsRtt = this.wsFeed.lastWsRttMs;
    const wsBadge = this.wsFeed.isConnected
      ? `${C.green}WS: ${wsRtt}ms${C.reset}`
      : `${C.red}WS: OFF${C.reset}`;

    // 4. Stake display with account-level cap (per-outcome limits are shown on the odds line)
    const limitDisplay = maxLimit > 0 ? ` (Баланс: €${Math.floor(maxLimit)})` : '';
    const stakeBadge = `${C.bold}Ставка: ${currency} ${stake}${limitDisplay}${C.reset}`;

    // 5. Line 1: Match info, period/mode. Line 2: stake, network
    const hudLine1 = `${matchBadge}`;
    const hudLine2 = `${stakeBadge} | ${h2Badge} | ${wsBadge}`;

    // 5b. Line 2: Active combat odds with per-outcome stake limits
    const oddsLine = `${C.bold}Кэфы:${C.reset} ${lineLabel}: ${overStatus} | ${slot2Label}: ${slot2Status} | ${slot3Label}: ${slot3Status}`;

    // 6. Line 2: Alternate markets & period preview
    let altPeriodLine;
    const p = this.stateManager.activePeriod;
    const odds = p === 'HT' ? this.stateManager.liveOdds.ht : this.stateManager.liveOdds.ft;

    if (this.stateManager.activeMarketMode === 'MAIN') {
      const itb1Str = odds.itb1Over > 1.0 ? odds.itb1Over.toFixed(2) : `${C.bold}${C.red}0.00${C.reset}`;
      const itb2Str = odds.itb2Over > 1.0 ? odds.itb2Over.toFixed(2) : `${C.bold}${C.red}0.00${C.reset}`;
      altPeriodLine = `${C.dim}Линия ИТБ (${p}):${C.reset} ИТБ1(${odds.itb1Line || '1.5'}): ${itb1Str} | ИТБ2(${odds.itb2Line || '1.5'}): ${itb2Str}  ${C.yellow}['I' — режим ИТБ, '6'/'7' — прямой удар ИТБ1/2, 'T' — тайм]${C.reset}`;
    } else {
      const hStr = odds.winHome > 1.0 ? odds.winHome.toFixed(2) : `${C.bold}${C.red}0.00${C.reset}`;
      const dStr = odds.winDraw > 1.0 ? odds.winDraw.toFixed(2) : `${C.bold}${C.red}0.00${C.reset}`;
      const aStr = odds.winAway > 1.0 ? odds.winAway.toFixed(2) : `${C.bold}${C.red}0.00${C.reset}`;
      altPeriodLine = `${C.dim}Линия 1X2 (${p}):${C.reset} 1: ${hStr} | X: ${dStr} | 2: ${aStr}  ${C.yellow}['I' — режим 1X2, 'T' — тайм]${C.reset}`;
    }

    // 7. Line 3: Persistent Combat Order Banner (tracks full lifecycle: in-flight -> done / rejected)
    let orderLine;
    if (this.lastExecutionResult) {
      const res = this.lastExecutionResult;
      const cleanStake = typeof res.stake === 'number'
        ? res.stake
        : (Array.isArray(res.stake) ? res.stake[1] : res.stake);
      const cutTag = typeof res.requestedStake === 'number' && res.requestedStake > cleanStake
        ? ` (срез с €${res.requestedStake} по лимиту)`
        : '';

      if (res.status === 'IN_FLIGHT') {
        orderLine = `${C.bold}${C.bgYellow}${C.black} [В СТАКАНЕ БК (IN-FLIGHT)...] ${res.targetKey} | Лимит: ${res.limitPrice ? res.limitPrice.toFixed(2) : '-.--'} | Ставка: €${cleanStake}${cutTag} | ID: ${res.orderId} | Ожидание подтверждения БК... [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'DONE') {
        const bookieTag = res.bookie ? ` ${res.bookie}` : '';
        const durTag = res.fillTimeSec ? ` (${res.fillTimeSec}s)` : '';
        const partialTag = res.partial ? ` ЧАСТИЧНО из €${res.sentStake}` : '';
        orderLine = `${C.bold}${C.bgGreen}${C.white} [СТАВКА ПРИНЯТА (DONE)${bookieTag}] ${res.targetKey} @ кэф ${res.gotPrice ? res.gotPrice.toFixed(2) : '-.--'} | Ставка: €${cleanStake}${partialTag}${cutTag} | ID: ${res.orderId}${durTag} [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'REJECTED') {
        const reasonTag = (res.reason || 'TIMED_OUT').toUpperCase();
        const durTag = res.durationSec ? ` (${res.durationSec}s)` : '';
        orderLine = `${C.bold}${C.bgRed}${C.white} [СТАВКА ОТКЛОНЕНА БК (${reasonTag})] ${res.targetKey} | Причина: ${res.reason || 'timed_out'} | ID: ${res.orderId}${durTag} [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'EVENT_SCORE') {
        const durTag = res.durationSec ? ` (${res.durationSec}s)` : '';
        orderLine = `${C.bold}${C.bgRed}${C.white} [СТАВКА АННУЛИРОВАНА (EVENT_SCORE)] ${res.targetKey} | Счёт изменился во время обработки | ID: ${res.orderId}${durTag} [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'SUCCESS') {
        const simTag = res.dryRun ? ' [DRY-RUN]' : '';
        orderLine = `${C.bold}${C.bgGreen}${C.white} [ОРДЕР РАЗМЕЩЕН${simTag}] ${res.targetKey} @ кэф ${res.limitPrice ? res.limitPrice.toFixed(2) : '-.--'} (Live: ${res.livePrice ? res.livePrice.toFixed(2) : '-.--'}) | ID: ${res.orderId || 'OK'} | RTT: ${res.rttMs}ms | Ставка: €${cleanStake}${cutTag} [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'FAILED') {
        orderLine = `${C.bold}${C.bgRed}${C.white} [СБОЙ ОТПРАВКИ HTTP ${res.httpStatus || 'ERR'}] ${res.targetKey} | Ошибка: ${res.reason || res.message} | RTT: ${res.rttMs}ms [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'ABORT') {
        orderLine = `${C.bold}${C.bgYellow}${C.black} [ОТМЕНА ВЫСТРЕЛА] ${res.targetKey} | ${res.message || res.reason} [${res.timestamp}] ${C.reset}`;
      } else if (res.status === 'EXCEPTION') {
        orderLine = `${C.bold}${C.bgRed}${C.white} [СЕТЕВОЕ ИСКЛЮЧЕНИЕ] ${res.targetKey} | ${res.reason || res.message} | RTT: ${res.rttMs}ms [${res.timestamp}] ${C.reset}`;
      } else {
        orderLine = `${C.dim}[ОРДЕР]: Статус неизвестен [${res.timestamp}]${C.reset}`;
      }
    } else {
      const modeKeyGuide = this.stateManager.activeMarketMode === 'ITB' ? '1=ИТБ1, 2=ИТБ2' : '1=П1, 2=П2';
      orderLine = `${C.dim}[ОРДЕР]: В боевом дежурстве. SPACE=Тотал, ${modeKeyGuide}, 6/7=Прямой удар ИТБ1/ИТБ2, 3/4/5=Удар HT.${C.reset}`;
    }

    // 8. Line 4: System Event Log
    let logLine = '';
    if (this.lastLogMessage) {
      let color = C.white;
      if (this.lastLogLevel === 'success') color = C.green;
      else if (this.lastLogLevel === 'error') color = C.red;
      else if (this.lastLogLevel === 'warn') color = C.yellow;

      logLine = `${C.dim}[СИСТЕМА ${this.lastLogTimestamp}]${C.reset} ${color}${this.lastLogMessage.slice(0, 130)}${C.reset}`;
    } else {
      logLine = `${C.dim}[СИСТЕМА]: Инициализация фоновых процессов...${C.reset}`;
    }

    // 9. Bet History (Recent 3 bets + Session PnL)
    const historyLines = [];
    const recentBets = (this.stateManager.ordersHistory || []).slice(0, 3);
    if (recentBets.length > 0) {
      for (const b of recentBets) {
        const id = String(b.order_id).slice(-6);
        const match = b.event_info ? `${b.event_info.home_team} vs ${b.event_info.away_team}` : 'Unknown';
        const market = b.bet_type_description || b.bet_type || 'Market';
        const price = b.effPrice ? b.effPrice.toFixed(2) : '-';
        const st = b.effStake || 0;
        
        let statusColor = C.white;
        let resultLabel = b.label || b.normalizedStatus;
        if (b.normalizedStatus === 'WON') {
          statusColor = C.green;
          resultLabel = `ВЫИГРЫШ: +€${b.pnl.toFixed(2)}`;
        } else if (b.normalizedStatus === 'LOST') {
          statusColor = C.red;
          resultLabel = `ПРОИГРЫШ: -€${Math.abs(b.pnl).toFixed(2)}`;
        } else if (b.normalizedStatus === 'VOID') {
          statusColor = C.cyan;
          resultLabel = `ВОЗВРАТ: €0.00`;
        } else if (b.normalizedStatus === 'REJECTED_GOAL') {
          statusColor = `${C.bgRed}${C.yellow}`;
          resultLabel = `ОТКЛОНЕНО (ГОЛ/СЧЕТ)`;
        } else if (b.normalizedStatus === 'IN_PLAY') {
          statusColor = C.yellow;
          resultLabel = `В ИГРЕ`;
        } else if (b.normalizedStatus === 'FAILED') {
          statusColor = C.red;
          resultLabel = b.label || `ОШИБКА (${b.close_reason || 'failed'})`;
        } else if (b.normalizedStatus === 'PENDING') {
          statusColor = C.dim;
          resultLabel = `В ПРОЦЕССЕ`;
        }

        historyLines.push(`${C.dim}[#${id}]${C.reset} ${match} | ${market} @ ${price} | €${st} -> ${statusColor}[${resultLabel}]${C.reset}`);
      }
    } else {
      historyLines.push(`${C.dim}Нет недавних ставок.${C.reset}`);
    }

    const sm = this.stateManager.sessionMetrics || {};
    const pnlStr = sm.totalProfitLoss > 0 ? `+€${sm.totalProfitLoss.toFixed(2)}` : `€${(sm.totalProfitLoss || 0).toFixed(2)}`;
    const pnlColor = sm.totalProfitLoss > 0 ? C.green : (sm.totalProfitLoss < 0 ? C.red : C.white);
    const sessionItoStr = `${C.bold}PnL Сессии: ${pnlColor}${pnlStr}${C.reset} | W: ${sm.wonCount || 0} | L: ${sm.lostCount || 0} | V: ${sm.voidCount || 0}`;
    
    // Join history bets to be concise, e.g. 2 lines if possible, or 3
    const betsOutput = historyLines.map(l => `${C.clearLine}${l}\n`).join('');

    // 10. Line 5: Hotkeys Guide
    const mMode = this.stateManager.activeMarketMode;
    const pLabel = this.stateManager.activePeriod;
    const hotkeysLine = `${C.cyan}[SPACE=ТОТАЛ, 1/2=УДАР, 6/7=ИТБ, L=ЛИНИИ, </>=СМЕНА ТБ, I=РЕЖИМ, T=ТАЙМ, 3/4/5=HT, B=ИСТОРИЯ, M=МЕНЮ, TAB=ЛОГИ, Q=ВЫХОД]${C.reset}`;

    process.stdout.write(
      `${C.cursorHome}` +
      `${C.clearLine}${hudLine1}\n` +
      `${C.clearLine}\n` +
      `${C.clearLine}${hudLine2}\n` +
      `${C.clearLine}\n` +
      `${C.clearLine}\n` +
      `${C.clearLine}${oddsLine}\n` +
      `${C.clearLine}\n` +
      `${C.clearLine}${altPeriodLine}\n` +
      `${C.clearLine}\n` +
      `${betsOutput}` +
      `${C.clearLine}${sessionItoStr}\n` +
      `${C.clearLine}\n` +
      `${C.clearLine}${orderLine}\n` +
      `${C.clearLine}${logLine}\n` +
      `${C.clearLine}${hotkeysLine}\n`
    );
  }

  /**
   * Renders the quick coupons manager menu.
   */
  renderCouponsMenu() {
    const armedList = this.stateManager.getArmedMatchesList();

    let output = `${C.clearScreen}`;
    output += `${C.bold}${C.magenta}=== ВЗВЕДЕННЫЕ КУПОНЫ И МАТЧИ (PRE-ARMED POOL) ===${C.reset}\n`;
    output += `Всего в пуле боевой готовности: ${C.bold}${armedList.length}${C.reset} матчей.\n`;
    output += `${C.dim}Управление: ВВЕРХ/ВНИЗ или [1-9] — выбрать, ENTER/ПРОБЕЛ — сделать активным,\n`;
    output += `'D' — удалить купон, 'Shift+D' — удалить ВСЕ, ESC/'C' — вернуться в HUD.${C.reset}\n\n`;

    if (armedList.length === 0) {
      output += `${C.yellow}Пул предвзведенных купонов пуст. Выберите матч в меню (нажмите 'M') для взведения.${C.reset}\n`;
    } else {
      for (let i = 0; i < armedList.length; i++) {
        const item = armedList[i];
        const isSelected = i === this.couponsSelectedIndex;
        const prefix = isSelected ? `${C.bgGreen}${C.bold} > [${i + 1}] ` : `   [${i + 1}] `;
        const resetSuffix = isSelected ? `${C.reset}` : '';

        const activeTag = item.isActive ? `${C.green}${C.bold}[АКТИВЕН ДЛЯ БОЯ]${C.reset} ` : '';
        const score = `${item.score.home}:${item.score.away}`;
        const min = item.minute ? ` (${item.minute})` : '';

        const periodTag = item.slips?.period === 'HT'
          ? `${C.bold}${C.yellow}[1-й ТАЙМ]${C.reset} `
          : `${C.bold}${C.cyan}[МАТЧ (FT)]${C.reset} `;

        const modeTag = item.slips?.marketMode === 'ITB'
          ? `${C.bold}${C.magenta}[ИТБ]${C.reset} `
          : `${C.bold}${C.blue}[1X2]${C.reset} `;

        const overStatus = this.formatSlipStatus(item.slips.OVER, item.slips.OVER?.currentPrice);
        let secondLineSlips = '';
        if (item.slips?.marketMode === 'ITB') {
          const itb1Status = this.formatSlipStatus(item.slips.ITB1, item.slips.ITB1?.currentPrice);
          const itb2Status = this.formatSlipStatus(item.slips.ITB2, item.slips.ITB2?.currentPrice);
          secondLineSlips = `O: ${overStatus} | ИТБ1: ${itb1Status} | ИТБ2: ${itb2Status}`;
        } else {
          const homeStatus = this.formatSlipStatus(item.slips.HOME, item.slips.HOME?.currentPrice);
          const awayStatus = this.formatSlipStatus(item.slips.AWAY, item.slips.AWAY?.currentPrice);
          secondLineSlips = `O: ${overStatus} | 1: ${homeStatus} | 2: ${awayStatus}`;
        }

        output += `${prefix}${activeTag}${periodTag}${modeTag}${item.homeTeam} ${score} ${item.awayTeam}${min} [ID: ${item.eventId.slice(-12)}]${resetSuffix}\n`;
        output += `       ${secondLineSlips}\n\n`;
      }
    }

    process.stdout.write(output);
  }

  /**
   * Renders the interactive Total Line Selection Menu.
   */
  renderLinesMenu() {
    const isHt = this.stateManager.activePeriod === 'HT';
    const pOdds = isHt ? this.stateManager.liveOdds.ht : this.stateManager.liveOdds.ft;
    const isItb = this.stateManager.activeMarketMode === 'ITB';

    let availableLines = pOdds.totalLines || [];
    let currentLine = pOdds.totalLine;
    let title = isHt ? 'ВЫБОР ЗНАЧЕНИЯ ТОТАЛА (1-Й ТАЙМ / HT)' : 'ВЫБОР ЗНАЧЕНИЯ ТОТАЛА (МАТЧ / FT)';

    let output = `${C.clearScreen}`;
    output += `${C.bold}${C.cyan}=== ${title} ===${C.reset}\n`;
    output += `Текущая активная линия: ${C.bold}${C.green}Over ${currentLine}${C.reset}\n`;
    output += `${C.dim}Стрелки ВВЕРХ/ВНИЗ или [1-9] — выбрать линию, ENTER/ПРОБЕЛ — подтвердить и взвести купон,\n`;
    output += `'L' или ESC — вернуться в боевой HUD.${C.reset}\n\n`;

    if (availableLines.length === 0) {
      // Generate synthetic standard step lines if feed hasn't provided multi-line offers yet
      const curNum = parseFloat(currentLine) || (isHt ? 0.5 : 2.5);
      const synth = [];
      for (let offset = -2; offset <= 3; offset++) {
        const val = curNum + offset * 0.5;
        if (val >= 0.5) {
          synth.push({
            totalLine: val.toFixed(1),
            rawTotalLineIndex: Math.round(val * 4),
            totalOver: val === curNum ? pOdds.totalOver : 0,
            totalUnder: val === curNum ? pOdds.totalUnder : 0
          });
        }
      }
      availableLines = synth;
    }

    if (this.linesSelectedIndex >= availableLines.length) {
      this.linesSelectedIndex = Math.max(0, availableLines.length - 1);
    }

    for (let i = 0; i < availableLines.length; i++) {
      const lineObj = availableLines[i];
      const isSelected = i === this.linesSelectedIndex;
      const isCurrentActive = lineObj.totalLine === currentLine;

      const prefix = isSelected ? `${C.bgGreen}${C.bold} > [${i + 1}] ` : `   [${i + 1}] `;
      const resetSuffix = isSelected ? `${C.reset}` : '';

      const activeBadge = isCurrentActive ? `${C.green}${C.bold} [АКТИВНАЯ ЛИНИЯ]${C.reset}` : '';
      const overStr = lineObj.totalOver > 1.0 ? `${C.bold}${lineObj.totalOver.toFixed(2)}${C.reset}` : `${C.dim}0.00${C.reset}`;
      const underStr = lineObj.totalUnder > 1.0 ? `${lineObj.totalUnder.toFixed(2)}` : '0.00';

      output += `${prefix}Тотал ${lineObj.totalLine.padEnd(5)} | ТБ (Over): ${overStr.padEnd(14)} | ТМ (Under): ${underStr.padEnd(6)}${activeBadge}${resetSuffix}\n`;
    }

    output += `\n${C.dim}Быстрые клавиши в HUD: '<' / '>' — переключение линии на лету без меню.${C.reset}\n`;
    process.stdout.write(output);
  }

  /**
   * Renders the interactive match selection menu.
   */
  renderMenu() {
    let { list, totalCount, liveCount } = this.stateManager.getSoccerList(this.menuFilterMode);
    
    if (this.menuSearchQuery) {
      const q = this.menuSearchQuery.toLowerCase();
      list = list.filter(m => 
        (m.homeTeam && m.homeTeam.toLowerCase().includes(q)) || 
        (m.awayTeam && m.awayTeam.toLowerCase().includes(q))
      );
    }
    
    this.menuMatches = list;

    let output = `${C.clearScreen}`;
    output += `${C.bold}${C.blue}=== ВЫБОР LIVE-МАТЧА ДЛЯ ДЕЖУРСТВА ===${C.reset}\n`;
    output += `В фиде: ${C.bold}${totalCount}${C.reset} | Live: ${C.green}${C.bold}${liveCount}${C.reset} | Режим: ${C.bold}[${this.menuFilterMode === 'LIVE' ? 'ТОЛЬКО LIVE' : 'ВСЕ МАТЧИ'}]${C.reset}\n`;
    output += `${C.dim}Поиск: просто начните печатать название. ESC — очистить/выйти. CTRL+L — сменить фильтр. ENTER — выбрать.${C.reset}\n`;
    output += `> ${C.cyan}${this.menuSearchQuery || '...'} ${C.reset}\n\n`;

    const totalMatches = this.menuMatches.length;
    const pageSize = 18;

    if (this.menuSelectedIndex >= totalMatches) {
      this.menuSelectedIndex = Math.max(0, totalMatches - 1);
    }

    let startIndex = 0;
    if (this.menuSelectedIndex >= pageSize) {
      startIndex = Math.min(
        this.menuSelectedIndex - Math.floor(pageSize / 2),
        totalMatches - pageSize
      );
    }
    startIndex = Math.max(0, startIndex);
    const endIndex = Math.min(totalMatches, startIndex + pageSize);

    if (totalMatches === 0) {
      output += `${C.yellow}Матчей не найдено. Ожидание данных от WebSocket фида... (Лог пишется в terminal.log)${C.reset}\n`;
    } else {
      for (let i = startIndex; i < endIndex; i++) {
        const m = this.menuMatches[i];
        const isSelected = i === this.menuSelectedIndex;
        const prefix = isSelected ? `${C.bgGreen}${C.bold} > [${i + 1}] ` : `   [${i + 1}] `;
        const resetSuffix = isSelected ? `${C.reset}` : '';

        const statusTag = m.isLive
          ? `${C.green}[LIVE ${m.minute || ''}]${C.reset}`
          : `${C.dim}[${m.startTs ? m.startTs.slice(11, 16) + ' UTC' : 'Pre'}]${C.reset}`;

        let statusBadge = '';
        if (m.lastOrder) {
          statusBadge = `${C.bold}${C.bgGreen}${C.white} [ОТРАБОТАН: ${m.lastOrder.targetKey} #${m.lastOrder.orderId}] ${C.reset} `;
        } else if (m.isActive) {
          statusBadge = `${C.bold}${C.bgBlue}${C.white} [НА ДЕЖУРСТВЕ] ${C.reset} `;
        } else if (m.hasArmed) {
          statusBadge = `${C.magenta}[В ПУЛЕ]${C.reset} `;
        }

        const score = `${m.score.home}:${m.score.away}`;
        const oddsInfo = m.odds && (m.odds.totalOver > 0 || m.odds.winHome > 0)
          ? `| 1: ${(m.odds.winHome || 0).toFixed(2)} | 2: ${(m.odds.winAway || 0).toFixed(2)} | O(${m.odds.totalLine}): ${(m.odds.totalOver || 0).toFixed(2)}`
          : '';

        output += `${prefix}${statusTag} ${statusBadge}${m.homeTeam} ${score} ${m.awayTeam} (${m.competition}) ${oddsInfo}${resetSuffix}\n`;
      }

      output += `\n${C.cyan}Показаны матчи ${startIndex + 1}–${endIndex} из ${totalMatches} | Выбран: #${this.menuSelectedIndex + 1}${C.reset}\n`;
      output += `${C.dim}Навигация: ВВЕРХ/ВНИЗ, PgUp/PgDn (шаг 10), Home/End, или ввод номера + ENTER${C.reset}\n`;
    }

    if (this.menuInputBuffer) {
      output += `\n${C.cyan}Ввод номера матча: ${this.menuInputBuffer}_${C.reset}\n`;
    }

    process.stdout.write(output);
  }

  /**
   * Renders the built-in diagnostic log viewer using in-memory cache (no disk I/O).
   */
  renderLogs() {
    let output = `${C.clearScreen}`;
    output += `${C.bold}${C.magenta}=== ДИАГНОСТИЧЕСКИЙ ЖУРНАЛ СОБЫТИЙ ===${C.reset}\n`;
    output += `${C.dim}Нажмите 'ESC' или 'TAB' для возврата в боевой HUD.${C.reset}\n\n`;

    if (this.logEntries.length === 0) {
      output += `${C.yellow}Журнал пока пуст. Записи появятся по мере работы терминала.${C.reset}\n`;
    } else {
      for (const line of this.logEntries) {
        if (!line) continue;
        let color = C.white;
        if (line.includes('[SUCCESS]')) color = C.green;
        else if (line.includes('[ERROR]')) color = C.red;
        else if (line.includes('[WARN]')) color = C.yellow;
        else if (line.includes('[DEBUG]')) color = C.dim;

        output += `${color}${line.trimEnd()}${C.reset}\n`;
      }
    }

    output += `\n${C.dim}Всего записей в кеше: ${this.logEntries.length}${C.reset}\n`;

    process.stdout.write(output);
  }

  /**
   * Renders the inline prompt for manual stake entry with limits.
   */
  renderStakeInput() {
    process.stdout.write(C.showCursor);
    const currency = this.config.defaultCurrency || 'EUR';
    const current = this.stateManager.activeStake;
    const maxLimit = this.stateManager.getMaxStakeLimit();

    let prompt = `${C.clearScreen}${C.bold}${C.cyan}=== УПРАВЛЕНИЕ СУММОЙ СТАВКИ ===${C.reset}\n`;
    prompt += `Текущая ставка: ${currency} ${current} | Доступный лимит брокера/баланса: ${C.green}${C.bold}${currency} ${maxLimit}${C.reset}\n`;
    prompt += `Введите новую сумму в ${currency} [Enter=ОК, X=Макс (${maxLimit}), Esc=Отмена]:\n> ${this.stakeInputBuffer}`;

    process.stdout.write(prompt);
  }

  /**
   * Dispatches keyboard input events.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleKeypress(str, key) {
    if (!key) return;

    // Global exit: Ctrl+C
    if (key.ctrl && key.name === 'c') {
      this.destroy();
      process.exit(0);
    }

    if (this.mode === 'HUD') {
      this.handleHudKeypress(str, key);
    } else if (this.mode === 'MENU') {
      this.handleMenuKeypress(str, key);
    } else if (this.mode === 'COUPONS') {
      this.handleCouponsKeypress(str, key);
    } else if (this.mode === 'LINES') {
      this.handleLinesKeypress(str, key);
    } else if (this.mode === 'LOGS') {
      this.handleLogsKeypress(str, key);
    } else if (this.mode === 'INPUT_STAKE') {
      this.handleStakeInputKeypress(str, key);
    } else if (this.mode === 'HISTORY') {
      this.handleHistoryKeypress(str, key);
    }
  }

  /**
   * Key handler for Combat HUD.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleHudKeypress(str, key) {
    if (key.name === 'q') {
      this.destroy();
      process.exit(0);
    }

    if (key.name === 'b') {
      this.mode = 'HISTORY';
      this.render();
      return;
    }

    // Toggle log viewer: TAB
    if (key.name === 'tab') {
      this.mode = 'LOGS';
      this.render();
      return;
    }

    // Quick switch between armed matches: '[' and ']' or Left/Right Arrow
    if (str === '[' || key.name === 'left') {
      const switched = this.stateManager.switchPrevArmedMatch();
      if (switched) {
        process.stdout.write(C.clearScreen);
        this.render();
      }
      return;
    }

    if (str === ']' || key.name === 'right') {
      const switched = this.stateManager.switchNextArmedMatch();
      if (switched) {
        process.stdout.write(C.clearScreen);
        this.render();
      }
      return;
    }

    // Open Coupons Quick Manager: 'c' or 'C'
    if (str === 'c' || str === 'C') {
      this.mode = 'COUPONS';
      const armedList = this.stateManager.getArmedMatchesList();
      const currentIdx = armedList.findIndex(m => m.eventId === this.stateManager.activeEventId);
      this.couponsSelectedIndex = currentIdx >= 0 ? currentIdx : 0;
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    // Open Lines Quick Manager: 'l' or 'L'
    if (str === 'l' || str === 'L') {
      this.mode = 'LINES';
      this.linesSelectedIndex = 0;
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    // Step Total Line down/up on the fly: '<' (or ',') and '>' (or '.')
    if (str === '<' || str === ',') {
      this.stateManager.cycleTotalLine(-1, 'OVER').then(() => {
        this.render();
      }).catch(() => {});
      return;
    }

    if (str === '>' || str === '.') {
      this.stateManager.cycleTotalLine(1, 'OVER').then(() => {
        this.render();
      }).catch(() => {});
      return;
    }

    // Disarm current event: 'd'
    if (str === 'd') {
      this.stateManager.disarmActiveEvent();
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    // Disarm ALL events: 'D' (Shift+D) or 'delete' key
    if (str === 'D' || key.name === 'delete') {
      this.stateManager.disarmAll();
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    // Switch to match selection menu
    if (str === 'm' || str === 'M') {
      this.mode = 'MENU';
      this.menuSelectedIndex = 0;
      this.menuInputBuffer = '';
      this.render();
      return;
    }

    // Manual stake input prompt
    if (str === 's' || str === 'S') {
      this.mode = 'INPUT_STAKE';
      this.stakeInputBuffer = '';
      this.render();
      return;
    }

    // Quick MAX stake: 'x' or 'X'
    if (str === 'x' || str === 'X') {
      const maxLimit = this.stateManager.getMaxStakeLimit();
      this.stateManager.setStake(maxLimit);
      this.render();
      return;
    }

    // Stake step increment: '+' or '='
    if (str === '+' || str === '=') {
      this.stateManager.adjustStake(this.stateManager.stakeStep);
      this.render();
      return;
    }

    // Stake step decrement: '-' or '_'
    if (str === '-' || str === '_') {
      this.stateManager.adjustStake(-this.stateManager.stakeStep);
      this.render();
      return;
    }

    // Toggle Period (FT <-> HT): 't' or 'T'
    if (str === 't' || str === 'T') {
      this.stateManager.togglePeriod().then((p) => {
        this.setLog('info', `Боевой период переключен: ${p === 'HT' ? '1-й тайм (HT)' : 'Весь матч (FT)'}`);
        this.render();
      }).catch(() => {});
      return;
    }

    // Toggle Market Mode (MAIN <-> ITB): 'i' or 'I'
    if (str === 'i' || str === 'I') {
      this.stateManager.toggleMarketMode().then((m) => {
        this.setLog('info', `Режим рынков переключен: ${m === 'ITB' ? 'Индивидуальные тоталы (ИТБ1 + ИТБ2)' : 'Основные рынки (1X2 + Тотал)'}`);
        this.render();
      }).catch(() => {});
      return;
    }

    // Direct Individual Over triggers:
    // '6' -> ITB1 (Team 1 Over)
    if (str === '6') {
      if (this.stateManager.activeMarketMode !== 'ITB') {
        this.stateManager.setMarketMode('ITB').then(() => {
          this.setLog('warn', 'Режим рынков переключен на ИТБ. Купоны взводятся, нажмите 6 для удара.');
          this.render();
        }).catch(() => {});
      } else {
        const target = this.stateManager.activePeriod === 'HT' ? 'HT_ITB1' : 'ITB1';
        this.executionEngine.fire(target).catch(() => {});
      }
      return;
    }

    // '7' -> ITB2 (Team 2 Over)
    if (str === '7') {
      if (this.stateManager.activeMarketMode !== 'ITB') {
        this.stateManager.setMarketMode('ITB').then(() => {
          this.setLog('warn', 'Режим рынков переключен на ИТБ. Купоны взводятся, нажмите 7 для удара.');
          this.render();
        }).catch(() => {});
      } else {
        const target = this.stateManager.activePeriod === 'HT' ? 'HT_ITB2' : 'ITB2';
        this.executionEngine.fire(target).catch(() => {});
      }
      return;
    }

    // Direct 1st Half triggers:
    // '3' -> HT_OVER
    if (str === '3') {
      if (this.stateManager.activePeriod !== 'HT') {
        this.stateManager.setPeriod('HT').then(() => {
          this.setLog('warn', 'Период переключен на 1-й тайм (HT). Купоны взводятся, нажмите 3 для удара.');
          this.render();
        }).catch(() => {});
      } else {
        this.executionEngine.fire('HT_OVER').catch(() => {});
      }
      return;
    }

    // '4' -> HT_HOME (MAIN) or HT_ITB1 (ITB)
    if (str === '4') {
      const isItb = this.stateManager.activeMarketMode === 'ITB';
      const target = isItb ? 'HT_ITB1' : 'HT_HOME';
      if (this.stateManager.activePeriod !== 'HT') {
        this.stateManager.setPeriod('HT').then(() => {
          this.setLog('warn', `Период переключен на 1-й тайм (HT). Купоны взводятся, нажмите 4 для удара (${target}).`);
          this.render();
        }).catch(() => {});
      } else {
        this.executionEngine.fire(target).catch(() => {});
      }
      return;
    }

    // '5' -> HT_AWAY (MAIN) or HT_ITB2 (ITB)
    if (str === '5') {
      const isItb = this.stateManager.activeMarketMode === 'ITB';
      const target = isItb ? 'HT_ITB2' : 'HT_AWAY';
      if (this.stateManager.activePeriod !== 'HT') {
        this.stateManager.setPeriod('HT').then(() => {
          this.setLog('warn', `Период переключен на 1-й тайм (HT). Купоны взводятся, нажмите 5 для удара (${target}).`);
          this.render();
        }).catch(() => {});
      } else {
        this.executionEngine.fire(target).catch(() => {});
      }
      return;
    }

    // Combat triggers for currently active period & market mode:
    // ' ' (Space) -> Total Match (OVER / HT_OVER)
    if (key.name === 'space' || str === ' ') {
      const target = this.stateManager.activePeriod === 'HT' ? 'HT_OVER' : 'OVER';
      this.executionEngine.fire(target).catch(() => {});
      return;
    }

    // '1' -> HOME (MAIN) or ITB1 (ITB)
    if (str === '1') {
      const isHt = this.stateManager.activePeriod === 'HT';
      const target = this.stateManager.activeMarketMode === 'ITB'
        ? (isHt ? 'HT_ITB1' : 'ITB1')
        : (isHt ? 'HT_HOME' : 'HOME');
      this.executionEngine.fire(target).catch(() => {});
      return;
    }

    // '2' -> AWAY (MAIN) or ITB2 (ITB)
    if (str === '2') {
      const isHt = this.stateManager.activePeriod === 'HT';
      const target = this.stateManager.activeMarketMode === 'ITB'
        ? (isHt ? 'HT_ITB2' : 'ITB2')
        : (isHt ? 'HT_AWAY' : 'AWAY');
      this.executionEngine.fire(target).catch(() => {});
      return;
    }
  }

  /**
   * Key handler for Armed Coupons Manager.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleCouponsKeypress(str, key) {
    if (key.name === 'escape' || str === 'c' || str === 'C') {
      this.mode = 'HUD';
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    if (key.name === 'tab') {
      this.mode = 'LOGS';
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    if (key.name === 'q') {
      this.destroy();
      process.exit(0);
    }

    const armedList = this.stateManager.getArmedMatchesList();

    if (key.name === 'up') {
      if (this.couponsSelectedIndex > 0) {
        this.couponsSelectedIndex--;
        this.render();
      }
      return;
    }

    if (key.name === 'down') {
      if (this.couponsSelectedIndex < armedList.length - 1) {
        this.couponsSelectedIndex++;
        this.render();
      }
      return;
    }

    // Direct number entry 1-9 to select and activate coupon
    if (/^[1-9]$/.test(str)) {
      const idx = parseInt(str, 10) - 1;
      if (idx >= 0 && idx < armedList.length) {
        this.couponsSelectedIndex = idx;
        this.stateManager.setActiveEvent(armedList[idx].eventId);
        this.mode = 'HUD';
        process.stdout.write(C.clearScreen);
        this.render();
      }
      return;
    }

    // Enter or Space: Activate selected match
    if (key.name === 'return' || key.name === 'enter' || key.name === 'space' || str === ' ') {
      if (armedList.length > 0 && this.couponsSelectedIndex < armedList.length) {
        const selected = armedList[this.couponsSelectedIndex];
        this.stateManager.setActiveEvent(selected.eventId);
        this.mode = 'HUD';
        process.stdout.write(C.clearScreen);
        this.render();
      }
      return;
    }

    // Delete single coupon: 'd' or 'delete' key
    if (str === 'd' || key.name === 'delete') {
      if (armedList.length > 0 && this.couponsSelectedIndex < armedList.length) {
        const toDelete = armedList[this.couponsSelectedIndex];
        this.stateManager.disarmEvent(toDelete.eventId);
        const remaining = this.stateManager.getArmedMatchesList();
        if (this.couponsSelectedIndex >= remaining.length) {
          this.couponsSelectedIndex = Math.max(0, remaining.length - 1);
        }
        this.render();
      }
      return;
    }

    // Delete ALL coupons: 'D' (Shift+D)
    if (str === 'D') {
      this.stateManager.disarmAll();
      this.couponsSelectedIndex = 0;
      this.render();
      return;
    }
  }

  /**
   * Key handler for Total Line Selection Menu.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleLinesKeypress(str, key) {
    if (key.name === 'escape' || str === 'l' || str === 'L') {
      this.mode = 'HUD';
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    if (key.name === 'tab') {
      this.mode = 'LOGS';
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    if (key.name === 'q') {
      this.destroy();
      process.exit(0);
    }

    const isHt = this.stateManager.activePeriod === 'HT';
    const pOdds = isHt ? this.stateManager.liveOdds.ht : this.stateManager.liveOdds.ft;
    let lines = pOdds.totalLines || [];

    if (lines.length === 0) {
      const curNum = parseFloat(pOdds.totalLine) || (isHt ? 0.5 : 2.5);
      const synth = [];
      for (let offset = -2; offset <= 3; offset++) {
        const val = curNum + offset * 0.5;
        if (val >= 0.5) {
          synth.push({
            totalLine: val.toFixed(1),
            rawTotalLineIndex: Math.round(val * 4),
            totalOver: 0,
            totalUnder: 0
          });
        }
      }
      lines = synth;
    }

    if (key.name === 'up') {
      if (this.linesSelectedIndex > 0) {
        this.linesSelectedIndex--;
        this.render();
      }
      return;
    }

    if (key.name === 'down') {
      if (this.linesSelectedIndex < lines.length - 1) {
        this.linesSelectedIndex++;
        this.render();
      }
      return;
    }

    // Direct number entry 1-9 to select line and activate immediately
    if (/^[1-9]$/.test(str)) {
      const idx = parseInt(str, 10) - 1;
      if (idx >= 0 && idx < lines.length) {
        const selected = lines[idx];
        const targetKey = isHt ? 'HT_OVER' : 'OVER';
        this.stateManager.setUserLineOverride(targetKey, selected.totalLine, selected.rawTotalLineIndex).then(() => {
          this.mode = 'HUD';
          process.stdout.write(C.clearScreen);
          this.render();
        }).catch(() => {});
      }
      return;
    }

    // Enter or Space: Activate selected line
    if (key.name === 'return' || key.name === 'enter' || key.name === 'space' || str === ' ') {
      if (lines.length > 0 && this.linesSelectedIndex < lines.length) {
        const selected = lines[this.linesSelectedIndex];
        const targetKey = isHt ? 'HT_OVER' : 'OVER';
        this.stateManager.setUserLineOverride(targetKey, selected.totalLine, selected.rawTotalLineIndex).then(() => {
          this.mode = 'HUD';
          process.stdout.write(C.clearScreen);
          this.render();
        }).catch(() => {});
      }
      return;
    }
  }

  /**
   * Key handler for Match Selection Menu.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleMenuKeypress(str, key) {
    if (key.name === 'escape') {
      if (this.menuSearchQuery && this.menuSearchQuery.length > 0) {
        this.menuSearchQuery = '';
        this.menuSelectedIndex = 0;
        this.render();
        return;
      }
      this.mode = 'HUD';
      this.menuSearchQuery = '';
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    if (key.name === 'tab') {
      this.mode = 'LOGS';
      this.render();
      return;
    }

    if (key.name === 'q' && key.ctrl) {
      this.destroy();
      process.exit(0);
    }

    // Toggle Filter: CTRL+L
    if (key.name === 'l' && key.ctrl) {
      this.menuFilterMode = this.menuFilterMode === 'LIVE' ? 'ALL' : 'LIVE';
      this.menuSelectedIndex = 0;
      this.render();
      return;
    }

    if (key.name === 'backspace') {
      if (this.menuSearchQuery && this.menuSearchQuery.length > 0) {
        this.menuSearchQuery = this.menuSearchQuery.slice(0, -1);
        this.menuSelectedIndex = 0;
        this.render();
      }
      return;
    }

    // Enter: select match and return straight to combat HUD
    if (key.name === 'return' || key.name === 'enter') {
      if (this.menuMatches.length > 0 && this.menuSelectedIndex < this.menuMatches.length) {
        const selected = this.menuMatches[this.menuSelectedIndex];
        this.stateManager.setActiveEvent(selected.eventId);
        this.menuInputBuffer = '';
        this.menuSearchQuery = '';
        this.mode = 'HUD';
        process.stdout.write(C.clearScreen);
        this.render();
      }
      return;
    }

    // Typing search query
    if (str && /^[a-zA-Z0-9 а-яА-ЯёЁ.-]$/.test(str) && !key.ctrl && !key.meta) {
      this.menuSearchQuery = (this.menuSearchQuery || '') + str;
      this.menuSelectedIndex = 0;
      this.render();
      return;
    }

    if (key.name === 'up') {
      if (this.menuSelectedIndex > 0) {
        this.menuSelectedIndex--;
        this.render();
      }
      return;
    }

    if (key.name === 'down') {
      if (this.menuSelectedIndex < this.menuMatches.length - 1) {
        this.menuSelectedIndex++;
        this.render();
      }
      return;
    }

    if (key.name === 'pageup') {
      this.menuSelectedIndex = Math.max(0, this.menuSelectedIndex - 10);
      this.render();
      return;
    }

    if (key.name === 'pagedown') {
      this.menuSelectedIndex = Math.min(this.menuMatches.length - 1, this.menuSelectedIndex + 10);
      this.render();
      return;
    }

    if (key.name === 'home') {
      this.menuSelectedIndex = 0;
      this.render();
      return;
    }

    if (key.name === 'end') {
      this.menuSelectedIndex = Math.max(0, this.menuMatches.length - 1);
      this.render();
      return;
    }

    // Direct match number entry
    if (/^[0-9]$/.test(str)) {
      this.menuInputBuffer += str;
      const num = parseInt(this.menuInputBuffer, 10);
      if (num >= 1 && num <= this.menuMatches.length) {
        this.menuSelectedIndex = num - 1;
      }
      this.render();
      return;
    }

    if (key.name === 'backspace') {
      if (this.menuInputBuffer.length > 0) {
        this.menuInputBuffer = this.menuInputBuffer.slice(0, -1);
        if (this.menuInputBuffer) {
          const num = parseInt(this.menuInputBuffer, 10);
          if (num >= 1 && num <= this.menuMatches.length) {
            this.menuSelectedIndex = num - 1;
          }
        }
        this.render();
      }
      return;
    }


  }

  /**
   * Key handler for Diagnostic Log Viewer.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleLogsKeypress(str, key) {
    if (key.name === 'escape' || key.name === 'tab' || str === 'q' || str === 'm') {
      this.mode = 'HUD';
      process.stdout.write(C.clearScreen);
      this.render();
    }
  }

  /**
   * Key handler for Stake Input dialogs.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleStakeInputKeypress(str, key) {
    if (key.name === 'escape') {
      this.mode = 'HUD';
      process.stdout.write(C.hideCursor);
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    // Shortcut: 'x' or 'X' to set max limit
    if (str === 'x' || str === 'X') {
      const maxLimit = this.stateManager.getMaxStakeLimit();
      this.stakeInputBuffer = String(maxLimit);
      this.render();
      return;
    }

    if (key.name === 'return' || key.name === 'enter') {
      const val = parseFloat(this.stakeInputBuffer);
      if (!Number.isNaN(val) && val > 0) {
        this.stateManager.setStake(val);
      }

      this.mode = 'HUD';
      process.stdout.write(C.hideCursor);
      process.stdout.write(C.clearScreen);
      this.render();
      return;
    }

    if (key.name === 'backspace') {
      this.stakeInputBuffer = this.stakeInputBuffer.slice(0, -1);
      this.render();
      return;
    }

    // Allow digits and single dot
    if (/^[0-9.]$/.test(str)) {
      if (str === '.' && this.stakeInputBuffer.includes('.')) {
        return;
      }
      this.stakeInputBuffer += str;
      this.render();
    }
  }

  /**
   * Renders the modal with full bet history.
   */
  renderHistory() {
    let output = `${C.clearScreen}`;
    output += `${C.bold}${C.cyan}=== ПОЛНАЯ ИСТОРИЯ СТАВОК ===${C.reset}\n`;
    output += `${C.dim}ID     | Время (Local) | Матч                   | Маркет         | Кэф    | Ставка | Статус / Исход         | P&L${C.reset}\n`;
    output += `${C.dim}-----------------------------------------------------------------------------------------------------------------------${C.reset}\n`;

    const orders = this.stateManager.ordersHistory || [];
    let turnover = 0;
    // Calculate global turnover for session
    for (const b of orders) {
      if (b.effStake) turnover += b.effStake;
    }

    const maxItems = Math.max(10, (process.stdout.rows || 30) - 12);
    const offset = this.historyOffset || 0;
    const visibleOrders = orders.slice(offset, offset + maxItems);

    for (const b of visibleOrders) {
      const id = String(b.order_id).slice(-6).padEnd(6, ' ');
      // Try to parse ts or fallback to just empty
      let timeStr = '-       ';
      if (b.placed && b.placed[0]) {
        try {
          const d = new Date(b.placed[0]);
          timeStr = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
        } catch {}
      }
      
      const match = b.event_info ? `${b.event_info.home_team} vs ${b.event_info.away_team}`.substring(0, 22).padEnd(22, ' ') : 'Unknown'.padEnd(22, ' ');
      const market = (b.bet_type_description || b.bet_type || '').substring(0, 14).padEnd(14, ' ');
      
      const price = (b.effPrice ? b.effPrice.toFixed(2) : '-').padStart(6, ' ');
      const stNum = b.effStake || 0;
      const stStr = `€${stNum}`.padEnd(6, ' ');

      let statusColor = C.white;
      let label = b.label || b.normalizedStatus;
      if (b.normalizedStatus === 'WON') { statusColor = C.green; label = 'ВЫИГРЫШ'; }
      else if (b.normalizedStatus === 'LOST') { statusColor = C.red; label = 'ПРОИГРЫШ'; }
      else if (b.normalizedStatus === 'VOID') { statusColor = C.cyan; label = 'ВОЗВРАТ'; }
      else if (b.normalizedStatus === 'REJECTED_GOAL') { statusColor = `${C.bgRed}${C.yellow}`; label = 'ОТКЛ(ГОЛ)'; }
      else if (b.normalizedStatus === 'FAILED') { statusColor = C.red; label = b.label || 'ОШИБКА'; }
      
      const statusFmt = `${statusColor}${label.substring(0, 22).padEnd(22, ' ')}${C.reset}`;
      
      const pnlVal = b.pnl || 0;
      let pnlStr = '';
      if (b.normalizedStatus === 'WON') pnlStr = `${C.green}+€${pnlVal.toFixed(2)}${C.reset}`;
      else if (b.normalizedStatus === 'LOST') pnlStr = `${C.red}-€${Math.abs(pnlVal).toFixed(2)}${C.reset}`;
      else if (b.normalizedStatus === 'VOID') pnlStr = `${C.cyan}€0.00${C.reset}`;
      else pnlStr = `${C.dim}-.-${C.reset}`;

      output += `${C.dim}${id}${C.reset} | ${timeStr} | ${match} | ${market} | ${price} | ${stStr} | ${statusFmt} | ${pnlStr}\n`;
    }

    if (orders.length === 0) {
      output += `${C.yellow}Нет истории ордеров за текущую сессию.${C.reset}\n`;
    }

    const sm = this.stateManager.sessionMetrics || {};
    const roi = turnover > 0 ? (sm.totalProfitLoss / turnover) * 100 : 0;
    
    output += `\n${C.bold}--- ИТОГИ СЕССИИ ---${C.reset}\n`;
    output += `Оборот: €${turnover.toFixed(2)}\n`;
    const pnlColor = sm.totalProfitLoss > 0 ? C.green : (sm.totalProfitLoss < 0 ? C.red : C.white);
    output += `Чистый профит: ${pnlColor}€${sm.totalProfitLoss.toFixed(2)}${C.reset}\n`;
    output += `ROI: ${roi > 0 ? C.green + '+' : (roi < 0 ? C.red : C.white)}${roi.toFixed(1)}%${C.reset}\n`;

    output += `\n${C.yellow}[UP/DOWN/PgUp/PgDn - Листать | ESC, B, M - Вернуться в HUD]${C.reset}\n`;
    process.stdout.write(output);
  }

  /**
   * Keyboard handler for History modal.
   * @param {string} str
   * @param {readline.Key} key
   */
  handleHistoryKeypress(str, key) {
    if (key.name === 'escape' || key.name === 'b' || key.name === 'm') {
      this.mode = 'HUD';
      this.historyOffset = 0;
      process.stdout.write(C.clearScreen);
      this.render();
    } else if (key.name === 'up') {
      this.historyOffset = Math.max(0, (this.historyOffset || 0) - 1);
      this.render();
    } else if (key.name === 'down') {
      const orders = this.stateManager.ordersHistory || [];
      const maxItems = Math.max(10, (process.stdout.rows || 30) - 12);
      const maxOffset = Math.max(0, orders.length - maxItems);
      this.historyOffset = Math.min(maxOffset, (this.historyOffset || 0) + 1);
      this.render();
    } else if (key.name === 'pageup') {
      this.historyOffset = Math.max(0, (this.historyOffset || 0) - 15);
      this.render();
    } else if (key.name === 'pagedown') {
      const orders = this.stateManager.ordersHistory || [];
      const maxItems = Math.max(10, (process.stdout.rows || 30) - 12);
      const maxOffset = Math.max(0, orders.length - maxItems);
      this.historyOffset = Math.min(maxOffset, (this.historyOffset || 0) + 15);
      this.render();
    }
  }

  /**
   * Cleans up raw mode, restores cursor and clears intervals.
   */
  destroy() {
    if (this.renderInterval) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }

    if (this.isRawModeActive && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Safe ignore
      }
      this.isRawModeActive = false;
    }

    process.stdin.removeListener('keypress', this.onKeypress);
    process.stdout.write(C.showCursor);
    process.stdout.write('\n');
  }
}
