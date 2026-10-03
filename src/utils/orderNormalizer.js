export function normalizeOrder(order) {
  let normalizedStatus = "UNKNOWN";
  let pnl = 0;
  let label = "";

  const pnlValue = (order.profit_loss && Array.isArray(order.profit_loss) && typeof order.profit_loss[1] === 'number') 
    ? order.profit_loss[1] 
    : null;

  let effStake = 0;
  let effPrice = order.price || order.got_price || null;

  // Try top-level stake
  if (order.stake && Array.isArray(order.stake) && typeof order.stake[1] === 'number') effStake = order.stake[1];
  else if (typeof order.stake === 'number') effStake = order.stake;
  else if (order.got_stake && Array.isArray(order.got_stake) && typeof order.got_stake[1] === 'number') effStake = order.got_stake[1];
  else if (typeof order.got_stake === 'number') effStake = order.got_stake;

  // Derive from bets array if present (handles partial fills correctly)
  if (order.bets && Array.isArray(order.bets)) {
    let totalGotStake = 0;
    let weightedPriceSum = 0;
    for (const b of order.bets) {
      // If bet is placed, it has a success/reconciled/void status or simply got_stake > 0
      let bStake = 0;
      if (b.got_stake && Array.isArray(b.got_stake) && typeof b.got_stake[1] === 'number') bStake = b.got_stake[1];
      else if (typeof b.got_stake === 'number') bStake = b.got_stake;
      
      let bPrice = b.got_price || 0;
      if (bStake > 0) {
        totalGotStake += bStake;
        weightedPriceSum += (bPrice * bStake);
      }
    }
    if (totalGotStake > 0) {
      effStake = totalGotStake;
      effPrice = weightedPriceSum / totalGotStake;
    }
  }

  const isPlaced = effStake > 0 || effPrice > 0 || order.price > 0;

  if (order.status === "reconciled" && pnlValue !== null && pnlValue > 0) {
    normalizedStatus = "WON";
    pnl = pnlValue;
  } else if (order.status === "reconciled" && pnlValue !== null && pnlValue < 0) {
    normalizedStatus = "LOST";
    pnl = pnlValue;
  } else if (
    order.status === "full_void" || 
    (isPlaced && order.bets && Array.isArray(order.bets) && order.bets.every(b => b.status && b.status.code === 'void')) ||
    (order.status === "reconciled" && pnlValue === 0)
  ) {
    normalizedStatus = "VOID";
    pnl = 0;
    label = "ВОЗВРАТ";
  } else if (isPlaced && pnlValue === null) {
    // If we have placed stake but no PNL yet, it's IN_PLAY! (even if order.status is "failed" due to timeout)
    normalizedStatus = "IN_PLAY";
    label = "В ИГРЕ";
  } else if (order.status === "failed" && order.close_reason === "event_score") {
    normalizedStatus = "REJECTED_GOAL";
    label = "ОТКЛОНЕНО (ГОЛ/СЧЕТ)";
  } else if (order.status === "failed") {
    normalizedStatus = "FAILED";
    let reason = "ОШИБКА";
    if (order.close_reason === "timed_out") {
      reason = "ТАЙМАУТ";
    }
    if (order.bets && Array.isArray(order.bets) && order.bets[0] && order.bets[0].status && order.bets[0].status.reason) {
      const apiReason = order.bets[0].status.reason;
      if (apiReason === "Unsuccessful") reason = "ОТКЛОНЕНО (БРОКЕР)";
      else reason = `ОТКЛ (${apiReason})`;
    }
    label = reason;
  } else if (order.closed === false) {
    normalizedStatus = "PENDING";
  } else if (order.status === "open") {
    normalizedStatus = "PENDING";
  } else {
    // Fallback
    if (isPlaced) normalizedStatus = "IN_PLAY";
    else normalizedStatus = "FAILED";
  }

  let displayStake = effStake;
  let displayPrice = effPrice;

  // If effStake is 0 (order failed entirely), show what we attempted to place
  if (effStake === 0) {
    if (order.want_stake && Array.isArray(order.want_stake) && typeof order.want_stake[1] === 'number') displayStake = order.want_stake[1];
    else if (typeof order.want_stake === 'number') displayStake = order.want_stake;
    displayPrice = order.want_price || order.price || null;
  }

  return {
    ...order,
    normalizedStatus,
    pnl,
    label,
    effStake: displayStake,
    effPrice: displayPrice
  };
}
