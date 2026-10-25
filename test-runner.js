import assert from 'node:assert/strict';
import { BaseAdapter } from './src/adapters/baseAdapter.js';
import { MollybetAdapter } from './src/adapters/mollybetAdapter.js';
import { StateManager } from './src/core/stateManager.js';
import { ExecutionEngine } from './src/core/executionEngine.js';
import { WsFeed } from './src/network/wsFeed.js';
import { TerminalUI } from './src/ui/terminalUI.js';

console.log('--- STARTING ARCHITECTURAL UNIT TESTS ---');

const testConfig = {
  baseUrl: "https://edge.madmarket.io",
  wsUrl: "wss://edge.madmarket.io/cpricefeed/",
  sessionToken: "d8a2f49a089977c420e9cf2431e99679",
  instanceId: "f98999",
  accounts: [["pin88", "_85ce631d_"]],
  defaultStake: 5.0,
  stakeStep: 10.0,
  defaultCurrency: "EUR",
  slippagePct: 0.03,
  defaultDuration: 15,
  debounceMs: 2000,
  dryRun: true
};

// 1. Test BaseAdapter abstract enforcement
try {
  new BaseAdapter(testConfig);
  assert.fail('Should not instantiate abstract BaseAdapter');
} catch (e) {
  assert(e instanceof TypeError);
  console.log('✓ BaseAdapter abstract instantiation blocked');
}

// 2. Test MollybetAdapter headers and payload resolution
const mockH2 = {
  request: async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ betslip_id: "slip_123", expiry: Math.floor(Date.now() / 1000) + 60 }),
    rttMs: 1.2
  }),
  isConnected: true,
  ensureConnected: async () => {}
};
const adapter = new MollybetAdapter(testConfig, mockH2);
const headers = adapter.buildBaseHeaders();
assert.equal(headers['session'], testConfig.sessionToken);
assert.equal(headers['x-molly-client-name'], 'sonic');
assert(headers['cookie'].includes(`root-session=${testConfig.sessionToken}`));
console.log('✓ MollybetAdapter headers conform to specification');

// Test bet type resolution
assert.equal(adapter.resolveBetType('OVER', { totalLine: '2.5' }), 'for,ahover,10');
assert.equal(adapter.resolveBetType('OVER', { totalLine: '2.5', isLive: true, liveScore: { home: 1, away: 0 } }), 'for,ir,1,0,ahover,10');
assert.equal(adapter.resolveBetType('HOME', {}), 'for,h');
assert.equal(adapter.resolveBetType('AWAY', {}), 'for,a');
console.log('✓ MollybetAdapter bet_type resolution accurate');

// 3. Test WsFeed parsing logic
const wsFeed = new WsFeed(testConfig);

let eventReceived = null;
wsFeed.on('event_update', (ev) => { eventReceived = ev; });

// Simulate Boost.Beast event frame
wsFeed.handleMessage(JSON.stringify([
  "event",
  ["fb", "998877"],
  {
    event_name: "Real Madrid vs Barcelona",
    competition_name: "La Liga",
    score: [2, 1],
    minute: "67",
    status: "in_play"
  }
]), false);

assert(eventReceived !== null);
assert.equal(eventReceived.eventId, "998877");
assert.equal(eventReceived.homeTeam, "Real Madrid");
assert.equal(eventReceived.awayTeam, "Barcelona");
assert.equal(eventReceived.score.home, 2);
assert.equal(eventReceived.score.away, 1);
assert.equal(eventReceived.minute, "67");
console.log('✓ WsFeed event frame parsing verified');

// Simulate offers_hcap frame
let oddsReceived = null;
wsFeed.on('odds_update', (odds) => { oddsReceived = odds; });

wsFeed.handleMessage(JSON.stringify([
  "offers_hcap",
  ["comp1", "fb", "998877"],
  {
    wdw: { h: 2.10, d: 3.40, a: 3.80 },
    ahou: {
      "2.5": { o: 1.95, u: 1.92 }
    }
  }
]), false);

assert(oddsReceived !== null);
assert.equal(oddsReceived.eventId, "998877");
assert.equal(oddsReceived.odds.winHome, 2.10);
assert.equal(oddsReceived.odds.winAway, 3.80);
assert.equal(oddsReceived.odds.totalOver, 1.95);
assert.equal(oddsReceived.odds.totalLine, "2.5");
console.log('✓ WsFeed offers_hcap parsing verified');

// 4. Test StateManager
const stateManager = new StateManager(testConfig);
stateManager.setAdapter(adapter);

stateManager.updateEventMetadata(eventReceived);
stateManager.updateOdds(oddsReceived);
stateManager.setActiveEvent("998877");

assert.equal(stateManager.activeStake, 5.0);
stateManager.adjustStake(10.0);
assert.equal(stateManager.activeStake, 15.0);
stateManager.adjustStake(-10.0);
assert.equal(stateManager.activeStake, 5.0);
stateManager.adjustStake(-20.0);
assert.equal(stateManager.activeStake, 1.0); // min boundary clamp
stateManager.setStake(50.0);
assert.equal(stateManager.activeStake, 50.0);
console.log('✓ StateManager stake management verified (+/- step & boundaries)');

// 5. Test ExecutionEngine
const engine = new ExecutionEngine(adapter, stateManager, testConfig);

// Simulate armed betslip in stateManager
stateManager.armedBetslips.OVER.betslipId = 'slip_test_over';
stateManager.armedBetslips.OVER.expiryTs = Date.now() + 20000;
stateManager.armedBetslips.OVER.currentPrice = 1.95;

let logCaptured = [];
engine.on('log', (log) => logCaptured.push(log));

// Fire OVER in dry-run mode
(async () => {
  const fireResult = await engine.fire('OVER');
  if (!fireResult.success) {
    console.error('FIRE RESULT FAILED:', fireResult, logCaptured);
  }
  assert(fireResult.success);
  assert(fireResult.dryRun);
  // limitPrice with 0.03 slippage: 1.95 * 0.97 = 1.8915 -> 1.891 or 1.892
  const expectedLimit = Number((1.95 * 0.97).toFixed(3));
  assert.equal(fireResult.limitPrice, expectedLimit);
  assert.equal(fireResult.stake, 50.0);
  console.log(`✓ ExecutionEngine fire('OVER') limitPrice=${fireResult.limitPrice} (expected: ${expectedLimit})`);

  // Verify debounce blocking
  const debounceResult = await engine.fire('OVER');
  assert.equal(debounceResult.success, false);
  assert.equal(debounceResult.reason, 'DEBOUNCE');
  console.log('✓ ExecutionEngine debounce cooldown verified (2000ms guard)');

  // 6. Test odds preservation in StateManager (partial ticks must not wipe prices)
  stateManager.updateOdds({
    eventId: "998877",
    odds: { winHome: 0, winAway: 0, totalOver: 0, totalUnder: 0 }
  });
  assert.equal(stateManager.liveOdds.winHome, 2.10);
  assert.equal(stateManager.liveOdds.winAway, 3.80);
  assert.equal(stateManager.liveOdds.totalOver, 1.95);
  console.log('✓ StateManager odds preservation verified (0-ticks do not wipe valid odds)');

  // 7. Test multi-match pool navigation and switching
  // Create second match
  stateManager.eventsMap.set("554433", {
    eventId: "554433",
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    sport: "fb",
    score: { home: 1, away: 0 }
  });
  stateManager.setActiveEvent("554433");
  stateManager.armedBetslips.OVER.betslipId = 'slip_test_arsenal_over';
  stateManager.armedBetslips.OVER.expiryTs = Date.now() + 25000;
  stateManager.armedBetslips.OVER.currentPrice = 2.05;

  const armedList = stateManager.getArmedMatchesList();
  assert.equal(armedList.length, 2);
  console.log(`✓ Armed matches list verified (${armedList.length} matches in pool)`);

  // Test cycling
  assert.equal(stateManager.activeEventId, "554433");
  stateManager.switchNextArmedMatch();
  assert.equal(stateManager.activeEventId, "998877");
  stateManager.switchPrevArmedMatch();
  assert.equal(stateManager.activeEventId, "554433");
  console.log('✓ Cycle switching between armed matches verified (switchNext / switchPrev)');

  // 8. Test disarming / deletion of coupons
  stateManager.disarmActiveEvent();
  assert.equal(stateManager.activeEventId, "998877"); // switched to remaining armed match
  assert.equal(stateManager.getArmedMatchesList().length, 1);
  console.log('✓ disarmActiveEvent verified (auto-switched to remaining match)');

  stateManager.disarmAll();
  assert.equal(stateManager.getArmedMatchesList().length, 0);
  assert.equal(stateManager.activeEventId, null);
  console.log('✓ disarmAll verified (pool completely purged)');

  // 9. Test MollybetAdapter bookies_with_offers extraction & deleteBetslip
  let deletedSlipId = null;
  const mockOfferH2 = {
    request: async (method, path) => {
      if (method === 'DELETE') {
        const parts = path.split('/').filter(Boolean);
        deletedSlipId = parts.pop();
        return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok' }), rttMs: 0.5 };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            betslip_id: "slip_offer_test",
            expiry_ts: Math.floor(Date.now() / 1000) + 45,
            bookies_with_offers: [
              ["pin88", 2.35, 1500.0],
              ["sbo", 2.30, 2000.0]
            ]
          }
        }),
        rttMs: 0.9
      };
    }
  };
  const offerAdapter = new MollybetAdapter(testConfig, mockOfferH2);
  const armRes = await offerAdapter.preArmBetslip('HOME', { eventId: '12345', liveScore: { home: 0, away: 0 } });
  assert.equal(armRes.betslipId, 'slip_offer_test');
  assert.equal(armRes.price, 2.35);
  assert.equal(armRes.maxStake, 1500.0); // Strictly filtered to pin88, ignoring unconfigured sbo
  console.log('✓ MollybetAdapter bookie price & stake limits extraction verified (pin88 filtered)');

  // Test deleteBetslip
  await offerAdapter.deleteBetslip('slip_to_delete_999');
  assert.equal(deletedSlipId, 'slip_to_delete_999');
  console.log('✓ MollybetAdapter deleteBetslip verified (DELETE /v1/betslips/<betslipId>)');

  // 10. Test 1st Half (HT) market resolution in MollybetAdapter
  assert.equal(offerAdapter.resolveBetType('HT_OVER', { totalLine: '0.5' }), 'for,ahover,2');
  assert.equal(offerAdapter.resolveBetType('HT_HOME', {}), 'for,h');
  assert.equal(offerAdapter.resolveBetType('HT_AWAY', {}), 'for,a');
  console.log('✓ MollybetAdapter 1st Half (HT) bet_type resolution verified');

  // 11. Test Period toggling and split liveOdds (FT vs HT) in StateManager
  const smPeriod = new StateManager(testConfig);
  smPeriod.setAdapter(offerAdapter);
  assert.equal(smPeriod.activePeriod, 'FT');

  smPeriod.eventsMap.set("112233", { eventId: "112233", sport: "fb", homeTeam: "Team A", awayTeam: "Team B" });
  smPeriod.setActiveEvent("112233");

  // Feed both FT and HT odds
  smPeriod.updateOdds({
    eventId: "112233",
    sport: "fb",
    odds: { winHome: 1.80, winAway: 4.50, totalOver: 1.90, totalLine: '2.5' }
  });
  smPeriod.updateOdds({
    eventId: "112233",
    sport: "fb_ht",
    odds: { winHome: 2.20, winAway: 5.00, totalOver: 2.05, totalLine: '0.5' }
  });

  // When activePeriod is FT, getters return FT odds
  assert.equal(smPeriod.liveOdds.winHome, 1.80);
  assert.equal(smPeriod.liveOdds.totalOver, 1.90);
  assert.equal(smPeriod.liveOdds.totalLine, '2.5');

  // Toggle to HT
  await smPeriod.togglePeriod();
  assert.equal(smPeriod.activePeriod, 'HT');
  // Now getters return HT odds
  assert.equal(smPeriod.liveOdds.winHome, 2.20);
  assert.equal(smPeriod.liveOdds.totalOver, 2.05);
  assert.equal(smPeriod.liveOdds.totalLine, '0.5');

  // Toggle back to FT
  await smPeriod.togglePeriod();
  assert.equal(smPeriod.activePeriod, 'FT');
  assert.equal(smPeriod.liveOdds.winHome, 1.80);
  console.log('✓ StateManager period switching (FT <-> HT) and isolated odds store verified');

  // 12. Test ExecutionEngine execution_result event emission
  let caughtExecResult = null;
  engine.on('execution_result', (res) => { caughtExecResult = res; });
  engine.lastFireTime = -Infinity;
  stateManager.eventsMap.set("998877", { eventId: "998877", homeTeam: "Real", awayTeam: "Barca", sport: "fb" });
  stateManager.setActiveEvent("998877");
  stateManager.armedBetslips.OVER.betslipId = 'slip_exec_event';
  stateManager.armedBetslips.OVER.expiryTs = Date.now() + 20000;
  stateManager.armedBetslips.OVER.currentPrice = 2.00;
  const fRes = await engine.fire('OVER');
  assert(fRes.success);
  assert(caughtExecResult !== null);
  assert.equal(caughtExecResult.status, 'SUCCESS');
  assert.equal(caughtExecResult.targetKey, 'OVER');
  assert(caughtExecResult.limitPrice > 0);
  // 13. Test StateManager handlePmmUpdate and betslip_closed
  stateManager.armedBetslips.HOME.betslipId = 'slip_pmm_test';
  stateManager.handlePmmUpdate({
    betslip_id: 'slip_pmm_test',
    bookie: 'pin88',
    status: { code: 'success' },
    price_list: [
      {
        effective: {
          price: 2.45,
          min: ['GBP', 1.0],
          max: ['GBP', 500.0]
        }
      }
    ]
  });
  assert.equal(stateManager.armedBetslips.HOME.currentPrice, 2.45);
  assert.equal(stateManager.armedBetslips.HOME.maxStake, 500.0);
  assert.equal(stateManager.liveOdds.winHome, 2.45);
  // 14. Test recordOrderExecution and getSoccerList status tracking
  stateManager.recordOrderExecution('HOME', { orderId: 'ORD_998877', limitPrice: 2.45, stake: 25.0 });
  const soccerRes = stateManager.getSoccerList('ALL');
  const matchedItem = soccerRes.list.find(m => m.eventId === '998877');
  assert(matchedItem !== undefined);
  assert.equal(matchedItem.lastOrder?.orderId, 'ORD_998877');
  assert.equal(matchedItem.lastOrder?.targetKey, 'HOME');
  // 15. Test MollybetAdapter ITB bet_type resolution & getOrderStatus
  assert.equal(offerAdapter.resolveBetType('ITB1', { itb1Line: '1.5', isLive: true, liveScore: { home: 1, away: 0 } }), 'for,ir,1,0,tahover,h,6');
  assert.equal(offerAdapter.resolveBetType('ITB2', { itb2Line: '1.5', isLive: true, liveScore: { home: 1, away: 0 } }), 'for,ir,1,0,tahover,a,6');
  assert.equal(offerAdapter.resolveBetType('HT_ITB1', { itb1Line: '0.5', isLive: true, liveScore: { home: 0, away: 0 } }), 'for,ir,0,0,tahover,h,2');
  assert.equal(offerAdapter.resolveBetType('HT_ITB2', { itb2Line: '0.5', isLive: true, liveScore: { home: 0, away: 0 } }), 'for,ir,0,0,tahover,a,2');

  // Test getOrderStatus mock
  const mockOrderH2 = {
    request: async (method, path) => {
      if (path.includes('2290465529')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              order_id: '2290465529',
              status: 'done',
              closed: true,
              close_reason: 'order_filled',
              got_price: 1.775,
              bookie: 'pin88',
              placed: ['EUR', 5.0]
            }
          }),
          rttMs: 1.1
        };
      }
      return { status: 404, headers: {}, body: 'Not found', rttMs: 1.0 };
    }
  };
  const orderTrackAdapter = new MollybetAdapter(testConfig, mockOrderH2);
  const statusRes = await orderTrackAdapter.getOrderStatus('2290465529');
  assert.equal(statusRes.status, 'done');
  assert.equal(statusRes.gotPrice, 1.775);
  assert.equal(statusRes.bookie, 'pin88');
  assert.equal(statusRes.closeReason, 'order_filled');
  console.log('✓ MollybetAdapter ITB bet_type resolution & getOrderStatus verified');

  // 16. Test WsFeed tahou,h and tahou,a parsing
  let itbOddsReceived = null;
  wsFeed.on('odds_update', (odds) => {
    if (odds.odds.itb1Over > 0) itbOddsReceived = odds;
  });
  wsFeed.handleMessage(JSON.stringify([
    "offers_hcap",
    ["comp1", "fb", "778899"],
    {
      "tahou,h": [6, [["over", 1.85], ["under", 1.95]]],
      "tahou,a": [2, [["over", 2.15], ["under", 1.70]]]
    }
  ]), false);

  assert(itbOddsReceived !== null);
  assert.equal(itbOddsReceived.odds.itb1Over, 1.85);
  assert.equal(itbOddsReceived.odds.itb1Line, "1.50");
  assert.equal(itbOddsReceived.odds.itb2Over, 2.15);
  assert.equal(itbOddsReceived.odds.itb2Line, "0.50");
  console.log('✓ WsFeed tahou (ITB1 / ITB2) offers parsing verified');

  // 17. Test StateManager Market Modes (MAIN <-> ITB)
  const smMarket = new StateManager(testConfig);
  smMarket.setAdapter(offerAdapter);
  assert.equal(smMarket.activeMarketMode, 'MAIN');
  assert.deepEqual(smMarket.getActiveSlipKeys(), ['OVER', 'HOME', 'AWAY']);

  smMarket.eventsMap.set("778899", { eventId: "778899", homeTeam: "H", awayTeam: "A", sport: "fb" });
  smMarket.setActiveEvent("778899");
  smMarket.updateOdds(itbOddsReceived);

  assert.equal(smMarket.getLivePrice('ITB1'), 1.85);
  assert.equal(smMarket.getLivePrice('ITB2'), 2.15);

  // Toggle mode to ITB
  await smMarket.toggleMarketMode();
  assert.equal(smMarket.activeMarketMode, 'ITB');
  assert.deepEqual(smMarket.getActiveSlipKeys(), ['OVER', 'ITB1', 'ITB2']);

  // Toggle back to MAIN
  await smMarket.toggleMarketMode();
  assert.equal(smMarket.activeMarketMode, 'MAIN');
  assert.deepEqual(smMarket.getActiveSlipKeys(), ['OVER', 'HOME', 'AWAY']);
  console.log('✓ StateManager Market Modes (MAIN <-> ITB) & 3-slip quota isolation verified');

  // 18. Test ExecutionEngine Order Lifecycle Tracking
  let orderLifecycleEvents = [];
  engine.on('execution_result', (e) => orderLifecycleEvents.push(e));

  // Test successful fill lifecycle
  const trackingAdapter = {
    getOrderStatus: async (id) => {
      if (id === 'ORD_FILL') {
        return { success: true, status: 'done', closed: true, closeReason: 'order_filled', gotPrice: 1.95, bookie: 'pin88' };
      }
      if (id === 'ORD_TIMEOUT') {
        return { success: true, status: 'failed', closed: true, closeReason: 'timed_out', gotPrice: null };
      }
      return { success: false };
    }
  };
  const liveTrackEngine = new ExecutionEngine(trackingAdapter, stateManager, testConfig);

  let trackDoneEvent = null;
  liveTrackEngine.on('execution_result', (e) => {
    if (e.status === 'DONE') trackDoneEvent = e;
  });
  await liveTrackEngine.trackOrder('ORD_FILL', 'ITB1', { limitPrice: 1.90, stake: 10.0, rttMs: 1.5 });
  assert(trackDoneEvent !== null);
  assert.equal(trackDoneEvent.status, 'DONE');
  assert.equal(trackDoneEvent.gotPrice, 1.95);
  assert.equal(trackDoneEvent.bookie, 'pin88');

  // Test rejection / timeout lifecycle
  let trackRejectEvent = null;
  liveTrackEngine.on('execution_result', (e) => {
    if (e.status === 'REJECTED') trackRejectEvent = e;
  });
  await liveTrackEngine.trackOrder('ORD_TIMEOUT', 'ITB2', { limitPrice: 2.10, stake: 10.0, rttMs: 1.2 });
  assert(trackRejectEvent !== null);
  assert.equal(trackRejectEvent.status, 'REJECTED');
  assert.equal(trackRejectEvent.reason, 'timed_out');
  console.log('✓ ExecutionEngine async order lifecycle tracking (in-flight -> done / rejected) verified');

  // 18b. Stake is clamped to per-outcome bookie limit (e.g. HT limit €25, stake €30)
  const clampSm = new StateManager({ ...testConfig, dryRun: false });
  clampSm.activeEventId = 'clamp_evt';
  clampSm.activePeriod = 'HT';
  clampSm.activeStake = 30;
  Object.assign(clampSm.armedBetslips.HOME, {
    betslipId: 'slip_clamp',
    expiryTs: Date.now() + 20000,
    currentPrice: 2.0,
    bookiePrice: 2.0,
    bookiePriceTs: Date.now(),
    maxStake: 25.789
  });
  let sentStake = null;
  const clampAdapter = {
    placeOrder: async (armed, livePrice, stake) => {
      sentStake = stake;
      return { success: true, orderId: null, status: 200, rttMs: 1, limitPrice: 1.94, livePrice, stake: ['EUR', stake] };
    }
  };
  const clampEngine = new ExecutionEngine(clampAdapter, clampSm, { ...testConfig, dryRun: false });
  let clampInFlight = null;
  clampEngine.on('execution_result', (e) => { if (e.status === 'IN_FLIGHT') clampInFlight = e; });
  const clampRes = await clampEngine.fire('HT_HOME');
  assert.equal(clampRes.success, true);
  assert.equal(sentStake, 25.78, 'Stake must be floored to outcome limit, never exceed it');
  assert.equal(clampInFlight.requestedStake, 30);
  assert.equal(clampSm.activeStake, 30, 'Configured stake must stay untouched for next shots');

  // Stake below limit is sent as-is
  clampSm.activeStake = 10;
  clampSm.armedBetslips.HOME.betslipId = 'slip_clamp2';
  clampSm.armedBetslips.HOME.expiryTs = Date.now() + 20000;
  clampEngine.lastFireTime = -Infinity;
  await clampEngine.fire('HT_HOME');
  assert.equal(sentStake, 10);
  console.log('✓ ExecutionEngine clamps stake to per-outcome limit (30 → 25.78) without touching configured stake');

  // 18c. Partial fill (closed timed_out with got_stake > 0) is reported as DONE, not REJECTED
  const partialEngine = new ExecutionEngine({
    getOrderStatus: async () => ({ success: true, status: 'done', closed: true, closeReason: 'timed_out', gotPrice: 2.01, gotStake: 25, bookie: 'pin88' })
  }, stateManager, testConfig);
  let partialEvent = null;
  partialEngine.on('execution_result', (e) => { partialEvent = e; });
  await partialEngine.trackOrder('ORD_PARTIAL', 'HT_OVER', { limitPrice: 1.95, stake: ['EUR', 30], rttMs: 1 });
  assert.equal(partialEvent.status, 'DONE');
  assert.equal(partialEvent.partial, true);
  assert.equal(partialEvent.stake, 25);
  assert.equal(MollybetAdapter.parseStakeAmount(['EUR', 25]), 25);
  assert.equal(MollybetAdapter.parseStakeAmount(undefined), null);
  console.log('✓ ExecutionEngine partial fill recognized (€25 of €30 → DONE/partial)');

  // 17. Test PMM strict bookmaker filtering (discards pmk, betdex etc.)
  const pmmStateManager = new StateManager({
    ...testConfig,
    accounts: [["pin88", "_acc123_"]]
  });
  pmmStateManager.armedBetslips.HOME.betslipId = 'slip_home_pmm';
  pmmStateManager.armedBetslips.HOME.currentPrice = 1.80;

  // Simulate junk quote from pmk (e.g. кэф 93.257, лимит €1218)
  pmmStateManager.handlePmmUpdate({
    betslip_id: 'slip_home_pmm',
    bookie: 'pmk',
    price_list: [{ effective: { price: 93.257, max: ["EUR", 1218] } }]
  });
  // Must NOT have changed to 93.257!
  assert.equal(pmmStateManager.armedBetslips.HOME.currentPrice, 1.80);
  assert.notEqual(pmmStateManager.armedBetslips.HOME.currentPrice, 93.257);

  // Simulate legitimate quote from pin88 (e.g. кэф 1.95, лимит €400)
  pmmStateManager.handlePmmUpdate({
    betslip_id: 'slip_home_pmm',
    bookie: 'pin88',
    price_list: [{ effective: { price: 1.95, max: ["EUR", 400] } }]
  });
  assert.equal(pmmStateManager.armedBetslips.HOME.currentPrice, 1.95);
  assert.equal(pmmStateManager.armedBetslips.HOME.maxStake, 400);
  console.log('✓ StateManager strict PMM bookmaker filtering verified (pmk discarded, pin88 accepted)');

  // 18. Test Closed Market zero-reset via updatedMarkets
  pmmStateManager.setActiveEvent('998877');
  pmmStateManager.updateOdds({
    eventId: '998877',
    sport: 'fb',
    odds: { winHome: 2.10, winAway: 1.80, totalOver: 1.90 },
    updatedMarkets: { wdw: true, ahou: true }
  });
  assert.equal(pmmStateManager.liveOdds.winHome, 2.10);

  // Bookmaker closes 1X2 market (home/away odds disappear or drop to 0)
  pmmStateManager.updateOdds({
    eventId: '998877',
    sport: 'fb',
    odds: { winHome: 0, winAway: 0, totalOver: 1.90 },
    updatedMarkets: { wdw: true, ahou: false }
  });
  assert.equal(pmmStateManager.liveOdds.winHome, 0);
  assert.equal(pmmStateManager.liveOdds.winAway, 0);
  assert.equal(pmmStateManager.armedBetslips.HOME.currentPrice, 0);
  assert.equal(pmmStateManager.liveOdds.totalOver, 1.90); // ahou preserved because updatedMarkets.ahou was false
  console.log('✓ StateManager closed market zero-reset verified (no stale odds kept)');

  // 19. Test ExecutionEngine abortion on closed line
  const closedEngine = new ExecutionEngine(adapter, pmmStateManager, testConfig);
  pmmStateManager.armedBetslips.HOME.betslipId = 'slip_home_closed';
  pmmStateManager.armedBetslips.HOME.expiryTs = Date.now() + 20000;
  pmmStateManager.armedBetslips.HOME.currentPrice = 0;

  const closedFireRes = await closedEngine.fire('HOME');
  assert.equal(closedFireRes.success, false);
  assert.equal(closedFireRes.reason, 'LINE_CLOSED');
  console.log('✓ ExecutionEngine closed line shot abort verified (0.00 prevents bad bets)');

  // 20. Test TerminalUI formatSlipStatus for closed line
  const ui = new TerminalUI(pmmStateManager, closedEngine, null, null, testConfig);
  const statusClosedArmed = ui.formatSlipStatus(pmmStateManager.armedBetslips.HOME, 0);
  assert(statusClosedArmed.includes('0.00'));
  assert(statusClosedArmed.includes('ЗАКРЫТО'));

  const statusClosedNoSlip = ui.formatSlipStatus({ betslipId: null }, 0);
  assert(statusClosedNoSlip.includes('0.00'));
  assert(statusClosedNoSlip.includes('NO SLIP'));
  ui.destroy();
  console.log('✓ TerminalUI closed line bold red 0.00 display verified');

  // 21. Test Total line selection, manual override, and cycling
  const smLines = new StateManager(testConfig);
  smLines.setAdapter(adapter);
  smLines.updateEventMetadata({ eventId: 'lines_test_1', homeTeam: 'TeamA', awayTeam: 'TeamB' });
  smLines.setActiveEvent('lines_test_1');

  smLines.updateOdds({
    eventId: 'lines_test_1',
    sport: 'fb',
    odds: {
      totalOver: 1.95,
      totalUnder: 1.92,
      totalLine: '2.5',
      rawTotalLineIndex: 10,
      totalLines: [
        { totalLine: '1.5', rawTotalLineIndex: 6, totalOver: 1.30, totalUnder: 3.40 },
        { totalLine: '2.5', rawTotalLineIndex: 10, totalOver: 1.95, totalUnder: 1.92 },
        { totalLine: '3.5', rawTotalLineIndex: 14, totalOver: 3.20, totalUnder: 1.35 }
      ]
    },
    updatedMarkets: { ahou: true }
  });

  assert.equal(smLines.liveOdds.totalLine, '2.5');
  assert.equal(smLines.liveOdds.totalOver, 1.95);

  // Cycle line forward (up): should switch to 3.5
  await smLines.cycleTotalLine(1, 'OVER');
  assert.equal(smLines.liveOdds.totalLine, '3.5');
  assert.equal(smLines.liveOdds.totalOver, 3.20);

  // Cycle line back (down): should switch back to 2.5
  await smLines.cycleTotalLine(-1, 'OVER');
  assert.equal(smLines.liveOdds.totalLine, '2.5');
  assert.equal(smLines.liveOdds.totalOver, 1.95);

  // Manual override directly
  await smLines.setUserLineOverride('OVER', '1.5', 6);
  assert.equal(smLines.liveOdds.totalLine, '1.5');
  assert.equal(smLines.liveOdds.totalOver, 1.30);
  console.log('✓ StateManager Total Line selection, cycling and manual overrides verified');

  // 19. Test HT period pre-arming of all 4 markets (Asian Total, ITB1, ITB2, 1X2) and fb_htft feed subscription
  const smHt = new StateManager(testConfig);
  let armedBetTypes = [];
  const mockHtH2 = {
    request: async (method, path, headers, body) => {
      if (method === 'POST') {
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        armedBetTypes.push({ targetKey: payload.sport === 'fb_ht' ? `HT_${payload.bet_type}` : payload.bet_type, sport: payload.sport, betType: payload.bet_type });
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              betslip_id: `slip_ht_${armedBetTypes.length}`,
              expiry_ts: Math.floor(Date.now() / 1000) + 40,
              bookies_with_offers: [
                ['pin88', payload.bet_type.includes('tahover,h') ? 1.75 : (payload.bet_type.includes('tahover,a') ? 2.90 : (payload.bet_type.includes('ahover') ? 1.95 : (payload.bet_type === 'for,h' ? 2.10 : 4.80))), 500]
              ]
            }
          }),
          rttMs: 0.5
        };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok' }), rttMs: 0.5 };
    }
  };
  const htAdapter = new MollybetAdapter(testConfig, mockHtH2);
  smHt.setAdapter(htAdapter);

  // Setup match with fb_htft sport
  smHt.eventsMap.set("778899", {
    eventId: "778899",
    competitionId: 1001,
    sport: "fb_htft",
    homeTeam: "Bayern",
    awayTeam: "Dortmund",
    isLive: true,
    score: { home: 0, away: 0 }
  });
  smHt.setActiveEvent("778899");

  // Verify WsFeed subscriptions for fb_htft match
  let sentWsFrames = [];
  const mockWs = {
    readyState: 1, // OPEN
    send: (msg) => { sentWsFrames.push(JSON.parse(msg)); }
  };
  const testWsFeed = new WsFeed(testConfig);
  testWsFeed.ws = mockWs;
  testWsFeed.isConnected = true;
  testWsFeed.subscribeToEvent(1001, 'fb_htft', '778899');

  const watchHcapsFrame = sentWsFrames.find(f => f[0] === 'watch_hcaps');
  assert(watchHcapsFrame !== undefined);
  const subscribedSports = watchHcapsFrame[1].map(t => t[1]);
  assert(subscribedSports.includes('fb'), 'Must subscribe to fb');
  assert(subscribedSports.includes('fb_ht'), 'Must subscribe to fb_ht');
  console.log('✓ WsFeed soccer subscription verified (fb + fb_ht subscribed for fb_htft events)');

  // Feed HT odds update
  smHt.updateOdds({
    eventId: "778899",
    sport: "fb_ht",
    odds: {
      winHome: 2.10,
      winDraw: 2.40,
      winAway: 4.80,
      totalOver: 1.95,
      totalUnder: 1.85,
      totalLine: '0.5',
      rawTotalLineIndex: 2,
      itb1Over: 1.75,
      itb1Under: 2.05,
      itb1Line: '0.5',
      rawItb1LineIndex: 2,
      itb2Over: 2.90,
      itb2Under: 1.40,
      itb2Line: '0.5',
      rawItb2LineIndex: 2
    },
    updatedMarkets: { wdw: true, ahou: true, itb1: true, itb2: true }
  });

  // Switch to HT period
  await smHt.setPeriod('HT');
  assert.equal(smHt.activePeriod, 'HT');

  // Verify betslips for HT are armed and have valid betslipIds and prices
  assert(smHt.armedBetslips.OVER.betslipId !== null, 'OVER must have betslipId in HT');
  assert.equal(smHt.armedBetslips.OVER.targetKey, 'HT_OVER');
  assert.equal(smHt.armedBetslips.OVER.currentPrice, 1.95);

  assert(smHt.armedBetslips.HOME.betslipId !== null, 'HOME must have betslipId in HT');
  assert.equal(smHt.armedBetslips.HOME.targetKey, 'HT_HOME');
  assert.equal(smHt.armedBetslips.HOME.currentPrice, 2.10);

  assert(smHt.armedBetslips.AWAY.betslipId !== null, 'AWAY must have betslipId in HT');
  assert.equal(smHt.armedBetslips.AWAY.targetKey, 'HT_AWAY');
  assert.equal(smHt.armedBetslips.AWAY.currentPrice, 4.80);

  // Switch to ITB mode in HT period
  await smHt.setMarketMode('ITB');
  assert.equal(smHt.activeMarketMode, 'ITB');
  assert(smHt.armedBetslips.ITB1.betslipId !== null, 'ITB1 must have betslipId in HT');
  assert.equal(smHt.armedBetslips.ITB1.targetKey, 'HT_ITB1');
  assert.equal(smHt.armedBetslips.ITB1.currentPrice, 1.75);

  assert(smHt.armedBetslips.ITB2.betslipId !== null, 'ITB2 must have betslipId in HT');
  assert.equal(smHt.armedBetslips.ITB2.targetKey, 'HT_ITB2');
  assert.equal(smHt.armedBetslips.ITB2.currentPrice, 2.90);
  console.log('✓ Half Time (HT) 4 markets pre-arming (Asian Total, 1X2, ITB1, ITB2) verified');

  // 20. Test MollybetAdapter strict allowed bookies filtering (no leak from other bookies or rawPrice)
  const mockUnallowedH2 = {
    request: async (method, path, headers, body) => {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            betslip_id: "slip_unallowed_test",
            price: 5.50, // Broker aggregate price from other unconfigured bookies
            best_price: 5.50,
            bookies_with_offers: [
              ["singbet", 5.50, 1000.0],
              ["isn", 5.40, 800.0]
              // Note: pin88 is ABSENT
            ]
          }
        }),
        rttMs: 0.5
      };
    }
  };
  const strictAdapter = new MollybetAdapter({ accounts: [["pin88", "_acc_"]] }, mockUnallowedH2);
  const strictArm = await strictAdapter.preArmBetslip('ITB1', { eventId: '999', liveScore: { home: 0, away: 0 } });
  assert.equal(strictArm.betslipId, 'slip_unallowed_test');
  assert.equal(strictArm.price, null, 'Must be null when allowed bookie (pin88) is absent from offers');
  console.log('✓ MollybetAdapter strict bookie filtering verified (refuses unallowed/raw broker prices)');

  // 21. Test WsFeed sticky line hysteresis (does not jump lines on micro-fluctuations)
  const stickyWsFeed = new WsFeed(testConfig);
  // Initial frame: 2.5 is at 1.95, 2.75 is at 2.40
  const frame1 = [
    'offers_hcap',
    [10, 'fb', 'match_sticky_1'],
    {
      ahou: [
        [10, [['over', 1.95], ['under', 1.90]]], // 2.50
        [11, [['over', 2.40], ['under', 1.60]]]  // 2.75
      ]
    }
  ];
  let lastOdds = null;
  stickyWsFeed.on('odds_update', (data) => { lastOdds = data.odds; });
  stickyWsFeed.dispatchSingleFrame(frame1);
  assert.equal(lastOdds.totalLine, '2.50');
  assert.equal(lastOdds.totalOver, 1.95);

  // Subsequent frame: 2.5 drops to 1.65, 2.75 becomes 2.05 (near even).
  // Because 2.50 is active and still has valid odds (1.65 > 1.0), it MUST NOT jump to 2.75!
  const frame2 = [
    'offers_hcap',
    [10, 'fb', 'match_sticky_1'],
    {
      ahou: [
        [10, [['over', 1.65], ['under', 2.30]]], // 2.50
        [11, [['over', 2.05], ['under', 1.80]]]  // 2.75
      ]
    }
  ];
  stickyWsFeed.dispatchSingleFrame(frame2);
  assert.equal(lastOdds.totalLine, '2.50', 'Must stick to active line 2.50 and not jump to 2.75');
  assert.equal(lastOdds.totalOver, 1.65);
  console.log('✓ WsFeed sticky line hysteresis verified (prevents line jumping between 2.5 and 2.75)');

  // 22. Test HT vs FT score isolation & goal detection
  const smScoreTest = new StateManager(testConfig);
  smScoreTest.eventsMap.set("iso_match", {
    eventId: "iso_match",
    competitionId: 100,
    sport: "fb",
    score: { home: 0, away: 0 }
  });
  smScoreTest.setActiveEvent("iso_match");
  assert.equal(smScoreTest.liveScore.home, 0);

  let goalCount = 0;
  smScoreTest.on('score_changed', () => { goalCount++; });

  // Simulate FT frame with score 1-0
  smScoreTest.updateEventMetadata({
    eventId: "iso_match",
    sport: "fb",
    score: { home: 1, away: 0 }
  });
  assert.equal(smScoreTest.liveScoreFt.home, 1);
  assert.equal(smScoreTest.liveScore.home, 1);
  assert.equal(goalCount, 1);

  // Simulate incoming fb_ht frame with score 0-0 (HT break score)
  // MUST NOT overwrite FT score, MUST NOT trigger goal detection!
  smScoreTest.updateEventMetadata({
    eventId: "iso_match",
    sport: "fb_ht",
    score: { home: 0, away: 0 }
  });
  assert.equal(smScoreTest.liveScoreFt.home, 1, 'FT score must remain 1');
  assert.equal(smScoreTest.liveScoreHt.home, 0, 'HT score must be 0');
  assert.equal(smScoreTest.liveScore.home, 1, 'Active FT period score must remain 1');
  assert.equal(goalCount, 1, 'Must not trigger goal detection on HT frame while in FT mode');

  // Switch to HT period
  await smScoreTest.setPeriod('HT');
  assert.equal(smScoreTest.liveScore.home, 0, 'Active period score must now reflect HT score (0)');

  smScoreTest.destroy();
  console.log('✓ HT vs FT score isolation and phantom goal prevention verified');

  // 23. Test Bookmaker PMM quote priority over generic ticker ticks
  const smPmmPriority = new StateManager({ accounts: [["pin88", "_acc_"]] });
  smPmmPriority.eventsMap.set("match_pmm_prio", {
    eventId: "match_pmm_prio",
    competitionId: 50,
    sport: "fb",
    score: { home: 0, away: 0 }
  });
  smPmmPriority.setActiveEvent("match_pmm_prio");
  const prioEngine = new ExecutionEngine(null, smPmmPriority, { dryRun: true, slippagePct: 0.03, debounceMs: 0 });

  // Arm fake slip
  smPmmPriority.armedBetslips.HOME.betslipId = 'slip_prio_1';
  smPmmPriority.armedBetslips.HOME.currentPrice = 1.35;

  // Simulate PMM quote from pin88: 1.364
  smPmmPriority.handlePmmUpdate({
    betslip_id: 'slip_prio_1',
    bookie: 'pin88',
    price_list: [{ effective: { price: 1.364, max: ['EUR', 67] } }]
  });

  assert.equal(smPmmPriority.armedBetslips.HOME.currentPrice, 1.364);
  assert.equal(smPmmPriority.armedBetslips.HOME.bookiePrice, 1.364);

  // Simulate incoming ticker tick with inflated indicative odds: 1.584
  smPmmPriority.updateOdds({
    eventId: "match_pmm_prio",
    sport: "fb",
    odds: { winHome: 1.584 },
    updatedMarkets: { wdw: true }
  });

  // Because PMM quote is fresh (<10s), armedBetslips.HOME.currentPrice MUST NOT be contaminated by 1.584!
  assert.equal(smPmmPriority.armedBetslips.HOME.currentPrice, 1.364, 'Must protect currentPrice against ticker contamination');

  // ExecutionEngine must fire using real bookie price (1.364), not 1.584!
  const fireRes = await prioEngine.fire('HOME');
  assert.equal(fireRes.success, true);
  assert.equal(fireRes.livePrice, 1.364, 'ExecutionEngine must use bookie price (1.364) instead of ticker (1.584)');
  assert.equal(fireRes.limitPrice, Number((1.364 * 0.97).toFixed(3)));
  console.log('✓ Bookmaker PMM quote priority over generic ticker ticks verified');

  // 24. Test Mollybet 4-betslip quota guard & pre-deletion lifecycle
  const deletedSlips = [];
  const mockQuotaAdapter = {
    deleteBetslip: async (id) => {
      deletedSlips.push(id);
      return true;
    },
    preArmBetslip: async (targetKey, matchInfo) => {
      return {
        betslipId: `new_slip_${targetKey}`,
        expiryTs: Date.now() + 50000,
        betType: 'for,ahover,10',
        price: 1.95,
        rttMs: 1.0
      };
    }
  };

  const smQuota = new StateManager({});
  smQuota.setAdapter(mockQuotaAdapter);
  smQuota.eventsMap.set("match_quota_test", {
    eventId: "match_quota_test",
    competitionId: 10,
    sport: "fb",
    score: { home: 0, away: 0 }
  });
  smQuota.setActiveEvent("match_quota_test");
  // Allow any initial arming from setActiveEvent to settle
  await new Promise(r => setTimeout(r, 250));

  // Pre-seed an existing betslip to test replacement
  smQuota.armedBetslips.OVER.betslipId = 'old_slip_to_delete';
  await smQuota.armTarget('OVER', true);

  // Assert that old_slip_to_delete was deleted BEFORE or during replacement
  assert.equal(deletedSlips.includes('old_slip_to_delete'), true, 'Previous betslip MUST be deleted to protect quota limit');
  assert.equal(smQuota.armedBetslips.OVER.betslipId, 'new_slip_OVER');

  // Test 403 error backoff
  let callsCount = 0;
  mockQuotaAdapter.preArmBetslip = async () => {
    callsCount++;
    throw new Error('Failed to pre-arm betslip: HTTP 403 - {"status":"error","code":"too_many_open_betslips"}');
  };

  await smQuota.armTarget('OVER', true);
  assert.equal(callsCount, 1);
  assert(smQuota.quotaBackoffMap.has('OVER'), 'quotaBackoffMap must record backoff timestamp on 403');
  assert(smQuota.quotaBackoffMap.get('OVER') > Date.now(), 'Backoff timestamp must be in future');

  // Second immediate attempt MUST be suppressed by backoff guard
  await smQuota.armTarget('OVER', true);
  assert.equal(callsCount, 1, 'Immediate retry within backoff window must be blocked');

  smQuota.destroy();
  console.log('✓ Mollybet 4-betslip quota guard (pre-deletion & 403 backoff) verified');

  // 25. Test that Asian Handicap (ah) does NOT contaminate 1X2 (wdw) winHome/winAway prices
  const smAhTest = new WsFeed(testConfig);
  let parsedAhOdds = null;
  smAhTest.on('odds_update', (data) => { parsedAhOdds = data.odds; });

  // Frame with Asian Handicap (e.g. -4.5 line @ 3.94 / +4.5 @ 1.21), but NO 1X2 (wdw is suspended/closed)
  const ahFrame = [
    'offers_hcap',
    [203, 'fb_ht', 'match_ah_isolation'],
    {
      ah: [
        [18, [['h', 3.94], ['a', 1.21]]]
      ],
      ahou: [
        [19, [['over', 4.12], ['under', 1.20]]]
      ]
    }
  ];
  smAhTest.dispatchSingleFrame(ahFrame);

  assert(parsedAhOdds !== null);
  assert.equal(parsedAhOdds.winHome, 0, 'winHome must be 0 when wdw is closed, never contaminated by ah');
  assert.equal(parsedAhOdds.winAway, 0, 'winAway must be 0 when wdw is closed, never contaminated by ah');
  assert.equal(parsedAhOdds.updatedMarkets.wdw, false, 'updatedMarkets.wdw must be false when wdw is absent');
  smAhTest.destroy();
  // 26. Test cross-match odds isolation when switching active events (e.g. Fleetwood 2-0 -> Twente 6-0)
  const smSwitchTest = new StateManager(testConfig);
  const mockSwitchAdapter = {
    deleteBetslip: async () => true,
    createBetslip: async () => ({ betslip_id: 'mock_switch_slip', expiry: Math.floor(Date.now() / 1000) + 60, best_price: null })
  };
  smSwitchTest.setAdapter(mockSwitchAdapter);

  // Match 1: Fleetwood with live odds (winHome: 1.401, winAway: 5.213)
  smSwitchTest.eventsMap.set('match_1_fleetwood', {
    eventId: 'match_1_fleetwood',
    homeTeam: 'Fleetwood Town',
    awayTeam: 'Sheffield Wednesday',
    sport: 'fb',
    competitionId: 49900,
    isLive: true,
    score: { home: 2, away: 0 },
    odds: {
      ft: {
        winHome: 1.401,
        winAway: 5.213,
        totalOver: 1.85,
        totalUnder: 1.95,
        totalLine: '2.5'
      }
    }
  });

  // Match 2: Twente 6-0 where 1X2 market is suspended/closed (no winHome, no winAway)
  smSwitchTest.eventsMap.set('match_2_twente', {
    eventId: 'match_2_twente',
    homeTeam: 'FC Twente',
    awayTeam: 'Werder Bremen',
    sport: 'fb',
    competitionId: 203,
    isLive: true,
    score: { home: 6, away: 0 },
    odds: {
      ft: {
        totalOver: 1.50,
        totalUnder: 2.30,
        totalLine: '6.5'
      }
    }
  });

  // Switch to Match 1 and verify odds are set
  smSwitchTest.setActiveEvent('match_1_fleetwood');
  assert.equal(smSwitchTest.liveOdds.ft.winHome, 1.401, 'Match 1 winHome must be 1.401');
  assert.equal(smSwitchTest.liveOdds.ft.winAway, 5.213, 'Match 1 winAway must be 5.213');

  // Switch to Match 2: Match 2 MUST NOT inherit Match 1's winHome / winAway!
  smSwitchTest.setActiveEvent('match_2_twente');
  assert.equal(smSwitchTest.liveOdds.ft.winHome, 0, 'Match 2 winHome must be 0 (market closed/no odds), NEVER leaked 1.401 from Match 1');
  assert.equal(smSwitchTest.liveOdds.ft.winAway, 0, 'Match 2 winAway must be 0, NEVER leaked from Match 1');
  assert.equal(smSwitchTest.liveOdds.ft.totalOver, 1.50, 'Match 2 totalOver must be from Match 2');

  // Verify armed betslips currentPrice does NOT take leaked 1.401
  assert.equal(smSwitchTest.armedBetslips.HOME.currentPrice, 0, 'Armed HOME betslip must not have leaked price');
  assert.equal(smSwitchTest.armedBetslips.AWAY.currentPrice, 0, 'Armed AWAY betslip must not have leaked price');

  // 27. Test strict allowed bookmaker (e.g. pin88) closed line protection
  const smPinStrict = new StateManager(testConfig); // testConfig has accounts: [["pin88", "_85ce631d_"]]
  const mockPinAdapter = {
    getAllowedBookies: () => new Set(['pin88']),
    preArmBetslip: async (targetKey) => {
      // SBO and Singbet have offers, but pin88 has NO offers (closed on Pinnacle)
      return {
        betslipId: 'mock_pin_closed_slip',
        expiryTs: Date.now() + 60000,
        price: null, // pin88 price is null
        bookiePrice: null,
        maxStake: null,
        betType: 'for,h',
        targetKey,
        rttMs: 15
      };
    }
  };
  smPinStrict.setAdapter(mockPinAdapter);
  smPinStrict.eventsMap.set('strict_pin_match', {
    eventId: 'strict_pin_match',
    sport: 'fb',
    isLive: true,
    score: { home: 1, away: 0 }
  });
  smPinStrict.setActiveEvent('strict_pin_match');

  // Generic WS ticker offers 1.58 from other bookmakers (e.g. SBO/Singbet)
  smPinStrict.updateOdds({
    eventId: 'strict_pin_match',
    sport: 'fb',
    odds: { winHome: 1.58, totalOver: 1.85 }
  });

  // Arm HOME coupon where pin88 has NO offers
  await smPinStrict.armTarget('HOME', true);
  const homeArmedSlip = smPinStrict.getArmedBetslip('HOME');
  assert.equal(homeArmedSlip.currentPrice, 0, 'currentPrice must be 0 when pin88 has no offer in betslip, NEVER taking 1.58 from other bookies');
  assert.equal(homeArmedSlip.priceSource, 'CLOSED', 'priceSource must be CLOSED');

  // Verify that an incoming generic WS ticker tick does NOT overwrite the closed pin88 coupon
  smPinStrict.updateOdds({
    eventId: 'strict_pin_match',
    sport: 'fb',
    odds: { winHome: 1.59, totalOver: 1.86 },
    updatedMarkets: { wdw: true }
  });
  assert.equal(homeArmedSlip.currentPrice, 0, 'Generic WS ticker tick must NOT overwrite closed pin88 slip with 1.59');

  // Verify that ExecutionEngine prevents firing into empty air
  const strictEngine = new ExecutionEngine(mockPinAdapter, smPinStrict, testConfig);
  let firedResult = null;
  strictEngine.on('execution_result', (res) => { firedResult = res; });
  const fireAttempt = await strictEngine.fire('HOME');
  assert.equal(fireAttempt.success, false, 'ExecutionEngine must abort shot on closed pin88 line');
  assert.equal(fireAttempt.reason, 'LINE_CLOSED', 'Reason must be LINE_CLOSED');
  assert(firedResult && firedResult.status === 'ABORT');

  // Verify that TerminalUI displays 0.00 (ЗАКРЫТО) even if generic WS liveOdds has 1.59
  const strictUi = new TerminalUI(smPinStrict, strictEngine, null, null, testConfig);
  const renderedSlipStatus = strictUi.formatSlipStatus(homeArmedSlip, 1.59);
  assert(renderedSlipStatus.includes('0.00'), 'UI must show 0.00 when pin88 line is closed');
  assert(renderedSlipStatus.includes('ЗАКРЫТО'), 'UI must show ЗАКРЫТО when pin88 line is closed');
  assert(!renderedSlipStatus.includes('1.59'), 'UI must NOT leak generic WS odds 1.59 onto closed coupon');
  strictUi.destroy();

  smPinStrict.destroy();
  console.log('✓ Strict bookmaker (pin88) line closed protection verified (prevents shooting into empty air)');

  // 28. Test getArmedBetslip strict context isolation (period and market mode)
  const smContextTest = new StateManager(testConfig);
  smContextTest.eventsMap.set('ctx_match', { eventId: 'ctx_match', sport: 'fb' });
  smContextTest.setActiveEvent('ctx_match');
  smContextTest.armedBetslips.OVER.betslipId = 'slip_ft_over';
  smContextTest.armedBetslips.HOME.betslipId = 'slip_ft_home';
  smContextTest.armedBetslips.AWAY.betslipId = 'slip_ft_away';

  // Period mismatch tests
  assert.equal(smContextTest.activePeriod, 'FT');
  assert.equal(smContextTest.getArmedBetslip('HT_OVER'), null, 'getArmedBetslip(HT_OVER) must return null when activePeriod === FT');
  assert.equal(smContextTest.getArmedBetslip('HT_HOME'), null, 'getArmedBetslip(HT_HOME) must return null when activePeriod === FT');
  assert.notEqual(smContextTest.getArmedBetslip('OVER'), null, 'getArmedBetslip(OVER) must return valid slip when activePeriod === FT');

  // Mode mismatch tests (MAIN vs ITB)
  assert.equal(smContextTest.activeMarketMode, 'MAIN');
  assert.equal(smContextTest.getArmedBetslip('ITB1'), null, 'getArmedBetslip(ITB1) must return null when activeMarketMode === MAIN');
  assert.equal(smContextTest.getArmedBetslip('ITB2'), null, 'getArmedBetslip(ITB2) must return null when activeMarketMode === MAIN');

  // Switch to ITB mode
  await smContextTest.setMarketMode('ITB');
  smContextTest.armedBetslips.ITB1.betslipId = 'slip_ft_itb1';
  smContextTest.armedBetslips.ITB2.betslipId = 'slip_ft_itb2';
  assert.notEqual(smContextTest.getArmedBetslip('ITB1'), null, 'getArmedBetslip(ITB1) must return valid slip when activeMarketMode === ITB');
  assert.equal(smContextTest.getArmedBetslip('HOME'), null, 'getArmedBetslip(HOME) must return null when activeMarketMode === ITB');

  // Switch to HT period
  await smContextTest.setPeriod('HT');
  smContextTest.armedBetslips.OVER.betslipId = 'slip_ht_over';
  assert.equal(smContextTest.getArmedBetslip('OVER'), null, 'getArmedBetslip(OVER) must return null when activePeriod === HT');
  assert.notEqual(smContextTest.getArmedBetslip('HT_OVER'), null, 'getArmedBetslip(HT_OVER) must return valid slip when activePeriod === HT');

  // Test ExecutionEngine abort on null getArmedBetslip
  const ctxEngine = new ExecutionEngine(null, smContextTest, testConfig);
  let ctxAbortResult = null;
  ctxEngine.on('execution_result', (r) => { ctxAbortResult = r; });
  const ctxFireRes = await ctxEngine.fire('OVER'); // fired FT 'OVER' while in HT
  assert.equal(ctxFireRes.success, false);
  assert.equal(ctxFireRes.reason, 'INVALID_CONTEXT');
  assert(ctxAbortResult && ctxAbortResult.status === 'ABORT');
  console.log('✓ getArmedBetslip strict context isolation (period & market mode) verified');
  smContextTest.destroy();

  // 29. Test WsFeed cumulative spectrum registry (Fix Jitter)
  const spectrumWsFeed = new WsFeed(testConfig);
  let spectrumOdds = null;
  spectrumWsFeed.on('odds_update', (data) => { spectrumOdds = data.odds; });

  // Tick 1: single line [10, [["over", 1.85], ["under", 1.95]]] (2.50)
  spectrumWsFeed.dispatchSingleFrame([
    'offers_hcap',
    [10, 'fb', 'match_spectrum_1'],
    {
      ahou: [10, [['over', 1.85], ['under', 1.95]]]
    }
  ]);
  assert.equal(spectrumOdds.totalLines.length, 1);
  assert.equal(spectrumOdds.totalLines[0].totalLine, '2.50');

  // Tick 2: single line [11, [["over", 2.20], ["under", 1.70]]] (2.75)
  spectrumWsFeed.dispatchSingleFrame([
    'offers_hcap',
    [10, 'fb', 'match_spectrum_1'],
    {
      ahou: [11, [['over', 2.20], ['under', 1.70]]]
    }
  ]);
  // WsFeed must accumulate both lines in the spectrum!
  assert.equal(spectrumOdds.totalLines.length, 2, 'WsFeed must accumulate lines in spectrum, not overwrite to 1 line');
  assert.equal(spectrumOdds.totalLines[0].totalLine, '2.50');
  assert.equal(spectrumOdds.totalLines[1].totalLine, '2.75');

  // Tick 3: update to line 2.50
  spectrumWsFeed.dispatchSingleFrame([
    'offers_hcap',
    [10, 'fb', 'match_spectrum_1'],
    {
      ahou: [10, [['over', 1.90], ['under', 1.90]]]
    }
  ]);
  assert.equal(spectrumOdds.totalLines.length, 2);
  const line25 = spectrumOdds.totalLines.find(x => x.totalLine === '2.50');
  assert.equal(line25.totalOver, 1.90);

  // Eviction test on unsubscribeEvent
  spectrumWsFeed.unsubscribeEvent(10, 'fb', 'match_spectrum_1');
  assert.equal(spectrumWsFeed.lineSpectrums.size, 0, 'lineSpectrums must be cleared on unsubscribeEvent');

  spectrumWsFeed.destroy();
  console.log('✓ WsFeed cumulative spectrum registry and eviction verified');

  // 30. Test protection against overwriting expired/stale bookiePrice (>10s) with unallowed ticker quotes
  const smStaleTest = new StateManager({ accounts: [["pin88", "_acc_"]] });
  smStaleTest.eventsMap.set('stale_match', { eventId: 'stale_match', sport: 'fb' });
  smStaleTest.setActiveEvent('stale_match');

  // Arm slip with fresh pin88 price
  smStaleTest.armedBetslips.OVER.betslipId = 'slip_stale_over';
  smStaleTest.armedBetslips.OVER.bookiePrice = 1.95;
  smStaleTest.armedBetslips.OVER.bookiePriceTs = Date.now() - 15000; // 15 seconds ago (> 10s TTL)
  smStaleTest.armedBetslips.OVER.currentPrice = 1.95;

  // Incoming generic tick with unallowed ticker odds 2.10
  smStaleTest.updateOdds({
    eventId: 'stale_match',
    sport: 'fb',
    odds: { totalOver: 2.10 },
    updatedMarkets: { ahou: true }
  });

  // Because pin88 quote has expired (>10s) and strict filter is active, currentPrice MUST reset to 0 (CLOSED),
  // NEVER contaminated with 2.10 from generic ticker!
  assert.equal(smStaleTest.armedBetslips.OVER.currentPrice, 0, 'Stale bookie slip must reset to 0 (CLOSED), not leak 2.10 ticker price');
  assert.equal(smStaleTest.armedBetslips.OVER.priceSource, 'CLOSED');

  smStaleTest.destroy();
  console.log('✓ Stale bookie quote protection against third-party ticker contamination verified');

  // 31. Test handleStreamingSlipUpdate and handlePmmUpdate period binding
  const smPmmPeriodTest = new StateManager({ accounts: [["pin88", "_acc_"]] });
  smPmmPeriodTest.eventsMap.set('pmm_period_match', { eventId: 'pmm_period_match', sport: 'fb' });
  smPmmPeriodTest.setActiveEvent('pmm_period_match');

  // Active period is FT, but coupon belongs to HT
  assert.equal(smPmmPeriodTest.activePeriod, 'FT');
  smPmmPeriodTest.armedBetslips.OVER.betslipId = 'slip_ht_pmm';
  smPmmPeriodTest.armedBetslips.OVER.period = 'HT';
  smPmmPeriodTest.armedBetslips.OVER.targetKey = 'HT_OVER';

  smPmmPeriodTest.handlePmmUpdate({
    betslip_id: 'slip_ht_pmm',
    bookie: 'pin88',
    price_list: [{ effective: { price: 2.05, max: ['EUR', 100] } }]
  });

  assert.equal(smPmmPeriodTest.liveOdds.ht.totalOver, 2.05, 'HT odds must be updated because slip belongs to HT');
  assert.equal(smPmmPeriodTest.liveOdds.ft.totalOver, 0, 'FT odds must NOT be contaminated by HT slip PMM quote');

  smPmmPeriodTest.destroy();
  console.log('✓ PMM & Betslip WS-handlers period isolation verified');

  // 32. Test Order Normalizer
  const { normalizeOrder } = await import('./src/utils/orderNormalizer.js');
  
  const orderWon = { status: "reconciled", profit_loss: ["EUR", 25.5] };
  assert.equal(normalizeOrder(orderWon).normalizedStatus, "WON");
  assert.equal(normalizeOrder(orderWon).pnl, 25.5);

  const orderLost = { status: "reconciled", profit_loss: ["EUR", -10.0] };
  assert.equal(normalizeOrder(orderLost).normalizedStatus, "LOST");
  assert.equal(normalizeOrder(orderLost).pnl, -10.0);

  const orderVoid = { status: "full_void" };
  assert.equal(normalizeOrder(orderVoid).normalizedStatus, "VOID");
  assert.equal(normalizeOrder(orderVoid).pnl, 0);

  const orderVoidBets = { status: "reconciled", profit_loss: ["EUR", 0], bets: [{status: {code: "void"}}] };
  assert.equal(normalizeOrder(orderVoidBets).normalizedStatus, "VOID");

  const orderRejectedGoal = { status: "failed", close_reason: "event_score" };
  assert.equal(normalizeOrder(orderRejectedGoal).normalizedStatus, "REJECTED_GOAL");

  const orderInPlay = { closed: true, price: 1.5, profit_loss: null };
  assert.equal(normalizeOrder(orderInPlay).normalizedStatus, "IN_PLAY");

  const orderPending = { closed: false, profit_loss: null };
  assert.equal(normalizeOrder(orderPending).normalizedStatus, "PENDING");

  console.log('✓ Order normalizer logic verified for WON, LOST, VOID, REJECTED_GOAL, IN_PLAY, PENDING');

  // 33. Test MollybetAdapter Ice Hockey ("ih") bet_type resolution & preArmBetslip sport payload
  const ihFtInfo = { sport: 'ih', period: 'FT', totalLine: '5.5', itb1Line: '2.5', itb2Line: '2.5', isLive: true, liveScore: { home: 2, away: 1 } };
  assert.equal(adapter.resolveBetType('OVER', ihFtInfo), 'for,tp,reg,ahover,22');
  assert.equal(adapter.resolveBetType('HOME', ihFtInfo), 'for,tp,reg,wdw,h');
  assert.equal(adapter.resolveBetType('AWAY', ihFtInfo), 'for,tp,reg,wdw,a');
  assert.equal(adapter.resolveBetType('ITB1', ihFtInfo), 'for,tp,reg,tahover,h,10');
  assert.equal(adapter.resolveBetType('ITB2', ihFtInfo), 'for,tp,reg,tahover,a,10');

  for (const p of [1, 2, 3]) {
    const ihPeriodInfo = { sport: 'ih', period: 'HT', hockeyPeriod: p, totalLine: '1.5', itb1Line: '0.5', itb2Line: '0.5', isLive: true, liveScore: { home: 1, away: 1 } };
    assert.equal(adapter.resolveBetType('HT_OVER', ihPeriodInfo), `for,tperiod,${p},ahover,6`);
    assert.equal(adapter.resolveBetType('HT_HOME', ihPeriodInfo), `for,tperiod,${p},wdw,h`);
    assert.equal(adapter.resolveBetType('HT_AWAY', ihPeriodInfo), `for,tperiod,${p},wdw,a`);
    assert.equal(adapter.resolveBetType('HT_ITB1', ihPeriodInfo), `for,tperiod,${p},tahover,h,2`);
    assert.equal(adapter.resolveBetType('HT_ITB2', ihPeriodInfo), `for,tperiod,${p},tahover,a,2`);
  }

  let capturedIhPayloads = [];
  const mockIhH2 = {
    request: async (method, path, headers, body) => {
      if (method === 'POST') {
        const p = typeof body === 'string' ? JSON.parse(body) : body;
        capturedIhPayloads.push(p);
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            betslip_id: `slip_ih_${capturedIhPayloads.length}`,
            expiry_ts: Math.floor(Date.now() / 1000) + 50,
            bookies_with_offers: [['pin88', 1.92, 800]]
          }
        }),
        rttMs: 0.7
      };
    }
  };
  const ihAdapter = new MollybetAdapter(testConfig, mockIhH2);
  await ihAdapter.preArmBetslip('OVER', { eventId: 'ih_ev_1', sport: 'ih', period: 'FT', totalLine: '5.5', liveScore: { home: 2, away: 2 } });
  await ihAdapter.preArmBetslip('HT_OVER', { eventId: 'ih_ev_1', sport: 'ih', period: 'HT', hockeyPeriod: 2, totalLine: '1.5', liveScore: { home: 1, away: 1 } });
  assert.equal(capturedIhPayloads.length, 2);
  assert.equal(capturedIhPayloads[0].sport, 'ih', 'FT hockey betslip payload sport must be ih');
  assert.equal(capturedIhPayloads[0].bet_type, 'for,tp,reg,ahover,22');
  assert.equal(capturedIhPayloads[1].sport, 'ih', 'Period hockey betslip payload sport must ALWAYS be ih');
  assert.equal(capturedIhPayloads[1].bet_type, 'for,tperiod,2,ahover,6');
  console.log('✓ MollybetAdapter Ice Hockey ("ih") bet_type resolution (tp,reg & tperiod,1..3) and sport payload verified');

  // 34. Test WsFeed Ice Hockey event frame parsing & period auto-detection
  const ihWsFeed = new WsFeed(testConfig);
  let ihEventParsed = null;
  ihWsFeed.on('event_update', (ev) => { ihEventParsed = ev; });

  // P2 frame with period_scores: [[0,0],[1,1]]
  ihWsFeed.handleMessage(JSON.stringify([
    "event",
    ["ih", "2026-10-24,51317,51313"],
    {
      event_type: "normal",
      start_ts: "2026-10-24T17:45:00Z",
      competition_id: 2736,
      competition_name: "Switzerland National League A",
      home: "SC Langnau Tigers",
      away: "HC Davos",
      ir_status: {
        score: [1, 1],
        period_scores: [[0, 0], [1, 1]],
        period_time: 14,
        event_stage: "2ND_PERIOD",
        suspend: [0, 0]
      }
    }
  ]), false);

  assert(ihEventParsed !== null);
  assert.equal(ihEventParsed.sport, 'ih');
  assert.equal(ihEventParsed.hockeyPeriod, 2, 'period_scores of length 2 must auto-detect hockeyPeriod === 2');
  assert.equal(ihEventParsed.score.home, 1);
  assert.equal(ihEventParsed.score.away, 1);
  assert.equal(ihEventParsed.htScore.home, 1);
  assert.equal(ihEventParsed.htScore.away, 1);
  assert.equal(ihEventParsed.periodScoresStr, '0:0, 1:1');
  assert.equal(ihEventParsed.isLive, true);

  // Real dump with period_time: null and event_stage: "AWAITING_EXTRA_TIME"
  ihWsFeed.handleMessage(JSON.stringify([
    "event",
    ["ih", "2026-10-24,51317,51313"],
    {
      event_type: "normal",
      start_ts: "2026-10-24T17:45:00Z",
      competition_id: 2736,
      competition_name: "Switzerland National League A",
      home: "SC Langnau Tigers",
      away: "HC Davos",
      ir_status: {
        score: [2, 2],
        period_scores: [[0, 0], [1, 1], [1, 1]],
        period_time: null,
        event_stage: "AWAITING_EXTRA_TIME",
        suspend: [1, 0]
      }
    }
  ]), false);

  assert.equal(ihEventParsed.hockeyPeriod, 3, 'period_scores of length 3 must auto-detect hockeyPeriod === 3');
  assert.equal(ihEventParsed.isLive, true, 'Must remain Live during break when period_time === null');
  assert.equal(ihEventParsed.periodScoresStr, '0:0, 1:1, 1:1');
  console.log('✓ WsFeed Ice Hockey event frame parsing and period auto-detection verified');

  // 35. Test WsFeed Ice Hockey offers_hcap parsing (including nested [null, ...] & dual FT+HT emit)
  const ihOffersEvents = [];
  ihWsFeed.on('odds_update', (data) => { ihOffersEvents.push(data); });

  // Real dump nested format: [["offers_hcap",[1294,"ih","2026-10-25,10043989,29080"],{"time_win,tp,all,ml":[null,[["a",1.589],["h",2.61]]]}]]
  ihWsFeed.handleMessage(JSON.stringify([
    ["offers_hcap", [1294, "ih", "2026-10-25,10043989,29080"], {
      "time_win,tp,all,ml": [null, [["a", 1.589], ["h", 2.61]]]
    }]
  ]), false);

  assert.equal(ihOffersEvents.length, 1);
  assert.equal(ihOffersEvents[0].sport, 'ih');
  assert.equal(ihOffersEvents[0].periodType, 'FT');
  assert.equal(ihOffersEvents[0].odds.winHome, 2.61);
  assert.equal(ihOffersEvents[0].odds.winAway, 1.589);

  // Combined frame with both tp,reg (FT) and tperiod,2 (HT) markets
  ihOffersEvents.length = 0;
  ihWsFeed.eventHockeyPeriods.set("ih_combo_ev", 2);
  ihWsFeed.handleMessage(JSON.stringify([
    "offers_hcap",
    [2736, "ih", "ih_combo_ev"],
    {
      "tp,reg,wdw": [null, [["h", 2.15], ["d", 4.10], ["a", 2.85]]],
      "tp,reg,ahou": [[22, [["over", 1.95], ["under", 1.85]]]],
      "tp,reg,tahou,h": [[10, [["over", 1.88], ["under", 1.92]]]],
      "tperiod,2,wdw": [null, [["h", 2.50], ["d", 2.75], ["a", 3.10]]],
      "tperiod,2,ahou": [[6, [["over", 2.02], ["under", 1.80]]]],
      "tperiod,2,tahou,a": [[2, [["over", 1.74], ["under", 2.06]]]]
    }
  ]), false);

  assert.equal(ihOffersEvents.length, 2, 'Combined ih frame with tp,reg and tperiod,2 must emit 2 separate odds_update events (FT & HT)');
  const ftUpdate = ihOffersEvents.find(e => e.periodType === 'FT');
  const htUpdate = ihOffersEvents.find(e => e.periodType === 'HT');
  assert(ftUpdate !== undefined && htUpdate !== undefined);
  assert.equal(ftUpdate.odds.winHome, 2.15);
  assert.equal(ftUpdate.odds.totalOver, 1.95);
  assert.equal(ftUpdate.odds.totalLine, '5.50');
  assert.equal(ftUpdate.odds.itb1Over, 1.88);
  assert.equal(htUpdate.hockeyPeriod, 2);
  assert.equal(htUpdate.odds.winHome, 2.50);
  assert.equal(htUpdate.odds.totalOver, 2.02);
  assert.equal(htUpdate.odds.totalLine, '1.50');
  assert.equal(htUpdate.odds.itb2Over, 1.74);
  ihWsFeed.destroy();
  console.log('✓ WsFeed Ice Hockey offers_hcap parsing (nested [null,...] & dual FT/HT dispatch) verified');

  // 36. Test StateManager automatic period transition (P1 -> P2) & coupon re-arming for Ice Hockey
  const ihArmedCalls = [];
  const ihDeletedSlips = [];
  const mockIhTransitionH2 = {
    request: async (method, path, headers, body) => {
      if (method === 'DELETE') {
        const parts = path.split('/').filter(Boolean);
        ihDeletedSlips.push(parts.pop());
        return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok' }), rttMs: 0.5 };
      }
      if (method === 'POST') {
        const payload = typeof body === 'string' ? JSON.parse(body) : body;
        ihArmedCalls.push(payload);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              betslip_id: `slip_ih_p_${ihArmedCalls.length}`,
              expiry_ts: Math.floor(Date.now() / 1000) + 55,
              bookies_with_offers: [['pin88', 1.95, 500]]
            }
          }),
          rttMs: 0.6
        };
      }
      return { status: 200, headers: {}, body: '{}', rttMs: 0.5 };
    }
  };
  const ihTransAdapter = new MollybetAdapter(testConfig, mockIhTransitionH2);
  const smIh = new StateManager(testConfig);
  smIh.setAdapter(ihTransAdapter);

  // Add 1 Football and 1 Hockey match to verify sport filtering in getSoccerList
  smIh.updateEventMetadata({
    eventId: 'fb_match_1',
    sport: 'fb',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    isLive: true,
    score: { home: 1, away: 0 }
  });
  smIh.updateEventMetadata({
    eventId: 'ih_match_1',
    sport: 'ih',
    homeTeam: 'SC Langnau Tigers',
    awayTeam: 'HC Davos',
    isLive: true,
    hockeyPeriod: 1,
    score: { home: 0, away: 0 },
    htScore: { home: 0, away: 0 },
    periodScores: [[0, 0]],
    periodScoresStr: '0:0'
  });

  assert.equal(smIh.getSoccerList('LIVE', 'ALL_SPORTS').list.length, 2);
  assert.equal(smIh.getSoccerList('LIVE', 'FB').list.length, 1);
  assert.equal(smIh.getSoccerList('LIVE', 'IH').list.length, 1);
  assert.equal(smIh.getSoccerList('LIVE', 'IH').list[0].eventId, 'ih_match_1');

  // Activate hockey match and switch to Period mode (HT -> P1)
  smIh.setActiveEvent('ih_match_1');
  assert.equal(smIh.liveOdds.ft.totalLine, '5.5');
  assert.equal(smIh.liveOdds.ft.itb1Line, '2.5');
  assert.equal(smIh.liveOdds.ht.totalLine, '1.5');
  assert.equal(smIh.liveOdds.ht.itb1Line, '0.5');

  await smIh.setPeriod('HT');
  assert.equal(smIh.activePeriod, 'HT');
  assert.equal(smIh.currentHockeyPeriod, 1);
  assert(smIh.armedBetslips.OVER.betType.includes('tperiod,1,ahover,6'), 'Must arm P1 over with tperiod,1');
  const p1OverSlipId = smIh.armedBetslips.OVER.betslipId;
  assert(p1OverSlipId !== null);

  // Now simulate P1 -> P2 transition via event_update frame
  let periodChangedEvent = null;
  smIh.on('hockey_period_changed', (ev) => { periodChangedEvent = ev; });

  smIh.updateEventMetadata({
    eventId: 'ih_match_1',
    sport: 'ih',
    hockeyPeriod: 2,
    score: { home: 0, away: 0 },
    htScore: { home: 0, away: 0 },
    periodScores: [[0, 0], [0, 0]],
    periodScoresStr: '0:0, 0:0',
    isLive: true
  });

  // Wait for async refreshAllBetslips(true) to complete
  await new Promise(r => setTimeout(r, 350));

  assert(periodChangedEvent !== null, 'hockey_period_changed event must fire on P1 -> P2');
  assert.equal(periodChangedEvent.prevPeriod, 1);
  assert.equal(periodChangedEvent.newPeriod, 2);
  assert.equal(smIh.currentHockeyPeriod, 2);
  assert(ihDeletedSlips.includes(p1OverSlipId), 'Old P1 betslip must be deleted on period change');
  assert.equal(smIh.armedBetslips.OVER.betType, 'for,tperiod,2,ahover,6', 'New betslip must be armed for P2 (tperiod,2)');
  assert.equal(smIh.armedBetslips.HOME.betType, 'for,tperiod,2,wdw,h', 'New HOME betslip must be armed for P2 (tperiod,2)');
  assert.equal(smIh.armedBetslips.AWAY.betType, 'for,tperiod,2,wdw,a', 'New AWAY betslip must be armed for P2 (tperiod,2)');

  smIh.destroy();
  console.log('✓ StateManager automatic hockey period switch (P1 -> P2) & coupon re-arming verified');

  // 41. Test MollybetAdapter.getOpenBetslips() and purgeAllRemoteBetslips()
  const deletedRemoteSlips = [];
  const mockPurgeH2 = {
    request: async (method, path) => {
      if (method === 'GET' && path === '/v1/betslips/') {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            status: 'ok',
            data: [
              { betslip_id: 'ghost_slip_1', closed: false },
              { id: 'ghost_slip_2', status: 'open' },
              { betslip_id: 'closed_slip_3', closed: true },
              'ghost_slip_4'
            ]
          }),
          rttMs: 1.1
        };
      }
      if (method === 'DELETE' && path.startsWith('/v1/betslips/')) {
        const id = path.replace('/v1/betslips/', '').replace('/', '');
        deletedRemoteSlips.push(id);
        return { status: 200, headers: {}, body: '{}', rttMs: 0.9 };
      }
      return { status: 404, headers: {}, body: '{}', rttMs: 1.0 };
    },
    isConnected: true,
    ensureConnected: async () => {}
  };

  const purgeAdapter = new MollybetAdapter(testConfig, mockPurgeH2);
  const openIds = await purgeAdapter.getOpenBetslips();
  assert.deepEqual(openIds, ['ghost_slip_1', 'ghost_slip_2', 'ghost_slip_4'], 'getOpenBetslips must return only open betslip IDs');

  const purgedCount = await purgeAdapter.purgeAllRemoteBetslips();
  assert.equal(purgedCount, 3, 'purgeAllRemoteBetslips must delete all 3 open ghost betslips');
  assert.deepEqual(deletedRemoteSlips, ['ghost_slip_1', 'ghost_slip_2', 'ghost_slip_4']);
  console.log('✓ MollybetAdapter.getOpenBetslips() & purgeAllRemoteBetslips() verified');

  // 42. Test StateManager.purgeAllServerBetslips() and 403 Auto-Healing (purge + 300ms wait + retry)
  let armAttempts = 0;
  let purgeInvocations = 0;
  const autoHealAdapter = {
    deleteBetslip: async () => true,
    purgeAllRemoteBetslips: async () => {
      purgeInvocations++;
      return 8;
    },
    preArmBetslip: async (targetKey) => {
      armAttempts++;
      if (armAttempts === 1) {
        throw new Error('Failed to pre-arm betslip: HTTP 403 - {"status":"error","code":"too_many_open_betslips","message":"Betslip limit reached"}');
      }
      return {
        betslipId: `healed_${targetKey}_slip`,
        expiryTs: Date.now() + 60000,
        betType: 'for,tp,reg,ahover,22',
        maxStake: 500,
        bookiePrice: 1.92,
        price: 1.92,
        rttMs: 1.5
      };
    }
  };

  const smHeal = new StateManager(testConfig);
  smHeal.setAdapter(autoHealAdapter);
  smHeal.eventsMap.set('heal_match_1', {
    eventId: 'heal_match_1',
    sport: 'ih',
    homeTeam: 'SKA',
    awayTeam: 'CSKA',
    score: { home: 1, away: 1 },
    isLive: true
  });
  smHeal.activeEventId = 'heal_match_1';
  smHeal.armedPool.set('heal_match_1', smHeal.armedBetslips);

  const healStartTs = Date.now();
  await smHeal.armTarget('OVER', true);
  const healElapsedMs = Date.now() - healStartTs;

  assert.equal(purgeInvocations, 1, 'Auto-Heal must invoke purgeAllRemoteBetslips() immediately on 403');
  assert.equal(armAttempts, 2, 'Auto-Heal must retry preArmBetslip after purging');
  assert(healElapsedMs >= 280, 'Auto-Heal must wait ~300ms before retrying');
  assert.equal(smHeal.armedBetslips.OVER.betslipId, 'healed_OVER_slip', 'Target betslip must be armed after auto-heal retry');
  assert.equal(smHeal.quotaBackoffMap.has('OVER'), false, 'quotaBackoffMap must be cleared after successful auto-heal');

  smHeal.destroy();
  console.log('✓ StateManager.purgeAllServerBetslips() & 403 Auto-Healing verified');

  // 43. Test soccer goal (0:0 -> 0:1) immediately advances ITB2 (0.5 -> 1.5) and OVER (0.5 -> 1.5) while keeping ITB1 at 0.5
  const goalFeed = new WsFeed(testConfig);
  const smGoal = new StateManager(testConfig);
  let goalSlipCounter = 0;
  const mockGoalH2 = {
    request: async (method, path, headers, body) => {
      if (method === 'POST' && path === '/v1/betslips/') {
        goalSlipCounter++;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              betslip_id: `goal_slip_${goalSlipCounter}`,
              expiry_ts: Math.floor(Date.now() / 1000) + 60,
              bookies_with_offers: [['pin88', 1.85, 500]]
            }
          }),
          rttMs: 1.0
        };
      }
      return { status: 200, headers: {}, body: '{}', rttMs: 0.8 };
    },
    isConnected: true,
    ensureConnected: async () => {}
  };
  const goalAdapter = new MollybetAdapter(testConfig, mockGoalH2);
  smGoal.setAdapter(goalAdapter);
  smGoal.setWsFeed(goalFeed);

  goalFeed.on('event_update', (ev) => smGoal.updateEventMetadata(ev));
  goalFeed.on('odds_update', (od) => smGoal.updateOdds(od));

  // Initial 0:0 state in soccer match
  goalFeed.handleMessage(JSON.stringify([
    'event',
    ['fb', 'fb_goal_match_1'],
    {
      home: 'Arsenal',
      away: 'Chelsea',
      competition_id: 100,
      competition_name: 'Premier League',
      ir_status: { score: [0, 0], time: ['2h', 70] }
    }
  ]), false);

  smGoal.setActiveEvent('fb_goal_match_1');
  await smGoal.setMarketMode('ITB');

  // Feed 0:0 offers where OVER, ITB1, and ITB2 are all 0.50 (index 2)
  goalFeed.handleMessage(JSON.stringify([
    'offers_hcap',
    [100, 'fb', 'fb_goal_match_1'],
    {
      ahou: [[2, [['o', 1.55], ['u', 2.40]]]],
      'tahou,h': [[2, [['o', 1.80], ['u', 2.00]]]],
      'tahou,a': [[2, [['o', 1.90], ['u', 1.90]]]]
    }
  ]), false);

  await new Promise(r => setTimeout(r, 150));

  assert.equal(smGoal.liveOdds.ft.totalLine, '0.50');
  assert.equal(smGoal.liveOdds.ft.itb1Line, '0.50');
  assert.equal(smGoal.liveOdds.ft.itb2Line, '0.50');

  // Now Away team (Chelsea) scores -> 0:1!
  goalFeed.handleMessage(JSON.stringify([
    'event',
    ['fb', 'fb_goal_match_1'],
    {
      home: 'Arsenal',
      away: 'Chelsea',
      competition_id: 100,
      competition_name: 'Premier League',
      ir_status: { score: [0, 1], time: ['2h', 72] }
    }
  ]), false);

  // Immediately on goal (even before new offers_hcap arrive):
  // ITB2 must advance from 0.50 to 1.50 (index 6), OVER from 0.50 to 1.50 (index 6), while ITB1 stays 0.50 (index 2)!
  assert.equal(smGoal.liveOdds.ft.itb2Line, '1.50', 'ITB2 line must immediately advance from 0.50 to 1.50 on 0:1 goal');
  assert.equal(smGoal.liveOdds.ft.rawItb2LineIndex, 6, 'ITB2 rawLineIndex must become 6 (1.5) on 0:1 goal');
  assert.equal(smGoal.liveOdds.ft.totalLine, '1.50', 'OVER line must immediately advance from 0.50 to 1.50 on 0:1 goal');
  assert.equal(smGoal.liveOdds.ft.rawTotalLineIndex, 6, 'OVER rawLineIndex must become 6 (1.5) on 0:1 goal');
  assert.equal(smGoal.liveOdds.ft.itb1Line, '0.50', 'ITB1 line must remain 0.50 since Home still has 0 goals');

  await new Promise(r => setTimeout(r, 350));

  assert.equal(smGoal.armedBetslips.OVER.betType, 'for,ir,0,1,ahover,6', 'Armed OVER slip must use new line index 6 at 0:1');
  assert.equal(smGoal.armedBetslips.ITB1.betType, 'for,ir,0,1,tahover,h,2', 'Armed ITB1 slip must stay on line index 2 at 0:1');
  assert.equal(smGoal.armedBetslips.ITB2.betType, 'for,ir,0,1,tahover,a,6', 'Armed ITB2 slip must use new line index 6 at 0:1');

  // Now subsequent offers_hcap arrives for 0:1 with new 1.50 line for ITB2 and OVER
  goalFeed.handleMessage(JSON.stringify([
    'offers_hcap',
    [100, 'fb', 'fb_goal_match_1'],
    {
      ahou: [[6, [['o', 1.72], ['u', 2.10]]]],
      'tahou,h': [[2, [['o', 1.85], ['u', 1.95]]]],
      'tahou,a': [[6, [['o', 2.15], ['u', 1.70]]]]
    }
  ]), false);

  assert.equal(smGoal.liveOdds.ft.itb2Line, '1.50', 'ITB2 must remain 1.50 and never revert to zombie 0.50');
  assert.equal(smGoal.liveOdds.ft.itb2Over, 2.15);
  assert.equal(smGoal.liveOdds.ft.itb1Line, '0.50');
  assert.equal(smGoal.liveOdds.ft.itb1Over, 1.85);

  smGoal.destroy();
  await goalFeed.destroy();
  console.log('✓ Soccer post-goal line advancement (ITB2 & OVER 0.5 -> 1.5 on 0:1) & spectrum eviction verified');

  // 44. Test Available Balance vs Total Balance (Баланс: €50 / €90) in WsFeed, StateManager & TerminalUI HUD
  const balFeed = new WsFeed(testConfig);
  const smBal = new StateManager(testConfig);
  smBal.setWsFeed(balFeed);

  // Case A: Total balance €90 with €40 in active IN_PLAY orders -> Available: €50 / €90
  balFeed.handleMessage(JSON.stringify([
    'api',
    {
      ts: 1700000000,
      data: [
        ['balance', { balance: ['EUR', 90.0] }],
        ['order', { order_id: 'ord_inplay_1', closed: true, price: 1.85, stake: ['EUR', 40.0], profit_loss: null }]
      ]
    }
  ]), false);

  assert.equal(smBal.accountBalance, 90.0, 'Total balance must be 90.0');
  assert.equal(smBal.openStakes, 40.0, 'Open stakes from IN_PLAY order must be 40.0');
  assert.equal(smBal.availableBalance, 50.0, 'Available balance must be 50.0 (90 - 40)');
  assert.equal(smBal.getMaxStakeLimit(), 50.0, 'Max stake limit must cap at availableBalance (50.0)');

  // Verify TerminalUI renders "(Баланс: €50 / €90)"
  let capturedHudOutput = '';
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    capturedHudOutput += String(chunk);
    return true;
  };
  const uiBal = new TerminalUI({
    stateManager: smBal,
    executionEngine: engine,
    http2Client: { isConnected: true, lastPingRttMs: 5 },
    wsFeed: { isConnected: true, lastWsRttMs: 8 },
    config: testConfig
  });
  try {
    uiBal.renderHud();
  } finally {
    process.stdout.write = origStdoutWrite;
  }
  assert(capturedHudOutput.includes('(Баланс: €50 / €90)'), `HUD must display "(Баланс: €50 / €90)", got: ${capturedHudOutput}`);
  console.log('✓ Available vs Total Balance (Баланс: €50 / €90) in WsFeed, StateManager & TerminalUI verified');

  // 45. Test Team Corner ITB Lines (ИТБ угловые команд) separated for FT (Общий) and HT (1-й тайм)
  // Both inline markets (ctahou,h / ctahou,a) and linked companion (Corners) events
  const cornFeed = new WsFeed(testConfig);
  const smCorn = new StateManager(testConfig);
  smCorn.setWsFeed(cornFeed);
  cornFeed.on('event_update', (ev) => smCorn.updateEventMetadata(ev));
  cornFeed.on('odds_update', (od) => smCorn.updateOdds(od));

  // Create main match + companion (Corners) match
  cornFeed.handleMessage(JSON.stringify([
    'event',
    ['fb', 'fb_main_101'],
    {
      home: 'Liverpool',
      away: 'Arsenal',
      competition_id: 10,
      competition_name: 'Premier League',
      ir_status: { score: [0, 0], time: ['1h', 20] }
    }
  ]), false);

  cornFeed.handleMessage(JSON.stringify([
    'event',
    ['fb', 'fb_corners_101'],
    {
      event_type: 'corners',
      home: 'Liverpool (Corners)',
      away: 'Arsenal (Corners)',
      competition_id: 11,
      competition_name: 'Premier League - Corners',
      ir_status: { score: [1, 1], time: ['1h', 20] }
    }
  ]), false);

  const mainEv = smCorn.eventsMap.get('fb_main_101');
  assert.equal(mainEv.cornersEventId, 'fb_corners_101', 'Companion (Corners) event must auto-link to main football match');

  smCorn.setActiveEvent('fb_main_101');

  // Feed FT Corner ITB lines via inline ctahou,h / ctahou,a on main match
  cornFeed.handleMessage(JSON.stringify([
    'offers_hcap',
    [10, 'fb', 'fb_main_101'],
    {
      'ctahou,h': [
        [18, [['o', 1.75], ['u', 2.05]]],
        [22, [['o', 2.25], ['u', 1.62]]]
      ],
      'ctahou,a': [
        [14, [['o', 1.65], ['u', 2.20]]],
        [18, [['o', 2.10], ['u', 1.72]]]
      ]
    }
  ]), false);

  // Feed HT (1st Half) Corner ITB lines via companion (Corners) event with sport "fb_ht"
  cornFeed.handleMessage(JSON.stringify([
    'offers_hcap',
    [11, 'fb_ht', 'fb_corners_101'],
    {
      'tahou,h': [
        [6, [['o', 1.60], ['u', 2.30]]],
        [10, [['o', 2.15], ['u', 1.68]]]
      ],
      'tahou,a': [
        [6, [['o', 1.88], ['u', 1.92]]],
        [10, [['o', 2.60], ['u', 1.48]]]
      ]
    }
  ]), false);

  // Verify FT (Общий) Corner ITB lines
  assert.equal(smCorn.liveOdds.ft.cornersItb1Lines.length, 2, 'FT must have 2 available Corners ITB1 lines (4.50, 5.50)');
  assert.equal(smCorn.liveOdds.ft.cornersItb1Lines[0].totalLine, '4.50');
  assert.equal(smCorn.liveOdds.ft.cornersItb1Lines[1].totalLine, '5.50');
  assert.equal(smCorn.liveOdds.ft.cornersItb2Lines.length, 2, 'FT must have 2 available Corners ITB2 lines (3.50, 4.50)');
  assert.equal(smCorn.liveOdds.ft.cornersItb2Lines[0].totalLine, '3.50');
  assert.equal(smCorn.liveOdds.ft.cornersItb2Lines[1].totalLine, '4.50');

  // Verify HT (1-й тайм) Corner ITB lines are strictly isolated from FT
  assert.equal(smCorn.liveOdds.ht.cornersItb1Lines.length, 2, 'HT must have 2 available Corners ITB1 lines (1.50, 2.50)');
  assert.equal(smCorn.liveOdds.ht.cornersItb1Lines[0].totalLine, '1.50');
  assert.equal(smCorn.liveOdds.ht.cornersItb1Lines[1].totalLine, '2.50');
  assert.equal(smCorn.liveOdds.ht.cornersItb2Lines.length, 2, 'HT must have 2 available Corners ITB2 lines (1.50, 2.50)');
  assert.equal(smCorn.liveOdds.ht.cornersItb2Line, '1.50');
  assert.equal(smCorn.liveOdds.ht.cornersItb2Over, 1.88);

  // Verify HUD & Lines Menu render both FT (Общий) and HT (1-й тайм) Corner ITB lines
  let capturedCornHud = '';
  let capturedLinesMenu = '';
  process.stdout.write = (chunk) => {
    capturedCornHud += String(chunk);
    return true;
  };
  const uiCorn = new TerminalUI({
    stateManager: smCorn,
    executionEngine: engine,
    http2Client: { isConnected: true, lastPingRttMs: 5 },
    wsFeed: { isConnected: true, lastWsRttMs: 8 },
    config: testConfig
  });
  try {
    uiCorn.renderHud();
    process.stdout.write = (chunk) => {
      capturedLinesMenu += String(chunk);
      return true;
    };
    uiCorn.linesMarketTab = 'CORNERS_ITB1';
    uiCorn.renderLinesMenu();
  } finally {
    process.stdout.write = origStdoutWrite;
  }

  assert(capturedCornHud.includes('Угловые ИТБ:'), 'HUD must display Угловые ИТБ line when broker provides corner lines');
  assert(capturedCornHud.includes('[Общий FT]') && capturedCornHud.includes('[1-й тайм HT]'), 'HUD must display both Общий FT and 1-й тайм HT corner ITB sections');
  assert(capturedCornHud.includes('4.50:1.75') && capturedCornHud.includes('5.50:2.25'), 'HUD must list FT Corners ITB1 lines');
  assert(capturedCornHud.includes('1.50:1.60') && capturedCornHud.includes('2.50:2.15'), 'HUD must list HT Corners ITB1 lines');
  assert(capturedLinesMenu.includes('ДОСТУПНЫЕ ЛИНИИ НА ИТБ УГЛОВЫЕ КОМАНД'), 'Lines Menu must render Corners ITB summary block');

  smBal.destroy();
  await balFeed.destroy();
  smCorn.destroy();
  await cornFeed.destroy();
  console.log('✓ Team Corner ITB lines (FT Общий & HT 1-й тайм) parsing, companion event linking & HUD/Lines UI verified');

  stickyWsFeed.destroy();
  smHt.destroy();
  testWsFeed.destroy();
  smLines.destroy();
  smPeriod.destroy();
  smMarket.destroy();
  stateManager.destroy();
  pmmStateManager.destroy();
  console.log('--- ALL ARCHITECTURAL TESTS PASSED SUCCESSFULLY ---');
  process.exit(0);
})();


