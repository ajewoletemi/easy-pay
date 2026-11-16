const express = require('express');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const MEMPOOL = 'https://mempool.space/api';
const BLOCKSTREAM = 'https://blockstream.info/api';

// Admin secret - CHANGE THIS in Render -> Environment -> ADMIN_KEY
const ADMIN_KEY = process.env.ADMIN_KEY || 'easypay-admin-123';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== IN-MEMORY DB =====
// In production, replace with Postgres / Mongo / Supabase.
// Render free tier resets this on redeploy - demo balances will reset too.
let ledger = {}; // { address: { demoBalanceSats, txs: [] } }
let pendingTxs = {}; // txid -> { from, to, amountSats, status }

// P2P Marketplace - starting offers
let p2pOffers = [
  { id: 1, seller: "EasyPay Official", type: "sell", coin: "BTC", priceNGN: 145000000, min: 5000, max: 500000, payment: "Bank Transfer", rating: 5.0, trades: 124, address: "demo" },
  { id: 2, seller: "LagosTrader", type: "buy", coin: "BTC", priceNGN: 143500000, min: 10000, max: 200000, payment: "OPay", rating: 4.8, trades: 89, address: "demo" },
  { id: 3, seller: "NaijaP2P", type: "sell", coin: "USDT", priceNGN: 1520, min: 10000, max: 1000000, payment: "Bank Transfer", rating: 4.9, trades: 210, address: "demo" },
  { id: 4, seller: "AbujaGold", type: "sell", coin: "BTC", priceNGN: 144800000, min: 20000, max: 1000000, payment: "Palmpay", rating: 4.7, trades: 56, address: "demo" },
  { id: 5, seller: "CryptoQueen", type: "buy", coin: "USDT", priceNGN: 1510, min: 5000, max: 300000, payment: "Bank Transfer", rating: 5.0, trades: 340, address: "demo" },
];

function getLedger(address) {
  if (!ledger[address]) ledger[address] = { demoBalanceSats: 0, txs: [] };
  return ledger[address];
}

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'easypay-backend', time: new Date().toISOString(), p2pOffers: p2pOffers.length });
});

// ===== 1. GET BALANCE - Real on-chain + Demo =====
// Frontend calls: GET /api/balance/:address
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;
  try {
    let onchainSats = 0;
    try {
      const r = await fetch(`${MEMPOOL}/address/${address}`, { timeout: 8000 });
      if (r.ok) {
        const data = await r.json();
        onchainSats = (data.chain_stats.funded_txo_sum || 0) - (data.chain_stats.spent_txo_sum || 0);
      }
    } catch (e) {
      // Fallback to Blockstream
      try {
        const r2 = await fetch(`${BLOCKSTREAM}/address/${address}`);
        if (r2.ok) {
          const d2 = await r2.json();
          onchainSats = (d2.chain_stats.funded_txo_sum || 0) - (d2.chain_stats.spent_txo_sum || 0);
        }
      } catch (e2) {}
    }
    const led = getLedger(address);
    const totalSats = onchainSats + led.demoBalanceSats;
    res.json({
      address,
      onchainSats,
      demoSats: led.demoBalanceSats,
      totalSats,
      btc: totalSats / 100000000,
      usd: (totalSats / 100000000 * 97000).toFixed(2)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 2. GET UTXOs - For sending real BTC =====
app.get('/api/utxos/:address', async (req, res) => {
  try {
    const r = await fetch(`${MEMPOOL}/address/${address}/utxo`);
    if (!r.ok) return res.json([]);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 3. GET HISTORY - On-chain + Internal =====
app.get('/api/history/:address', async (req, res) => {
  const { address } = req.params;
  try {
    let onchain = [];
    try {
      const r = await fetch(`${MEMPOOL}/address/${address}/txs`);
      if (r.ok) onchain = await r.json();
    } catch (e) {}
    const led = getLedger(address);
    const all = [
      ...onchain.map(tx => ({
        txid: tx.txid,
        type: tx.vout.some(o => o.scriptpubkey_address === address) ? 'received' : 'sent',
        amountSats: tx.vout.filter(o => o.scriptpubkey_address === address).reduce((a, o) => a + o.value, 0),
        status: tx.status?.confirmed ? 'confirmed' : 'pending',
        confirmations: tx.status?.block_height ? 1 : 0,
        source: 'onchain',
        time: tx.status?.block_time || Date.now() / 1000
      })),
      ...led.txs
    ];
    // Sort newest first
    all.sort((a, b) => (b.time || 0) - (a.time || 0));
    res.json(all.slice(0, 30));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 4. BROADCAST + TRACK REAL TRANSACTION =====
// Frontend builds signed TX, sends hex here. Backend broadcasts + tracks it.
app.post('/api/send', async (req, res) => {
  const { hex, from, to, amountSats } = req.body;
  if (!hex) return res.status(400).json({ error: 'Missing hex' });
  try {
    const r = await fetch(`${MEMPOOL}/tx`, {
      method: 'POST',
      body: hex,
      headers: { 'Content-Type': 'text/plain' }
    });
    const txid = await r.text();
    if (!r.ok) return res.status(400).json({ error: 'Broadcast failed: ' + txid });

    // Save as pending
    pendingTxs[txid] = { from, to, amountSats, status: 'pending', createdAt: Date.now() };
    // Save in ledger for both sides
    if (from) getLedger(from).txs.unshift({ txid, type: 'sent', amountSats, status: 'pending', source: 'easypay', time: Date.now() / 1000 });
    if (to) getLedger(to).txs.unshift({ txid, type: 'received', amountSats, status: 'pending', source: 'easypay', time: Date.now() / 1000 });

    res.json({ success: true, txid, status: 'pending', message: 'Transaction broadcasted. Waiting for confirmation.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 5. CONFIRM TRANSACTION STATUS =====
// Frontend polls this after sending: GET /api/confirm/:txid
app.get('/api/confirm/:txid', async (req, res) => {
  const { txid } = req.params;
  try {
    // Demo tx - already confirmed instantly
    if (txid.startsWith('demo-')) {
      return res.json({ txid, status: 'confirmed', confirmed: true });
    }
    const r = await fetch(`${MEMPOOL}/tx/${txid}/status`);
    if (!r.ok) {
      if (pendingTxs[txid]) return res.json({ txid, status: pendingTxs[txid].status, confirmations: 0 });
      return res.status(404).json({ error: 'TX not found' });
    }
    const data = await r.json();
    const confirmed = !!data.confirmed;
    const status = confirmed ? 'confirmed' : 'pending';
    if (pendingTxs[txid]) pendingTxs[txid].status = status;
    // Update ledger status too
    for (let addr in ledger) {
      for (let t of ledger[addr].txs) {
        if (t.txid === txid) t.status = status;
      }
    }
    res.json({ txid, status, confirmed, block_height: data.block_height || null, block_time: data.block_time || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== 6. DEMO TRANSFER - Send test money to another EasyPay wallet =====
// POST /api/demo-transfer { from, to, amountSats }
// Instant, no fee, no blockchain. For testing only. NOT real BTC.
app.post('/api/demo-transfer', (req, res) => {
  const { from, to, amountSats } = req.body;
  if (!from || !to || !amountSats) return res.status(400).json({ error: 'Missing from/to/amount' });
  const amt = parseInt(amountSats);
  if (amt <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  if (from === to) return res.status(400).json({ error: 'Cannot send to yourself' });

  const fromLed = getLedger(from);
  const toLed = getLedger(to);

  if (fromLed.demoBalanceSats < amt) {
    return res.status(400).json({ error: `Not enough demo balance. You have ${fromLed.demoBalanceSats} sats demo. Use "Get Test Money" first.` });
  }

  fromLed.demoBalanceSats -= amt;
  toLed.demoBalanceSats += amt;
  const txid = 'demo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  fromLed.txs.unshift({ txid, type: 'sent', amountSats: amt, status: 'confirmed', source: 'demo-transfer', to, time: Date.now() / 1000 });
  toLed.txs.unshift({ txid, type: 'received', amountSats: amt, status: 'confirmed', source: 'demo-transfer', from, time: Date.now() / 1000 });

  res.json({ success: true, txid, fromBalance: fromLed.demoBalanceSats, toBalance: toLed.demoBalanceSats, message: 'Demo transfer complete - instant!' });
});

// ===== 7. ADMIN - ADD DEMO BALANCE (for testing, NOT real BTC) =====
// POST /api/admin/add-balance { adminKey, address, amountSats }
// Example: 100000 sats = 0.001 BTC demo
app.post('/api/admin/add-balance', (req, res) => {
  const { adminKey, address, amountSats } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Wrong admin key' });
  if (!address || !amountSats) return res.status(400).json({ error: 'Missing address or amountSats' });
  const led = getLedger(address);
  led.demoBalanceSats += parseInt(amountSats);
  led.txs.unshift({
    txid: 'demo-' + Date.now(),
    type: 'received',
    amountSats: parseInt(amountSats),
    status: 'confirmed',
    source: 'admin-demo',
    time: Date.now() / 1000
  });
  res.json({ success: true, address, newDemoBalance: led.demoBalanceSats, totalBtc: led.demoBalanceSats / 100000000 });
});

// ===== 8. ADMIN - RESET DEMO BALANCE =====
app.post('/api/admin/reset', (req, res) => {
  const { adminKey, address } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Wrong admin key' });
  if (address) delete ledger[address];
  else ledger = {};
  res.json({ success: true, message: 'Ledger cleared' });
});

// ===== 9. P2P MARKETPLACE =====
// GET all offers
app.get('/api/p2p/offers', (req, res) => {
  res.json(p2pOffers);
});

// POST create new offer
app.post('/api/p2p/create', (req, res) => {
  const { seller, type, coin, priceNGN, min, max, payment, address } = req.body;
  if (!type || !coin || !priceNGN || !min || !max) {
    return res.status(400).json({ error: 'Missing fields: type, coin, priceNGN, min, max' });
  }
  const offer = {
    id: Date.now(),
    seller: seller || "You",
    type, // 'buy' or 'sell'
    coin, // 'BTC' or 'USDT'
    priceNGN: parseFloat(priceNGN),
    min: parseFloat(min),
    max: parseFloat(max),
    payment: payment || "Bank Transfer",
    rating: 5.0,
    trades: 0,
    address: address || ""
  };
  p2pOffers.unshift(offer);
  res.json({ success: true, offer });
});

// DELETE an offer (optional - for admin / owner)
app.delete('/api/p2p/:id', (req, res) => {
  const id = parseInt(req.params.id);
  p2pOffers = p2pOffers.filter(o => o.id !== id);
  res.json({ success: true });
});

// ===== 10. MARKET PRICES - Live from CoinGecko =====
// GET /api/market -> { bitcoin: { usd, ngn }, ethereum: ..., tether: ..., solana: ... }
app.get('/api/market', async (req, res) => {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether,solana&vs_currencies=usd,ngn&include_24hr_change=true', { timeout: 8000 });
    if (!r.ok) throw new Error('CoinGecko failed');
    const d = await r.json();
    res.json(d);
  } catch (e) {
    // Fallback prices if CoinGecko is down / rate-limited
    res.json({
      bitcoin: { usd: 97000, ngn: 145000000, usd_24h_change: 1.2 },
      ethereum: { usd: 3400, ngn: 5100000, usd_24h_change: 0.8 },
      tether: { usd: 1, ngn: 1520, usd_24h_change: 0.01 },
      solana: { usd: 210, ngn: 315000, usd_24h_change: 2.1 }
    });
  }
});

// ===== 11. FOREX RATES (for Market tab) =====
app.get('/api/forex', async (req, res) => {
  // Simple static + CoinGecko NGN fallback - replace with real Forex API (exchangerate.host) if you get a key
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ngn');
    const d = await r.json();
    const usdNgn = d.tether?.ngn || 1520;
    res.json({
      EURUSD: 1.0850,
      GBPUSD: 1.2700,
      USDNGN: usdNgn,
      XAUUSD: 2650,
      BTCUSD: 97000,
      ETHUSD: 3400,
      updatedAt: new Date().toISOString()
    });
  } catch (e) {
    res.json({ EURUSD: 1.0850, GBPUSD: 1.2700, USDNGN: 1520, XAUUSD: 2650, BTCUSD: 97000, ETHUSD: 3400 });
  }
});

// ===== FRONTEND =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fallback for SPA routes - serve index.html
app.get('*', (req, res) => {
  // Don't catch /api routes
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ EasyPay Backend + Frontend live on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Balance: http://localhost:${PORT}/api/balance/1A...`);
  console.log(`   P2P: http://localhost:${PORT}/api/p2p/offers`);
  console.log(`   Market: http://localhost:${PORT}/api/market`);
});
