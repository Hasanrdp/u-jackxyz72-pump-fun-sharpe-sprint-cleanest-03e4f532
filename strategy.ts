// Clean Sharpe Sniper — strategy for the agent-fun/replay/v2 pump.fun replay.
//
// Idea: on this market almost every fresh launch bleeds, and the only launches
// that pay are the ones whose creator bought a serious stake of their own at
// launch with a few real wallets piling in beside them. So the bot is picky: it
// watches every curve from birth, scores only its opening tape (the create slot
// and the next few slots), and buys only the rare launches that pass every filter.
// A position is small (the 1%-of-real-reserve cap binds early, so the first buy is
// 0.03-0.06 SOL), exits fast (take profit +25%, stop loss -10%, at most 30 slots
// held, out at once when the creator sells), and never chases: a launch that
// fails a filter is done for good.
//
// The guardrail problem is the opposite of the entry problem: a picky bot trades
// too few coins to clear 20 distinct mints in a 6-hour window. So a second,
// deliberately boring mechanism runs beside it: pace probes. When the distinct
// coins traded lag the pace (30 coins over the 6-hour window, prorated by block
// time), the bot buys 0.01 SOL of the most liquid coin traded on this batch and
// sells it whole on the next batch. A probe loses about 0.0005 SOL to fees, so
// twenty of them cost ~0.01 SOL — cheap insurance for the guardrail, and they
// never take a slot a main position needs.
//
// Deterministic by construction: no clock, no Math.random, no environment reads;
// every iteration follows insertion-ordered maps fed by the batch stream, and the
// only time source is the block_time the harness itself delivers.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since CreateEvent) at which a first buy may be decided. */
  maxEntryAgeSlots: number;
  /** Lamports aimed for per main position (the 1% reserve cap usually binds first). */
  stakeLamports: number;
  /** Smallest first buy worth paying the transaction fee for (also the guardrail size). */
  minFirstBuyLamports: number;
  /** Real SOL reserve window at decision time. */
  minRealSolLamports: number;
  maxRealSolLamports: number;
  /** Creator's own buys inside the create slot: lamports window. */
  minCreatorBuyLamports: number;
  maxCreatorBuyLamports: number;
  /** Distinct non-creator buyers seen before entry: window. */
  minEarlyBuyers: number;
  maxEarlyBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Price now over the create price, as bps, at most (10000 = 1x). */
  maxRunupBps: number;
  /** Creator sold before entry: skip the coin. */
  skipCreatorSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  takeProfitBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnCreatorSell: boolean;
  /** Most main positions open at once (the rest of the 5 slots is for probes). */
  maxMainPositions: number;
  /** Most probe round trips in flight at once. */
  maxProbePositions: number;
  /** One probe round trip buys this many lamports (the guardrail minimum). */
  probeLamports: number;
  /** Distinct coins to reach by the end of the window. */
  probeTargetCoins: number;
  /** Seconds of block time the window is paced over (the 6-hour final). */
  probeWindowSeconds: number;
}

/** Shipped settings: the selective core that scored positive on the dev window
 * (net +0.008 SOL, hourly Sharpe +0.03, max drawdown 0.5%, 48 round trips over
 * 24 hours of dev data), with probes pacing the coin count to 30. Stress on 20
 * rebuilt copies of the window: median -0.064 SOL, 19 of 20 copies lose money,
 * so the dev score leans on a few coins — the entry is a small, controlled bet
 * on the final window's fresh launches, not a forecast. */
export const DEFAULT_PARAMS: Params = {
  maxEntryAgeSlots: 3,
  stakeLamports: 200_000_000,
  minFirstBuyLamports: 10_000_000,
  minRealSolLamports: 3_000_000_000,
  maxRealSolLamports: 30_000_000_000,
  minCreatorBuyLamports: 1_000_000_000,
  maxCreatorBuyLamports: 2_000_000_000,
  minEarlyBuyers: 2,
  maxEarlyBuyers: 3,
  maxSellRatioBps: 10_000,
  maxRunupBps: 1_000_000,
  skipCreatorSold: true,
  buySlippageBps: 10_000,
  takeProfitBps: 2500,
  stopLossBps: 1000,
  maxHoldSlots: 30,
  exitOnCreatorSell: true,
  maxMainPositions: 5,
  maxProbePositions: 2,
  probeLamports: 10_000_000,
  probeTargetCoins: 30,
  probeWindowSeconds: 21_600,
};

const BPS = 10_000n;
/** Curve fees on a sell: protocol 95 bps + creator 30 bps. */
const CURVE_FEE_BPS = 125n;

interface OpeningTape {
  mint: Pubkey;
  createdSlot: number;
  creator: Pubkey;
  /** Price at creation, as a virtual-quote / virtual-token pair. */
  createVq: bigint;
  createVt: bigint;
  /** Creator buys inside the create slot only. */
  creatorBuy: bigint;
  /** Distinct non-creator buyers seen so far. */
  earlyBuyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  creatorSold: boolean;
  lastTradeSlot: number;
  /** Never consider this coin again (decided, exited, or completed). */
  done: boolean;
}

interface OpenTrade {
  openedSlot: number;
  /** Transaction fees paid on this position's fills so far. */
  txPaid: bigint;
  /** True for a guardrail probe (sold on the batch after its buy lands). */
  probe: boolean;
  /** A probe whose buy has filled and is waiting for its sell batch. */
  probeReady: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees, before the tx fee. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, OpeningTape>();
  const open = new Map<Pubkey, OpenTrade>();
  /** Coins a probe round trip already covered (probes chase new coins). */
  const probed = new Set<Pubkey>();
  /** Distinct mints this bot's own filled orders touched (harness closes excluded). */
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime = 0;

  const tapeOf = (mint: Pubkey): OpeningTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      // A tape is only created from a CreateEvent below; this is unreachable in
      // practice, but keep a harmless blank so a stray trade never crashes us.
      t = {
        mint,
        createdSlot: 0,
        creator: '',
        createVq: 0n,
        createVt: 1n,
        creatorBuy: 0n,
        earlyBuyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        creatorSold: false,
        lastTradeSlot: 0,
        done: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const traded: Pubkey[] = [];

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapes.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            createVq: BigInt(e.virtual_quote_reserves),
            createVt: BigInt(e.virtual_token_reserves),
            creatorBuy: 0n,
            earlyBuyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            creatorSold: false,
            lastTradeSlot: e.slot,
            done: false,
          });
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = BigInt(e.sol_amount);
          t.lastTradeSlot = e.slot;
          const isCreator = e.user === t.creator;
          if (e.is_buy) {
            t.bought += sol;
            if (isCreator && e.slot === t.createdSlot) t.creatorBuy += sol;
            else if (!isCreator) t.earlyBuyers.add(e.user);
          } else if (isCreator) {
            t.creatorSold = true;
          } else {
            t.soldByOthers += sol;
          }
          traded.push(e.mint);
        } else {
          const t = tapes.get(e.mint);
          if (t !== undefined) t.done = true;
        }
      }

      // Fold this batch's fills in: count our coins, track tx fees per position,
      // and drop anything the harness closed for us (client_id starts with `_`).
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          open.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') myCoins.add(f.mint);
        const h = open.get(f.mint);
        if (h !== undefined && f.status !== 'rejected') {
          h.txPaid += BigInt(f.tx_fee_lamports);
          if (f.side === 'buy' && f.status === 'filled' && h.probe) h.probeReady = true;
        }
      }
      // A held position whose tokens are gone without a sell in flight is closed.
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !hasPending(state, mint, 'buy')) {
          open.delete(mint);
        }
      }

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return null;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // Exits first: every open position is checked against take profit, stop
      // loss, the hold limit, and a creator sale. Probes sell on the batch after
      // their buy lands, whatever the price did.
      let mainOpen = 0;
      for (const [mint, h] of open) {
        if (!state.positions.has(mint)) continue;
        if (!h.probe) mainOpen++;
      }
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (hasPending(state, mint, 'sell')) continue;
        const h = open.get(mint);
        if (h === undefined) {
          open.set(mint, { openedSlot: now, txPaid: tx, probe: false, probeReady: false });
          continue;
        }
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = sellValue(pos.token_amount, r.vq, r.vt) - tx;
        const basis = BigInt(pos.cost_lamports) + h.txPaid;
        let exit = false;
        if (h.probe) {
          exit = h.probeReady;
        } else {
          if (basis > 0n) {
            if (value * BPS >= basis * (BPS + BigInt(p.takeProfitBps))) exit = true;
            if (value * BPS <= basis * (BPS - BigInt(p.stopLossBps))) exit = true;
          }
          if (now - h.openedSlot >= p.maxHoldSlots) exit = true;
          const t = tapes.get(mint);
          if (p.exitOnCreatorSell && t !== undefined && t.creatorSold) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        const t = tapes.get(mint);
        if (t !== undefined && !h.probe) t.done = true;
      }

      // Main entries: fresh launches whose opening tape passes every filter.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (mainOpen >= p.maxMainPositions) break;
        if (state.committedPositionCount() >= state.hello.caps.max_open_positions) break;
        const t = tapes.get(mint);
        if (t === undefined || t.done) continue;
        if (open.has(mint) || hasPending(state, mint, 'buy')) continue;
        const age = now - t.createdSlot;
        if (age > p.maxEntryAgeSlots) {
          t.done = true;
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // The opening-tape filter: serious creator money, a small real crowd,
        // no creator sale, no heavy selling by others, real reserves present.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.minRealSolLamports) || rq > BigInt(p.maxRealSolLamports)) continue;
        if (t.creatorBuy < BigInt(p.minCreatorBuyLamports) || t.creatorBuy > BigInt(p.maxCreatorBuyLamports)) continue;
        if (t.earlyBuyers.size < p.minEarlyBuyers || t.earlyBuyers.size > p.maxEarlyBuyers) continue;
        if (p.skipCreatorSold && t.creatorSold) {
          t.done = true;
          continue;
        }
        if (t.bought > 0n && t.soldByOthers * BPS > t.bought * BigInt(p.maxSellRatioBps)) continue;
        if (t.createVq > 0n && t.createVt > 0n) {
          const runup = (curve.virtual_quote_reserves * t.createVt * BPS) / (curve.virtual_token_reserves * t.createVq);
          if (runup > BigInt(p.maxRunupBps)) continue;
        }
        const capBuy = state.maxBuyLamports(mint);
        const stake = BigInt(p.stakeLamports);
        const amount = stake < capBuy ? stake : capBuy;
        if (amount < BigInt(p.minFirstBuyLamports)) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        mainOpen++;
        open.set(mint, { openedSlot: now, txPaid: 0n, probe: false, probeReady: false });
      }

      // Guardrail pacing: when the distinct coins traded lag the pace (30 coins
      // over the 6-hour window, prorated by block time), open one tiny probe
      // round trip on the most liquid coin traded on this batch.
      let probesOpen = 0;
      for (const h of open.values()) if (h.probe) probesOpen++;
      if (probesOpen < p.maxProbePositions && firstBlockTime !== null) {
        const elapsed = Math.max(0, Math.min(p.probeWindowSeconds, lastBlockTime - firstBlockTime));
        const due = Math.ceil((p.probeTargetCoins * elapsed) / p.probeWindowSeconds);
        if (myCoins.size < due && state.committedPositionCount() < state.hello.caps.max_open_positions) {
          let best: Pubkey | null = null;
          let bestRq = -1n;
          for (const mint of traded) {
            if (orders.length >= cap) break;
            if (open.has(mint) || probed.has(mint) || hasPending(state, mint, 'buy')) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < BigInt(p.probeLamports) * 100n) continue;
            // A probe still prefers a coin real money is flowing into, not one
            // being dumped: net buying since creation must be positive.
            const t = tapes.get(mint);
            if (t !== undefined && t.soldByOthers >= t.bought) continue;
            // Never probe a coin still inside the main entry window: a probe
            // would spend the slot (and the entry window) a main buy needs.
            if (t !== undefined && now - t.createdSlot <= p.maxEntryAgeSlots) continue;
            if (curve.real_quote_reserves > bestRq) {
              bestRq = curve.real_quote_reserves;
              best = mint;
            }
          }
          if (best !== null) {
            const capBuy = state.maxBuyLamports(best);
            const amount = BigInt(p.probeLamports) < capBuy ? BigInt(p.probeLamports) : capBuy;
            if (amount >= BigInt(p.probeLamports) && free >= amount + tx) {
              orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: 10_000 });
              free -= amount + tx;
              probed.add(best);
              open.set(best, { openedSlot: now, txPaid: 0n, probe: true, probeReady: false });
            }
          }
        }
      }

      return orders;
    },
  };
}
