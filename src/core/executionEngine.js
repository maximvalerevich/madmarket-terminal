import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger.js';

/**
 * ExecutionEngine
 * Ultra low-latency execution manager for combat orders.
 * Performs sub-millisecond local serialization, debounce guards,
 * slippage price calculations, and asynchronous order dispatching.
 */
export class ExecutionEngine extends EventEmitter {
  /**
   * @param {import('../adapters/baseAdapter.js').BaseAdapter} adapter
   * @param {import('./stateManager.js').StateManager} stateManager
   * @param {Object} config
   */
  constructor(adapter, stateManager, config) {
    super();
    this.adapter = adapter;
    this.stateManager = stateManager;
    this.config = config;

    this.lastFireTime = -Infinity;
    this.debounceMs = Number(config.debounceMs) || 2000;
    this.wsFeed = null;
    this.activeOrderTrackers = new Map();
  }

  /**
   * Binds WebSocket feed for streaming order execution events.
   * @param {import('../network/wsFeed.js').WsFeed} wsFeed
   */
  setWsFeed(wsFeed) {
    this.wsFeed = wsFeed;
    wsFeed.on('order_update', (orderData) => {
      this.handleWsOrderUpdate(orderData);
    });
  }

  /**
   * Handles WebSocket order event push.
   * @param {Object} orderData
   */
  handleWsOrderUpdate(orderData) {
    if (!orderData) return;
    const orderId = String(orderData.order_id || orderData.id || '');
    if (!orderId) return;

    const tracker = this.activeOrderTrackers.get(orderId);
    if (tracker) {
      tracker.resolveWithData(orderData);
    }
  }

  /**
   * Fires an immediate combat bet for the given target key.
   *
   * @param {'OVER' | 'HOME' | 'AWAY'} targetKey
   * @returns {Promise<Object>}
   */
  async fire(targetKey) {
    const triggerStart = performance.now();

    // 1. Debounce guard
    const elapsed = triggerStart - this.lastFireTime;
    if (elapsed < this.debounceMs) {
      const remaining = Math.ceil(this.debounceMs - elapsed);
      const msg = `[DEBOUNCE] Fire blocked! Cooldown active (${remaining}ms remaining)`;
      logger.warn('ExecutionEngine', msg);
      this.emit('log', { level: 'warn', message: msg });
      return { success: false, reason: 'DEBOUNCE', remaining };
    }

    // 2. Active event validation
    if (!this.stateManager.activeEventId) {
      const msg = `[ABORT] No active event selected! Press 'M' to choose a match.`;
      logger.error('ExecutionEngine', msg);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', { status: 'ABORT', targetKey, message: msg, timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false }) });
      return { success: false, reason: 'NO_ACTIVE_EVENT' };
    }

    // 3. Extract pre-armed betslip
    const armed = this.stateManager.getArmedBetslip(targetKey);
    if (!armed) {
      const msg = `[ABORT] Купон для ${targetKey} недоступен в текущем контексте (период: ${this.stateManager.activePeriod}, режим: ${this.stateManager.activeMarketMode})!`;
      logger.error('ExecutionEngine', msg);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', { status: 'ABORT', targetKey, message: msg, timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false }) });
      return { success: false, reason: 'INVALID_CONTEXT' };
    }
    if (!armed.betslipId) {
      const msg = `[ABORT] Betslip for ${targetKey} is NOT armed! (Waiting for pre-warm)`;
      logger.error('ExecutionEngine', msg);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', { status: 'ABORT', targetKey, message: msg, timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false }) });
      return { success: false, reason: 'BETSLIP_NOT_ARMED' };
    }

    // Check expiry
    const nowTs = Date.now();
    if (armed.expiryTs > 0 && nowTs >= armed.expiryTs) {
      const msg = `[ABORT] Betslip for ${targetKey} has expired (${(nowTs - armed.expiryTs)}ms ago)!`;
      logger.error('ExecutionEngine', msg);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', { status: 'ABORT', targetKey, message: msg, timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false }) });
      // Force immediate re-arming
      this.stateManager.invalidateBetslip(targetKey);
      return { success: false, reason: 'BETSLIP_EXPIRED' };
    }

    // Snapshot armed slip data before invalidating to avoid race condition/null dereference
    const betslipId = armed.betslipId;
    const armedSnapshot = { ...armed };

    // 4. Freshest live price and limit price calculation
    // Absolute priority order:
    // 1. Fresh bookie quote (< 10s old) directly from PMM or betslip offer (e.g. pin88)
    // 2. armed.currentPrice (if set and valid)
    // 3. rawLivePrice from general feed ticker (ONLY if no strict bookmaker filtering is configured)
    // 4. armed.price (fallback)
    const now = Date.now();
    const hasFreshBookieQuote = armed.bookiePrice && (now - (armed.bookiePriceTs || 0) < 10000);
    const rawLivePrice = this.stateManager.getLivePrice(targetKey);
    const allowed = this.stateManager.getAllowedBookies();
    const hasStrictAllowed = allowed && allowed.size > 0;

    let livePrice = 0;
    if (hasFreshBookieQuote) {
      livePrice = armed.bookiePrice;
    } else if (armed.currentPrice && armed.currentPrice > 1.0) {
      livePrice = armed.currentPrice;
    } else if (!hasStrictAllowed && rawLivePrice > 1.0) {
      livePrice = rawLivePrice;
    } else if (armed.price && armed.price > 1.0) {
      livePrice = armed.price;
    }

    if (!livePrice || livePrice <= 1.0) {
      const msg = `[ABORT] Линия БК закрыта (кэф: 0.00). Дождитесь открытия котировок БК.`;
      logger.error('ExecutionEngine', msg);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', { status: 'ABORT', targetKey, message: msg, timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false }) });
      return { success: false, reason: 'LINE_CLOSED' };
    }

    const slippagePct = typeof this.config.slippagePct === 'number' ? this.config.slippagePct : 0.03;
    const limitPrice = Math.max(1.01, Number((livePrice * (1 - slippagePct)).toFixed(3)));

    // Clamp stake to per-outcome bookie limit (HT markets usually have much lower limits).
    // Sending more than the limit makes the broker fill only the limit and keep the remainder
    // hanging until `duration` expires (closed as timed_out) — so cut it locally before dispatch.
    const requestedStake = this.stateManager.activeStake;
    const outcomeLimit = typeof armedSnapshot.maxStake === 'number' && armedSnapshot.maxStake > 0
      ? Math.floor(armedSnapshot.maxStake * 100) / 100
      : 0;
    const stake = outcomeLimit > 0 ? Math.min(requestedStake, outcomeLimit) : requestedStake;
    const stakeClamped = stake < requestedStake;
    const currency = this.config.defaultCurrency || 'EUR';

    if (!(stake > 0)) {
      const msg = `[ABORT] Лимит исхода ${targetKey} равен нулю — БК не принимает ставки.`;
      logger.error('ExecutionEngine', msg);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', { status: 'ABORT', targetKey, message: msg, timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false }) });
      return { success: false, reason: 'ZERO_LIMIT' };
    }

    if (stakeClamped) {
      const msg = `[LIMIT] ${targetKey}: ставка €${requestedStake} срезана до лимита исхода €${stake}`;
      logger.warn('ExecutionEngine', msg);
      this.emit('log', { level: 'warn', message: msg });
    }

    // Set debounce timestamp immediately
    this.lastFireTime = performance.now();

    // 5. Dry-run simulation mode
    if (this.config.dryRun) {
      this.stateManager.invalidateBetslip(targetKey);
      const prepTimeMs = Number((performance.now() - triggerStart).toFixed(2));
      const slipTag = betslipId ? String(betslipId).slice(-8) : 'N/A';
      const msg = `[DRY-RUN] ${targetKey} | Slip: ${slipTag} | Limit: ${limitPrice.toFixed(2)} (Live: ${livePrice.toFixed(2)}) | Stake: €${stake} | Prep: ${prepTimeMs}ms`;
      logger.success('ExecutionEngine', msg);
      this.emit('log', { level: 'success', message: msg });
      this.emit('execution_result', {
        status: 'SUCCESS',
        dryRun: true,
        targetKey,
        orderId: `SIM-${Date.now()}`,
        limitPrice,
        livePrice,
        stake,
        requestedStake: stakeClamped ? requestedStake : null,
        rttMs: prepTimeMs,
        message: msg,
        timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
      });
      return {
        success: true,
        dryRun: true,
        orderId: `SIM-${Date.now()}`,
        limitPrice,
        livePrice,
        stake,
        rttMs: prepTimeMs
      };
    }

    // 6. Live combat order dispatch via HTTP/2
    try {
      logger.info('ExecutionEngine', `Dispatching LIVE order for ${targetKey} against betslip ${betslipId} (livePrice: ${livePrice}, stake: ${stake})`);
      const result = await this.adapter.placeOrder(armedSnapshot, livePrice, stake);

      if (result.success) {
        const orderDisplay = result.orderId ? `Order: ${result.orderId}` : 'Order: OK';
        const msg = `[В СТАКАНЕ БК (IN-FLIGHT)...] ${orderDisplay} | ${targetKey} | Limit: ${result.limitPrice.toFixed(2)} (Live: ${result.livePrice.toFixed(2)}) | Stake: €${stake} | RTT: ${result.rttMs}ms`;
        logger.info('ExecutionEngine', msg);
        this.stateManager.recordOrderExecution(targetKey, result);
        this.emit('log', { level: 'info', message: msg });
        this.emit('execution_result', {
          status: 'IN_FLIGHT',
          targetKey,
          orderId: result.orderId,
          limitPrice: result.limitPrice,
          livePrice: result.livePrice,
          stake,
          requestedStake: stakeClamped ? requestedStake : null,
          rttMs: result.rttMs,
          message: msg,
          timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
        });

        if (result.orderId) {
          this.trackOrder(result.orderId, targetKey, { ...result, requestedStake: stakeClamped ? requestedStake : null });
        }
      } else {
        const errorDetail = result.data?.errors
          ? JSON.stringify(result.data.errors)
          : (result.data?.message || result.rawBody?.slice(0, 120) || 'Unknown error');
        const msg = `[FAILED ${result.status}] ${targetKey} | Reason: ${errorDetail} | RTT: ${result.rttMs}ms`;
        logger.error('ExecutionEngine', msg);
        this.emit('log', { level: 'error', message: msg });
        this.emit('execution_result', {
          status: 'FAILED',
          targetKey,
          httpStatus: result.status,
          reason: errorDetail,
          limitPrice,
          livePrice,
          stake,
          rttMs: result.rttMs,
          message: msg,
          timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
        });
      }

      return result;
    } catch (orderErr) {
      const rttMs = Number((performance.now() - triggerStart).toFixed(2));
      const msg = `[EXCEPTION] ${targetKey} | Error: ${orderErr.message} | RTT: ${rttMs}ms`;
      logger.error('ExecutionEngine', msg, orderErr);
      this.emit('log', { level: 'error', message: msg });
      this.emit('execution_result', {
        status: 'EXCEPTION',
        targetKey,
        reason: orderErr.message,
        rttMs,
        message: msg,
        timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
      });
      return {
        success: false,
        error: orderErr.message,
        rttMs
      };
    } finally {
      // Invalidate betslip only AFTER order dispatch call finishes
      this.stateManager.invalidateBetslip(targetKey);
    }
  }

  /**
   * Asynchronously monitors order settlement status until filled or rejected.
   * Emits updated execution_result with definitive bookmaker status.
   *
   * @param {string} orderId
   * @param {string} targetKey
   * @param {Object} initialResult
   */
  async trackOrder(orderId, targetKey, initialResult) {
    if (!orderId || !this.adapter || typeof this.adapter.getOrderStatus !== 'function') {
      return;
    }

    const startTs = performance.now();
    const durationSec = typeof this.config.defaultDuration === 'number' ? this.config.defaultDuration : 25;
    const timeoutMs = (durationSec + 10) * 1000;
    const pollIntervalMs = 400;

    let isDone = false;
    let wsResolver = null;

    const cleanup = () => {
      isDone = true;
      this.activeOrderTrackers.delete(orderId);
    };

    this.activeOrderTrackers.set(orderId, {
      resolveWithData: (data) => {
        if (wsResolver) wsResolver(data);
      }
    });

    const pollLoop = async () => {
      while (!isDone && (performance.now() - startTs < timeoutMs)) {
        try {
          const statusResult = await this.adapter.getOrderStatus(orderId);
          if (statusResult && statusResult.success) {
            const st = String(statusResult.status || '').toLowerCase();
            const closed = Boolean(statusResult.closed);
            const closeReason = statusResult.closeReason || '';
            const gotStake = typeof statusResult.gotStake === 'number' ? statusResult.gotStake : 0;
            const isFinal = closed || st === 'done' || st === 'failed';
            const fullyFilled = (st !== 'failed') && (closeReason === 'order_filled' || (st === 'done' && !closeReason));

            // 1. Success fill / matched (including partial fill: closed with got_stake > 0)
            if (isFinal && (fullyFilled || gotStake > 0)) {
              cleanup();
              const gotPrice = statusResult.gotPrice || initialResult.limitPrice;
              const bookie = statusResult.bookie || 'pin88';
              const durationSec = ((performance.now() - startTs) / 1000).toFixed(1);
              const sentStake = typeof initialResult.stake === 'number'
                ? initialResult.stake
                : (Array.isArray(initialResult.stake) ? initialResult.stake[1] : initialResult.stake);
              const filledStake = gotStake > 0 ? gotStake : sentStake;
              const isPartial = !fullyFilled && gotStake > 0 && typeof sentStake === 'number' && gotStake < sentStake;
              const partialTag = isPartial ? ` ЧАСТИЧНО €${filledStake} из €${sentStake}` : '';
              const msg = `[СТАВКА ПРИНЯТА (DONE) ${bookie}${partialTag}] ${targetKey} @ кэф ${gotPrice.toFixed(2)} | €${filledStake} | ID: ${orderId} (${durationSec}s)`;
              logger.success('ExecutionEngine', msg);
              this.emit('log', { level: 'success', message: msg });
              this.emit('execution_result', {
                status: 'DONE',
                targetKey,
                orderId,
                bookie,
                gotPrice,
                limitPrice: initialResult.limitPrice,
                livePrice: initialResult.livePrice,
                stake: filledStake,
                sentStake,
                requestedStake: initialResult.requestedStake ?? null,
                partial: isPartial,
                rttMs: initialResult.rttMs,
                fillTimeSec: Number(durationSec),
                message: msg,
                timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
              });
              return;
            }

            // 2. Failed / timed out / rejected (nothing filled)
            if (isFinal) {
              cleanup();
              const reason = closeReason || 'timed_out';
              const durationSec = ((performance.now() - startTs) / 1000).toFixed(1);

              let unplacedDetail = '';
              if (Array.isArray(statusResult.unplaced) && statusResult.unplaced.length > 0) {
                unplacedDetail = statusResult.unplaced
                  .map(u => `${u.bookie || 'BK'}: ${u.reason || u.status || 'rejected'}`)
                  .join(', ');
              }

              let statusEnum = 'REJECTED';
              let msg = `[СТАВКА ОТКЛОНЕНА БК (${reason.toUpperCase()})] ${targetKey} | Причина: ${reason}${unplacedDetail ? ` (${unplacedDetail})` : ''} | ID: ${orderId} (${durationSec}s)`;

              if (reason === 'event_score') {
                statusEnum = 'EVENT_SCORE';
                msg = `[СТАВКА АННУЛИРОВАНА] Счёт изменился во время обработки ордера БК (event_score) | ID: ${orderId} (${durationSec}s)`;
              }

              logger.warn('ExecutionEngine', msg);
              this.emit('log', { level: 'warn', message: msg });
              this.emit('execution_result', {
                status: statusEnum,
                targetKey,
                orderId,
                reason,
                limitPrice: initialResult.limitPrice,
                livePrice: initialResult.livePrice,
                stake: initialResult.stake,
                rttMs: initialResult.rttMs,
                durationSec: Number(durationSec),
                message: msg,
                timestamp: new Date().toLocaleTimeString('ru-RU', { hour12: false })
              });
              return;
            }
          }
        } catch (err) {
          logger.debug('ExecutionEngine', `Order tracking poll error for ${orderId}: ${err.message}`);
        }

        // Wait poll interval or early WS update trigger
        await new Promise((resolve) => {
          wsResolver = resolve;
          setTimeout(resolve, pollIntervalMs);
        });
      }

      if (!isDone) {
        cleanup();
        logger.debug('ExecutionEngine', `Order tracking timed out after ${timeoutMs / 1000}s for ${orderId}`);
      }
    };

    pollLoop().catch((err) => {
      cleanup();
      logger.debug('ExecutionEngine', `Order tracker loop error: ${err.message}`);
    });
  }
}
