import { MollybetAdapter } from './src/adapters/mollybetAdapter.js';

const testConfig = {
  baseUrl: 'https://edge.madmarket.io',
  sessionToken: 'd8a2f49a089977c420e9cf2431e99679',
  accounts: [['pin88', '_85ce631d_']]
};

const mockH2 = {
  request: async (method, path, headers) => {
    const res = await fetch(testConfig.baseUrl + path, { headers });
    const text = await res.text();
    return { status: res.status, body: text };
  }
};

const adapter = new MollybetAdapter(testConfig, mockH2);
adapter.getOrdersHistory(10).then(orders => {
  const filtered = orders.filter(o => String(o.order_id).includes('803024') || String(o.order_id).includes('827309') || String(o.order_id).includes('649936'));
  console.log(JSON.stringify(filtered.map(o => ({
    id: o.order_id,
    effStake: o.effStake,
    effPrice: o.effPrice,
    rawStake: o.stake,
    rawGotStake: o.got_stake,
    want_stake: o.want_stake,
    want_price: o.want_price,
    bets: o.bets,
    status: o.status,
    close_reason: o.close_reason
  })), null, 2));
}).catch(console.error);
