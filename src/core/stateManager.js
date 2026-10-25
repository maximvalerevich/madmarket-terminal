import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { getAllowedBookies } from '../utils/configHelpers.js';
import { normalizeOrder } from '../utils/orderNormalizer.js';

/**
 * StateManager
 * In-memory high-speed state store. Maintains active live soccer events,
 * real-time odds, live scores, stake configurations, account balance limits,
 * and a persistent cache of pre-armed betslips across matches.
 */
export class StateManager extends EventEmitter {
  /**
   * @param {Object} config
   */
  constructor(config) {
    super();
    this.config = config;
    this.adapter = null;
    this.wsFeed = null;

    /** @type {Map<string, Object>} */
    this.eventsMap = new Map();

    this.activeEventId = null;
    this.activeStake = Number(config.defaultStake) || 5.0;
    this.stakeStep = Number(config.stakeStep) || 10.0;

    // Account limits pulled from broker feed
    this.accountBalance = 0;
    this.availableBalance = 0;
    this.openStakes = 0;
    this._explicitAvailableBalance = null;
    this._wsOpenStakes = null;
    this.accountCurrency = config.defaultCurrency || 'EUR';

    /** @type {'FT' | 'HT'} */
    this.activePeriod = 'FT';

    /** @type {'MAIN' | 'ITB'} */
    this.activeMarketMode = 'MAIN';

    this.liveScore = { home: 0, away: 0 };
    this.liveScoreFt = { home: 0, away: 0 };
    this.liveScoreHt = { home: 0, away: 0 };

    /** @type {1 | 2 | 3} Current active period for ice hockey ('ih') matches */
    this.currentHockeyPeriod = 1;

    /**
     * User manual line selections per event and market: eventId -> { 'FT_OVER': { totalLine, rawTotalLineIndex }, ... }
     * @type {Map<string, Object>}
     */
    this.userLineOverrides = new Map();

    const self = this;
    this.liveOdds = {
      ft: {
        totalOver: 0,
        totalUnder: 0,
        winHome: 0,
        winDraw: 0,
        winAway: 0,
        totalLine: '2.5',
        rawTotalLineIndex: 10,
        totalLines: [],
        itb1Over: 0,
        itb1Under: 0,
        itb1Line: '1.5',
        rawItb1LineIndex: 6,
        itb1Lines: [],
        itb2Over: 0,
        itb2Under: 0,
        itb2Line: '1.5',
        rawItb2LineIndex: 6,
        itb2Lines: [],
        cornersTotalOver: 0,
        cornersTotalUnder: 0,
        cornersTotalLine: '9.5',
        rawCornersTotalLineIndex: 38,
        cornersTotalLines: [],
        cornersItb1Over: 0,
        cornersItb1Under: 0,
        cornersItb1Line: '4.5',
        rawCornersItb1LineIndex: 18,
        cornersItb1Lines: [],
        cornersItb2Over: 0,
        cornersItb2Under: 0,
        cornersItb2Line: '4.5',
        rawCornersItb2LineIndex: 18,
        cornersItb2Lines: []
      },
      ht: {
        totalOver: 0,
        totalUnder: 0,
        winHome: 0,
        winDraw: 0,
        winAway: 0,
        totalLine: '0.5',
        rawTotalLineIndex: 2,
        totalLines: [],
        itb1Over: 0,
        itb1Under: 0,
        itb1Line: '0.5',
        rawItb1LineIndex: 2,
        itb1Lines: [],
        itb2Over: 0,
        itb2Under: 0,
        itb2Line: '0.5',
        rawItb2LineIndex: 2,
        itb2Lines: [],
        cornersTotalOver: 0,
        cornersTotalUnder: 0,
        cornersTotalLine: '4.5',
        rawCornersTotalLineIndex: 18,
        cornersTotalLines: [],
        cornersItb1Over: 0,
        cornersItb1Under: 0,
        cornersItb1Line: '2.5',
        rawCornersItb1LineIndex: 10,
        cornersItb1Lines: [],
        cornersItb2Over: 0,
        cornersItb2Under: 0,
        cornersItb2Line: '2.5',
        rawCornersItb2LineIndex: 10,
        cornersItb2Lines: []
      },
      get totalOver() { return (self.activePeriod === 'HT' ? this.ht.totalOver : this.ft.totalOver) || 0; },
      set totalOver(v) { if (self.activePeriod === 'HT') this.ht.totalOver = v; else this.ft.totalOver = v; },
      get totalUnder() { return (self.activePeriod === 'HT' ? this.ht.totalUnder : this.ft.totalUnder) || 0; },
      set totalUnder(v) { if (self.activePeriod === 'HT') this.ht.totalUnder = v; else this.ft.totalUnder = v; },
      get winHome() { return (self.activePeriod === 'HT' ? this.ht.winHome : this.ft.winHome) || 0; },
      set winHome(v) { if (self.activePeriod === 'HT') this.ht.winHome = v; else this.ft.winHome = v; },
      get winDraw() { return (self.activePeriod === 'HT' ? this.ht.winDraw : this.ft.winDraw) || 0; },
      set winDraw(v) { if (self.activePeriod === 'HT') this.ht.winDraw = v; else this.ft.winDraw = v; },
      get winAway() { return (self.activePeriod === 'HT' ? this.ht.winAway : this.ft.winAway) || 0; },
      set winAway(v) { if (self.activePeriod === 'HT') this.ht.winAway = v; else this.ft.winAway = v; },
      get totalLine() { return self.activePeriod === 'HT' ? this.ht.totalLine : this.ft.totalLine; },
      set totalLine(v) { if (self.activePeriod === 'HT') this.ht.totalLine = v; else this.ft.totalLine = v; },
      get rawTotalLineIndex() { return self.activePeriod === 'HT' ? this.ht.rawTotalLineIndex : this.ft.rawTotalLineIndex; },
      set rawTotalLineIndex(v) { if (self.activePeriod === 'HT') this.ht.rawTotalLineIndex = v; else this.ft.rawTotalLineIndex = v; },
      get itb1Over() { return (self.activePeriod === 'HT' ? this.ht.itb1Over : this.ft.itb1Over) || 0; },
      set itb1Over(v) { if (self.activePeriod === 'HT') this.ht.itb1Over = v; else this.ft.itb1Over = v; },
      get itb1Under() { return (self.activePeriod === 'HT' ? this.ht.itb1Under : this.ft.itb1Under) || 0; },
      set itb1Under(v) { if (self.activePeriod === 'HT') this.ht.itb1Under = v; else this.ft.itb1Under = v; },
      get itb1Line() { return self.activePeriod === 'HT' ? this.ht.itb1Line : this.ft.itb1Line; },
      set itb1Line(v) { if (self.activePeriod === 'HT') this.ht.itb1Line = v; else this.ft.itb1Line = v; },
      get rawItb1LineIndex() { return self.activePeriod === 'HT' ? this.ht.rawItb1LineIndex : this.ft.rawItb1LineIndex; },
      set rawItb1LineIndex(v) { if (self.activePeriod === 'HT') this.ht.rawItb1LineIndex = v; else this.ft.rawItb1LineIndex = v; },
      get itb2Over() { return (self.activePeriod === 'HT' ? this.ht.itb2Over : this.ft.itb2Over) || 0; },
      set itb2Over(v) { if (self.activePeriod === 'HT') this.ht.itb2Over = v; else this.ft.itb2Over = v; },
      get itb2Under() { return (self.activePeriod === 'HT' ? this.ht.itb2Under : this.ft.itb2Under) || 0; },
      set itb2Under(v) { if (self.activePeriod === 'HT') this.ht.itb2Under = v; else this.ft.itb2Under = v; },
      get itb2Line() { return self.activePeriod === 'HT' ? this.ht.itb2Line : this.ft.itb2Line; },
      set itb2Line(v) { if (self.activePeriod === 'HT') this.ht.itb2Line = v; else this.ft.itb2Line = v; },
      get rawItb2LineIndex() { return self.activePeriod === 'HT' ? this.ht.rawItb2LineIndex : this.ft.rawItb2LineIndex; },
      set rawItb2LineIndex(v) { if (self.activePeriod === 'HT') this.ht.rawItb2LineIndex = v; else this.ft.rawItb2LineIndex = v; },
      get cornersTotalOver() { return (self.activePeriod === 'HT' ? this.ht.cornersTotalOver : this.ft.cornersTotalOver) || 0; },
      set cornersTotalOver(v) { if (self.activePeriod === 'HT') this.ht.cornersTotalOver = v; else this.ft.cornersTotalOver = v; },
      get cornersTotalLine() { return self.activePeriod === 'HT' ? this.ht.cornersTotalLine : this.ft.cornersTotalLine; },
      set cornersTotalLine(v) { if (self.activePeriod === 'HT') this.ht.cornersTotalLine = v; else this.ft.cornersTotalLine = v; },
      get cornersTotalLines() { return (self.activePeriod === 'HT' ? this.ht.cornersTotalLines : this.ft.cornersTotalLines) || []; },
      get cornersItb1Over() { return (self.activePeriod === 'HT' ? this.ht.cornersItb1Over : this.ft.cornersItb1Over) || 0; },
      set cornersItb1Over(v) { if (self.activePeriod === 'HT') this.ht.cornersItb1Over = v; else this.ft.cornersItb1Over = v; },
      get cornersItb1Line() { return self.activePeriod === 'HT' ? this.ht.cornersItb1Line : this.ft.cornersItb1Line; },
      set cornersItb1Line(v) { if (self.activePeriod === 'HT') this.ht.cornersItb1Line = v; else this.ft.cornersItb1Line = v; },
      get cornersItb1Lines() { return (self.activePeriod === 'HT' ? this.ht.cornersItb1Lines : this.ft.cornersItb1Lines) || []; },
      get cornersItb2Over() { return (self.activePeriod === 'HT' ? this.ht.cornersItb2Over : this.ft.cornersItb2Over) || 0; },
      set cornersItb2Over(v) { if (self.activePeriod === 'HT') this.ht.cornersItb2Over = v; else this.ft.cornersItb2Over = v; },
      get cornersItb2Line() { return self.activePeriod === 'HT' ? this.ht.cornersItb2Line : this.ft.cornersItb2Line; },
      set cornersItb2Line(v) { if (self.activePeriod === 'HT') this.ht.cornersItb2Line = v; else this.ft.cornersItb2Line = v; },
      get cornersItb2Lines() { return (self.activePeriod === 'HT' ? this.ht.cornersItb2Lines : this.ft.cornersItb2Lines) || []; }
    };

    /**
     * Cache pool of pre-armed betslips per match: eventId -> { period, marketMode, OVER, HOME, AWAY, ITB1, ITB2 }
     * Enables zero-latency switching between matches without losing armed slips.
     * @type {Map<string, Object>}
     */
    this.armedPool = new Map();

    /**
     * Active match armed betslips references
     */
    this.armedBetslips = this.createEmptySlips(this.activePeriod, this.activeMarketMode);

    /**
     * Quota backoff map: targetKey -> retryAvailableTimestamp
     * Backs off requests when Mollybet returns 403 too_many_open_betslips
     * @type {Map<string, number>}
     */
    this.quotaBackoffMap = new Map();

    this.isDestroyed = false;
    /** @type {NodeJS.Timeout | null} */
    this.refreshTimer = null;

    // Bet History & PnL
    this.ordersHistory = [];
    this.sessionMetrics = {
      totalProfitLoss: 0,
      totalBetsCount: 0,
      wonCount: 0,
      lostCount: 0,
      voidCount: 0,
      rejectedCount: 0
    };
    this.ordersPollingTimer = null;

    this.startPoolWatchdog();
  }

  /**
   * Starts periodic background polling for orders history (every 8-10s).
   */
  startOrdersPolling() {
    if (this.ordersPollingTimer) {
      clearInterval(this.ordersPollingTimer);
    }
    
    // Initial fetch shortly after start
    setTimeout(() => this.fetchOrdersHistory(), 2000);

    this.ordersPollingTimer = setInterval(() => {
      this.fetchOrdersHistory();
    }, 9000);
  }

  /**
   * Fetches latest orders, normalizes them, updates metrics and cache.
   */
  async fetchOrdersHistory() {
    if (!this.adapter) return;

    try {
      const orders = await this.adapter.getOrdersHistory(200);
      if (!Array.isArray(orders) || orders.length === 0) return;

      this.ordersHistory = orders;
      this.recalculateSessionMetrics();
      this.emit('history_updated');
    } catch (err) {
      logger.error('StateManager', `fetchOrdersHistory error: ${err.message}`);
    }
  }

  /**
   * Recalculates PnL and counters based on ordersHistory
   */
  recalculateSessionMetrics() {
    let totalProfitLoss = 0;
    let wonCount = 0;
    let lostCount = 0;
    let voidCount = 0;
    let rejectedCount = 0;

    for (const order of this.ordersHistory) {
      const pnl = Number(order.pnl) || 0;
      const status = order.normalizedStatus;

      if (status === 'WON') {
        wonCount++;
        totalProfitLoss += pnl;
      } else if (status === 'LOST') {
        lostCount++;
        totalProfitLoss += pnl; // pnl is negative
      } else if (status === 'VOID') {
        voidCount++;
      } else if (status === 'REJECTED_GOAL') {
        rejectedCount++;
      }
      // PENDING, IN_PLAY, FAILED, etc.
    }

    this.sessionMetrics = {
      totalProfitLoss,
      totalBetsCount: this.ordersHistory.length,
      wonCount,
      lostCount,
      voidCount,
      rejectedCount
    };
    this._recalculateAvailableBalance();
  }

  /**
   * Recalculates availableBalance from accountBalance and any active/in-play stakes.
   */
  _recalculateAvailableBalance() {
    if (this._explicitAvailableBalance != null && !Number.isNaN(this._explicitAvailableBalance)) {
      this.availableBalance = Math.max(0, Number(this._explicitAvailableBalance.toFixed(2)));
      this.openStakes = Math.max(0, Number((this.accountBalance - this.availableBalance).toFixed(2)));
      return;
    }

    let inPlayStakes = 0;
    if (Array.isArray(this.ordersHistory)) {
      for (const order of this.ordersHistory) {
        if (order.normalizedStatus === 'IN_PLAY' || order.normalizedStatus === 'PENDING') {
          inPlayStakes += Number(order.effStake) || 0;
        }
      }
    }

    const activeOpen = (this._wsOpenStakes != null && !Number.isNaN(this._wsOpenStakes))
      ? Math.max(this._wsOpenStakes, inPlayStakes)
      : inPlayStakes;

    this.openStakes = Number(activeOpen.toFixed(2));
    this.availableBalance = Math.max(0, Number((this.accountBalance - this.openStakes).toFixed(2)));
  }

  /**
   * Returns keys of the 3 active coupons based on current market mode.
   * @returns {string[]}
   */
  getActiveSlipKeys() {
    return this.activeMarketMode === 'ITB'
      ? ['OVER', 'ITB1', 'ITB2']
      : ['OVER', 'HOME', 'AWAY'];
  }

  /**
   * Creates a clean default odds structure for a specific period and sport.
   * @param {'FT' | 'HT'} [period='FT']
   * @param {string} [sport='fb']
   * @returns {Object}
   */
  createEmptyPeriodOdds(period = 'FT', sport = 'fb') {
    const isHt = period === 'HT';
    const isHockey = sport === 'ih';
    if (isHockey) {
      return {
        totalOver: 0,
        totalUnder: 0,
        winHome: 0,
        winDraw: 0,
        winAway: 0,
        totalLine: isHt ? '1.5' : '5.5',
        rawTotalLineIndex: isHt ? 6 : 22,
        totalLines: [],
        itb1Over: 0,
        itb1Under: 0,
        itb1Line: isHt ? '0.5' : '2.5',
        rawItb1LineIndex: isHt ? 2 : 10,
        itb1Lines: [],
        itb2Over: 0,
        itb2Under: 0,
        itb2Line: isHt ? '0.5' : '2.5',
        rawItb2LineIndex: isHt ? 2 : 10,
        itb2Lines: []
      };
    }

    return {
      totalOver: 0,
      totalUnder: 0,
      winHome: 0,
      winDraw: 0,
      winAway: 0,
      totalLine: isHt ? '0.5' : '2.5',
      rawTotalLineIndex: isHt ? 2 : 10,
      totalLines: [],
      itb1Over: 0,
      itb1Under: 0,
      itb1Line: isHt ? '0.5' : '1.5',
      rawItb1LineIndex: isHt ? 2 : 6,
      itb1Lines: [],
      itb2Over: 0,
      itb2Under: 0,
      itb2Line: isHt ? '0.5' : '1.5',
      rawItb2LineIndex: isHt ? 2 : 6,
      itb2Lines: [],
      cornersTotalOver: 0,
      cornersTotalUnder: 0,
      cornersTotalLine: isHt ? '4.5' : '9.5',
      rawCornersTotalLineIndex: isHt ? 18 : 38,
      cornersTotalLines: [],
      cornersItb1Over: 0,
      cornersItb1Under: 0,
      cornersItb1Line: isHt ? '2.5' : '4.5',
      rawCornersItb1LineIndex: isHt ? 10 : 18,
      cornersItb1Lines: [],
      cornersItb2Over: 0,
      cornersItb2Under: 0,
      cornersItb2Line: isHt ? '2.5' : '4.5',
      rawCornersItb2LineIndex: isHt ? 10 : 18,
      cornersItb2Lines: []
    };
  }

  /**
   * Creates an empty set of betslips for the given period and market mode.
   * @param {'FT' | 'HT'} [period]
   * @param {'MAIN' | 'ITB'} [marketMode]
   * @returns {Object}
   */
  createEmptySlips(period = null, marketMode = null) {
    const p = period || this.activePeriod || 'FT';
    const m = marketMode || this.activeMarketMode || 'MAIN';
    const isHt = p === 'HT';

    return {
      period: p,
      marketMode: m,
      OVER: {
        targetKey: isHt ? 'HT_OVER' : 'OVER',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      HOME: {
        targetKey: isHt ? 'HT_HOME' : 'HOME',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      AWAY: {
        targetKey: isHt ? 'HT_AWAY' : 'AWAY',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      ITB1: {
        targetKey: isHt ? 'HT_ITB1' : 'ITB1',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      ITB2: {
        targetKey: isHt ? 'HT_ITB2' : 'ITB2',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      DRAW: {
        targetKey: isHt ? 'HT_DRAW' : 'DRAW',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      CORNERS_ITB1: {
        targetKey: isHt ? 'HT_CORNERS_ITB1' : 'CORNERS_ITB1',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      },
      CORNERS_ITB2: {
        targetKey: isHt ? 'HT_CORNERS_ITB2' : 'CORNERS_ITB2',
        betslipId: null,
        betType: null,
        currentPrice: 0,
        bookiePrice: null,
        bookiePriceTs: 0,
        priceSource: 'NONE',
        expiryTs: 0,
        maxStake: null,
        isArming: false,
        lastArmedAt: 0,
        error: null
      }
    };
  }

  /**
   * Returns a Set of allowed bookmakers (e.g. pin88) configured for this session.
   * Delegates to shared utility in configHelpers.
   * @returns {Set<string>}
   */
  getAllowedBookies() {
    return getAllowedBookies(this.config);
  }

  /**
   * Binds the API adapter for executing pre-arm operations.
   * @param {import('../adapters/baseAdapter.js').BaseAdapter} adapter
   */
  setAdapter(adapter) {
    this.adapter = adapter;
    this.startOrdersPolling();
  }

  /**
   * Binds the WebSocket feed for real-time market subscriptions and balance updates.
   * @param {import('../network/wsFeed.js').WsFeed} wsFeed
   */
  setWsFeed(wsFeed) {
    this.wsFeed = wsFeed;

    wsFeed.on('balance', ({ currency, amount, available, openStakes, total }) => {
      this.accountCurrency = currency || this.accountCurrency;
      if (total != null && available != null) {
        this.accountBalance = Number(total);
        this._explicitAvailableBalance = Number(available);
        this._wsOpenStakes = openStakes != null ? Number(openStakes) : null;
      } else if (available != null) {
        this.accountBalance = Number(amount);
        this._explicitAvailableBalance = Number(available);
        this._wsOpenStakes = openStakes != null ? Number(openStakes) : null;
      } else if (openStakes != null) {
        this.accountBalance = Number(amount);
        this._wsOpenStakes = Number(openStakes);
        this._explicitAvailableBalance = null;
      } else {
        this.accountBalance = Number(amount);
        this._explicitAvailableBalance = null;
        this._wsOpenStakes = null;
      }
      this._recalculateAvailableBalance();
      logger.info('StateManager', `Updated live balance: ${this.accountCurrency} ${this.availableBalance} / ${this.accountBalance}`);
      this.emit('balance_updated', {
        currency: this.accountCurrency,
        amount: this.accountBalance,
        available: this.availableBalance,
        openStakes: this.openStakes
      });
      this.emit('state_updated');
    });

    wsFeed.on('betslip_update', (slipData) => {
      this.handleStreamingSlipUpdate(slipData);
    });

    wsFeed.on('pmm_update', (pmmData) => {
      this.handlePmmUpdate(pmmData);
    });

    wsFeed.on('betslip_closed', (closedData) => {
      this.handleBetslipClosed(closedData);
    });

    wsFeed.on('order_update', (orderObj) => {
      if (orderObj && typeof orderObj === 'object') {
        const normalized = normalizeOrder(orderObj);
        const ordId = String(normalized.order_id || normalized.id || '');
        if (ordId) {
          const existingIdx = this.ordersHistory.findIndex(o => String(o.order_id || o.id || '') === ordId);
          if (existingIdx !== -1) {
            this.ordersHistory[existingIdx] = normalized;
          } else {
            this.ordersHistory.unshift(normalized);
          }
          this.recalculateSessionMetrics();
          this.emit('state_updated');
        }
      }
      // Also trigger background history sync if adapter is attached
      this.fetchOrdersHistory();
    });
  }

  /**
   * Handles asynchronous betslip updates from WS feed.
   * @param {Object} slipData
   */
  handleStreamingSlipUpdate(slipData) {
    if (!slipData || !slipData.betslip_id) return;
    const slipId = slipData.betslip_id;
    const allowed = this.getAllowedBookies();

    for (const key of ['OVER', 'HOME', 'DRAW', 'AWAY', 'ITB1', 'ITB2', 'CORNERS_ITB1', 'CORNERS_ITB2']) {
      const slip = this.armedBetslips[key];
      if (slip && slip.betslipId === slipId) {
        if (Array.isArray(slipData.bookies_with_offers) && slipData.bookies_with_offers.length > 0) {
          let maxLimit = 0;
          let bestPrice = 0;
          for (const b of slipData.bookies_with_offers) {
            if (Array.isArray(b)) {
              const bName = String(b[0] || '').toLowerCase();
              if (bName && !allowed.has(bName)) continue;
              if (typeof b[1] === 'number' && b[1] > 1.0) {
                bestPrice = Math.max(bestPrice, b[1]);
              }
              if (typeof b[2] === 'number' && b[2] > 0) {
                maxLimit = Math.max(maxLimit, b[2]);
              }
            }
          }
          if (bestPrice > 0) {
            slip.currentPrice = bestPrice;
            slip.price = bestPrice;
            slip.bookiePrice = bestPrice;
            slip.bookiePriceTs = Date.now();
            slip.priceSource = 'BOOKIE_SLIP';
            const isSlipHt = slip.period === 'HT' || (slip.targetKey && slip.targetKey.startsWith('HT_'));
            const pOdds = isSlipHt ? this.liveOdds.ht : this.liveOdds.ft;
            if (key === 'OVER') pOdds.totalOver = bestPrice;
            if (key === 'HOME') pOdds.winHome = bestPrice;
            if (key === 'DRAW') pOdds.winDraw = bestPrice;
            if (key === 'AWAY') pOdds.winAway = bestPrice;
            if (key === 'ITB1') pOdds.itb1Over = bestPrice;
            if (key === 'ITB2') pOdds.itb2Over = bestPrice;
            if (key === 'CORNERS_ITB1') pOdds.cornersItb1Over = bestPrice;
            if (key === 'CORNERS_ITB2') pOdds.cornersItb2Over = bestPrice;
          }
          if (maxLimit > 0) {
            slip.maxStake = maxLimit;
            logger.info('StateManager', `Updated max stake limit for ${key} (${slipId.slice(-8)}): €${maxLimit}${bestPrice > 0 ? `, price: ${bestPrice}` : ''}`);
          }
          if (bestPrice > 0 || maxLimit > 0) {
            this.emit('slip_quote_updated', { key, targetKey: slip.targetKey || key, betslipId: slipId, price: bestPrice, maxStake: slip.maxStake });
            this.emit('state_updated');
          }
        }
      }
    }
  }

  /**
   * Handles streaming PMM (Pre-Market Maker) price & limit quotes from broker.
   * Strictly filters quotes to accept only configured accounts/bookmakers (e.g. pin88).
   * Discards junk/distorted quotes from other bookmakers (e.g. pmk, betdex).
   * @param {Object} pmmData
   */
  handlePmmUpdate(pmmData) {
    if (!pmmData || !pmmData.betslip_id) return;
    const slipId = pmmData.betslip_id;
    const bookie = String(pmmData.bookie || '').toLowerCase();
    const allowed = this.getAllowedBookies();

    // Strict filter: ignore PMM frames from bookies not configured in accounts
    if (bookie && !allowed.has(bookie)) {
      return;
    }

    for (const key of ['OVER', 'HOME', 'DRAW', 'AWAY', 'ITB1', 'ITB2', 'CORNERS_ITB1', 'CORNERS_ITB2']) {
      const slip = this.armedBetslips[key];
      if (slip && slip.betslipId === slipId) {
        let bestPrice = 0;
        let maxLimit = 0;

        if (Array.isArray(pmmData.price_list) && pmmData.price_list.length > 0) {
          for (const pItem of pmmData.price_list) {
            const eff = pItem.effective;
            if (eff && typeof eff.price === 'number' && eff.price > 1.0) {
              bestPrice = eff.price;
            }
            if (eff && Array.isArray(eff.max) && typeof eff.max[1] === 'number') {
              maxLimit = Math.max(maxLimit, eff.max[1]);
            }
          }
        }

        if (bestPrice > 1.0) {
          slip.currentPrice = bestPrice;
          slip.price = bestPrice;
          slip.bookiePrice = bestPrice;
          slip.bookiePriceTs = Date.now();
          slip.priceSource = 'PMM';

          const isSlipHt = slip.period === 'HT' || (slip.targetKey && slip.targetKey.startsWith('HT_'));
          const pOdds = isSlipHt ? this.liveOdds.ht : this.liveOdds.ft;
          if (key === 'OVER') pOdds.totalOver = bestPrice;
          if (key === 'HOME') pOdds.winHome = bestPrice;
          if (key === 'DRAW') pOdds.winDraw = bestPrice;
          if (key === 'AWAY') pOdds.winAway = bestPrice;
          if (key === 'ITB1') pOdds.itb1Over = bestPrice;
          if (key === 'ITB2') pOdds.itb2Over = bestPrice;
          if (key === 'CORNERS_ITB1') pOdds.cornersItb1Over = bestPrice;
          if (key === 'CORNERS_ITB2') pOdds.cornersItb2Over = bestPrice;
        }

        if (maxLimit > 0) {
          slip.maxStake = maxLimit;
        }

        if (bestPrice > 1.0) {
          logger.info('StateManager', `PMM quote for ${key} [${slip.targetKey || key}] (${slipId.slice(-8)}): кэф ${bestPrice}, лимит €${Math.floor(maxLimit || 0)} (${bookie || 'pin88'})`);
          this.emit('slip_quote_updated', { key, targetKey: slip.targetKey || key, betslipId: slipId, price: bestPrice, maxStake: slip.maxStake });
          this.emit('state_updated');
        }
      }
    }
  }

  /**
   * Handles betslip_closed frames from WS feed.
   * Triggers immediate re-arming when a slip expires or closes on server.
   * @param {Object} closedData
   */
  handleBetslipClosed(closedData) {
    if (!closedData || !closedData.betslip_id) return;
    const slipId = closedData.betslip_id;
    for (const key of ['OVER', 'HOME', 'DRAW', 'AWAY', 'ITB1', 'ITB2', 'CORNERS_ITB1', 'CORNERS_ITB2']) {
      const slip = this.armedBetslips[key];
      if (slip && slip.betslipId === slipId) {
        logger.warn('StateManager', `Betslip ${slipId.slice(-8)} closed by server (${closedData.close_reason || 'closed'}). Re-arming immediately!`);
        this.invalidateBetslip(slip.targetKey || key);
      }
    }
  }

  /**
   * Sets the active event for courtsiding / combat mode.
   * Persists old match slips in the pool cache and retrieves/initializes slips for the new match.
   * @param {string} eventId
   */
  setActiveEvent(eventId) {
    const newId = String(eventId);
    if (this.activeEventId === newId) return;

    // 1. Release previous active slips from Mollybet to keep total open slips <= 3
    if (this.activeEventId && this.adapter) {
      for (const key of ['OVER', 'HOME', 'DRAW', 'AWAY', 'ITB1', 'ITB2', 'CORNERS_ITB1', 'CORNERS_ITB2']) {
        const slip = this.armedBetslips[key];
        if (slip && slip.betslipId) {
          this.adapter.deleteBetslip(slip.betslipId).catch(() => {});
          slip.betslipId = null;
        }
      }
      this.armedPool.set(this.activeEventId, this.armedBetslips);
    }

    this.activeEventId = newId;

    const event = this.eventsMap.get(this.activeEventId);
    if (event) {
      const evSport = String(event.sport || 'fb');
      if (evSport === 'ih') {
        this.currentHockeyPeriod = Number(event.hockeyPeriod) || 1;
      }

      if (event.ftScore) {
        this.liveScoreFt = { ...event.ftScore };
      } else if (event.score) {
        this.liveScoreFt = { ...event.score };
      }
      if (event.htScore) {
        this.liveScoreHt = { ...event.htScore };
      } else {
        this.liveScoreHt = { home: 0, away: 0 };
      }

      this.liveScore = this.activePeriod === 'HT' ? { ...this.liveScoreHt } : { ...this.liveScoreFt };

      // Reset liveOdds cleanly for the incoming match so prices from previous match never leak
      this.liveOdds.ft = event.odds?.ft
        ? { ...this.createEmptyPeriodOdds('FT', evSport), ...event.odds.ft }
        : (event.odds ? { ...this.createEmptyPeriodOdds('FT', evSport), ...event.odds } : this.createEmptyPeriodOdds('FT', evSport));
      this.liveOdds.ht = event.odds?.ht
        ? { ...this.createEmptyPeriodOdds('HT', evSport), ...event.odds.ht }
        : this.createEmptyPeriodOdds('HT', evSport);

      // Merge corner ITB/Total lines from linked companion (Corners) event if available
      const cornersEv = event.cornersEventId ? this.eventsMap.get(event.cornersEventId) : null;
      if (cornersEv?.odds) {
        for (const pk of ['ft', 'ht']) {
          const cOdds = cornersEv.odds[pk];
          if (cOdds) {
            this._mergeCornersIntoPeriodOdds(this.liveOdds[pk], cOdds);
          }
        }
      }

      this._reconcileOddsWithScore(this.activeEventId, 'ft', this.liveScoreFt);
      this._reconcileOddsWithScore(this.activeEventId, 'ht', this.liveScoreHt);

      if (this.wsFeed) {
        this.wsFeed.subscribeToEvent(
          event.competitionId,
          event.sport,
          this.activeEventId,
          event.cornersEventId || null,
          cornersEv?.competitionId || event.competitionId
        );
      }
    } else {
      // Event not yet in eventsMap: ensure odds and scores are cleanly reset to defaults
      this.liveScoreFt = { home: 0, away: 0 };
      this.liveScoreHt = { home: 0, away: 0 };
      this.liveScore = { home: 0, away: 0 };
      this.currentHockeyPeriod = 1;
      this.liveOdds.ft = this.createEmptyPeriodOdds('FT');
      this.liveOdds.ht = this.createEmptyPeriodOdds('HT');
    }

    // 2. Restore from armedPool or initialize fresh set for activePeriod and activeMarketMode
    const existing = this.armedPool.get(this.activeEventId);

    if (existing && existing.period === this.activePeriod && existing.marketMode === this.activeMarketMode) {
      this.armedBetslips = existing;
      logger.info('StateManager', `Switched to ${this.activeEventId} - Restored armed betslips from fast cache!`);
    } else {
      this.armedBetslips = this.createEmptySlips(this.activePeriod, this.activeMarketMode);
      this.armedPool.set(this.activeEventId, this.armedBetslips);
      logger.info('StateManager', `Switched to ${this.activeEventId} (${event?.homeTeam || 'Home'} vs ${event?.awayTeam || 'Away'})`);
    }

    // Update prices
    for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
      const slip = this.armedBetslips[key];
      if (slip) {
        const liveP = this.getLivePrice(slip.targetKey || key);
        if (liveP > 0) slip.currentPrice = liveP;
      }
    }

    this.emit('active_event_changed', {
      eventId: this.activeEventId,
      event
    });

    // Check if any slip needs refreshing
    this.refreshAllBetslips(false);
  }

  /**
   * Returns details of active event.
   * @returns {Object | null}
   */
  getActiveEvent() {
    if (!this.activeEventId) return null;
    return this.eventsMap.get(this.activeEventId) || {
      eventId: this.activeEventId,
      homeTeam: 'Home',
      awayTeam: 'Away',
      competition: 'Soccer',
      score: this.liveScore,
      minute: ''
    };
  }

  /**
   * Ensures all total and individual total lines (OVER, ITB1, ITB2) for an event and period
   * are strictly greater than the already-scored goals, immediately advancing any settled/obsolete line
   * (e.g., ITB2 0.5 -> 1.5 when score becomes 0:1).
   * @param {string} eventId
   * @param {'ft' | 'ht'} periodKey
   * @param {{ home: number, away: number }} score
   * @param {boolean} [onGoal=false]
   */
  _reconcileOddsWithScore(eventId, periodKey, score, onGoal = false) {
    if (!eventId || !score) return;
    const home = Number(score.home) || 0;
    const away = Number(score.away) || 0;
    const totalGoals = home + away;
    const isHt = periodKey === 'ht';

    // Clear any manual user line overrides that have already been settled by the new score
    const overKey = isHt ? 'HT_OVER' : 'OVER';
    const itb1Key = isHt ? 'HT_ITB1' : 'ITB1';
    const itb2Key = isHt ? 'HT_ITB2' : 'ITB2';

    const userOver = this.getUserLineOverride(overKey, eventId);
    if (userOver && parseFloat(userOver.totalLine) <= totalGoals) {
      this.userLineOverrides.delete(`${eventId}:${overKey}`);
    }
    const userItb1 = this.getUserLineOverride(itb1Key, eventId);
    if (userItb1 && parseFloat(userItb1.totalLine) <= home) {
      this.userLineOverrides.delete(`${eventId}:${itb1Key}`);
    }
    const userItb2 = this.getUserLineOverride(itb2Key, eventId);
    if (userItb2 && parseFloat(userItb2.totalLine) <= away) {
      this.userLineOverrides.delete(`${eventId}:${itb2Key}`);
    }

    const advanceTargetOdds = (oddsObj) => {
      if (!oddsObj || typeof oddsObj !== 'object') return;

      const filterLinesIfValid = (arr, minG) => {
        if (!Array.isArray(arr)) return [];
        const higher = arr.filter(x => parseFloat(x.totalLine) > minG);
        return (higher.length > 0 || onGoal) ? higher : arr;
      };

      if (Array.isArray(oddsObj.totalLines)) {
        oddsObj.totalLines = filterLinesIfValid(oddsObj.totalLines, totalGoals);
      }
      if (Array.isArray(oddsObj.itb1Lines)) {
        oddsObj.itb1Lines = filterLinesIfValid(oddsObj.itb1Lines, home);
      }
      if (Array.isArray(oddsObj.itb2Lines)) {
        oddsObj.itb2Lines = filterLinesIfValid(oddsObj.itb2Lines, away);
      }

      const stepIfObsolete = (lineField, idxField, overField, underField, linesField, minGoals) => {
        const curStr = oddsObj[lineField];
        if (!curStr) return;
        const curVal = parseFloat(curStr);
        if (Number.isNaN(curVal) || curVal > minGoals) return;

        const validLines = Array.isArray(oddsObj[linesField]) ? oddsObj[linesField] : [];
        const nextEntry = validLines.find(x => parseFloat(x.totalLine) > minGoals && x.totalOver > 1.0)
          || validLines.find(x => parseFloat(x.totalLine) > minGoals);

        if (nextEntry) {
          oddsObj[lineField] = nextEntry.totalLine;
          oddsObj[idxField] = nextEntry.rawTotalLineIndex;
          oddsObj[overField] = nextEntry.totalOver || 0;
          oddsObj[underField] = nextEntry.totalUnder || 0;
        } else if (onGoal) {
          const nextVal = minGoals + 0.5;
          const decimals = (String(curStr).includes('.') && String(curStr).split('.')[1]?.length === 2) ? 2 : 1;
          oddsObj[lineField] = nextVal.toFixed(decimals);
          oddsObj[idxField] = Math.round(nextVal * 4);
          oddsObj[overField] = 0;
          oddsObj[underField] = 0;
        }
      };

      stepIfObsolete('totalLine', 'rawTotalLineIndex', 'totalOver', 'totalUnder', 'totalLines', totalGoals);
      stepIfObsolete('itb1Line', 'rawItb1LineIndex', 'itb1Over', 'itb1Under', 'itb1Lines', home);
      stepIfObsolete('itb2Line', 'rawItb2LineIndex', 'itb2Over', 'itb2Under', 'itb2Lines', away);
    };

    const ev = this.eventsMap.get(eventId);
    if (ev?.odds?.[periodKey]) {
      advanceTargetOdds(ev.odds[periodKey]);
    }
    if (this.activeEventId === eventId && this.liveOdds[periodKey]) {
      advanceTargetOdds(this.liveOdds[periodKey]);
    }
  }

  /**
   * Ensures corner total and individual corner total lines for an event and period
   * are strictly greater than the already-taken corners.
   * @param {string} eventId
   * @param {'ft' | 'ht'} periodKey
   * @param {{ home: number, away: number }} cornersScore
   */
  _reconcileCornersOddsWithScore(eventId, periodKey, cornersScore) {
    if (!eventId || !cornersScore) return;
    const home = Number(cornersScore.home) || 0;
    const away = Number(cornersScore.away) || 0;
    const totalCorners = home + away;
    const isHt = periodKey === 'ht';

    const cOverKey = isHt ? 'HT_CORNERS_OVER' : 'CORNERS_OVER';
    const cItb1Key = isHt ? 'HT_CORNERS_ITB1' : 'CORNERS_ITB1';
    const cItb2Key = isHt ? 'HT_CORNERS_ITB2' : 'CORNERS_ITB2';

    const userCOver = this.getUserLineOverride(cOverKey, eventId);
    if (userCOver && parseFloat(userCOver.totalLine) <= totalCorners) {
      this.userLineOverrides.delete(`${eventId}:${cOverKey}`);
    }
    const userCItb1 = this.getUserLineOverride(cItb1Key, eventId);
    if (userCItb1 && parseFloat(userCItb1.totalLine) <= home) {
      this.userLineOverrides.delete(`${eventId}:${cItb1Key}`);
    }
    const userCItb2 = this.getUserLineOverride(cItb2Key, eventId);
    if (userCItb2 && parseFloat(userCItb2.totalLine) <= away) {
      this.userLineOverrides.delete(`${eventId}:${cItb2Key}`);
    }

    const advanceCornerOdds = (oddsObj) => {
      if (!oddsObj || typeof oddsObj !== 'object') return;

      const filterLinesIfValid = (arr, minC) => {
        if (!Array.isArray(arr)) return [];
        const higher = arr.filter(x => parseFloat(x.totalLine) > minC);
        return higher.length > 0 ? higher : arr;
      };

      if (Array.isArray(oddsObj.cornersTotalLines) && oddsObj.cornersTotalLines.length > 0) {
        oddsObj.cornersTotalLines = filterLinesIfValid(oddsObj.cornersTotalLines, totalCorners);
      }
      if (Array.isArray(oddsObj.cornersItb1Lines) && oddsObj.cornersItb1Lines.length > 0) {
        oddsObj.cornersItb1Lines = filterLinesIfValid(oddsObj.cornersItb1Lines, home);
      }
      if (Array.isArray(oddsObj.cornersItb2Lines) && oddsObj.cornersItb2Lines.length > 0) {
        oddsObj.cornersItb2Lines = filterLinesIfValid(oddsObj.cornersItb2Lines, away);
      }

      const stepIfObsolete = (lineField, idxField, overField, underField, linesField, minVal) => {
        const curStr = oddsObj[lineField];
        if (!curStr) return;
        const curVal = parseFloat(curStr);
        if (Number.isNaN(curVal) || curVal > minVal) return;

        const validLines = Array.isArray(oddsObj[linesField]) ? oddsObj[linesField] : [];
        const nextEntry = validLines.find(x => parseFloat(x.totalLine) > minVal && x.totalOver > 1.0)
          || validLines.find(x => parseFloat(x.totalLine) > minVal);

        if (nextEntry) {
          oddsObj[lineField] = nextEntry.totalLine;
          oddsObj[idxField] = nextEntry.rawTotalLineIndex;
          oddsObj[overField] = nextEntry.totalOver || 0;
          oddsObj[underField] = nextEntry.totalUnder || 0;
        }
      };

      stepIfObsolete('cornersTotalLine', 'rawCornersTotalLineIndex', 'cornersTotalOver', 'cornersTotalUnder', 'cornersTotalLines', totalCorners);
      stepIfObsolete('cornersItb1Line', 'rawCornersItb1LineIndex', 'cornersItb1Over', 'cornersItb1Under', 'cornersItb1Lines', home);
      stepIfObsolete('cornersItb2Line', 'rawCornersItb2LineIndex', 'cornersItb2Over', 'cornersItb2Under', 'cornersItb2Lines', away);
    };

    const ev = this.eventsMap.get(eventId);
    if (ev?.odds?.[periodKey]) {
      advanceCornerOdds(ev.odds[periodKey]);
    }
    if (this.activeEventId === eventId && this.liveOdds[periodKey]) {
      advanceCornerOdds(this.liveOdds[periodKey]);
    }
  }

  /**
   * Normalizes a team name by stripping "(Corners)" / "(Угловые)" suffix.
   * @param {string} name
   * @returns {string}
   */
  _normalizeBaseTeamName(name) {
    if (!name) return '';
    return String(name)
      .replace(/\s*\((?:corners?|угловые)\)\s*/gi, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Links a companion (Corners) event to its parent normal football match (or vice versa)
   * so corner ITB/Total lines from companion events are automatically merged into the main match.
   * @param {Object} updatedEvent
   */
  _linkCornersEvent(updatedEvent) {
    if (!updatedEvent || !updatedEvent.eventId) return;
    const isCorn = Boolean(
      updatedEvent.isCorners ||
      updatedEvent.eventType === 'corners' ||
      /\b(?:corners?|угловые)\b/i.test(updatedEvent.homeTeam || '') ||
      /\b(?:corners?|угловые)\b/i.test(updatedEvent.awayTeam || '') ||
      /\b(?:corners?|угловые)\b/i.test(updatedEvent.competition || '')
    );
    updatedEvent.isCorners = isCorn;

    const baseHome = this._normalizeBaseTeamName(updatedEvent.homeTeam);
    const baseAway = this._normalizeBaseTeamName(updatedEvent.awayTeam);
    if (!baseHome || !baseAway || baseHome === 'home') return;

    for (const [otherId, otherEv] of this.eventsMap.entries()) {
      if (otherId === updatedEvent.eventId) continue;
      const otherIsCorn = Boolean(
        otherEv.isCorners ||
        otherEv.eventType === 'corners' ||
        /\b(?:corners?|угловые)\b/i.test(otherEv.homeTeam || '') ||
        /\b(?:corners?|угловые)\b/i.test(otherEv.awayTeam || '') ||
        /\b(?:corners?|угловые)\b/i.test(otherEv.competition || '')
      );
      if (isCorn === otherIsCorn) continue;

      const otherHome = this._normalizeBaseTeamName(otherEv.homeTeam);
      const otherAway = this._normalizeBaseTeamName(otherEv.awayTeam);
      if (baseHome === otherHome && baseAway === otherAway) {
        const parentEv = isCorn ? otherEv : updatedEvent;
        const cornersEv = isCorn ? updatedEvent : otherEv;
        parentEv.cornersEventId = cornersEv.eventId;
        cornersEv.parentEventId = parentEv.eventId;

        if (cornersEv.odds) {
          if (!parentEv.odds) parentEv.odds = { ft: {}, ht: {} };
          for (const pk of ['ft', 'ht']) {
            if (cornersEv.odds[pk]) {
              if (!parentEv.odds[pk]) parentEv.odds[pk] = {};
              this._mergeCornersIntoPeriodOdds(parentEv.odds[pk], cornersEv.odds[pk]);
              if (this.activeEventId === parentEv.eventId && this.liveOdds[pk]) {
                this._mergeCornersIntoPeriodOdds(this.liveOdds[pk], cornersEv.odds[pk]);
              }
            }
          }
        }

        if (this.activeEventId === parentEv.eventId && this.wsFeed) {
          this.wsFeed.subscribeToEvent(
            parentEv.competitionId,
            parentEv.sport,
            parentEv.eventId,
            cornersEv.eventId,
            cornersEv.competitionId || parentEv.competitionId
          );
        }
        break;
      }
    }
  }

  /**
   * Copies corner ITB1, ITB2, and Total lines from a source odds object (either inline corners or a companion Corners event)
   * into a target period odds object.
   * @param {Object} targetPeriodOdds
   * @param {Object} sourceOdds
   */
  _mergeCornersIntoPeriodOdds(targetPeriodOdds, sourceOdds) {
    if (!targetPeriodOdds || !sourceOdds) return;

    const hasInlineTotal = (sourceOdds.cornersTotalLines && sourceOdds.cornersTotalLines.length > 0) || sourceOdds.cornersTotalOver > 0;
    const hasInlineItb1 = (sourceOdds.cornersItb1Lines && sourceOdds.cornersItb1Lines.length > 0) || sourceOdds.cornersItb1Over > 0;
    const hasInlineItb2 = (sourceOdds.cornersItb2Lines && sourceOdds.cornersItb2Lines.length > 0) || sourceOdds.cornersItb2Over > 0;

    const cTotalLines = (sourceOdds.cornersTotalLines && sourceOdds.cornersTotalLines.length > 0)
      ? sourceOdds.cornersTotalLines
      : (sourceOdds.totalLines || []);
    const cItb1Lines = (sourceOdds.cornersItb1Lines && sourceOdds.cornersItb1Lines.length > 0)
      ? sourceOdds.cornersItb1Lines
      : (sourceOdds.itb1Lines || []);
    const cItb2Lines = (sourceOdds.cornersItb2Lines && sourceOdds.cornersItb2Lines.length > 0)
      ? sourceOdds.cornersItb2Lines
      : (sourceOdds.itb2Lines || []);

    if (cTotalLines.length > 0 || sourceOdds.cornersTotalOver > 0 || sourceOdds.totalOver > 0) {
      targetPeriodOdds.cornersTotalLines = cTotalLines;
      targetPeriodOdds.cornersTotalOver = sourceOdds.cornersTotalOver || sourceOdds.totalOver || 0;
      targetPeriodOdds.cornersTotalUnder = sourceOdds.cornersTotalUnder || sourceOdds.totalUnder || 0;
      targetPeriodOdds.cornersTotalLine = (hasInlineTotal ? sourceOdds.cornersTotalLine : sourceOdds.totalLine) || targetPeriodOdds.cornersTotalLine || '9.5';
      targetPeriodOdds.rawCornersTotalLineIndex = (hasInlineTotal ? sourceOdds.rawCornersTotalLineIndex : sourceOdds.rawTotalLineIndex) ?? targetPeriodOdds.rawCornersTotalLineIndex ?? 38;
    }

    if (cItb1Lines.length > 0 || sourceOdds.cornersItb1Over > 0 || sourceOdds.itb1Over > 0) {
      targetPeriodOdds.cornersItb1Lines = cItb1Lines;
      targetPeriodOdds.cornersItb1Over = sourceOdds.cornersItb1Over || sourceOdds.itb1Over || 0;
      targetPeriodOdds.cornersItb1Under = sourceOdds.cornersItb1Under || sourceOdds.itb1Under || 0;
      targetPeriodOdds.cornersItb1Line = (hasInlineItb1 ? sourceOdds.cornersItb1Line : sourceOdds.itb1Line) || targetPeriodOdds.cornersItb1Line || '4.5';
      targetPeriodOdds.rawCornersItb1LineIndex = (hasInlineItb1 ? sourceOdds.rawCornersItb1LineIndex : sourceOdds.rawItb1LineIndex) ?? targetPeriodOdds.rawCornersItb1LineIndex ?? 18;
    }

    if (cItb2Lines.length > 0 || sourceOdds.cornersItb2Over > 0 || sourceOdds.itb2Over > 0) {
      targetPeriodOdds.cornersItb2Lines = cItb2Lines;
      targetPeriodOdds.cornersItb2Over = sourceOdds.cornersItb2Over || sourceOdds.itb2Over || 0;
      targetPeriodOdds.cornersItb2Under = sourceOdds.cornersItb2Under || sourceOdds.itb2Under || 0;
      targetPeriodOdds.cornersItb2Line = (hasInlineItb2 ? sourceOdds.cornersItb2Line : sourceOdds.itb2Line) || targetPeriodOdds.cornersItb2Line || '4.5';
      targetPeriodOdds.rawCornersItb2LineIndex = (hasInlineItb2 ? sourceOdds.rawCornersItb2LineIndex : sourceOdds.rawItb2LineIndex) ?? targetPeriodOdds.rawCornersItb2LineIndex ?? 18;
    }
  }

  /**
   * Updates match metadata from WebSocket event frame.
   * @param {Object} data
   */
  updateEventMetadata(data) {
    const { eventId } = data;
    if (!eventId) return;

    const existing = this.eventsMap.get(eventId) || {};
    const prevHockeyPeriod = existing.hockeyPeriod || (this.activeEventId === eventId ? this.currentHockeyPeriod : 1) || 1;
    const sport = String(data.sport || existing.sport || 'fb');
    const isHockey = sport === 'ih';
    const isHtSport = sport === 'fb_ht';
    const isCornersSport = Boolean(
      data.isCornersSport ||
      sport.includes('corn') ||
      sport === 'fb_c' ||
      sport === 'fb_c_ht'
    );

    if (isCornersSport) {
      const isCornHt = sport === 'fb_corn_ht' || sport === 'fb_c_ht';
      const incomingCornersScore = data.score
        ? { home: Number(data.score.home) || 0, away: Number(data.score.away) || 0 }
        : null;

      const updatedCornTarget = {
        ...existing,
        eventId,
        sport: existing.sport || 'fb',
        eventType: existing.eventType || 'normal',
        isCorners: Boolean(existing.isCorners),
        competitionId: existing.competitionId || data.competitionId || 0,
        competition: existing.competition || data.competition || 'Soccer',
        homeTeam: existing.homeTeam || data.homeTeam || 'Home',
        awayTeam: existing.awayTeam || data.awayTeam || 'Away',
        score: existing.score || { home: 0, away: 0 },
        ftScore: existing.ftScore || existing.score || { home: 0, away: 0 },
        htScore: existing.htScore,
        minute: existing.minute || data.minute || '',
        isLive: Boolean(existing.isLive || data.isLive),
        startTs: existing.startTs || data.startTs || '',
        lastUpdate: Date.now()
      };

      if (incomingCornersScore) {
        if (isCornHt) {
          updatedCornTarget.cornersHtScore = incomingCornersScore;
        } else {
          updatedCornTarget.cornersFtScore = incomingCornersScore;
        }
        if (this.wsFeed && typeof this.wsFeed.syncEventScore === 'function') {
          this.wsFeed.syncEventScore(eventId, sport, incomingCornersScore);
        }
      }

      this.eventsMap.set(eventId, updatedCornTarget);
      if (incomingCornersScore) {
        this._reconcileCornersOddsWithScore(eventId, isCornHt ? 'ht' : 'ft', incomingCornersScore);
      }
      if (this.activeEventId === eventId) {
        this.emit('state_updated');
      }
      return;
    }

    const updated = {
      ...existing,
      ...data,
      sport: (existing.sport && existing.sport !== 'fb_ht' && isHtSport) ? existing.sport : sport,
      lastUpdate: Date.now()
    };

    if (isHockey) {
      const newHockeyPeriod = Number(data.hockeyPeriod || existing.hockeyPeriod) || 1;
      updated.hockeyPeriod = newHockeyPeriod;
      if (data.htScore) {
        updated.htScore = {
          home: Number(data.htScore.home) || 0,
          away: Number(data.htScore.away) || 0
        };
      }
    }

    if (data.score) {
      const incomingScore = {
        home: Number(data.score.home) || 0,
        away: Number(data.score.away) || 0
      };

      if (isHtSport) {
        existing.htScore = incomingScore;
        updated.htScore = incomingScore;
        if (this.wsFeed && typeof this.wsFeed.syncEventScore === 'function') {
          this.wsFeed.syncEventScore(eventId, 'fb_ht', incomingScore);
        }
      } else {
        existing.ftScore = incomingScore;
        updated.ftScore = incomingScore;
        if (this.wsFeed && typeof this.wsFeed.syncEventScore === 'function') {
          this.wsFeed.syncEventScore(eventId, isHockey ? `${eventId}:ih:FT` : sport, incomingScore);
          if (updated.htScore) {
            this.wsFeed.syncEventScore(
              eventId,
              isHockey ? `${eventId}:ih:P${updated.hockeyPeriod || 1}` : 'fb_ht',
              updated.htScore
            );
          }
        }
      }
    }

    this.eventsMap.set(eventId, updated);
    this._linkCornersEvent(updated);

    if (data.score) {
      const incomingScore = {
        home: Number(data.score.home) || 0,
        away: Number(data.score.away) || 0
      };
      if (isHtSport) {
        this._reconcileOddsWithScore(eventId, 'ht', incomingScore);
      } else {
        this._reconcileOddsWithScore(eventId, 'ft', incomingScore);
        if (updated.htScore) {
          this._reconcileOddsWithScore(eventId, 'ht', updated.htScore);
        }
      }
    }

    if (this.activeEventId === eventId) {
      let hockeyPeriodSwitched = false;
      if (isHockey) {
        const newHockeyPeriod = updated.hockeyPeriod || 1;
        this.currentHockeyPeriod = newHockeyPeriod;

        if (prevHockeyPeriod !== newHockeyPeriod) {
          hockeyPeriodSwitched = true;
          this.liveScoreHt = updated.htScore ? { ...updated.htScore } : { home: 0, away: 0 };
          this.liveOdds.ht = this.createEmptyPeriodOdds('HT', 'ih');
          if (updated.odds) {
            updated.odds.ht = this.createEmptyPeriodOdds('HT', 'ih');
          }

          if (this.activePeriod === 'HT') {
            this.liveScore = { ...this.liveScoreHt };
            logger.warn('StateManager', `HOCKEY PERIOD CHANGED in match ${eventId}: P${prevHockeyPeriod} -> P${newHockeyPeriod}! Resetting period betslips and re-arming for P${newHockeyPeriod}!`);

            if (this.adapter) {
              for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
                const slip = this.armedBetslips[key];
                if (slip && slip.betslipId) {
                  this.adapter.deleteBetslip(slip.betslipId).catch(() => {});
                  slip.betslipId = null;
                }
              }
            }

            this.armedBetslips = this.createEmptySlips('HT', this.activeMarketMode);
            this.armedPool.set(this.activeEventId, this.armedBetslips);
            this.emit('hockey_period_changed', { eventId, prevPeriod: prevHockeyPeriod, newPeriod: newHockeyPeriod });
            this.refreshAllBetslips(true);
          }
        }
      }

      if (data.score) {
        const incomingScore = {
          home: Number(data.score.home) || 0,
          away: Number(data.score.away) || 0
        };

        const clearPreGoalPrices = () => {
          for (const k of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
            const s = this.armedBetslips[k];
            if (s) {
              s.bookiePrice = null;
              s.bookiePriceTs = 0;
              s.currentPrice = 0;
            }
          }
        };

        if (isHtSport) {
          const prevHt = `${this.liveScoreHt.home}-${this.liveScoreHt.away}`;
          const newHt = `${incomingScore.home}-${incomingScore.away}`;
          const htChanged = prevHt !== newHt;
          this.liveScoreHt = incomingScore;
          this._reconcileOddsWithScore(eventId, 'ht', incomingScore, htChanged);

          if (this.activePeriod === 'HT') {
            const prevActive = `${this.liveScore.home}-${this.liveScore.away}`;
            this.liveScore = { ...incomingScore };
            if (htChanged && prevActive !== newHt) {
              logger.warn('StateManager', `GOAL DETECTED in match ${eventId} [HT]: ${prevHt} -> ${newHt}! Refreshing betslips immediately!`);
              clearPreGoalPrices();
              this.emit('score_changed', { eventId, score: this.liveScore });
              this.refreshAllBetslips(true);
            }
          }
        } else {
          const prevFt = `${this.liveScoreFt.home}-${this.liveScoreFt.away}`;
          const newFt = `${incomingScore.home}-${incomingScore.away}`;
          const ftChanged = prevFt !== newFt;
          this.liveScoreFt = incomingScore;
          this._reconcileOddsWithScore(eventId, 'ft', incomingScore, ftChanged);

          if (updated.htScore && !hockeyPeriodSwitched) {
            const prevHt = `${this.liveScoreHt.home}-${this.liveScoreHt.away}`;
            const newHt = `${updated.htScore.home}-${updated.htScore.away}`;
            const htChanged = prevHt !== newHt;
            this.liveScoreHt = { ...updated.htScore };
            this._reconcileOddsWithScore(eventId, 'ht', this.liveScoreHt, htChanged);
            if (this.activePeriod === 'HT') {
              const prevActive = `${this.liveScore.home}-${this.liveScore.away}`;
              this.liveScore = { ...this.liveScoreHt };
              if (htChanged && prevActive !== newHt) {
                logger.warn('StateManager', `GOAL DETECTED in match ${eventId} [HT/P${this.currentHockeyPeriod}]: ${prevHt} -> ${newHt}! Refreshing betslips immediately!`);
                clearPreGoalPrices();
                this.emit('score_changed', { eventId, score: this.liveScore });
                this.refreshAllBetslips(true);
              }
            }
          }

          if (this.activePeriod === 'FT') {
            const prevActive = `${this.liveScore.home}-${this.liveScore.away}`;
            this.liveScore = { ...incomingScore };
            if (ftChanged && prevActive !== newFt) {
              logger.warn('StateManager', `GOAL DETECTED in match ${eventId} [FT]: ${prevFt} -> ${newFt}! Refreshing betslips immediately!`);
              clearPreGoalPrices();
              this.emit('score_changed', { eventId, score: this.liveScore });
              this.refreshAllBetslips(true);
            }
          }
        }
      }

      this.emit('state_updated');
    }
  }

  /**
   * Updates odds from WebSocket offers_hcap / offers_event frame.
   * Differentiates full-time (fb / ih FT) and period/half-time (fb_ht / ih HT) markets.
   * When a bookmaker closes/suspends a market, sets price to 0 without fabricating or keeping stale odds.
   * @param {Object} data
   */
  updateOdds(data) {
    const { eventId, sport, odds, updatedMarkets } = data;
    if (!eventId || !odds) return;

    const isHt = sport === 'fb_ht' || data.periodType === 'HT';
    const targetPeriod = isHt ? 'ht' : 'ft';

    const event = this.eventsMap.get(eventId);
    const isHockey = sport === 'ih' || event?.sport === 'ih';
    const defTotalLine = isHockey ? (isHt ? '1.5' : '5.5') : (isHt ? '0.5' : '2.5');
    const defTotalIdx = isHockey ? (isHt ? 6 : 22) : (isHt ? 2 : 10);
    const defItbLine = isHockey ? (isHt ? '0.5' : '2.5') : (isHt ? '0.5' : '1.5');
    const defItbIdx = isHockey ? (isHt ? 2 : 10) : (isHt ? 2 : 6);
    const defCornersTotalLine = isHt ? '4.5' : '9.5';
    const defCornersTotalIdx = isHt ? 18 : 38;
    const defCornersItbLine = isHt ? '1.5' : '4.5';
    const defCornersItbIdx = isHt ? 6 : 18;

    const isCornersSport = Boolean(
      String(sport || '').includes('corn') ||
      sport === 'fb_c' ||
      sport === 'fb_c_ht'
    );
    const isCompanionCornersEvent = Boolean(
      !isCornersSport && (event?.isCorners || event?.eventType === 'corners')
    );

    if (event) {
      if (isHockey && data.hockeyPeriod && !event.hockeyPeriod) {
        event.hockeyPeriod = data.hockeyPeriod;
      }
      if (!event.odds) {
        event.odds = { ft: {}, ht: {} };
      } else if (!event.odds.ft) {
        event.odds = { ft: { ...event.odds }, ht: {} };
      }

      const prevPeriodOdds = event.odds[targetPeriod] || {};

      if (updatedMarkets) {
        // Market-level updates: if market was updated in tick, take exact value (including 0 when closed)
        event.odds[targetPeriod] = {
          totalOver: updatedMarkets.ahou ? (odds.totalOver || 0) : (prevPeriodOdds.totalOver || 0),
          totalUnder: updatedMarkets.ahou ? (odds.totalUnder || 0) : (prevPeriodOdds.totalUnder || 0),
          winHome: updatedMarkets.wdw ? (odds.winHome || 0) : (prevPeriodOdds.winHome || 0),
          winDraw: updatedMarkets.wdw ? (odds.winDraw || 0) : (prevPeriodOdds.winDraw || 0),
          winAway: updatedMarkets.wdw ? (odds.winAway || 0) : (prevPeriodOdds.winAway || 0),
          totalLine: odds.totalLine || prevPeriodOdds.totalLine || defTotalLine,
          rawTotalLineIndex: odds.rawTotalLineIndex ?? prevPeriodOdds.rawTotalLineIndex ?? defTotalIdx,
          totalLines: (odds.totalLines && odds.totalLines.length > 0) ? odds.totalLines : (prevPeriodOdds.totalLines || []),
          itb1Over: updatedMarkets.itb1 ? (odds.itb1Over || 0) : (prevPeriodOdds.itb1Over || 0),
          itb1Under: updatedMarkets.itb1 ? (odds.itb1Under || 0) : (prevPeriodOdds.itb1Under || 0),
          itb1Line: odds.itb1Line || prevPeriodOdds.itb1Line || defItbLine,
          rawItb1LineIndex: odds.rawItb1LineIndex ?? prevPeriodOdds.rawItb1LineIndex ?? defItbIdx,
          itb1Lines: (odds.itb1Lines && odds.itb1Lines.length > 0) ? odds.itb1Lines : (prevPeriodOdds.itb1Lines || []),
          itb2Over: updatedMarkets.itb2 ? (odds.itb2Over || 0) : (prevPeriodOdds.itb2Over || 0),
          itb2Under: updatedMarkets.itb2 ? (odds.itb2Under || 0) : (prevPeriodOdds.itb2Under || 0),
          itb2Line: odds.itb2Line || prevPeriodOdds.itb2Line || defItbLine,
          rawItb2LineIndex: odds.rawItb2LineIndex ?? prevPeriodOdds.rawItb2LineIndex ?? defItbIdx,
          itb2Lines: (odds.itb2Lines && odds.itb2Lines.length > 0) ? odds.itb2Lines : (prevPeriodOdds.itb2Lines || []),
          cornersTotalOver: updatedMarkets.cornersAhou ? (odds.cornersTotalOver || 0) : (prevPeriodOdds.cornersTotalOver || 0),
          cornersTotalUnder: updatedMarkets.cornersAhou ? (odds.cornersTotalUnder || 0) : (prevPeriodOdds.cornersTotalUnder || 0),
          cornersTotalLine: odds.cornersTotalLine || prevPeriodOdds.cornersTotalLine || defCornersTotalLine,
          rawCornersTotalLineIndex: odds.rawCornersTotalLineIndex ?? prevPeriodOdds.rawCornersTotalLineIndex ?? defCornersTotalIdx,
          cornersTotalLines: (odds.cornersTotalLines && odds.cornersTotalLines.length > 0) ? odds.cornersTotalLines : (prevPeriodOdds.cornersTotalLines || []),
          cornersItb1Over: updatedMarkets.cornersItb1 ? (odds.cornersItb1Over || 0) : (prevPeriodOdds.cornersItb1Over || 0),
          cornersItb1Under: updatedMarkets.cornersItb1 ? (odds.cornersItb1Under || 0) : (prevPeriodOdds.cornersItb1Under || 0),
          cornersItb1Line: odds.cornersItb1Line || prevPeriodOdds.cornersItb1Line || defCornersItbLine,
          rawCornersItb1LineIndex: odds.rawCornersItb1LineIndex ?? prevPeriodOdds.rawCornersItb1LineIndex ?? defCornersItbIdx,
          cornersItb1Lines: (odds.cornersItb1Lines && odds.cornersItb1Lines.length > 0) ? odds.cornersItb1Lines : (prevPeriodOdds.cornersItb1Lines || []),
          cornersItb2Over: updatedMarkets.cornersItb2 ? (odds.cornersItb2Over || 0) : (prevPeriodOdds.cornersItb2Over || 0),
          cornersItb2Under: updatedMarkets.cornersItb2 ? (odds.cornersItb2Under || 0) : (prevPeriodOdds.cornersItb2Under || 0),
          cornersItb2Line: odds.cornersItb2Line || prevPeriodOdds.cornersItb2Line || defCornersItbLine,
          rawCornersItb2LineIndex: odds.rawCornersItb2LineIndex ?? prevPeriodOdds.rawCornersItb2LineIndex ?? defCornersItbIdx,
          cornersItb2Lines: (odds.cornersItb2Lines && odds.cornersItb2Lines.length > 0) ? odds.cornersItb2Lines : (prevPeriodOdds.cornersItb2Lines || [])
        };
      } else {
        // Fallback for partial/synthetic updates (e.g. tests)
        event.odds[targetPeriod] = {
          totalOver: (odds.totalOver && odds.totalOver > 0) ? odds.totalOver : (prevPeriodOdds.totalOver || 0),
          totalUnder: (odds.totalUnder && odds.totalUnder > 0) ? odds.totalUnder : (prevPeriodOdds.totalUnder || 0),
          winHome: (odds.winHome && odds.winHome > 0) ? odds.winHome : (prevPeriodOdds.winHome || 0),
          winDraw: (odds.winDraw && odds.winDraw > 0) ? odds.winDraw : (prevPeriodOdds.winDraw || 0),
          winAway: (odds.winAway && odds.winAway > 0) ? odds.winAway : (prevPeriodOdds.winAway || 0),
          totalLine: odds.totalLine || prevPeriodOdds.totalLine || defTotalLine,
          rawTotalLineIndex: odds.rawTotalLineIndex ?? prevPeriodOdds.rawTotalLineIndex ?? defTotalIdx,
          totalLines: (odds.totalLines && odds.totalLines.length > 0) ? odds.totalLines : (prevPeriodOdds.totalLines || []),
          itb1Over: (odds.itb1Over && odds.itb1Over > 0) ? odds.itb1Over : (prevPeriodOdds.itb1Over || 0),
          itb1Under: (odds.itb1Under && odds.itb1Under > 0) ? odds.itb1Under : (prevPeriodOdds.itb1Under || 0),
          itb1Line: odds.itb1Line || prevPeriodOdds.itb1Line || defItbLine,
          rawItb1LineIndex: odds.rawItb1LineIndex ?? prevPeriodOdds.rawItb1LineIndex ?? defItbIdx,
          itb1Lines: (odds.itb1Lines && odds.itb1Lines.length > 0) ? odds.itb1Lines : (prevPeriodOdds.itb1Lines || []),
          itb2Over: (odds.itb2Over && odds.itb2Over > 0) ? odds.itb2Over : (prevPeriodOdds.itb2Over || 0),
          itb2Under: (odds.itb2Under && odds.itb2Under > 0) ? odds.itb2Under : (prevPeriodOdds.itb2Under || 0),
          itb2Line: odds.itb2Line || prevPeriodOdds.itb2Line || defItbLine,
          rawItb2LineIndex: odds.rawItb2LineIndex ?? prevPeriodOdds.rawItb2LineIndex ?? defItbIdx,
          itb2Lines: (odds.itb2Lines && odds.itb2Lines.length > 0) ? odds.itb2Lines : (prevPeriodOdds.itb2Lines || []),
          cornersTotalOver: (odds.cornersTotalOver && odds.cornersTotalOver > 0) ? odds.cornersTotalOver : (prevPeriodOdds.cornersTotalOver || 0),
          cornersTotalUnder: (odds.cornersTotalUnder && odds.cornersTotalUnder > 0) ? odds.cornersTotalUnder : (prevPeriodOdds.cornersTotalUnder || 0),
          cornersTotalLine: odds.cornersTotalLine || prevPeriodOdds.cornersTotalLine || defCornersTotalLine,
          rawCornersTotalLineIndex: odds.rawCornersTotalLineIndex ?? prevPeriodOdds.rawCornersTotalLineIndex ?? defCornersTotalIdx,
          cornersTotalLines: (odds.cornersTotalLines && odds.cornersTotalLines.length > 0) ? odds.cornersTotalLines : (prevPeriodOdds.cornersTotalLines || []),
          cornersItb1Over: (odds.cornersItb1Over && odds.cornersItb1Over > 0) ? odds.cornersItb1Over : (prevPeriodOdds.cornersItb1Over || 0),
          cornersItb1Under: (odds.cornersItb1Under && odds.cornersItb1Under > 0) ? odds.cornersItb1Under : (prevPeriodOdds.cornersItb1Under || 0),
          cornersItb1Line: odds.cornersItb1Line || prevPeriodOdds.cornersItb1Line || defCornersItbLine,
          rawCornersItb1LineIndex: odds.rawCornersItb1LineIndex ?? prevPeriodOdds.rawCornersItb1LineIndex ?? defCornersItbIdx,
          cornersItb1Lines: (odds.cornersItb1Lines && odds.cornersItb1Lines.length > 0) ? odds.cornersItb1Lines : (prevPeriodOdds.cornersItb1Lines || []),
          cornersItb2Over: (odds.cornersItb2Over && odds.cornersItb2Over > 0) ? odds.cornersItb2Over : (prevPeriodOdds.cornersItb2Over || 0),
          cornersItb2Under: (odds.cornersItb2Under && odds.cornersItb2Under > 0) ? odds.cornersItb2Under : (prevPeriodOdds.cornersItb2Under || 0),
          cornersItb2Line: odds.cornersItb2Line || prevPeriodOdds.cornersItb2Line || defCornersItbLine,
          rawCornersItb2LineIndex: odds.rawCornersItb2LineIndex ?? prevPeriodOdds.rawCornersItb2LineIndex ?? defCornersItbIdx,
          cornersItb2Lines: (odds.cornersItb2Lines && odds.cornersItb2Lines.length > 0) ? odds.cornersItb2Lines : (prevPeriodOdds.cornersItb2Lines || [])
        };
      }

      if (isCompanionCornersEvent) {
        // In a separate companion (Corners) event, standard ahou / tahou,h / tahou,a ARE the corner markets
        this._mergeCornersIntoPeriodOdds(event.odds[targetPeriod], event.odds[targetPeriod]);
        if (event.parentEventId) {
          const parentEv = this.eventsMap.get(event.parentEventId);
          if (parentEv) {
            if (!parentEv.odds) parentEv.odds = { ft: {}, ht: {} };
            if (!parentEv.odds[targetPeriod]) parentEv.odds[targetPeriod] = {};
            this._mergeCornersIntoPeriodOdds(parentEv.odds[targetPeriod], event.odds[targetPeriod]);
          }
          if (this.activeEventId === event.parentEventId) {
            this._mergeCornersIntoPeriodOdds(this.liveOdds[targetPeriod], event.odds[targetPeriod]);
            this.emit('state_updated');
          }
        }
      }

      event.lastUpdate = Date.now();
      const evScore = isHt ? (event.htScore || { home: 0, away: 0 }) : (event.ftScore || event.score || { home: 0, away: 0 });
      this._reconcileOddsWithScore(eventId, targetPeriod, evScore);
      const evCornScore = isHt ? event.cornersHtScore : event.cornersFtScore;
      if (evCornScore) {
        this._reconcileCornersOddsWithScore(eventId, targetPeriod, evCornScore);
      }
    }

    if (this.activeEventId === eventId) {
      const pOdds = this.liveOdds[targetPeriod];

      if (updatedMarkets) {
        if (updatedMarkets.ahou) {
          if (odds.totalLines && odds.totalLines.length > 0) pOdds.totalLines = odds.totalLines;
          pOdds.totalOver = odds.totalOver || 0;
          pOdds.totalUnder = odds.totalUnder || 0;
          if (odds.totalLine) pOdds.totalLine = odds.totalLine;
          if (odds.rawTotalLineIndex != null) pOdds.rawTotalLineIndex = odds.rawTotalLineIndex;
        }
        if (updatedMarkets.wdw) {
          pOdds.winHome = odds.winHome || 0;
          pOdds.winDraw = odds.winDraw || 0;
          pOdds.winAway = odds.winAway || 0;
        }
        if (updatedMarkets.itb1) {
          if (odds.itb1Lines && odds.itb1Lines.length > 0) pOdds.itb1Lines = odds.itb1Lines;
          pOdds.itb1Over = odds.itb1Over || 0;
          pOdds.itb1Under = odds.itb1Under || 0;
          if (odds.itb1Line) pOdds.itb1Line = odds.itb1Line;
          if (odds.rawItb1LineIndex != null) pOdds.rawItb1LineIndex = odds.rawItb1LineIndex;
        }
        if (updatedMarkets.itb2) {
          if (odds.itb2Lines && odds.itb2Lines.length > 0) pOdds.itb2Lines = odds.itb2Lines;
          pOdds.itb2Over = odds.itb2Over || 0;
          pOdds.itb2Under = odds.itb2Under || 0;
          if (odds.itb2Line) pOdds.itb2Line = odds.itb2Line;
          if (odds.rawItb2LineIndex != null) pOdds.rawItb2LineIndex = odds.rawItb2LineIndex;
        }
        if (updatedMarkets.cornersAhou) {
          if (odds.cornersTotalLines && odds.cornersTotalLines.length > 0) pOdds.cornersTotalLines = odds.cornersTotalLines;
          pOdds.cornersTotalOver = odds.cornersTotalOver || 0;
          pOdds.cornersTotalUnder = odds.cornersTotalUnder || 0;
          if (odds.cornersTotalLine) pOdds.cornersTotalLine = odds.cornersTotalLine;
          if (odds.rawCornersTotalLineIndex != null) pOdds.rawCornersTotalLineIndex = odds.rawCornersTotalLineIndex;
        }
        if (updatedMarkets.cornersItb1) {
          if (odds.cornersItb1Lines && odds.cornersItb1Lines.length > 0) pOdds.cornersItb1Lines = odds.cornersItb1Lines;
          pOdds.cornersItb1Over = odds.cornersItb1Over || 0;
          pOdds.cornersItb1Under = odds.cornersItb1Under || 0;
          if (odds.cornersItb1Line) pOdds.cornersItb1Line = odds.cornersItb1Line;
          if (odds.rawCornersItb1LineIndex != null) pOdds.rawCornersItb1LineIndex = odds.rawCornersItb1LineIndex;
        }
        if (updatedMarkets.cornersItb2) {
          if (odds.cornersItb2Lines && odds.cornersItb2Lines.length > 0) pOdds.cornersItb2Lines = odds.cornersItb2Lines;
          pOdds.cornersItb2Over = odds.cornersItb2Over || 0;
          pOdds.cornersItb2Under = odds.cornersItb2Under || 0;
          if (odds.cornersItb2Line) pOdds.cornersItb2Line = odds.cornersItb2Line;
          if (odds.rawCornersItb2LineIndex != null) pOdds.rawCornersItb2LineIndex = odds.rawCornersItb2LineIndex;
        }
      } else {
        if (odds.totalLines && odds.totalLines.length > 0) pOdds.totalLines = odds.totalLines;
        if (odds.totalOver > 0) pOdds.totalOver = odds.totalOver;
        if (odds.totalUnder > 0) pOdds.totalUnder = odds.totalUnder;
        if (odds.winHome > 0) pOdds.winHome = odds.winHome;
        if (odds.winDraw > 0) pOdds.winDraw = odds.winDraw;
        if (odds.winAway > 0) pOdds.winAway = odds.winAway;
        if (odds.totalLine) pOdds.totalLine = odds.totalLine;
        if (odds.rawTotalLineIndex != null) pOdds.rawTotalLineIndex = odds.rawTotalLineIndex;

        if (odds.itb1Lines && odds.itb1Lines.length > 0) pOdds.itb1Lines = odds.itb1Lines;
        if (odds.itb1Over > 0) pOdds.itb1Over = odds.itb1Over;
        if (odds.itb1Under > 0) pOdds.itb1Under = odds.itb1Under;
        if (odds.itb1Line) pOdds.itb1Line = odds.itb1Line;
        if (odds.rawItb1LineIndex != null) pOdds.rawItb1LineIndex = odds.rawItb1LineIndex;

        if (odds.itb2Lines && odds.itb2Lines.length > 0) pOdds.itb2Lines = odds.itb2Lines;
        if (odds.itb2Over > 0) pOdds.itb2Over = odds.itb2Over;
        if (odds.itb2Under > 0) pOdds.itb2Under = odds.itb2Under;
        if (odds.itb2Line) pOdds.itb2Line = odds.itb2Line;
        if (odds.rawItb2LineIndex != null) pOdds.rawItb2LineIndex = odds.rawItb2LineIndex;

        if (odds.cornersTotalLines && odds.cornersTotalLines.length > 0) pOdds.cornersTotalLines = odds.cornersTotalLines;
        if (odds.cornersTotalOver > 0) pOdds.cornersTotalOver = odds.cornersTotalOver;
        if (odds.cornersTotalUnder > 0) pOdds.cornersTotalUnder = odds.cornersTotalUnder;
        if (odds.cornersTotalLine) pOdds.cornersTotalLine = odds.cornersTotalLine;
        if (odds.rawCornersTotalLineIndex != null) pOdds.rawCornersTotalLineIndex = odds.rawCornersTotalLineIndex;

        if (odds.cornersItb1Lines && odds.cornersItb1Lines.length > 0) pOdds.cornersItb1Lines = odds.cornersItb1Lines;
        if (odds.cornersItb1Over > 0) pOdds.cornersItb1Over = odds.cornersItb1Over;
        if (odds.cornersItb1Under > 0) pOdds.cornersItb1Under = odds.cornersItb1Under;
        if (odds.cornersItb1Line) pOdds.cornersItb1Line = odds.cornersItb1Line;
        if (odds.rawCornersItb1LineIndex != null) pOdds.rawCornersItb1LineIndex = odds.rawCornersItb1LineIndex;

        if (odds.cornersItb2Lines && odds.cornersItb2Lines.length > 0) pOdds.cornersItb2Lines = odds.cornersItb2Lines;
        if (odds.cornersItb2Over > 0) pOdds.cornersItb2Over = odds.cornersItb2Over;
        if (odds.cornersItb2Under > 0) pOdds.cornersItb2Under = odds.cornersItb2Under;
        if (odds.cornersItb2Line) pOdds.cornersItb2Line = odds.cornersItb2Line;
        if (odds.rawCornersItb2LineIndex != null) pOdds.rawCornersItb2LineIndex = odds.rawCornersItb2LineIndex;
      }

      if (isCompanionCornersEvent) {
        this._mergeCornersIntoPeriodOdds(pOdds, pOdds);
      }

      // Enforce score-based minimum line constraints (never keep a line <= goals scored)
      const activePeriodScore = isHt ? this.liveScoreHt : this.liveScoreFt;
      this._reconcileOddsWithScore(eventId, targetPeriod, activePeriodScore);
      const activeCornScore = isHt ? event?.cornersHtScore : event?.cornersFtScore;
      if (activeCornScore) {
        this._reconcileCornersOddsWithScore(eventId, targetPeriod, activeCornScore);
      }

      // Check if user has an explicit manual line override for active period/market
      const overKey = isHt ? 'HT_OVER' : 'OVER';
      const userOver = this.getUserLineOverride(overKey, this.activeEventId);
      if (userOver) {
        pOdds.totalLine = userOver.totalLine;
        pOdds.rawTotalLineIndex = userOver.rawTotalLineIndex;
        const matchingLine = pOdds.totalLines.find(x => x.totalLine === userOver.totalLine);
        if (matchingLine) {
          pOdds.totalOver = matchingLine.totalOver || 0;
          pOdds.totalUnder = matchingLine.totalUnder || 0;
        }
      }

      const itb1Key = isHt ? 'HT_ITB1' : 'ITB1';
      const userItb1 = this.getUserLineOverride(itb1Key, this.activeEventId);
      if (userItb1) {
        pOdds.itb1Line = userItb1.totalLine;
        pOdds.rawItb1LineIndex = userItb1.rawTotalLineIndex;
        const matchingLine = pOdds.itb1Lines.find(x => x.totalLine === userItb1.totalLine);
        if (matchingLine) {
          pOdds.itb1Over = matchingLine.totalOver || 0;
          pOdds.itb1Under = matchingLine.totalUnder || 0;
        }
      }

      const itb2Key = isHt ? 'HT_ITB2' : 'ITB2';
      const userItb2 = this.getUserLineOverride(itb2Key, this.activeEventId);
      if (userItb2) {
        pOdds.itb2Line = userItb2.totalLine;
        pOdds.rawItb2LineIndex = userItb2.rawTotalLineIndex;
        const matchingLine = pOdds.itb2Lines.find(x => x.totalLine === userItb2.totalLine);
        if (matchingLine) {
          pOdds.itb2Over = matchingLine.totalOver || 0;
          pOdds.itb2Under = matchingLine.totalUnder || 0;
        }
      }

      const cOverKey = isHt ? 'HT_CORNERS_OVER' : 'CORNERS_OVER';
      const userCOver = this.getUserLineOverride(cOverKey, this.activeEventId);
      if (userCOver) {
        pOdds.cornersTotalLine = userCOver.totalLine;
        pOdds.rawCornersTotalLineIndex = userCOver.rawTotalLineIndex;
        const matchingLine = (pOdds.cornersTotalLines || []).find(x => x.totalLine === userCOver.totalLine);
        if (matchingLine) {
          pOdds.cornersTotalOver = matchingLine.totalOver || 0;
          pOdds.cornersTotalUnder = matchingLine.totalUnder || 0;
        }
      }

      const cItb1Key = isHt ? 'HT_CORNERS_ITB1' : 'CORNERS_ITB1';
      const userCItb1 = this.getUserLineOverride(cItb1Key, this.activeEventId);
      if (userCItb1) {
        pOdds.cornersItb1Line = userCItb1.totalLine;
        pOdds.rawCornersItb1LineIndex = userCItb1.rawTotalLineIndex;
        const matchingLine = (pOdds.cornersItb1Lines || []).find(x => x.totalLine === userCItb1.totalLine);
        if (matchingLine) {
          pOdds.cornersItb1Over = matchingLine.totalOver || 0;
          pOdds.cornersItb1Under = matchingLine.totalUnder || 0;
        }
      }

      const cItb2Key = isHt ? 'HT_CORNERS_ITB2' : 'CORNERS_ITB2';
      const userCItb2 = this.getUserLineOverride(cItb2Key, this.activeEventId);
      if (userCItb2) {
        pOdds.cornersItb2Line = userCItb2.totalLine;
        pOdds.rawCornersItb2LineIndex = userCItb2.rawTotalLineIndex;
        const matchingLine = (pOdds.cornersItb2Lines || []).find(x => x.totalLine === userCItb2.totalLine);
        if (matchingLine) {
          pOdds.cornersItb2Over = matchingLine.totalOver || 0;
          pOdds.cornersItb2Under = matchingLine.totalUnder || 0;
        }
      }

      // Update current active slips if this update belongs to current active period
      const currentActivePeriod = this.activePeriod === 'HT' ? 'ht' : 'ft';
      if (targetPeriod === currentActivePeriod) {
        const now = Date.now();
        const bookieQuoteTtl = 10000; // 10 seconds priority for fresh bookie PMM/slip quotes
        const allowed = this.getAllowedBookies();
        const hasStrictAllowed = allowed && allowed.size > 0;

        const overSlip = this.armedBetslips.OVER;
        if (overSlip && overSlip.betslipId && overSlip.betType && pOdds.rawTotalLineIndex != null && !overSlip.betType.endsWith(`,${pOdds.rawTotalLineIndex}`)) {
          overSlip.bookiePrice = null;
          overSlip.bookiePriceTs = 0;
          this.armTarget(overKey, true).catch(() => {});
        }
        const hasFreshOverBookie = overSlip.bookiePrice && (now - overSlip.bookiePriceTs < bookieQuoteTtl);
        if (!hasFreshOverBookie && (!updatedMarkets || updatedMarkets.ahou)) {
          if (hasStrictAllowed) {
            overSlip.currentPrice = 0;
            overSlip.priceSource = 'CLOSED';
          } else {
            overSlip.currentPrice = pOdds.totalOver;
          }
        }

        if (this.activeMarketMode === 'ITB') {
          const itb1Slip = this.armedBetslips.ITB1;
          if (itb1Slip && itb1Slip.betslipId && itb1Slip.betType && pOdds.rawItb1LineIndex != null && !itb1Slip.betType.endsWith(`,${pOdds.rawItb1LineIndex}`)) {
            itb1Slip.bookiePrice = null;
            itb1Slip.bookiePriceTs = 0;
            this.armTarget(itb1Key, true).catch(() => {});
          }
          const hasFreshItb1 = itb1Slip.bookiePrice && (now - itb1Slip.bookiePriceTs < bookieQuoteTtl);
          if (!hasFreshItb1 && (!updatedMarkets || updatedMarkets.itb1)) {
            if (hasStrictAllowed) {
              itb1Slip.currentPrice = 0;
              itb1Slip.priceSource = 'CLOSED';
            } else {
              itb1Slip.currentPrice = pOdds.itb1Over;
            }
          }

          const itb2Slip = this.armedBetslips.ITB2;
          if (itb2Slip && itb2Slip.betslipId && itb2Slip.betType && pOdds.rawItb2LineIndex != null && !itb2Slip.betType.endsWith(`,${pOdds.rawItb2LineIndex}`)) {
            itb2Slip.bookiePrice = null;
            itb2Slip.bookiePriceTs = 0;
            this.armTarget(itb2Key, true).catch(() => {});
          }
          const hasFreshItb2 = itb2Slip.bookiePrice && (now - itb2Slip.bookiePriceTs < bookieQuoteTtl);
          if (!hasFreshItb2 && (!updatedMarkets || updatedMarkets.itb2)) {
            if (hasStrictAllowed) {
              itb2Slip.currentPrice = 0;
              itb2Slip.priceSource = 'CLOSED';
            } else {
              itb2Slip.currentPrice = pOdds.itb2Over;
            }
          }
        } else {
          const homeSlip = this.armedBetslips.HOME;
          const hasFreshHome = homeSlip.bookiePrice && (now - homeSlip.bookiePriceTs < bookieQuoteTtl);
          if (!hasFreshHome && (!updatedMarkets || updatedMarkets.wdw)) {
            if (hasStrictAllowed) {
              homeSlip.currentPrice = 0;
              homeSlip.priceSource = 'CLOSED';
            } else {
              homeSlip.currentPrice = pOdds.winHome;
            }
          }

          const awaySlip = this.armedBetslips.AWAY;
          const hasFreshAway = awaySlip.bookiePrice && (now - awaySlip.bookiePriceTs < bookieQuoteTtl);
          if (!hasFreshAway && (!updatedMarkets || updatedMarkets.wdw)) {
            if (hasStrictAllowed) {
              awaySlip.currentPrice = 0;
              awaySlip.priceSource = 'CLOSED';
            } else {
              awaySlip.currentPrice = pOdds.winAway;
            }
          }
        }
      }

      this.emit('state_updated');
    }
  }

  /**
   * Returns the freshest live price for a targetKey across periods.
   * @param {'OVER' | 'HOME' | 'AWAY' | 'ITB1' | 'ITB2' | 'HT_OVER' | 'HT_HOME' | 'HT_AWAY' | 'HT_ITB1' | 'HT_ITB2'} targetKey
   * @returns {number}
   */
  getLivePrice(targetKey) {
    const isHt = targetKey.startsWith('HT_') || this.activePeriod === 'HT';
    const odds = isHt ? this.liveOdds.ht : this.liveOdds.ft;

    switch (targetKey) {
      case 'OVER':
      case 'HT_OVER':
        return Number(odds.totalOver) || 0;
      case 'HOME':
      case 'HT_HOME':
        return Number(odds.winHome) || 0;
      case 'DRAW':
      case 'HT_DRAW':
        return Number(odds.winDraw) || 0;
      case 'AWAY':
      case 'HT_AWAY':
        return Number(odds.winAway) || 0;
      case 'ITB1':
      case 'HT_ITB1':
        return Number(odds.itb1Over) || 0;
      case 'ITB2':
      case 'HT_ITB2':
        return Number(odds.itb2Over) || 0;
      case 'CORNERS_ITB1':
      case 'HT_CORNERS_ITB1':
        return Number(odds.cornersItb1Over) || 0;
      case 'CORNERS_ITB2':
      case 'HT_CORNERS_ITB2':
        return Number(odds.cornersItb2Over) || 0;
      default:
        return 0;
    }
  }

  /**
   * Retrieves the pre-armed betslip for instant execution.
   * Validates period and market mode context to prevent cross-period / cross-mode misfires.
   * @param {'OVER' | 'HOME' | 'DRAW' | 'AWAY' | 'ITB1' | 'ITB2' | 'CORNERS_ITB1' | 'CORNERS_ITB2' | 'HT_OVER' | 'HT_HOME' | 'HT_DRAW' | 'HT_AWAY' | 'HT_ITB1' | 'HT_ITB2' | 'HT_CORNERS_ITB1' | 'HT_CORNERS_ITB2'} targetKey
   * @returns {Object | null}
   */
  getArmedBetslip(targetKey) {
    if (!targetKey) return null;

    const isHtTarget = targetKey.startsWith('HT_');
    if (isHtTarget && this.activePeriod === 'FT') {
      logger.warn('StateManager', `[ABORT] Попытка выстрела [${targetKey}], но активен период [${this.activePeriod}]!`);
      return null;
    }
    if (!isHtTarget && this.activePeriod === 'HT') {
      logger.warn('StateManager', `[ABORT] Попытка выстрела [${targetKey}], но активен период [${this.activePeriod}]!`);
      return null;
    }

    const slotKey = targetKey.replace(/^HT_/, '');
    if ((slotKey === 'ITB1' || slotKey === 'ITB2') && this.activeMarketMode === 'MAIN') {
      logger.warn('StateManager', `[ABORT] Слот [${targetKey}] не взведен в режиме [${this.activeMarketMode}]!`);
      return null;
    }
    if ((slotKey === 'HOME' || slotKey === 'AWAY') && this.activeMarketMode === 'ITB') {
      logger.warn('StateManager', `[ABORT] Слот [${targetKey}] не взведен в режиме [${this.activeMarketMode}]!`);
      return null;
    }

    if (slotKey === 'OVER') return this.armedBetslips.OVER;
    if (slotKey === 'HOME') return this.armedBetslips.HOME;
    if (slotKey === 'DRAW') return this.armedBetslips.DRAW;
    if (slotKey === 'AWAY') return this.armedBetslips.AWAY;
    if (slotKey === 'ITB1') return this.armedBetslips.ITB1;
    if (slotKey === 'ITB2') return this.armedBetslips.ITB2;
    if (slotKey === 'CORNERS_ITB1') return this.armedBetslips.CORNERS_ITB1;
    if (slotKey === 'CORNERS_ITB2') return this.armedBetslips.CORNERS_ITB2;
    return this.armedBetslips[targetKey] || null;
  }

  /**
   * Returns the maximum stake limit for the target outcome or account.
   * Respects availableBalance when accountBalance and open stakes / explicit available balance are present.
   * @param {'OVER' | 'HOME' | 'AWAY' | 'HT_OVER' | 'HT_HOME' | 'HT_AWAY'} [targetKey]
   * @returns {number}
   */
  getMaxStakeLimit(targetKey = null) {
    let limit = 2000.0;
    if (this.accountBalance > 0) {
      if (this._explicitAvailableBalance !== null || this._wsOpenStakes !== null || this.openStakes > 0 || this.availableBalance > 0) {
        limit = this.availableBalance;
      } else {
        limit = this.accountBalance;
      }
    }
    if (targetKey) {
      const slip = this.getArmedBetslip(targetKey);
      if (slip && typeof slip.maxStake === 'number' && slip.maxStake > 0) {
        limit = Math.min(limit, slip.maxStake);
      }
    }
    return Number(limit.toFixed(2));
  }

  /**
   * Invalidates a betslip after firing to force immediate re-arm (or release on-demand slot).
   * @param {string} targetKey
   */
  invalidateBetslip(targetKey) {
    const slip = this.getArmedBetslip(targetKey);
    const slotKey = String(targetKey || '').replace(/^HT_/, '');
    const isOnDemandSlot = slotKey === 'DRAW' || slotKey === 'CORNERS_ITB1' || slotKey === 'CORNERS_ITB2';
    if (slip) {
      if (isOnDemandSlot && slip.betslipId && this.adapter && typeof this.adapter.deleteBetslip === 'function') {
        this.adapter.deleteBetslip(slip.betslipId).catch(() => {});
      }
      slip.betslipId = null;
      slip.expiryTs = 0;
    }
    if (!isOnDemandSlot) {
      this.armTarget(slip?.targetKey || targetKey, true).catch(() => {});
    }
  }

  /**
   * Pre-arms a single target key for a specific event with mutual exclusion.
   * @param {string} eventId
   * @param {'OVER' | 'HOME' | 'AWAY'} targetKey
   * @param {boolean} [force=false]
   * @param {boolean} [isRetry=false]
   */
  async armEventTarget(eventId, targetKey, force = false, isRetry = false) {
    if (!this.adapter || !eventId) return;

    let poolEntry = this.armedPool.get(eventId);
    if (!poolEntry) {
      if (eventId === this.activeEventId) {
        poolEntry = this.armedBetslips;
        this.armedPool.set(eventId, poolEntry);
      } else {
        return;
      }
    }

    const slotKey = targetKey.replace(/^HT_/, '');
    const slip = poolEntry[slotKey] || poolEntry[targetKey];
    if (!slip) return;

    const now = Date.now();
    if (slip.isArming) return;
    if (!force && slip.betslipId && (slip.expiryTs - now > 5000)) {
      return;
    }

    const backoffUntil = this.quotaBackoffMap.get(targetKey) || 0;
    if (now < backoffUntil) {
      return;
    }

    slip.isArming = true;
    slip.error = null;

    try {
      // RELEASE PREVIOUS BETSLIP FIRST:
      // Mollybet strictly enforces max 4 open betslips per session across the account.
      // If we request a new slip before deleting the previous one, concurrent slips count exceeds 4!
      if (slip.betslipId && this.adapter) {
        const oldSlipId = slip.betslipId;
        slip.betslipId = null;
        try {
          await this.adapter.deleteBetslip(oldSlipId);
        } catch {
          // Ignore delete failure, continue to arm new slip
        }
      }

      const activeEv = this.eventsMap.get(eventId);
      const isHockey = activeEv?.sport === 'ih';
      const isHt = targetKey.startsWith('HT_') || this.activePeriod === 'HT';
      const score = (eventId === this.activeEventId)
        ? (isHt ? this.liveScoreHt : this.liveScoreFt)
        : (isHt ? (activeEv?.htScore || { home: 0, away: 0 }) : (activeEv?.ftScore || activeEv?.score || { home: 0, away: 0 }));
      const odds = (eventId === this.activeEventId)
        ? (isHt ? this.liveOdds.ht : this.liveOdds.ft)
        : (activeEv?.odds ? (isHt ? (activeEv.odds.ht || {}) : (activeEv.odds.ft || activeEv.odds)) : {});

      const defTotalLine = isHockey ? (isHt ? '1.5' : '5.5') : (isHt ? '0.5' : '2.5');
      const defTotalIdx = isHockey ? (isHt ? 6 : 22) : (isHt ? 2 : 10);
      const defItbLine = isHockey ? (isHt ? '0.5' : '2.5') : (isHt ? '0.5' : '1.5');
      const defItbIdx = isHockey ? (isHt ? 2 : 10) : (isHt ? 2 : 6);
      const defCornersItbLine = isHt ? '1.5' : '4.5';
      const defCornersItbIdx = isHt ? 6 : 18;
      const hockeyPeriod = (eventId === this.activeEventId)
        ? (this.currentHockeyPeriod || activeEv?.hockeyPeriod || 1)
        : (activeEv?.hockeyPeriod || 1);

      const isCornersSlot = slotKey === 'CORNERS_ITB1' || slotKey === 'CORNERS_ITB2';
      const cornersEv = (isCornersSlot && activeEv?.cornersEventId)
        ? this.eventsMap.get(activeEv.cornersEventId)
        : null;
      const isCompanionCornersEvent = Boolean(cornersEv || activeEv?.isCorners);
      const targetEvId = cornersEv ? cornersEv.eventId : eventId;
      const targetScore = isCornersSlot
        ? (cornersEv
            ? (isHt ? (cornersEv.htScore || cornersEv.score || { home: 0, away: 0 }) : (cornersEv.ftScore || cornersEv.score || { home: 0, away: 0 }))
            : (isHt ? (activeEv?.cornersHtScore || activeEv?.cornersFtScore || { home: 0, away: 0 }) : (activeEv?.cornersFtScore || { home: 0, away: 0 })))
        : score;

      const matchInfo = {
        eventId: targetEvId,
        liveScore: targetScore,
        totalLine: odds.totalLine || defTotalLine,
        rawTotalLineIndex: odds.rawTotalLineIndex ?? defTotalIdx,
        itb1Line: odds.itb1Line || defItbLine,
        rawItb1LineIndex: odds.rawItb1LineIndex ?? defItbIdx,
        itb2Line: odds.itb2Line || defItbLine,
        rawItb2LineIndex: odds.rawItb2LineIndex ?? defItbIdx,
        cornersItb1Line: odds.cornersItb1Line || defCornersItbLine,
        rawCornersItb1LineIndex: odds.rawCornersItb1LineIndex ?? defCornersItbIdx,
        cornersItb2Line: odds.cornersItb2Line || defCornersItbLine,
        rawCornersItb2LineIndex: odds.rawCornersItb2LineIndex ?? defCornersItbIdx,
        isCornersEvent: isCompanionCornersEvent,
        isCompanionCornersEvent,
        period: isHt ? 'HT' : 'FT',
        sport: isHockey
          ? 'ih'
          : (isCornersSlot && !isCompanionCornersEvent
              ? (isHt ? 'fb_corn_ht' : 'fb_corn')
              : (isHt ? 'fb_ht' : 'fb')),
        hockeyPeriod: isHockey ? hockeyPeriod : undefined,
        isLive: Boolean(activeEv?.isLive || targetScore.home > 0 || targetScore.away > 0)
      };

      const result = await this.adapter.preArmBetslip(targetKey, matchInfo);

      // Successfully armed: clear backoff
      this.quotaBackoffMap.delete(targetKey);

      slip.betslipId = result.betslipId;
      slip.expiryTs = result.expiryTs;
      slip.betType = result.betType;
      slip.maxStake = result.maxStake || slip.maxStake;
      slip.lastArmedAt = Date.now();

      // Determine the best available price with priority on allowed bookmaker quotes
      const bookieP = (typeof result.bookiePrice === 'number' && result.bookiePrice > 1.0)
        ? result.bookiePrice
        : ((typeof result.price === 'number' && result.price > 1.0) ? result.price : null);

      if (bookieP) {
        slip.bookiePrice = bookieP;
        slip.bookiePriceTs = Date.now();
        slip.priceSource = 'ARM_SLIP';
        slip.currentPrice = bookieP;
        slip.price = bookieP;

        if (eventId === this.activeEventId) {
          const pOdds = isHt ? this.liveOdds.ht : this.liveOdds.ft;
          if ((targetKey === 'OVER' || targetKey === 'HT_OVER') && pOdds.totalOver <= 1.0) pOdds.totalOver = bookieP;
          if ((targetKey === 'HOME' || targetKey === 'HT_HOME') && pOdds.winHome <= 1.0) pOdds.winHome = bookieP;
          if ((targetKey === 'DRAW' || targetKey === 'HT_DRAW') && pOdds.winDraw <= 1.0) pOdds.winDraw = bookieP;
          if ((targetKey === 'AWAY' || targetKey === 'HT_AWAY') && pOdds.winAway <= 1.0) pOdds.winAway = bookieP;
          if ((targetKey === 'ITB1' || targetKey === 'HT_ITB1') && pOdds.itb1Over <= 1.0) pOdds.itb1Over = bookieP;
          if ((targetKey === 'ITB2' || targetKey === 'HT_ITB2') && pOdds.itb2Over <= 1.0) pOdds.itb2Over = bookieP;
          if ((targetKey === 'CORNERS_ITB1' || targetKey === 'HT_CORNERS_ITB1') && pOdds.cornersItb1Over <= 1.0) pOdds.cornersItb1Over = bookieP;
          if ((targetKey === 'CORNERS_ITB2' || targetKey === 'HT_CORNERS_ITB2') && pOdds.cornersItb2Over <= 1.0) pOdds.cornersItb2Over = bookieP;
        }
      } else {
        const allowed = this.getAllowedBookies();
        // If specific bookmakers are configured (e.g. pin88) and gave NO offer in betslip,
        // NEVER fall back to generic multi-bookie WS ticker ticks (e.g. 188bet/Singbet),
        // because the user's order will be rejected or timed out by the target bookie!
        if (allowed && allowed.size > 0) {
          slip.currentPrice = 0;
          slip.priceSource = 'CLOSED';
        } else {
          const liveP = this.getLivePrice(targetKey);
          if (liveP > 1.0) {
            slip.currentPrice = liveP;
            slip.priceSource = 'TICK';
          } else {
            slip.currentPrice = 0;
            slip.priceSource = 'CLOSED';
          }
        }
      }

      const matchName = activeEv?.homeTeam ? `${activeEv.homeTeam} vs ${activeEv.awayTeam}` : eventId;
      const periodLabel = isHt ? ' [HT]' : ' [FT]';
      logger.info('StateManager', `Pre-armed slip for [${matchName}]${periodLabel} ${targetKey}: ${slip.betslipId.slice(-8)} (TTL: ${Math.round((slip.expiryTs - now)/1000)}s, RTT: ${result.rttMs}ms, Price: ${slip.currentPrice > 0 ? slip.currentPrice : 'N/A'})`);

      if (eventId === this.activeEventId) {
        this.emit('betslip_armed', { targetKey, slip });
        this.emit('state_updated');
      }
    } catch (err) {
      slip.error = err.message;
      const isQuotaError = Boolean(
        err.message && (
          err.message.includes('too_many_open_betslips') ||
          err.message.includes('Betslip limit reached')
        )
      );

      if (isQuotaError) {
        if (!isRetry && this.adapter && typeof this.adapter.purgeAllRemoteBetslips === 'function') {
          logger.warn('StateManager', `[Auto-Heal] Mollybet 403 quota limit hit for ${targetKey}. Purging all remote betslips and retrying in 300ms...`);
          slip.isArming = false;
          await this.purgeAllServerBetslips();
          await new Promise((resolve) => setTimeout(resolve, 300));
          return await this.armEventTarget(eventId, targetKey, true, true);
        }

        // Apply 6s backoff on this targetKey to allow Mollybet server to expire or purge orphaned betslips
        this.quotaBackoffMap.set(targetKey, Date.now() + 6000);
        logger.warn('StateManager', `Mollybet 403 quota exceeded for ${targetKey}. Backing off re-arming by 6s to allow server slots to free.`);
      }
      logger.error('StateManager', `Pre-arm error for [${eventId}] ${targetKey}: ${err.message}`);
      if (eventId === this.activeEventId) {
        this.emit('betslip_arm_error', { targetKey, error: err.message });
      }
    } finally {
      slip.isArming = false;
    }
  }

  /**
   * Pre-arms a single target key for the active match.
   * @param {'OVER' | 'HOME' | 'AWAY' | 'ITB1' | 'ITB2' | 'HT_OVER' | 'HT_HOME' | 'HT_AWAY' | 'HT_ITB1' | 'HT_ITB2'} targetKey
   * @param {boolean} [force=false]
   */
  async armTarget(targetKey, force = false) {
    if (!this.activeEventId) return;
    return this.armEventTarget(this.activeEventId, targetKey, force);
  }

  /**
   * Refreshes all 3 active target betslips for active match in parallel.
   * @param {boolean} [force=false]
   */
  async refreshAllBetslips(force = false) {
    if (!this.activeEventId) return;
    const isHt = this.activePeriod === 'HT';
    const overKey = isHt ? 'HT_OVER' : 'OVER';

    const targetKeys = [overKey];
    if (this.activeMarketMode === 'ITB') {
      targetKeys.push(isHt ? 'HT_ITB1' : 'ITB1');
      targetKeys.push(isHt ? 'HT_ITB2' : 'ITB2');
    } else {
      targetKeys.push(isHt ? 'HT_HOME' : 'HOME');
      targetKeys.push(isHt ? 'HT_AWAY' : 'AWAY');
    }

    for (let i = 0; i < targetKeys.length; i++) {
      await this.armTarget(targetKeys[i], force);
      if (i < targetKeys.length - 1) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  /**
   * Toggles combat market mode between MAIN (1X2 + Total) and ITB (Team 1 Over + Team 2 Over + Total).
   * @returns {Promise<string>}
   */
  async toggleMarketMode() {
    const nextMode = this.activeMarketMode === 'MAIN' ? 'ITB' : 'MAIN';
    await this.setMarketMode(nextMode);
    return this.activeMarketMode;
  }

  /**
   * Sets active market mode ('MAIN' or 'ITB').
   * Automatically closes replaced coupons in Mollybet and pre-arms new ones.
   * @param {'MAIN' | 'ITB'} mode
   */
  async setMarketMode(mode) {
    if (mode !== 'MAIN' && mode !== 'ITB') return;
    if (this.activeMarketMode === mode) return;

    logger.info('StateManager', `Switching market mode: ${this.activeMarketMode} -> ${mode}`);

    // Release replaced coupons to stay below Mollybet quota limit (4 concurrent slips)
    if (this.adapter) {
      const keysToRelease = this.activeMarketMode === 'MAIN' ? ['HOME', 'AWAY'] : ['ITB1', 'ITB2'];
      const deletePromises = [];
      for (const key of keysToRelease) {
        const slip = this.armedBetslips[key];
        if (slip && slip.betslipId) {
          deletePromises.push(this.adapter.deleteBetslip(slip.betslipId).catch(() => {}));
          slip.betslipId = null;
        }
      }
      if (deletePromises.length > 0) {
        await Promise.allSettled(deletePromises);
      }
    }

    this.activeMarketMode = mode;
    this.armedBetslips.marketMode = mode;

    if (this.activeEventId) {
      await this.refreshAllBetslips(true);
    }

    this.emit('market_mode_changed', this.activeMarketMode);
    this.emit('state_updated');
  }

  /**
   * Retrieves manual user line override if present.
   * @param {string} targetKey ('OVER', 'HT_OVER', 'ITB1', etc.)
   * @param {string} [eventId]
   * @returns {{ totalLine: string, rawTotalLineIndex: number } | null}
   */
  getUserLineOverride(targetKey, eventId = null) {
    const id = eventId || this.activeEventId;
    if (!id) return null;
    const eventOverrides = this.userLineOverrides.get(id);
    if (!eventOverrides) return null;
    return eventOverrides[targetKey] || null;
  }

  /**
   * Sets manual user line override for target and re-arms betslip with the new line.
   * @param {string} targetKey ('OVER' | 'HT_OVER' | 'ITB1' | 'HT_ITB1' | 'ITB2' | 'HT_ITB2')
   * @param {string} line ('1.5', '2.5', etc.)
   * @param {number} [lineIndex]
   */
  async setUserLineOverride(targetKey, line, lineIndex = null) {
    if (!this.activeEventId) return;

    const isHt = targetKey.startsWith('HT_') || this.activePeriod === 'HT';
    const cleanKey = isHt
      ? (targetKey.startsWith('HT_') ? targetKey : `HT_${targetKey}`)
      : targetKey.replace(/^HT_/, '');

    const rawIdx = lineIndex != null ? lineIndex : Math.round(parseFloat(line) * 4);

    let eventOverrides = this.userLineOverrides.get(this.activeEventId);
    if (!eventOverrides) {
      eventOverrides = {};
      this.userLineOverrides.set(this.activeEventId, eventOverrides);
    }
    eventOverrides[cleanKey] = { totalLine: String(line), rawTotalLineIndex: rawIdx };

    const pOdds = isHt ? this.liveOdds.ht : this.liveOdds.ft;

    if (cleanKey === 'OVER' || cleanKey === 'HT_OVER') {
      pOdds.totalLine = String(line);
      pOdds.rawTotalLineIndex = rawIdx;
      const found = pOdds.totalLines.find(x => x.totalLine === String(line));
      if (found) {
        pOdds.totalOver = found.totalOver || 0;
        pOdds.totalUnder = found.totalUnder || 0;
      }
    } else if (cleanKey === 'ITB1' || cleanKey === 'HT_ITB1') {
      pOdds.itb1Line = String(line);
      pOdds.rawItb1LineIndex = rawIdx;
      const found = pOdds.itb1Lines.find(x => x.totalLine === String(line));
      if (found) {
        pOdds.itb1Over = found.totalOver || 0;
        pOdds.itb1Under = found.totalUnder || 0;
      }
    } else if (cleanKey === 'ITB2' || cleanKey === 'HT_ITB2') {
      pOdds.itb2Line = String(line);
      pOdds.rawItb2LineIndex = rawIdx;
      const found = pOdds.itb2Lines.find(x => x.totalLine === String(line));
      if (found) {
        pOdds.itb2Over = found.totalOver || 0;
        pOdds.itb2Under = found.totalUnder || 0;
      }
    } else if (cleanKey === 'CORNERS_OVER' || cleanKey === 'HT_CORNERS_OVER') {
      pOdds.cornersTotalLine = String(line);
      pOdds.rawCornersTotalLineIndex = rawIdx;
      const found = (pOdds.cornersTotalLines || []).find(x => x.totalLine === String(line));
      if (found) {
        pOdds.cornersTotalOver = found.totalOver || 0;
        pOdds.cornersTotalUnder = found.totalUnder || 0;
      }
    } else if (cleanKey === 'CORNERS_ITB1' || cleanKey === 'HT_CORNERS_ITB1') {
      pOdds.cornersItb1Line = String(line);
      pOdds.rawCornersItb1LineIndex = rawIdx;
      const found = (pOdds.cornersItb1Lines || []).find(x => x.totalLine === String(line));
      if (found) {
        pOdds.cornersItb1Over = found.totalOver || 0;
        pOdds.cornersItb1Under = found.totalUnder || 0;
      }
    } else if (cleanKey === 'CORNERS_ITB2' || cleanKey === 'HT_CORNERS_ITB2') {
      pOdds.cornersItb2Line = String(line);
      pOdds.rawCornersItb2LineIndex = rawIdx;
      const found = (pOdds.cornersItb2Lines || []).find(x => x.totalLine === String(line));
      if (found) {
        pOdds.cornersItb2Over = found.totalOver || 0;
        pOdds.cornersItb2Under = found.totalUnder || 0;
      }
    }

    logger.info('StateManager', `User line override applied for ${cleanKey}: ${line} (rawIndex: ${rawIdx}). Re-arming...`);
    if (!cleanKey.includes('CORNERS')) {
      await this.armTarget(cleanKey, true);
    }
    this.emit('state_updated');
  }

  /**
   * Cycles to next or previous available line for current combat total.
   * @param {number} direction (+1 for higher line, -1 for lower line)
   * @param {'OVER' | 'ITB1' | 'ITB2' | 'CORNERS_OVER' | 'CORNERS_ITB1' | 'CORNERS_ITB2'} [slotType='OVER']
   */
  async cycleTotalLine(direction = 1, slotType = 'OVER') {
    if (!this.activeEventId) return;

    const isHt = this.activePeriod === 'HT';
    const pOdds = isHt ? this.liveOdds.ht : this.liveOdds.ft;

    let lines = [];
    let currentLine = '';
    let targetKey = 'OVER';

    if (slotType === 'ITB1') {
      targetKey = isHt ? 'HT_ITB1' : 'ITB1';
      lines = pOdds.itb1Lines;
      currentLine = pOdds.itb1Line || (isHt ? '0.5' : '1.5');
    } else if (slotType === 'ITB2') {
      targetKey = isHt ? 'HT_ITB2' : 'ITB2';
      lines = pOdds.itb2Lines;
      currentLine = pOdds.itb2Line || (isHt ? '0.5' : '1.5');
    } else if (slotType === 'CORNERS_ITB1') {
      targetKey = isHt ? 'HT_CORNERS_ITB1' : 'CORNERS_ITB1';
      lines = pOdds.cornersItb1Lines || [];
      currentLine = pOdds.cornersItb1Line || (isHt ? '1.5' : '4.5');
    } else if (slotType === 'CORNERS_ITB2') {
      targetKey = isHt ? 'HT_CORNERS_ITB2' : 'CORNERS_ITB2';
      lines = pOdds.cornersItb2Lines || [];
      currentLine = pOdds.cornersItb2Line || (isHt ? '1.5' : '4.5');
    } else if (slotType === 'CORNERS_OVER') {
      targetKey = isHt ? 'HT_CORNERS_OVER' : 'CORNERS_OVER';
      lines = pOdds.cornersTotalLines || [];
      currentLine = pOdds.cornersTotalLine || (isHt ? '4.5' : '9.5');
    } else {
      targetKey = isHt ? 'HT_OVER' : 'OVER';
      lines = pOdds.totalLines;
      currentLine = pOdds.totalLine || (isHt ? '0.5' : '2.5');
    }

    if (!Array.isArray(lines) || lines.length <= 1) {
      // If bookie hasn't sent full line spectrum, step line manually by 0.5 or 1.0
      const curNum = parseFloat(currentLine) || (isHt ? 0.5 : 2.5);
      const nextNum = Math.max(0.5, curNum + (direction > 0 ? 0.5 : -0.5));
      await this.setUserLineOverride(targetKey, nextNum.toFixed(1));
      return;
    }

    // Find current index in sorted lines
    const currentIdx = lines.findIndex(x => x.totalLine === currentLine);
    let nextIdx = 0;
    if (currentIdx !== -1) {
      nextIdx = (currentIdx + (direction > 0 ? 1 : -1) + lines.length) % lines.length;
    } else {
      nextIdx = direction > 0 ? 0 : lines.length - 1;
    }

    const nextLineObj = lines[nextIdx];
    if (nextLineObj) {
      await this.setUserLineOverride(targetKey, nextLineObj.totalLine, nextLineObj.rawTotalLineIndex);
    }
  }

  /**
   * Toggles combat trading period between FT (Full Time) and HT (1st Half).
   * @returns {Promise<string>}
   */
  async togglePeriod() {
    const nextPeriod = this.activePeriod === 'FT' ? 'HT' : 'FT';
    await this.setPeriod(nextPeriod);
    return this.activePeriod;
  }

  /**
   * Sets active combat period ('FT' or 'HT').
   * Closes old period betslips to stay within Mollybet quota and arms new period slips.
   * @param {'FT' | 'HT'} period
   */
  async setPeriod(period) {
    if (period !== 'FT' && period !== 'HT') return;
    if (this.activePeriod === period) return;

    logger.info('StateManager', `Switching combat period: ${this.activePeriod} -> ${period}`);

    // Release previous period betslips in Mollybet and wait for server confirmation
    if (this.adapter) {
      const deletePromises = [];
      for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
        const slip = this.armedBetslips[key];
        if (slip && slip.betslipId) {
          deletePromises.push(this.adapter.deleteBetslip(slip.betslipId).catch(() => {}));
          slip.betslipId = null;
        }
      }
      if (deletePromises.length > 0) {
        await Promise.allSettled(deletePromises);
      }
    }

    this.activePeriod = period;
    this.liveScore = period === 'HT' ? { ...this.liveScoreHt } : { ...this.liveScoreFt };
    this.armedBetslips = this.createEmptySlips(period, this.activeMarketMode);

    if (this.activeEventId) {
      const allowed = this.getAllowedBookies();
      const hasStrictAllowed = allowed && allowed.size > 0;
      const pOdds = period === 'HT' ? this.liveOdds.ht : this.liveOdds.ft;

      if (!hasStrictAllowed) {
        this.armedBetslips.OVER.currentPrice = pOdds.totalOver || 0;
        this.armedBetslips.HOME.currentPrice = pOdds.winHome || 0;
        this.armedBetslips.AWAY.currentPrice = pOdds.winAway || 0;
        this.armedBetslips.ITB1.currentPrice = pOdds.itb1Over || 0;
        this.armedBetslips.ITB2.currentPrice = pOdds.itb2Over || 0;
      } else {
        this.armedBetslips.OVER.currentPrice = 0;
        this.armedBetslips.HOME.currentPrice = 0;
        this.armedBetslips.AWAY.currentPrice = 0;
        this.armedBetslips.ITB1.currentPrice = 0;
        this.armedBetslips.ITB2.currentPrice = 0;
      }

      this.armedPool.set(this.activeEventId, this.armedBetslips);
      await this.refreshAllBetslips(true);
    }

    this.emit('period_changed', this.activePeriod);
    this.emit('state_updated');
  }

  /**
   * Background watchdog checking pool health every 2 seconds.
   * Actively maintains ONLY the active match's 3 slips to guarantee
   * strictly staying below Mollybet's 4-betslip concurrent session quota!
   */
  startPoolWatchdog() {
    this._watchdogTick = 0;
    this.refreshTimer = setInterval(() => {
      if (this.isDestroyed || !this.activeEventId) return;

      // Evict stale events every ~60 seconds (30 ticks × 2s)
      this._watchdogTick++;
      if (this._watchdogTick % 30 === 0) {
        const staleThreshold = Date.now() - 4 * 60 * 60 * 1000;
        for (const [id, ev] of this.eventsMap.entries()) {
          if (ev.lastUpdate && ev.lastUpdate < staleThreshold && id !== this.activeEventId && !this.armedPool.has(id)) {
            this.eventsMap.delete(id);
          }
        }
      }

      const now = Date.now();
      const activeKeys = this.getActiveSlipKeys();
      for (const key of activeKeys) {
        const slip = this.armedBetslips[key];
        if (!slip) continue;

        const targetKey = slip.targetKey || key;
        const backoffUntil = this.quotaBackoffMap.get(targetKey) || 0;
        if (now < backoffUntil) {
          continue; // Respect 403 quota backoff
        }

        const isExpiringSoon = slip.betslipId && (slip.expiryTs - now < 6000);
        const isMissing = !slip.betslipId && !slip.isArming;

        if (isExpiringSoon || isMissing) {
          this.armTarget(targetKey, true).catch(() => {});
        }
      }
    }, 2000);
  }

  /**
   * Returns list of currently armed matches in the pool.
   * @returns {Array<{ eventId: string, homeTeam: string, awayTeam: string, competition: string, score: {home: number, away: number}, minute: string, slips: Object, isActive: boolean }>}
   */
  getArmedMatchesList() {
    const list = [];
    for (const [id, slips] of this.armedPool.entries()) {
      const ev = this.eventsMap.get(id);
      list.push({
        eventId: id,
        homeTeam: ev?.homeTeam || 'Home',
        awayTeam: ev?.awayTeam || 'Away',
        competition: ev?.competition || 'Soccer',
        score: id === this.activeEventId ? this.liveScore : (ev?.score || { home: 0, away: 0 }),
        minute: ev?.minute || '',
        slips,
        isActive: id === this.activeEventId
      });
    }
    return list;
  }

  /**
   * Cycles to the next armed match in the pool.
   * @returns {boolean}
   */
  switchNextArmedMatch() {
    const list = this.getArmedMatchesList();
    if (list.length <= 1) return false;

    const currentIndex = list.findIndex(m => m.eventId === this.activeEventId);
    const nextIndex = (currentIndex + 1) % list.length;
    this.setActiveEvent(list[nextIndex].eventId);
    return true;
  }

  /**
   * Cycles to the previous armed match in the pool.
   * @returns {boolean}
   */
  switchPrevArmedMatch() {
    const list = this.getArmedMatchesList();
    if (list.length <= 1) return false;

    const currentIndex = list.findIndex(m => m.eventId === this.activeEventId);
    const prevIndex = (currentIndex - 1 + list.length) % list.length;
    this.setActiveEvent(list[prevIndex].eventId);
    return true;
  }

  /**
   * Directly sets active match to a specific armed event.
   * @param {string} eventId
   * @returns {boolean}
   */
  switchToArmedMatch(eventId) {
    if (this.armedPool.has(eventId)) {
      this.setActiveEvent(eventId);
      return true;
    }
    return false;
  }

  /**
   * Disarms and removes a match from the pre-armed pool.
   * Releases open betslips in Mollybet.
   * @param {string} eventId
   * @returns {boolean}
   */
  disarmEvent(eventId) {
    const targetId = String(eventId);
    const poolItem = this.armedPool.get(targetId);

    // Release open slips from Mollybet quota
    if (poolItem && this.adapter) {
      for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
        const slip = poolItem[key];
        if (slip && slip.betslipId) {
          this.adapter.deleteBetslip(slip.betslipId).catch(() => {});
        }
      }
    }

    const existed = this.armedPool.delete(targetId);

    if (this.activeEventId === targetId) {
      this.activeEventId = null;
      this.armedBetslips = this.createEmptySlips();
      const remaining = this.getArmedMatchesList();
      if (remaining.length > 0) {
        logger.info('StateManager', `Disarmed event ${targetId}. Switching to next armed match: ${remaining[0].eventId}`);
        this.setActiveEvent(remaining[0].eventId);
      } else {
        logger.info('StateManager', `Disarmed event ${targetId}. No more armed matches in pool.`);
        this.liveScore = { home: 0, away: 0 };
        this.liveOdds.ft = this.createEmptyPeriodOdds('FT');
        this.liveOdds.ht = this.createEmptyPeriodOdds('HT');
      }
    } else {
      logger.info('StateManager', `Disarmed cached event ${targetId}`);
    }

    this.emit('state_updated');
    return existed;
  }

  /**
   * Disarms the currently active match coupons.
   * @returns {boolean}
   */
  disarmActiveEvent() {
    if (this.activeEventId) {
      return this.disarmEvent(this.activeEventId);
    }
    return false;
  }

  /**
   * Disarms all matches and purges the armed pool.
   * Releases all open betslips in Mollybet.
   */
  disarmAll() {
    if (this.adapter) {
      for (const [_, slips] of this.armedPool.entries()) {
        for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
          const slip = slips[key];
          if (slip && slip.betslipId) {
            this.adapter.deleteBetslip(slip.betslipId).catch(() => {});
          }
        }
      }
    }

    this.armedPool.clear();
    this.armedBetslips = this.createEmptySlips();
    this.activeEventId = null;
    this.liveScore = { home: 0, away: 0 };
    this.liveOdds.ft = this.createEmptyPeriodOdds('FT');
    this.liveOdds.ht = this.createEmptyPeriodOdds('HT');
    logger.warn('StateManager', 'All armed betslips disarmed and cleared from pool');
    this.emit('state_updated');
  }

  /**
   * Purges all open betslips on the remote Mollybet server and resets local coupon slots and backoff timers.
   * @returns {Promise<number>} Number of purged remote betslips
   */
  async purgeAllServerBetslips() {
    let purgedCount = 0;
    if (this.adapter) {
      if (typeof this.adapter.purgeAllRemoteBetslips === 'function') {
        try {
          purgedCount = await this.adapter.purgeAllRemoteBetslips();
        } catch (err) {
          logger.error('StateManager', `Failed to purge remote betslips: ${err.message}`);
        }
      } else if (typeof this.adapter.deleteBetslip === 'function') {
        const localIds = new Set();
        for (const [_, slips] of this.armedPool.entries()) {
          for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
            if (slips[key]?.betslipId) localIds.add(slips[key].betslipId);
          }
        }
        for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
          if (this.armedBetslips[key]?.betslipId) localIds.add(this.armedBetslips[key].betslipId);
        }
        await Promise.allSettled([...localIds].map((id) => this.adapter.deleteBetslip(id)));
        purgedCount = localIds.size;
      }
    }

    this.armedPool.clear();
    this.armedBetslips = this.createEmptySlips(this.activePeriod, this.activeMarketMode);
    this.quotaBackoffMap.clear();
    logger.warn('StateManager', `[Purge] Серверные купоны очищены (${purgedCount} шт.), локальный пул и квоты сброшены.`);
    this.emit('state_updated');
    return purgedCount;
  }

  /**
   * Updates the active stake amount with limit clamping.
   * @param {number} amount
   */
  setStake(amount) {
    const val = Number(amount);
    if (!Number.isNaN(val) && val > 0) {
      const maxLimit = this.getMaxStakeLimit();
      const clamped = Math.min(val, maxLimit);
      this.activeStake = Number(clamped.toFixed(2));
      logger.info('StateManager', `Stake set to ${this.activeStake} ${this.accountCurrency} (max limit: ${maxLimit})`);
      this.emit('stake_changed', this.activeStake);
      this.emit('state_updated');
    }
  }

  /**
   * Adjusts the current stake by delta (e.g. +10 or -10).
   * @param {number} delta
   */
  adjustStake(delta) {
    const step = typeof delta === 'number' ? delta : this.stakeStep;
    const maxLimit = this.getMaxStakeLimit();
    const target = this.activeStake + step;
    const newStake = Math.max(1, Math.min(target, maxLimit));
    this.setStake(newStake);
  }

  /**
   * Records execution of an order against active event.
   * Marks the event as executed so the menu can display the completed order badge.
   * @param {string} targetKey
   * @param {Object} result
   */
  recordOrderExecution(targetKey, result) {
    if (!this.activeEventId) return;
    const ev = this.eventsMap.get(this.activeEventId);
    if (ev) {
      ev.lastOrder = {
        orderId: result.orderId,
        targetKey,
        price: result.limitPrice || result.livePrice,
        stake: result.stake,
        timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
      };
    }
    const slip = this.getArmedBetslip(targetKey);
    if (slip) {
      slip.isExecuted = true;
      slip.lastOrderId = result.orderId;
    }
    this.emit('state_updated');
  }

  /**
   * Returns list of soccer & ice hockey games formatted for menu selection.
   * Supports filtering by mode ('LIVE' | 'ALL') and sport ('ALL_SPORTS' | 'FB' | 'IH').
   * @param {'LIVE' | 'ALL' | 'ALL_SPORTS' | 'FB' | 'IH'} [mode='LIVE']
   * @param {'ALL_SPORTS' | 'FB' | 'IH'} [sportFilter='ALL_SPORTS']
   * @returns {{ list: Array<Object>, totalCount: number, liveCount: number }}
   */
  getSoccerList(mode = 'LIVE', sportFilter = 'ALL_SPORTS') {
    let effMode = mode;
    let effSport = sportFilter;
    if (mode === 'FB' || mode === 'IH' || mode === 'ALL_SPORTS') {
      effSport = mode;
      effMode = 'ALL';
    }

    const allList = [];
    const liveList = [];

    for (const [id, ev] of this.eventsMap.entries()) {
      const sport = String(ev.sport || 'fb');
      const isFb = sport.startsWith('fb');
      const isIh = sport === 'ih';
      if (!isFb && !isIh) continue;
      if (effSport === 'FB' && !isFb) continue;
      if (effSport === 'IH' && !isIh) continue;

      const hasArmed = this.armedPool.has(id);
      const isActive = id === this.activeEventId;
      const lastOrder = ev.lastOrder || null;
      const normalizedOdds = ev.odds
        ? (ev.odds.ft ? { ...ev.odds.ft, ft: ev.odds.ft, ht: ev.odds.ht } : ev.odds)
        : null;

      const item = {
        eventId: id,
        sport: isIh ? 'ih' : ev.sport,
        competitionId: ev.competitionId,
        homeTeam: ev.homeTeam || 'Home',
        awayTeam: ev.awayTeam || 'Away',
        competition: ev.competition || (isIh ? 'Ice Hockey' : 'Soccer'),
        score: ev.ftScore || ev.score || { home: 0, away: 0 },
        htScore: ev.htScore || null,
        hockeyPeriod: isIh ? (ev.hockeyPeriod || 1) : null,
        periodScores: ev.periodScores || null,
        periodScoresStr: ev.periodScoresStr || '',
        minute: ev.minute || '',
        isLive: Boolean(ev.isLive),
        startTs: ev.startTs || '',
        hasArmed,
        isActive,
        lastOrder,
        odds: normalizedOdds
      };

      allList.push(item);
      if (ev.isLive) {
        liveList.push(item);
      }
    }

    liveList.sort((a, b) => b.isLive - a.isLive);
    const activeList = (effMode === 'LIVE' && liveList.length > 0) ? liveList : allList;

    return {
      list: activeList,
      totalCount: allList.length,
      liveCount: liveList.length
    };
  }

  /**
   * Alias for getSoccerList supporting multi-sport (Football & Ice Hockey) match list retrieval.
   * @param {'LIVE' | 'ALL'} [mode='LIVE']
   * @param {'ALL_SPORTS' | 'FB' | 'IH'} [sportFilter='ALL_SPORTS']
   * @returns {{ list: Array<Object>, totalCount: number, liveCount: number }}
   */
  getMatchesList(mode = 'LIVE', sportFilter = 'ALL_SPORTS') {
    return this.getSoccerList(mode, sportFilter);
  }

  /**
   * Teardown resources and timers.
   */
  destroy() {
    this.isDestroyed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
