// Pump.fun Replay Sprint — strict single-shot launch snipe (own design).
//
// The dev window (24h, 2-3 Nov 2026, 1,222 coins) is brutal: the median coin
// dumps ~-16% from its launch price, and every loose rule loses money. The
// sibling entry on this same dataset (a launch snipe with top-ups, 122 coins)
// scored -0.074 SOL, and its stricter cuts scored better but traded too few
// coins for a 6h window. This competition's final window is 24h, not 6h, so
// a strict filter that still trades 30+ coins a day clears the 20-coin
// guardrail with room to spare. This bot is built for that shape:
//
//   * Buy once, in a single order, within 2 slots of a coin's create.
//   * Only the cleanest launches: zero non-creator buyers so far, the
//     creator's own buys at most 2.5 SOL, real SOL 0.3-30 at first sight,
//     creator has not sold, curve not complete.
//   * No top-ups: a partial fill is accepted as-is, never chased.
//   * Exit fast: take profit +10%, stop loss -8%, max hold 6 slots, sell
//     if still below entry after 3 slots, and out the moment the
//     creator sells.
//
// Sweep results on the dev window (16 variants through the real harness):
// the shipped config scores -0.0199 SOL over 33 coins (win rate 6.1%),
// guardrails met. Looser entry (1 buyer) trades 120 coins but loses
// -0.055; tighter creator cap (1.5 SOL) loses less (-0.011) but trades
// only 17 coins and fails the 20-coin guardrail. Wider take-profit /
// stop-loss / hold do not change the score at all on dev: every exit is
// decided by the stall rule or a creator sell. No rule tested is
// profitable on dev — this is the least-negative ticket available, and
// it wins only if the final window runs hotter than the dev one.
//
// Protocol: the harness sends hello, then one batch per slot, then done.
// Each batch carries that slot's events, marks for held/pending curves,
// fills, and the account. Orders decided on the batch for slot s fill at
// slot s + 2. Replies are one JSON line per batch with the orders for
// that slot. Every decision below is a pure function of the hello/batch
// stream (no clock, no env, no randomness), so two runs on the same data
// produce identical orders.

import { runBot, LAMPORTS_PER_SOL, type BotState, type Batch, type OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- config
// Every tunable lives here. The local sweep varies entry and exit knobs;
// the shipped values are the least-negative config that still trades
// 30+ coins on the dev window.
const CFG = {
  stakeLamports: 10_000_000n, // 0.01 SOL per coin, single order (swept: 0.01-0.03; 0.01 loses least)
  maxAgeSlots: 3, // buy only within 3 slots of create
  minRealSol: 0.3, // real SOL at decision: skip dust launches ...
  maxRealSol: 30, // ... and skip coins that already ran far
  maxDevBuySol: 2.5, // creator's own buys so far (SOL); more smells bundled
  maxBuyers: 0, // distinct non-creator buyers so far; 0 = cleanest launches
  takeProfitBps: 1000, // sell all at +10% vs cost basis
  stopLossBps: 800, // sell all at -8% vs cost basis
  maxHoldSlots: 6, // sell all this many slots after the position opened
  stallSlots: 3, // sell if still below entry after this many slots held
  maxSlippageBps: 500,
  maxOpenPositions: 5,
} as const;

const SOL = 1_000_000_000n;

// ---------------------------------------------------------------- per-coin book
// BotState.curves knows reserves but not who traded, so launch quality is
// tracked here from the batch events (hello/batch/orders/slot flow below).
interface Launch {
  mint: string;
  createdSlot: number;
  createPrice: number; // virtual quote / virtual token at create
  devBuyLamports: bigint;
  devSold: boolean;
  buyers: Set<string>;
  ordered: boolean; // a buy was sent and not yet rejected
  bought: boolean; // a buy filled for this coin
  entrySlot: number; // slot the position first appeared, 0 = not open yet
  peakPrice: number; // highest price seen while holding
  gone: boolean; // bought and sold, or completed: never touch again
}

const launches = new Map<string, Launch>();

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

function curvePrice(state: BotState, mint: string): number {
  const c = state.curves.get(mint);
  if (!c) return 0;
  return priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
}

function solOf(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

// Fold one batch's fills and events into the per-coin book. Runs before any
// order decision on that slot, so entry filters see this slot's trades and
// a rejected buy frees the coin for one retry while it is still fresh.
function observeBatch(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.side !== 'buy') continue;
    const c = launches.get(f.mint);
    if (!c) continue;
    if (f.status === 'filled') c.bought = true;
    else c.ordered = false; // rejected/failed: may retry while age allows
  }
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!launches.has(e.mint)) {
        launches.set(e.mint, {
          mint: e.mint,
          createdSlot: e.slot,
          createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          devBuyLamports: 0n,
          devSold: false,
          buyers: new Set(),
          ordered: false,
          bought: false,
          entrySlot: 0,
          peakPrice: 0,
          gone: false,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const c = launches.get(e.mint);
      if (!c) continue;
      if (e.user === e.creator) {
        if (e.is_buy) c.devBuyLamports += BigInt(e.sol_amount);
        else c.devSold = true;
      } else if (e.is_buy) {
        c.buyers.add(e.user);
      }
    } else if (e.event === 'CompleteEvent') {
      const c = launches.get(e.mint);
      if (c) c.gone = true;
    }
  }
}

// A coin is buyable only while it is a fresh, clean launch. Single-shot:
// one order per coin, no top-ups, so a rejected or partial fill is never
// chased beyond the age window.
function entryOk(state: BotState, c: Launch, slot: number): boolean {
  if (c.gone || c.bought || c.ordered) return false;
  if (state.positions.has(c.mint)) return false;
  if (slot - c.createdSlot > CFG.maxAgeSlots) return false;
  const curve = state.curves.get(c.mint);
  if (!curve || curve.complete) return false;
  const realSol = solOf(curve.real_quote_reserves);
  if (realSol < CFG.minRealSol || realSol > CFG.maxRealSol) return false;
  if (solOf(c.devBuyLamports) > CFG.maxDevBuySol) return false;
  if (c.devSold) return false;
  if (c.buyers.size > CFG.maxBuyers) return false;
  return true;
}

// Buy the whole stake in one order, capped by the harness rule (buys on one
// mint in one reply may spend at most 1% of its real SOL reserve) and by
// free cash. Returns the order, or null when nothing to buy.
function buyOne(state: BotState, c: Launch): OrderInput | null {
  const cap = state.maxBuyLamports(c.mint);
  if (cap <= 0n) return null;
  let amount = CFG.stakeLamports < cap ? CFG.stakeLamports : cap;
  const free = state.freeCashLamports();
  if (free <= 0n) return null;
  if (amount > free) amount = free;
  if (amount < 10_000_000n) return null; // below 0.01 SOL a round trip cannot count
  c.ordered = true;
  return { side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: CFG.maxSlippageBps };
}

// ---------------------------------------------------------------- exits
// One sell per mint per batch at most: a pending sell blocks a second one,
// since the harness would reject the oversell as insufficient_tokens.
function sellPending(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === 'sell') return true;
  }
  return false;
}

// Decide the exit for one held position. Returns a sell order or null.
// Priority: creator sold -> stop-loss -> take-profit -> stalled below
// entry -> max hold. Cost basis is the position's cost per token.
function exitOne(state: BotState, mint: string, slot: number): OrderInput | null {
  const pos = state.positions.get(mint);
  if (!pos || pos.token_amount <= 0n) return null;
  if (sellPending(state, mint)) return null;
  const c = launches.get(mint);
  const now = curvePrice(state, mint);
  if (now <= 0) return null;
  const entry = Number(pos.cost_lamports) / Number(pos.token_amount);
  if (entry <= 0) return null;
  if (c) {
    if (c.entrySlot === 0) {
      c.entrySlot = slot;
      c.peakPrice = now;
    }
    if (now > c.peakPrice) c.peakPrice = now;
  }
  const sellAll = (): OrderInput => {
    if (c) c.gone = true;
    return { side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: CFG.maxSlippageBps };
  };
  // Creator dumping their own launch is the strongest exit signal.
  if (c && c.devSold) return sellAll();
  if (now <= entry * (1 - CFG.stopLossBps / 10000)) return sellAll();
  if (now >= entry * (1 + CFG.takeProfitBps / 10000)) return sellAll();
  if (c && c.entrySlot > 0) {
    if (slot - c.entrySlot >= CFG.stallSlots && now < entry) return sellAll();
    if (slot - c.entrySlot >= CFG.maxHoldSlots) return sellAll();
  }
  return null;
}

// ---------------------------------------------------------------- the batch loop
// One batch = one slot of market data. Fold its fills and events in, exit
// what must go, then snipe fresh launches while a position slot is free.
// Everything here is a pure function of the hello/batch stream, so two runs
// on the same data produce identical orders.
async function onBatch(state: BotState, batch: Batch): Promise<OrderInput[]> {
  observeBatch(state, batch);
  const orders: OrderInput[] = [];
  const slot = batch.slot;

  for (const mint of state.positions.keys()) {
    const o = exitOne(state, mint, slot);
    if (o) orders.push(o);
  }

  if (state.committedPositionCount() < CFG.maxOpenPositions) {
    for (const c of launches.values()) {
      if (orders.length >= 16) break;
      if (state.committedPositionCount() >= CFG.maxOpenPositions) break;
      if (!entryOk(state, c, slot)) continue;
      const o = buyOne(state, c);
      if (o) orders.push(o);
    }
  }
  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `hello: capital=${solOf(BigInt(state.hello.capital.lamports))} SOL ` +
        `maxPos=${state.hello.caps.max_open_positions} latency=${state.hello.latency_slots} ` +
        `seed=${state.hello.seed}`,
    );
  },
  onBatch,
  onDone(state) {
    let bought = 0;
    for (const c of launches.values()) if (c.bought) bought += 1;
    console.error(
      `done: cash=${solOf(state.cash)} SOL positions=${state.positions.size} ` +
        `coinsSeen=${launches.size} coinsBought=${bought}`,
    );
  },
});
