import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { BaseFeed } from '../adapters/baseFeed.js';
import { logger } from '../utils/logger.js';

/**
 * Helper to recursively extract 1X2 (wdw) prices from nested arrays or dictionaries
 * @param {any} wdw
 * @returns {{ h: number, d: number, a: number }}
 */
function extractWdwPrices(wdw) {
  let h = 0, d = 0, a = 0;
  if (!wdw) return { h, d, a };

  function walk(arr) {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string') {
        const key = item[0].toLowerCase();
        const price = Number(item[1]) || 0;
        if (key === 'h' || key === '1') h = price;
        else if (key === 'd' || key === 'x') d = price;
        else if (key === 'a' || key === '2') a = price;
      } else if (Array.isArray(item)) {
        walk(item);
      }
    }
  }

  if (typeof wdw === 'object' && !Array.isArray(wdw)) {
    h = Number(wdw.h || wdw['1'] || 0);
    d = Number(wdw.d || wdw.x || 0);
    a = Number(wdw.a || wdw['2'] || 0);
  } else {
    walk(wdw);
  }
  return { h, d, a };
}

/**
 * Helper to extract Asian Handicap (ah) prices
 * @param {any} ah
 * @returns {{ h: number, a: number }}
 */
function extractAhPrices(ah) {
  let h = 0, a = 0;
  if (!ah) return { h, a };

  function walk(arr) {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string') {
        const key = item[0].toLowerCase();
        const price = Number(item[1]) || 0;
        if (key === 'h' || key === '1') h = price;
        else if (key === 'a' || key === '2') a = price;
      } else if (Array.isArray(item)) {
        walk(item);
      }
    }
  }
  walk(ah);
  return { h, a };
}

/**
 * WsFeed
 * High-speed WebSocket client for MadMarket/Mollybet price and event feed.
 */
export class WsFeed extends BaseFeed {
  /**
   * @param {Object} config
   * @param {string} config.wsUrl - Base WS URL (e.g. "wss://edge.madmarket.io/cpricefeed/")
   * @param {string} config.sessionToken - User authentication token
   */
  constructor(config) {
    super(config);
    this.config = config;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isDestroyed = false;

    /** @type {NodeJS.Timeout | null} */
    this.pingTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1000;
    this.lastPingSentTs = 0;
    this.lastWsRttMs = 0;

    this.totalEventsReceived = 0;
    this.totalPriceTicksReceived = 0;

    this.watchedEvent = null; // { competitionId, sport, eventId }
    /**
     * Map of eventId:sport -> { totalLine, itb1Line, itb2Line }
     * Preserves sticky line choices per event and sport to prevent jitter.
     * @type {Map<string, { totalLine?: string, itb1Line?: string, itb2Line?: string }>}
     */
    this.eventActiveLines = new Map();

    /**
     * Cumulative spectrum registry per event, sport and market type.
     * key: `${eventId}:${sport}:${marketType}` -> Map(lineStr -> lineObj)
     * @type {Map<string, Map<string, Object>>}
     */
    this.lineSpectrums = new Map();

    /**
     * Tracks current active hockey period (1, 2, or 3) per eventId.
     * @type {Map<string, number>}
     */
    this.eventHockeyPeriods = new Map();

    /**
     * Tracks live scores per scopeKey (`${eventId}:${sport}`) to evict stale/settled lines after goals.
     * @type {Map<string, { home: number, away: number }>}
     */
    this.eventScores = new Map();
  }

  /**
   * Constructs the full WebSocket connection URL including token.
   * @returns {string}
   */
  buildConnectionUrl() {
    const base = this.config.wsUrl || 'wss://edge.madmarket.io/cpricefeed/';
    const sep = base.includes('?') ? '&' : '?';
    const token = encodeURIComponent(this.config.sessionToken || '');
    return `${base}${sep}token=${token}&lang=en`;
  }

  /**
   * Connects to the WebSocket feed.
   */
  connect() {
    if (this.isDestroyed || this.isConnected || this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    const url = this.buildConnectionUrl();
    logger.info('WsFeed', `Connecting to WebSocket: ${this.config.wsUrl} (token: ${this.config.sessionToken?.slice(0, 6)}...)`);

    try {
      this.ws = new WebSocket(url, {
        headers: {
          'Origin': this.config.baseUrl || 'https://edge.madmarket.io',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        },
        perMessageDeflate: false
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectDelayMs = 1000;
        logger.success('WsFeed', 'WebSocket connected to MadMarket feed successfully');
        this.startHeartbeat();
        this.emit('connected');

        if (this.watchedEvent) {
          this.subscribeToEvent(this.watchedEvent.competitionId, this.watchedEvent.sport, this.watchedEvent.eventId);
        }
      });

      this.ws.on('message', (data, isBinary) => {
        this.handleMessage(data, isBinary);
      });

      this.ws.on('error', (err) => {
        logger.error('WsFeed', `WebSocket error: ${err.message}`, err);
        this.emit('error', err);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this.isConnecting = false;
        this.stopHeartbeat();
        const reasonStr = reason?.toString() || 'Normal closure';
        logger.warn('WsFeed', `WebSocket closed (code: ${code}, reason: ${reasonStr})`);
        this.emit('disconnected', { code, reason: reasonStr });
        this.scheduleReconnect();
      });

      this.ws.on('ping', () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.pong();
        }
      });

    } catch (err) {
      this.isConnecting = false;
      logger.error('WsFeed', `WebSocket connection creation failed: ${err.message}`, err);
      this.emit('error', err);
      this.scheduleReconnect();
    }
  }

  /**
   * Starts Boost.Beast heartbeat ["ping", "<timestamp>"] every 10s.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingSentTs = performance.now();
        const payload = JSON.stringify(['ping', String(Date.now())]);
        this.ws.send(payload);
      }
    }, 10000);
  }

  /**
   * Stops heartbeat timer.
   */
  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Schedules reconnection with exponential backoff.
   */
  scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 1.5, 10000);
      logger.info('WsFeed', `Reconnecting WebSocket in ${this.reconnectDelayMs}ms...`);
      this.connect();
    }, this.reconnectDelayMs);
  }

  /**
   * Subscribes to live price updates and handicap lines for a specific match.
   * Watches both 'fb' and 'fb_ht' to guarantee in-running coverage in both halves.
   *
   * @param {number|string} competitionId
   * @param {string} sport - e.g. "fb"
   * @param {string} eventId
   */
  subscribeToEvent(competitionId, sport, eventId) {
    if (!competitionId || !eventId) return;

    const compId = Number(competitionId) || 0;
    const s = String(sport || 'fb');
    const id = String(eventId);

    if (this.watchedEvent && (this.watchedEvent.eventId !== id)) {
      this.unsubscribeEvent(this.watchedEvent.competitionId, this.watchedEvent.sport, this.watchedEvent.eventId);
    }

    this.watchedEvent = { competitionId: compId, sport: s, eventId: id };

    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Build subscription targets: subscribe to primary sport + ht if football, or 'ih' if ice hockey
      const targets = [];
      if (s.startsWith('fb')) {
        targets.push([compId, 'fb', id]);
        targets.push([compId, 'fb_ht', id]);
      } else if (s === 'ih') {
        targets.push([compId, 'ih', id]);
      } else {
        targets.push([compId, s, id]);
      }

      const watchHcapsMsg = JSON.stringify(['watch_hcaps', targets]);
      this.ws.send(watchHcapsMsg);

      for (const t of targets) {
        this.ws.send(JSON.stringify(['watch_event', t]));
      }

      logger.info('WsFeed', `Subscribed to live prices for event ${id} (comp: ${compId}, sports: ${targets.map(t => t[1]).join(', ')})`);
    }
  }

  /**
   * Unsubscribes from an event.
   * @param {number|string} competitionId
   * @param {string} sport
   * @param {string} eventId
   */
  unsubscribeEvent(competitionId, sport, eventId) {
    const compId = Number(competitionId) || 0;
    const s = String(sport || 'fb');
    const id = String(eventId);

    // Evict lineSpectrums and eventActiveLines for this event
    for (const key of Array.from(this.eventActiveLines.keys())) {
      if (key.startsWith(`${id}:`)) {
        this.eventActiveLines.delete(key);
      }
    }
    for (const key of Array.from(this.lineSpectrums.keys())) {
      if (key.startsWith(`${id}:`)) {
        this.lineSpectrums.delete(key);
      }
    }
    for (const key of Array.from(this.eventScores.keys())) {
      if (key.startsWith(`${id}:`)) {
        this.eventScores.delete(key);
      }
    }

    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      const targets = [];
      if (s.startsWith('fb')) {
        targets.push([compId, 'fb', id]);
        targets.push([compId, 'fb_ht', id]);
      } else if (s === 'ih') {
        targets.push([compId, 'ih', id]);
      } else {
        targets.push([compId, s, id]);
      }

      this.ws.send(JSON.stringify(['unwatch_hcaps', targets]));
      for (const t of targets) {
        this.ws.send(JSON.stringify(['unwatch_event', t]));
      }

      logger.info('WsFeed', `Unwatched event ${id}`);
    } catch (err) {
      logger.error('WsFeed', `Failed to unwatch event ${id}: ${err.message}`);
    }
  }

  /**
   * Dispatches and parses incoming WebSocket messages.
   * Supports both single frames and batched array frames from Boost.Beast.
   *
   * @param {WebSocket.RawData} data
   * @param {boolean} isBinary
   */
  handleMessage(data, isBinary) {
    if (isBinary) return;

    let text;
    try {
      text = typeof data === 'string' ? data : data.toString('utf8');
    } catch {
      return;
    }

    if (!text || text.length === 0) return;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      logger.warn('WsFeed', `Failed to parse WS JSON: ${text.slice(0, 100)}`);
      return;
    }

    if (!Array.isArray(parsed) || parsed.length === 0) return;

    const frames = Array.isArray(parsed[0]) ? parsed : [parsed];

    for (let i = 0; i < frames.length; i++) {
      this.dispatchSingleFrame(frames[i]);
    }
  }

  /**
   * Dispatches an individual Boost.Beast frame.
   * @param {Array} frame
   */
  dispatchSingleFrame(frame) {
    if (!Array.isArray(frame) || frame.length === 0) return;

    const action = frame[0];

    // 1. Heartbeat pong response
    if (action === 'pong') {
      if (this.lastPingSentTs > 0) {
        this.lastWsRttMs = Number((performance.now() - this.lastPingSentTs).toFixed(2));
        this.emit('heartbeat', this.lastWsRttMs);
      }
      return;
    }

    // 2. Initial synchronization complete indicator
    if (action === 'synced') {
      logger.success('WsFeed', `Initial feed sync complete! Total events loaded: ${this.totalEventsReceived}`);
      this.emit('synced', { totalEvents: this.totalEventsReceived });
      return;
    }

    // 3. Match / event metadata
    if (action === 'event') {
      this.totalEventsReceived++;
      this.parseEventMessage(frame);
      return;
    }

    // 4. Live offers / prices
    if (action === 'offers_hcap' || action === 'offers_event' || action === 'offers_comp' || action === 'offers') {
      this.totalPriceTicksReceived++;
      this.parseOffersMessage(frame);
      return;
    }

    // 5. Account telemetry or status
    if (action === 'api') {
      this.parseApiMessage(frame);
      return;
    }

    if (action === 'error') {
      logger.warn('WsFeed', `Feed reported error frame: ${JSON.stringify(frame)}`);
      return;
    }

    this.emit('raw_frame', frame);
  }

  /**
   * Parses event metadata updates.
   * Frame format: ["event", [sport, eventId], metadata]
   * @param {Array} frame
   */
  parseEventMessage(frame) {
    if (frame.length < 3) return;

    const targetSpec = frame[1];
    const metadata = frame[2];

    if (!Array.isArray(targetSpec) || !metadata) return;

    const sport = String(targetSpec[0] || 'fb');
    const eventId = String(targetSpec[1]);
    const isHockey = sport === 'ih';

    let homeTeam = metadata.home || metadata.home_team || (metadata.teams && metadata.teams[0]?.name) || '';
    let awayTeam = metadata.away || metadata.away_team || (metadata.teams && metadata.teams[1]?.name) || '';

    if ((!homeTeam || !awayTeam) && metadata.event_name) {
      const parts = metadata.event_name.split(/ vs\.? | v | - /i);
      if (parts.length >= 2) {
        if (!homeTeam) homeTeam = parts[0].trim();
        if (!awayTeam) awayTeam = parts[1].trim();
      } else if (!homeTeam) {
        homeTeam = metadata.event_name;
      }
    }

    homeTeam = homeTeam || 'Home';
    awayTeam = awayTeam || 'Away';
    const competition = metadata.competition_name || metadata.competition || (isHockey ? 'Ice Hockey' : 'Soccer');
    const competitionId = metadata.competition_id || 0;
    const startTs = metadata.start_ts || '';

    let score = { home: 0, away: 0 };
    let htScore = undefined;
    let minute = '';
    let isLive = false;
    let hockeyPeriod = isHockey ? 1 : undefined;
    let periodScores = undefined;
    let periodScoresStr = '';
    let eventStage = '';

    if (metadata.ir_status && typeof metadata.ir_status === 'object') {
      const ir = metadata.ir_status;
      if (Array.isArray(ir.score) && ir.score.length >= 2) {
        score = {
          home: Number(ir.score[0]) || 0,
          away: Number(ir.score[1]) || 0
        };
        isLive = true;
      }

      if (isHockey) {
        eventStage = String(ir.event_stage || '');
        const upperStage = eventStage.toUpperCase();
        isLive = upperStage !== 'ENDED' && upperStage !== 'FINISHED';

        if (Array.isArray(ir.period_scores) && ir.period_scores.length > 0) {
          periodScores = ir.period_scores;
          if (ir.period_scores.length === 1) hockeyPeriod = 1;
          else if (ir.period_scores.length === 2) hockeyPeriod = 2;
          else if (ir.period_scores.length >= 3) hockeyPeriod = 3;

          const lastP = ir.period_scores[ir.period_scores.length - 1];
          if (Array.isArray(lastP) && lastP.length >= 2) {
            htScore = {
              home: Number(lastP[0]) || 0,
              away: Number(lastP[1]) || 0
            };
          }
          periodScoresStr = ir.period_scores
            .filter(p => Array.isArray(p) && p.length >= 2)
            .map(p => `${p[0]}:${p[1]}`)
            .join(', ');
        } else {
          const stageOrTime = `${eventStage} ${Array.isArray(ir.time) ? ir.time.join(' ') : (ir.time || '')}`;
          const m = stageOrTime.match(/\b([123])\s*p\b|\bp\s*([123])\b|\b([123])(?:st|nd|rd)[_\s]*period\b/i);
          if (m) {
            hockeyPeriod = Number(m[1] || m[2] || m[3]) || 1;
          }
        }

        this.eventHockeyPeriods.set(eventId, hockeyPeriod);

        let timeLabel = '';
        if (ir.period_time != null) {
          const pt = Array.isArray(ir.period_time) ? ir.period_time.join(' ') : String(ir.period_time);
          timeLabel = `P${hockeyPeriod} ${pt}'`;
        } else if (Array.isArray(ir.time) && ir.time.length >= 2) {
          timeLabel = `P${hockeyPeriod} ${ir.time[1]}'`;
        } else if (eventStage) {
          timeLabel = eventStage;
        } else {
          timeLabel = `P${hockeyPeriod}`;
        }

        minute = periodScoresStr ? `${timeLabel} (${periodScoresStr})` : timeLabel;
      } else if (Array.isArray(ir.time) && ir.time.length >= 2) {
        const half = ir.time[0] === '1h' ? '1H' : (ir.time[0] === '2h' ? '2H' : ir.time[0]);
        minute = `${half} ${ir.time[1]}'`;
        isLive = true;
        if (sport === 'fb' && ir.time[0] === '1h') {
          htScore = { ...score };
        }
      }
    }

    if (!isLive && !(isHockey && metadata.ir_status)) {
      if (Array.isArray(metadata.score) && metadata.score.length >= 2) {
        score = { home: Number(metadata.score[0]) || 0, away: Number(metadata.score[1]) || 0 };
        isLive = true;
      } else if (metadata.live_score && typeof metadata.live_score === 'object') {
        score = { home: Number(metadata.live_score.home) || 0, away: Number(metadata.live_score.away) || 0 };
        isLive = true;
      }

      if (metadata.minute || metadata.clock || metadata.time) {
        minute = String(metadata.minute || metadata.clock || metadata.time);
        isLive = true;
      }

      if (metadata.in_running || metadata.is_live || metadata.status === 'in_play') {
        isLive = true;
      }
    }

    if (isLive) {
      if (isHockey) {
        this.syncEventScore(eventId, `${eventId}:ih:FT`, score);
        if (htScore) {
          this.syncEventScore(eventId, `${eventId}:ih:P${hockeyPeriod}`, htScore);
        }
      } else {
        this.syncEventScore(eventId, `${eventId}:${sport}`, score);
        if (htScore && sport === 'fb') {
          this.syncEventScore(eventId, `${eventId}:fb_ht`, htScore);
        }
      }
    }

    const eventPayload = {
      eventId,
      sport,
      competitionId,
      competition,
      homeTeam,
      awayTeam,
      score,
      ftScore: (sport === 'fb' || isHockey) ? score : undefined,
      htScore: isHockey ? htScore : (sport === 'fb_ht' ? score : htScore),
      hockeyPeriod,
      periodScores,
      periodScoresStr: isHockey ? periodScoresStr : undefined,
      eventStage: isHockey ? eventStage : undefined,
      minute,
      isLive,
      startTs,
      raw: metadata
    };

    this.emit('event_update', eventPayload);
  }

  /**
   * Synchronizes live score for an event scope and evicts stale/settled lines from spectrum and sticky caches.
   * @param {string} eventId
   * @param {string} scopeOrSport - e.g. 'fb', 'fb_ht', 'ih', or full scopeKey `${eventId}:fb`
   * @param {{ home: number, away: number }} score
   */
  syncEventScore(eventId, scopeOrSport, score) {
    if (!eventId || !score) return;
    const home = Number(score.home) || 0;
    const away = Number(score.away) || 0;
    const total = home + away;

    const scopeKey = String(scopeOrSport).startsWith(`${eventId}:`)
      ? String(scopeOrSport)
      : (scopeOrSport === 'ih' ? `${eventId}:ih:FT` : `${eventId}:${scopeOrSport}`);

    const prev = this.eventScores.get(scopeKey);
    this.eventScores.set(scopeKey, { home, away });

    const sticky = this.eventActiveLines.get(scopeKey);
    if (prev && (prev.home !== home || prev.away !== away)) {
      if (sticky) {
        sticky.totalLine = null;
        if (prev.home !== home) sticky.itb1Line = null;
        if (prev.away !== away) sticky.itb2Line = null;
      }
      this.lineSpectrums.delete(`${scopeKey}:ahou`);
      if (prev.home !== home) this.lineSpectrums.delete(`${scopeKey}:itb1`);
      if (prev.away !== away) this.lineSpectrums.delete(`${scopeKey}:itb2`);
    }

    if (sticky) {
      if (sticky.totalLine && parseFloat(sticky.totalLine) <= total) sticky.totalLine = null;
      if (sticky.itb1Line && parseFloat(sticky.itb1Line) <= home) sticky.itb1Line = null;
      if (sticky.itb2Line && parseFloat(sticky.itb2Line) <= away) sticky.itb2Line = null;
    }

    const pruneSpectrum = (specKey, minGoalVal) => {
      const map = this.lineSpectrums.get(specKey);
      if (!map) return;
      for (const [lineStr] of map.entries()) {
        if (parseFloat(lineStr) <= minGoalVal) {
          map.delete(lineStr);
        }
      }
    };

    pruneSpectrum(`${scopeKey}:ahou`, total);
    pruneSpectrum(`${scopeKey}:itb1`, home);
    pruneSpectrum(`${scopeKey}:itb2`, away);
  }

  /**
   * Helper to format quarter-lines from Mollybet representation
   * @param {number|string} rawLine
   * @returns {string}
   */
  formatTotalLine(rawLine) {
    const num = Number(rawLine);
    if (Number.isNaN(num)) return String(rawLine || '2.5');
    if (Number.isInteger(num) && num >= 1) {
      return (num / 4).toFixed(2);
    }
    return String(num);
  }

  /**
   * Helper to parse general Total (over/under) markets across ahou and tahou.
   * Uses sticky line preference (preferredLine) to prevent jitter/hopping between lines.
   * Accumulates incoming lines into persistent lineSpectrums Map to fix jitter from single ticks.
   * @param {any} rawMarket
   * @param {string} defaultLine
   * @param {string} [preferredLine]
   * @param {string} [spectrumKey] - e.g. `${eventId}:${sport}:${marketType}`
   * @param {string} [selectionMode='even_money']
   * @param {number} [minExclusiveLine=-1] - Minimum goals already scored (lines <= this value are already settled)
   * @returns {{ totalOver: number, totalUnder: number, totalLine: string | null, rawTotalLineIndex: number | null, allLines: Array }}
   */
  parseTotalMarket(rawMarket, defaultLine = '2.5', preferredLine = null, spectrumKey = null, selectionMode = 'even_money', minExclusiveLine = -1) {
    if (!rawMarket) return { totalOver: 0, totalUnder: 0, totalLine: null, rawTotalLineIndex: null, allLines: [] };

    const parseSingle = (entry) => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const lineIdx = Number(entry[0]);
      if (Number.isNaN(lineIdx)) return null;
      const prices = entry[1];
      let over = 0, under = 0;
      if (Array.isArray(prices)) {
        for (const item of prices) {
          if (Array.isArray(item) && item.length >= 2) {
            const k = String(item[0]).toLowerCase();
            if (k === 'over' || k === 'o') over = Number(item[1]) || 0;
            if (k === 'under' || k === 'u') under = Number(item[1]) || 0;
          }
        }
      }
      return { lineIdx, over, under };
    };

    const incomingLines = [];

    const walkArrayMarket = (node) => {
      if (!Array.isArray(node)) return;
      if (typeof node[0] === 'number' && Array.isArray(node[1])) {
        const r = parseSingle(node);
        if (r) {
          incomingLines.push({
            rawTotalLineIndex: r.lineIdx,
            totalLine: this.formatTotalLine(r.lineIdx),
            totalOver: r.over,
            totalUnder: r.under
          });
        }
        return;
      }
      for (const child of node) {
        if (Array.isArray(child)) {
          walkArrayMarket(child);
        }
      }
    };

    if (Array.isArray(rawMarket)) {
      walkArrayMarket(rawMarket);
    } else if (typeof rawMarket === 'object' && rawMarket !== null) {
      const lines = Object.keys(rawMarket);
      if (lines.length > 0) {
        for (const line of lines) {
          const val = rawMarket[line];
          const lineIdx = Math.round(parseFloat(line) * 4);
          incomingLines.push({
            rawTotalLineIndex: lineIdx,
            totalLine: String(line),
            totalOver: Number(val?.o || val?.over || 0),
            totalUnder: Number(val?.u || val?.under || 0)
          });
        }
      }
    }

    if (incomingLines.length === 0) {
      return { totalOver: 0, totalUnder: 0, totalLine: null, rawTotalLineIndex: null, allLines: [] };
    }

    // Filter out any already-settled lines (<= minExclusiveLine) when newer lines exist
    const filteredIncoming = minExclusiveLine >= 0
      ? incomingLines.filter(item => parseFloat(item.totalLine) > minExclusiveLine)
      : incomingLines;
    const validIncoming = filteredIncoming.length > 0 ? filteredIncoming : incomingLines;

    // Accumulate in lineSpectrums registry if spectrumKey is provided
    let allLines = [];
    if (spectrumKey) {
      let spectrumMap = this.lineSpectrums.get(spectrumKey);
      if (!spectrumMap) {
        spectrumMap = new Map();
        this.lineSpectrums.set(spectrumKey, spectrumMap);
      }
      if (minExclusiveLine >= 0) {
        for (const [k] of spectrumMap.entries()) {
          if (parseFloat(k) <= minExclusiveLine) {
            spectrumMap.delete(k);
          }
        }
      }
      for (const item of validIncoming) {
        spectrumMap.set(item.totalLine, item);
      }
      allLines = Array.from(spectrumMap.values());
    } else {
      allLines = validIncoming;
    }

    if (allLines.length === 0) {
      return { totalOver: 0, totalUnder: 0, totalLine: null, rawTotalLineIndex: null, allLines: [] };
    }

    allLines.sort((a, b) => parseFloat(a.totalLine) - parseFloat(b.totalLine));

    // 1. Sticky line check: if preferredLine is provided, > minExclusiveLine, and still has active offers, stick to it!
    if (preferredLine && (minExclusiveLine < 0 || parseFloat(preferredLine) > minExclusiveLine)) {
      const pref = allLines.find(x => x.totalLine === String(preferredLine));
      if (pref && pref.totalOver > 1.0) {
        return {
          rawTotalLineIndex: pref.rawTotalLineIndex,
          totalLine: pref.totalLine,
          totalOver: pref.totalOver,
          totalUnder: pref.totalUnder,
          allLines
        };
      }
    }

    // 2. Select main market line
    let best = null;
    
    if (selectionMode === 'lowest') {
      // For ITB: pick the smallest total line available with over > 1.0 (e.g., 0.5 or 1.5)
      for (const item of allLines) {
        if (item.totalOver > 1.0) {
          best = item;
          break; // Since allLines is already sorted ascending, the first one is the lowest
        }
      }
    } else {
      // For main total (even_money): closest to 1.95 with over > 1.0
      let minDiff = Infinity;
      for (const item of allLines) {
        if (item.totalOver > 1.0) {
          const diff = Math.abs(item.totalOver - 1.95);
          if (diff < minDiff) {
            minDiff = diff;
            best = item;
          }
        }
      }
    }

    const chosen = best || (allLines.find(x => x.totalOver > 1.0)) || allLines[0];
    if (chosen) {
      return {
        rawTotalLineIndex: chosen.rawTotalLineIndex,
        totalLine: chosen.totalLine,
        totalOver: chosen.totalOver,
        totalUnder: chosen.totalUnder,
        allLines
      };
    }

    return { totalOver: 0, totalUnder: 0, totalLine: null, rawTotalLineIndex: null, allLines };
  }

  /**
   * Builds a single parsedOdds structure from resolved market entries.
   * @private
   */
  _buildParsedOdds(eventId, scopeKey, defaultTotalLine, defaultItbLine, marketSlice, rawMarkets) {
    const parsedOdds = {
      winHome: 0,
      winDraw: 0,
      winAway: 0,
      totalOver: 0,
      totalUnder: 0,
      totalLine: null,
      rawTotalLineIndex: null,
      itb1Over: 0,
      itb1Under: 0,
      itb1Line: null,
      rawItb1LineIndex: null,
      itb2Over: 0,
      itb2Under: 0,
      itb2Line: null,
      rawItb2LineIndex: null,
      totalLines: [],
      itb1Lines: [],
      itb2Lines: [],
      rawMarkets
    };

    if (marketSlice.hasWdw && marketSlice.rawWdw) {
      const wdwPrices = extractWdwPrices(marketSlice.rawWdw);
      if (wdwPrices.h > 0) parsedOdds.winHome = wdwPrices.h;
      if (wdwPrices.d > 0) parsedOdds.winDraw = wdwPrices.d;
      if (wdwPrices.a > 0) parsedOdds.winAway = wdwPrices.a;
    }

    const stickyLines = this.eventActiveLines.get(scopeKey) || {};
    const currentScore = this.eventScores.get(scopeKey);
    const minTotalLine = currentScore ? (currentScore.home + currentScore.away) : -1;
    const minItb1Line = currentScore ? currentScore.home : -1;
    const minItb2Line = currentScore ? currentScore.away : -1;

    if (marketSlice.hasAhou && marketSlice.rawAhou) {
      const ahouKey = `${scopeKey}:ahou`;
      const parsedAhou = this.parseTotalMarket(marketSlice.rawAhou, defaultTotalLine, stickyLines.totalLine, ahouKey, 'even_money', minTotalLine);
      parsedOdds.totalLines = parsedAhou.allLines || [];
      if (parsedAhou.totalOver > 0 || parsedAhou.totalUnder > 0 || parsedAhou.totalLine) {
        parsedOdds.totalOver = parsedAhou.totalOver;
        parsedOdds.totalUnder = parsedAhou.totalUnder;
        parsedOdds.totalLine = parsedAhou.totalLine;
        parsedOdds.rawTotalLineIndex = parsedAhou.rawTotalLineIndex;
        stickyLines.totalLine = parsedAhou.totalLine;
      }
    }

    if (marketSlice.hasTahouH && marketSlice.rawTahouH) {
      const itb1Key = `${scopeKey}:itb1`;
      const parsedTahouH = this.parseTotalMarket(marketSlice.rawTahouH, defaultItbLine, null, itb1Key, 'lowest', minItb1Line);
      parsedOdds.itb1Lines = parsedTahouH.allLines || [];
      if (parsedTahouH.totalOver > 0 || parsedTahouH.totalUnder > 0 || parsedTahouH.totalLine) {
        parsedOdds.itb1Over = parsedTahouH.totalOver;
        parsedOdds.itb1Under = parsedTahouH.totalUnder;
        parsedOdds.itb1Line = parsedTahouH.totalLine;
        parsedOdds.rawItb1LineIndex = parsedTahouH.rawTotalLineIndex;
        stickyLines.itb1Line = parsedTahouH.totalLine;
      }
    }

    if (marketSlice.hasTahouA && marketSlice.rawTahouA) {
      const itb2Key = `${scopeKey}:itb2`;
      const parsedTahouA = this.parseTotalMarket(marketSlice.rawTahouA, defaultItbLine, null, itb2Key, 'lowest', minItb2Line);
      parsedOdds.itb2Lines = parsedTahouA.allLines || [];
      if (parsedTahouA.totalOver > 0 || parsedTahouA.totalUnder > 0 || parsedTahouA.totalLine) {
        parsedOdds.itb2Over = parsedTahouA.totalOver;
        parsedOdds.itb2Under = parsedTahouA.totalUnder;
        parsedOdds.itb2Line = parsedTahouA.totalLine;
        parsedOdds.rawItb2LineIndex = parsedTahouA.rawTotalLineIndex;
        stickyLines.itb2Line = parsedTahouA.totalLine;
      }
    }

    this.eventActiveLines.set(scopeKey, stickyLines);

    parsedOdds.updatedMarkets = {
      wdw: Boolean(marketSlice.hasWdw),
      ahou: Boolean(marketSlice.hasAhou),
      itb1: Boolean(marketSlice.hasTahouH),
      itb2: Boolean(marketSlice.hasTahouA)
    };

    return parsedOdds;
  }

  /**
   * Parses live offers / prices updates.
   * Frame format: ["offers_hcap" | "offers_event", [compId, sport, eventId], markets]
   * @param {Array} frame
   */
  parseOffersMessage(frame) {
    if (frame.length < 3) return;

    const targetSpec = frame[1];
    const markets = frame[2];

    if (!Array.isArray(targetSpec) || !markets) return;

    let eventId = '';
    let sport = 'fb';
    let competitionId = 0;

    if (targetSpec.length === 3) {
      competitionId = Number(targetSpec[0]) || 0;
      sport = String(targetSpec[1]);
      eventId = String(targetSpec[2]);
    } else if (targetSpec.length === 2) {
      sport = String(targetSpec[0]);
      eventId = String(targetSpec[1]);
    }

    if (!eventId) return;

    // Special smart market resolution for Ice Hockey ('ih')
    if (sport === 'ih') {
      const allKeys = Object.keys(markets);
      const isPeriodKey = (k) => k.includes('tperiod,') || /tp,p[123]\b/.test(k);

      // 1. Resolve Regular Time (FT: tp,reg or short keys, with fallback to tp,all,ml for menu display)
      const ftWdwKey = ['wdw', 'tp,reg,wdw', 'time_win,tp,reg,wdw'].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => !isPeriodKey(k) && (k === 'wdw' || k.endsWith(',wdw')))
        || ['time_win,tp,all,ml', 'tp,all,ml', 'ml'].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => !isPeriodKey(k) && k.endsWith(',ml'));

      const ftAhouKey = ['ahou', 'tp,reg,ahou', 'total,tp,reg,ahou'].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => !isPeriodKey(k) && !k.includes('tahou') && (k === 'ahou' || k.endsWith(',ahou')));

      const ftTahouHKey = ['tahou,h', 'tahou_h', 'tp,reg,tahou,h', 'tp,reg,tahou_h'].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => !isPeriodKey(k) && (k.endsWith('tahou,h') || k.endsWith('tahou_h')));

      const ftTahouAKey = ['tahou,a', 'tahou_a', 'tp,reg,tahou,a', 'tp,reg,tahou_a'].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => !isPeriodKey(k) && (k.endsWith('tahou,a') || k.endsWith('tahou_a')));

      const hasAnyFt = Boolean(ftWdwKey || ftAhouKey || ftTahouHKey || ftTahouAKey);

      // 2. Resolve Active Hockey Period (HT: tperiod,N or tp,pN)
      const knownPeriod = this.eventHockeyPeriods.get(eventId);
      const periodNumbersInFrame = new Set();
      for (const k of allKeys) {
        const m = k.match(/(?:tperiod,|tp,p)([123])(?:,|$)/);
        if (m) periodNumbersInFrame.add(Number(m[1]));
      }

      let activePeriod = knownPeriod || 1;
      if (periodNumbersInFrame.size > 0 && !periodNumbersInFrame.has(activePeriod)) {
        activePeriod = Array.from(periodNumbersInFrame)[0];
      }

      const matchPeriodN = (k, p) => k.includes(`tperiod,${p}`) || k.includes(`tp,p${p}`);
      const htWdwKey = [`tperiod,${activePeriod},wdw`, `tp,p${activePeriod},wdw`, `time_win,tperiod,${activePeriod},wdw`].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => matchPeriodN(k, activePeriod) && k.endsWith('wdw'));

      const htAhouKey = [`tperiod,${activePeriod},ahou`, `tp,p${activePeriod},ahou`, `total,tperiod,${activePeriod},ahou`].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => matchPeriodN(k, activePeriod) && !k.includes('tahou') && k.endsWith('ahou'));

      const htTahouHKey = [`tperiod,${activePeriod},tahou,h`, `tperiod,${activePeriod},tahou_h`, `tp,p${activePeriod},tahou,h`, `tp,p${activePeriod},tahou_h`].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => matchPeriodN(k, activePeriod) && (k.endsWith('tahou,h') || k.endsWith('tahou_h')));

      const htTahouAKey = [`tperiod,${activePeriod},tahou,a`, `tperiod,${activePeriod},tahou_a`, `tp,p${activePeriod},tahou,a`, `tp,p${activePeriod},tahou_a`].find(k => Object.prototype.hasOwnProperty.call(markets, k))
        || allKeys.find(k => matchPeriodN(k, activePeriod) && (k.endsWith('tahou,a') || k.endsWith('tahou_a')));

      const hasAnyHt = Boolean(htWdwKey || htAhouKey || htTahouHKey || htTahouAKey);

      if (hasAnyFt || !hasAnyHt) {
        const ftParsed = this._buildParsedOdds(
          eventId,
          `${eventId}:ih`,
          '5.5',
          '2.5',
          {
            hasWdw: Boolean(ftWdwKey),
            rawWdw: ftWdwKey ? markets[ftWdwKey] : null,
            hasAhou: Boolean(ftAhouKey),
            rawAhou: ftAhouKey ? markets[ftAhouKey] : null,
            hasTahouH: Boolean(ftTahouHKey),
            rawTahouH: ftTahouHKey ? markets[ftTahouHKey] : null,
            hasTahouA: Boolean(ftTahouAKey),
            rawTahouA: ftTahouAKey ? markets[ftTahouAKey] : null
          },
          markets
        );

        logger.debug('WsFeed', `[IH FT] Odds tick for ${eventId}: O(${ftParsed.totalLine || '5.5'})=${ftParsed.totalOver}, 1=${ftParsed.winHome}, 2=${ftParsed.winAway}, ITB1(${ftParsed.itb1Line || '2.5'})=${ftParsed.itb1Over}, ITB2(${ftParsed.itb2Line || '2.5'})=${ftParsed.itb2Over}`);

        this.emit('odds_update', {
          eventId,
          sport: 'ih',
          periodType: 'FT',
          competitionId,
          odds: ftParsed,
          updatedMarkets: ftParsed.updatedMarkets
        });
      }

      if (hasAnyHt) {
        const htParsed = this._buildParsedOdds(
          eventId,
          `${eventId}:ih_p${activePeriod}`,
          '1.5',
          '0.5',
          {
            hasWdw: Boolean(htWdwKey),
            rawWdw: htWdwKey ? markets[htWdwKey] : null,
            hasAhou: Boolean(htAhouKey),
            rawAhou: htAhouKey ? markets[htAhouKey] : null,
            hasTahouH: Boolean(htTahouHKey),
            rawTahouH: htTahouHKey ? markets[htTahouHKey] : null,
            hasTahouA: Boolean(htTahouAKey),
            rawTahouA: htTahouAKey ? markets[htTahouAKey] : null
          },
          markets
        );

        logger.debug('WsFeed', `[IH P${activePeriod}] Odds tick for ${eventId}: O(${htParsed.totalLine || '1.5'})=${htParsed.totalOver}, 1=${htParsed.winHome}, 2=${htParsed.winAway}, ITB1(${htParsed.itb1Line || '0.5'})=${htParsed.itb1Over}, ITB2(${htParsed.itb2Line || '0.5'})=${htParsed.itb2Over}`);

        this.emit('odds_update', {
          eventId,
          sport: 'ih',
          periodType: 'HT',
          hockeyPeriod: activePeriod,
          competitionId,
          odds: htParsed,
          updatedMarkets: htParsed.updatedMarkets
        });
      }

      return;
    }

    const isHtSport = sport === 'fb_ht';
    const defaultTotalLine = isHtSport ? '0.5' : '2.5';
    const defaultItbLine = isHtSport ? '0.5' : '1.5';

    const hasWdw = Object.prototype.hasOwnProperty.call(markets, 'wdw');
    const hasAhou = Object.prototype.hasOwnProperty.call(markets, 'ahou');
    const hasTahouH = Object.prototype.hasOwnProperty.call(markets, 'tahou,h') || Object.prototype.hasOwnProperty.call(markets, 'tahou_h');
    const hasTahouA = Object.prototype.hasOwnProperty.call(markets, 'tahou,a') || Object.prototype.hasOwnProperty.call(markets, 'tahou_a');

    const parsedOdds = this._buildParsedOdds(
      eventId,
      `${eventId}:${sport}`,
      defaultTotalLine,
      defaultItbLine,
      {
        hasWdw,
        rawWdw: markets.wdw,
        hasAhou,
        rawAhou: markets.ahou,
        hasTahouH,
        rawTahouH: markets['tahou,h'] || markets.tahou_h,
        hasTahouA,
        rawTahouA: markets['tahou,a'] || markets.tahou_a
      },
      markets
    );

    logger.debug('WsFeed', `Odds tick for ${eventId}: O(${parsedOdds.totalLine || '?'})=${parsedOdds.totalOver}, 1=${parsedOdds.winHome}, 2=${parsedOdds.winAway}, ITB1(${parsedOdds.itb1Line || '?'})=${parsedOdds.itb1Over}, ITB2(${parsedOdds.itb2Line || '?'})=${parsedOdds.itb2Over}`);

    this.emit('odds_update', {
      eventId,
      sport,
      periodType: isHtSport ? 'HT' : 'FT',
      competitionId,
      odds: parsedOdds,
      updatedMarkets: parsedOdds.updatedMarkets
    });
  }

  /**
   * Parses account balance / info from API frames.
   * @param {Array} frame
   */
  parseApiMessage(frame) {
    if (frame.length < 2 || !frame[1] || !Array.isArray(frame[1].data)) return;

    for (const item of frame[1].data) {
      if (Array.isArray(item) && item[0] === 'balance' && item[1]) {
        const bal = item[1].balance;
        if (Array.isArray(bal)) {
          logger.info('WsFeed', `Account Balance: ${bal[0]} ${bal[1]}`);
          this.emit('balance', { currency: bal[0], amount: Number(bal[1]) });
        }
      } else if (Array.isArray(item) && item[0] === 'betslip' && item[1]) {
        logger.debug('WsFeed', `Received betslip update for ${item[1].betslip_id}`);
        this.emit('betslip_update', item[1]);
      } else if (Array.isArray(item) && item[0] === 'pmm' && item[1]) {
        this.emit('pmm_update', item[1]);
      } else if (Array.isArray(item) && item[0] === 'order' && item[1]) {
        logger.debug('WsFeed', `Received order frame for ${item[1].order_id || item[1].id}`);
        this.emit('order_update', item[1]);
      } else if (Array.isArray(item) && item[0] === 'betslip_closed' && item[1]) {
        logger.debug('WsFeed', `Received betslip_closed for ${item[1].betslip_id} (${item[1].close_reason})`);
        this.emit('betslip_closed', item[1]);
      }
    }
  }

  /**
   * Graceful disconnect and resource disposal.
   */
  async destroy() {
    this.isDestroyed = true;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // Safe ignore
      }
      this.ws = null;
    }
    this.eventActiveLines.clear();
    this.lineSpectrums.clear();
    this.eventScores.clear();
    this.isConnected = false;
  }
}
