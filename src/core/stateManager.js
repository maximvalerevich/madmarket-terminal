import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';
import { getAllowedBookies } from '../utils/configHelpers.js';

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
    this.accountCurrency = config.defaultCurrency || 'EUR';

    /** @type {'FT' | 'HT'} */
    this.activePeriod = 'FT';

    /** @type {'MAIN' | 'ITB'} */
    this.activeMarketMode = 'MAIN';

    this.liveScore = { home: 0, away: 0 };
    this.liveScoreFt = { home: 0, away: 0 };
    this.liveScoreHt = { home: 0, away: 0 };

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
        itb2Lines: []
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
        itb2Lines: []
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
      set rawItb2LineIndex(v) { if (self.activePeriod === 'HT') this.ht.rawItb2LineIndex = v; else this.ft.rawItb2LineIndex = v; }
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
   * Creates a clean default odds structure for a specific period.
   * @param {'FT' | 'HT'} [period='FT']
   * @returns {Object}
   */
  createEmptyPeriodOdds(period = 'FT') {
    const isHt = period === 'HT';
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
      itb2Lines: []
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

    wsFeed.on('balance', ({ currency, amount }) => {
      this.accountBalance = amount;
      this.accountCurrency = currency;
      logger.info('StateManager', `Updated live balance: ${currency} ${amount}`);
      this.emit('balance_updated', { currency, amount });
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

    wsFeed.on('order_update', () => {
      // Fetch instantly on any order update via WS to update PnL
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

    for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
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
            if (key === 'AWAY') pOdds.winAway = bestPrice;
            if (key === 'ITB1') pOdds.itb1Over = bestPrice;
            if (key === 'ITB2') pOdds.itb2Over = bestPrice;
          }
          if (maxLimit > 0) {
            slip.maxStake = maxLimit;
            logger.info('StateManager', `Updated max stake limit for ${key} (${slipId.slice(-8)}): €${maxLimit}${bestPrice > 0 ? `, price: ${bestPrice}` : ''}`);
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

    for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
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
          if (key === 'AWAY') pOdds.winAway = bestPrice;
          if (key === 'ITB1') pOdds.itb1Over = bestPrice;
          if (key === 'ITB2') pOdds.itb2Over = bestPrice;
        }

        if (maxLimit > 0) {
          slip.maxStake = maxLimit;
        }

        if (bestPrice > 1.0) {
          logger.info('StateManager', `PMM quote for ${key} [${slip.targetKey || key}] (${slipId.slice(-8)}): кэф ${bestPrice}, лимит €${Math.floor(maxLimit || 0)} (${bookie || 'pin88'})`);
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
    for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
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
      for (const key of ['OVER', 'HOME', 'AWAY', 'ITB1', 'ITB2']) {
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
      if (event.ftScore) {
        this.liveScoreFt = { ...event.ftScore };
      } else if (event.score) {
        this.liveScoreFt = { ...event.score };
      }
      if (event.htScore) {
        this.liveScoreHt = { ...event.htScore };
      }

      this.liveScore = this.activePeriod === 'HT' ? { ...this.liveScoreHt } : { ...this.liveScoreFt };

      // Reset liveOdds cleanly for the incoming match so prices from previous match never leak
      this.liveOdds.ft = event.odds?.ft
        ? { ...this.createEmptyPeriodOdds('FT'), ...event.odds.ft }
        : (event.odds ? { ...this.createEmptyPeriodOdds('FT'), ...event.odds } : this.createEmptyPeriodOdds('FT'));
      this.liveOdds.ht = event.odds?.ht
        ? { ...this.createEmptyPeriodOdds('HT'), ...event.odds.ht }
        : this.createEmptyPeriodOdds('HT');

      if (this.wsFeed) {
        this.wsFeed.subscribeToEvent(event.competitionId, event.sport, this.activeEventId);
      }
    } else {
      // Event not yet in eventsMap: ensure odds and scores are cleanly reset to defaults
      this.liveScoreFt = { home: 0, away: 0 };
      this.liveScoreHt = { home: 0, away: 0 };
      this.liveScore = { home: 0, away: 0 };
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
   * Updates match metadata from WebSocket event frame.
   * @param {Object} data
   */
  updateEventMetadata(data) {
    const { eventId } = data;
    if (!eventId) return;

    const existing = this.eventsMap.get(eventId) || {};
    const updated = {
      ...existing,
      ...data,
      lastUpdate: Date.now()
    };

    const sport = String(data.sport || 'fb');
    const isHtSport = sport === 'fb_ht';

    if (data.score) {
      const incomingScore = {
        home: Number(data.score.home) || 0,
        away: Number(data.score.away) || 0
      };

      if (isHtSport) {
        existing.htScore = incomingScore;
        updated.htScore = incomingScore;
      } else {
        existing.ftScore = incomingScore;
        updated.ftScore = incomingScore;
      }
    }

    this.eventsMap.set(eventId, updated);

    if (this.activeEventId === eventId) {
      if (data.score) {
        const incomingScore = {
          home: Number(data.score.home) || 0,
          away: Number(data.score.away) || 0
        };

        if (isHtSport) {
          const prevHt = `${this.liveScoreHt.home}-${this.liveScoreHt.away}`;
          const newHt = `${incomingScore.home}-${incomingScore.away}`;
          this.liveScoreHt = incomingScore;

          if (this.activePeriod === 'HT') {
            const prevActive = `${this.liveScore.home}-${this.liveScore.away}`;
            this.liveScore = { ...incomingScore };
            if (prevHt !== newHt && prevActive !== newHt) {
              logger.warn('StateManager', `GOAL DETECTED in match ${eventId} [HT]: ${prevHt} -> ${newHt}! Refreshing betslips immediately!`);
              this.emit('score_changed', { eventId, score: this.liveScore });
              this.refreshAllBetslips(true);
            }
          }
        } else {
          const prevFt = `${this.liveScoreFt.home}-${this.liveScoreFt.away}`;
          const newFt = `${incomingScore.home}-${incomingScore.away}`;
          this.liveScoreFt = incomingScore;

          if (this.activePeriod === 'FT') {
            const prevActive = `${this.liveScore.home}-${this.liveScore.away}`;
            this.liveScore = { ...incomingScore };
            if (prevFt !== newFt && prevActive !== newFt) {
              logger.warn('StateManager', `GOAL DETECTED in match ${eventId} [FT]: ${prevFt} -> ${newFt}! Refreshing betslips immediately!`);
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
   * Differentiates full-time (fb) and half-time (fb_ht) markets.
   * When a bookmaker closes/suspends a market, sets price to 0 without fabricating or keeping stale odds.
   * @param {Object} data
   */
  updateOdds(data) {
    const { eventId, sport, odds, updatedMarkets } = data;
    if (!eventId || !odds) return;

    const isHt = sport === 'fb_ht';
    const targetPeriod = isHt ? 'ht' : 'ft';

    const event = this.eventsMap.get(eventId);
    if (event) {
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
          totalLine: odds.totalLine || prevPeriodOdds.totalLine || (isHt ? '0.5' : '2.5'),
          rawTotalLineIndex: odds.rawTotalLineIndex ?? prevPeriodOdds.rawTotalLineIndex ?? (isHt ? 2 : 10),
          totalLines: (odds.totalLines && odds.totalLines.length > 0) ? odds.totalLines : (prevPeriodOdds.totalLines || []),
          itb1Over: updatedMarkets.itb1 ? (odds.itb1Over || 0) : (prevPeriodOdds.itb1Over || 0),
          itb1Under: updatedMarkets.itb1 ? (odds.itb1Under || 0) : (prevPeriodOdds.itb1Under || 0),
          itb1Line: odds.itb1Line || prevPeriodOdds.itb1Line || (isHt ? '0.5' : '1.5'),
          rawItb1LineIndex: odds.rawItb1LineIndex ?? prevPeriodOdds.rawItb1LineIndex ?? (isHt ? 2 : 6),
          itb1Lines: (odds.itb1Lines && odds.itb1Lines.length > 0) ? odds.itb1Lines : (prevPeriodOdds.itb1Lines || []),
          itb2Over: updatedMarkets.itb2 ? (odds.itb2Over || 0) : (prevPeriodOdds.itb2Over || 0),
          itb2Under: updatedMarkets.itb2 ? (odds.itb2Under || 0) : (prevPeriodOdds.itb2Under || 0),
          itb2Line: odds.itb2Line || prevPeriodOdds.itb2Line || (isHt ? '0.5' : '1.5'),
          rawItb2LineIndex: odds.rawItb2LineIndex ?? prevPeriodOdds.rawItb2LineIndex ?? (isHt ? 2 : 6),
          itb2Lines: (odds.itb2Lines && odds.itb2Lines.length > 0) ? odds.itb2Lines : (prevPeriodOdds.itb2Lines || [])
        };
      } else {
        // Fallback for partial/synthetic updates (e.g. tests)
        event.odds[targetPeriod] = {
          totalOver: (odds.totalOver && odds.totalOver > 0) ? odds.totalOver : (prevPeriodOdds.totalOver || 0),
          totalUnder: (odds.totalUnder && odds.totalUnder > 0) ? odds.totalUnder : (prevPeriodOdds.totalUnder || 0),
          winHome: (odds.winHome && odds.winHome > 0) ? odds.winHome : (prevPeriodOdds.winHome || 0),
          winDraw: (odds.winDraw && odds.winDraw > 0) ? odds.winDraw : (prevPeriodOdds.winDraw || 0),
          winAway: (odds.winAway && odds.winAway > 0) ? odds.winAway : (prevPeriodOdds.winAway || 0),
          totalLine: odds.totalLine || prevPeriodOdds.totalLine || (isHt ? '0.5' : '2.5'),
          rawTotalLineIndex: odds.rawTotalLineIndex ?? prevPeriodOdds.rawTotalLineIndex ?? (isHt ? 2 : 10),
          totalLines: (odds.totalLines && odds.totalLines.length > 0) ? odds.totalLines : (prevPeriodOdds.totalLines || []),
          itb1Over: (odds.itb1Over && odds.itb1Over > 0) ? odds.itb1Over : (prevPeriodOdds.itb1Over || 0),
          itb1Under: (odds.itb1Under && odds.itb1Under > 0) ? odds.itb1Under : (prevPeriodOdds.itb1Under || 0),
          itb1Line: odds.itb1Line || prevPeriodOdds.itb1Line || (isHt ? '0.5' : '1.5'),
          rawItb1LineIndex: odds.rawItb1LineIndex ?? prevPeriodOdds.rawItb1LineIndex ?? (isHt ? 2 : 6),
          itb1Lines: (odds.itb1Lines && odds.itb1Lines.length > 0) ? odds.itb1Lines : (prevPeriodOdds.itb1Lines || []),
          itb2Over: (odds.itb2Over && odds.itb2Over > 0) ? odds.itb2Over : (prevPeriodOdds.itb2Over || 0),
          itb2Under: (odds.itb2Under && odds.itb2Under > 0) ? odds.itb2Under : (prevPeriodOdds.itb2Under || 0),
          itb2Line: odds.itb2Line || prevPeriodOdds.itb2Line || (isHt ? '0.5' : '1.5'),
          rawItb2LineIndex: odds.rawItb2LineIndex ?? prevPeriodOdds.rawItb2LineIndex ?? (isHt ? 2 : 6),
          itb2Lines: (odds.itb2Lines && odds.itb2Lines.length > 0) ? odds.itb2Lines : (prevPeriodOdds.itb2Lines || [])
        };
      }
      event.lastUpdate = Date.now();
    }

    if (this.activeEventId === eventId) {
      const pOdds = this.liveOdds[targetPeriod];

      if (updatedMarkets) {
        if (updatedMarkets.ahou) {
          if (odds.totalLines && odds.totalLines.length > 0) pOdds.totalLines = odds.totalLines;

          // Check if current active totalLine is present in new totalLines spectrum
          const existingLine = pOdds.totalLine
            ? pOdds.totalLines?.find(x => x.totalLine === pOdds.totalLine)
            : null;

          if (existingLine && existingLine.totalOver > 0) {
            pOdds.totalOver = existingLine.totalOver;
            pOdds.totalUnder = existingLine.totalUnder;
            pOdds.rawTotalLineIndex = existingLine.rawTotalLineIndex;
          } else {
            pOdds.totalOver = odds.totalOver || 0;
            pOdds.totalUnder = odds.totalUnder || 0;
            if (odds.totalLine) pOdds.totalLine = odds.totalLine;
            if (odds.rawTotalLineIndex != null) pOdds.rawTotalLineIndex = odds.rawTotalLineIndex;
          }
        }
        if (updatedMarkets.wdw) {
          pOdds.winHome = odds.winHome || 0;
          pOdds.winDraw = odds.winDraw || 0;
          pOdds.winAway = odds.winAway || 0;
        }
        if (updatedMarkets.itb1) {
          if (odds.itb1Lines && odds.itb1Lines.length > 0) pOdds.itb1Lines = odds.itb1Lines;

          const existingItb1 = pOdds.itb1Line
            ? pOdds.itb1Lines?.find(x => x.totalLine === pOdds.itb1Line)
            : null;

          if (existingItb1 && existingItb1.totalOver > 0) {
            pOdds.itb1Over = existingItb1.totalOver;
            pOdds.itb1Under = existingItb1.totalUnder;
            pOdds.rawItb1LineIndex = existingItb1.rawTotalLineIndex;
          } else {
            pOdds.itb1Over = odds.itb1Over || 0;
            pOdds.itb1Under = odds.itb1Under || 0;
            if (odds.itb1Line) pOdds.itb1Line = odds.itb1Line;
            if (odds.rawItb1LineIndex != null) pOdds.rawItb1LineIndex = odds.rawItb1LineIndex;
          }
        }
        if (updatedMarkets.itb2) {
          if (odds.itb2Lines && odds.itb2Lines.length > 0) pOdds.itb2Lines = odds.itb2Lines;

          const existingItb2 = pOdds.itb2Line
            ? pOdds.itb2Lines?.find(x => x.totalLine === pOdds.itb2Line)
            : null;

          if (existingItb2 && existingItb2.totalOver > 0) {
            pOdds.itb2Over = existingItb2.totalOver;
            pOdds.itb2Under = existingItb2.totalUnder;
            pOdds.rawItb2LineIndex = existingItb2.rawTotalLineIndex;
          } else {
            pOdds.itb2Over = odds.itb2Over || 0;
            pOdds.itb2Under = odds.itb2Under || 0;
            if (odds.itb2Line) pOdds.itb2Line = odds.itb2Line;
            if (odds.rawItb2LineIndex != null) pOdds.rawItb2LineIndex = odds.rawItb2LineIndex;
          }
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

      // Update current active slips if this update belongs to current active period
      const currentActivePeriod = this.activePeriod === 'HT' ? 'ht' : 'ft';
      if (targetPeriod === currentActivePeriod) {
        const now = Date.now();
        const bookieQuoteTtl = 10000; // 10 seconds priority for fresh bookie PMM/slip quotes
        const allowed = this.getAllowedBookies();
        const hasStrictAllowed = allowed && allowed.size > 0;

        const overSlip = this.armedBetslips.OVER;
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
      case 'AWAY':
      case 'HT_AWAY':
        return Number(odds.winAway) || 0;
      case 'ITB1':
      case 'HT_ITB1':
        return Number(odds.itb1Over) || 0;
      case 'ITB2':
      case 'HT_ITB2':
        return Number(odds.itb2Over) || 0;
      default:
        return 0;
    }
  }

  /**
   * Retrieves the pre-armed betslip for instant execution.
   * Validates period and market mode context to prevent cross-period / cross-mode misfires.
   * @param {'OVER' | 'HOME' | 'AWAY' | 'ITB1' | 'ITB2' | 'HT_OVER' | 'HT_HOME' | 'HT_AWAY' | 'HT_ITB1' | 'HT_ITB2'} targetKey
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
    if (slotKey === 'AWAY') return this.armedBetslips.AWAY;
    if (slotKey === 'ITB1') return this.armedBetslips.ITB1;
    if (slotKey === 'ITB2') return this.armedBetslips.ITB2;
    return this.armedBetslips[targetKey] || null;
  }

  /**
   * Returns the maximum stake limit for the target outcome or account.
   * @param {'OVER' | 'HOME' | 'AWAY' | 'HT_OVER' | 'HT_HOME' | 'HT_AWAY'} [targetKey]
   * @returns {number}
   */
  getMaxStakeLimit(targetKey = null) {
    let limit = this.accountBalance > 0 ? this.accountBalance : 2000.0;
    if (targetKey) {
      const slip = this.getArmedBetslip(targetKey);
      if (slip && typeof slip.maxStake === 'number' && slip.maxStake > 0) {
        limit = Math.min(limit, slip.maxStake);
      }
    }
    return Number(limit.toFixed(2));
  }

  /**
   * Invalidates a betslip after firing to force immediate re-arm.
   * @param {'OVER' | 'HOME' | 'AWAY' | 'HT_OVER' | 'HT_HOME' | 'HT_AWAY'} targetKey
   */
  invalidateBetslip(targetKey) {
    const slip = this.getArmedBetslip(targetKey);
    if (slip) {
      slip.betslipId = null;
      slip.expiryTs = 0;
    }
    this.armTarget(slip?.targetKey || targetKey, true).catch(() => {});
  }

  /**
   * Pre-arms a single target key for a specific event with mutual exclusion.
   * @param {string} eventId
   * @param {'OVER' | 'HOME' | 'AWAY'} targetKey
   * @param {boolean} [force=false]
   */
  async armEventTarget(eventId, targetKey, force = false) {
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
      const isHt = targetKey.startsWith('HT_') || this.activePeriod === 'HT';
      const score = (eventId === this.activeEventId)
        ? (isHt ? this.liveScoreHt : this.liveScoreFt)
        : (isHt ? (activeEv?.htScore || { home: 0, away: 0 }) : (activeEv?.ftScore || activeEv?.score || { home: 0, away: 0 }));
      const odds = (eventId === this.activeEventId)
        ? (isHt ? this.liveOdds.ht : this.liveOdds.ft)
        : (activeEv?.odds ? (isHt ? (activeEv.odds.ht || {}) : (activeEv.odds.ft || activeEv.odds)) : {});

      const matchInfo = {
        eventId,
        liveScore: score,
        totalLine: odds.totalLine || (isHt ? '0.5' : '2.5'),
        rawTotalLineIndex: odds.rawTotalLineIndex ?? (isHt ? 2 : 10),
        itb1Line: odds.itb1Line || (isHt ? '0.5' : '1.5'),
        rawItb1LineIndex: odds.rawItb1LineIndex ?? (isHt ? 2 : 6),
        itb2Line: odds.itb2Line || (isHt ? '0.5' : '1.5'),
        rawItb2LineIndex: odds.rawItb2LineIndex ?? (isHt ? 2 : 6),
        period: isHt ? 'HT' : 'FT',
        sport: isHt ? 'fb_ht' : 'fb',
        isLive: Boolean(activeEv?.isLive || score.home > 0 || score.away > 0)
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
          if ((targetKey === 'AWAY' || targetKey === 'HT_AWAY') && pOdds.winAway <= 1.0) pOdds.winAway = bookieP;
          if ((targetKey === 'ITB1' || targetKey === 'HT_ITB1') && pOdds.itb1Over <= 1.0) pOdds.itb1Over = bookieP;
          if ((targetKey === 'ITB2' || targetKey === 'HT_ITB2') && pOdds.itb2Over <= 1.0) pOdds.itb2Over = bookieP;
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
      if (err.message && err.message.includes('too_many_open_betslips')) {
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
    }

    logger.info('StateManager', `User line override applied for ${cleanKey}: ${line} (rawIndex: ${rawIdx}). Re-arming...`);
    await this.armTarget(cleanKey, true);
    this.emit('state_updated');
  }

  /**
   * Cycles to next or previous available line for current combat total.
   * @param {number} direction (+1 for higher line, -1 for lower line)
   * @param {'OVER' | 'ITB1' | 'ITB2'} [slotType='OVER']
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
   * Returns list of soccer games formatted for menu selection.
   * @param {'LIVE' | 'ALL'} [mode='LIVE']
   * @returns {{ list: Array<Object>, totalCount: number, liveCount: number }}
   */
  getSoccerList(mode = 'LIVE') {
    const allList = [];
    const liveList = [];

    for (const [id, ev] of this.eventsMap.entries()) {
      const sport = String(ev.sport || 'fb');
      if (sport.startsWith('fb')) {
        const hasArmed = this.armedPool.has(id);
        const isActive = id === this.activeEventId;
        const lastOrder = ev.lastOrder || null;
        const item = {
          eventId: id,
          sport: ev.sport,
          competitionId: ev.competitionId,
          homeTeam: ev.homeTeam || 'Home',
          awayTeam: ev.awayTeam || 'Away',
          competition: ev.competition || 'Soccer',
          score: ev.score || { home: 0, away: 0 },
          minute: ev.minute || '',
          isLive: Boolean(ev.isLive),
          startTs: ev.startTs || '',
          hasArmed,
          isActive,
          lastOrder,
          odds: ev.odds || null
        };

        allList.push(item);
        if (ev.isLive) {
          liveList.push(item);
        }
      }
    }

    liveList.sort((a, b) => b.isLive - a.isLive);
    const activeList = (mode === 'LIVE' && liveList.length > 0) ? liveList : allList;

    return {
      list: activeList,
      totalCount: allList.length,
      liveCount: liveList.length
    };
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
