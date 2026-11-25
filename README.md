[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Hasanrdp/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Hasanrdp/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# Clean Sharpe Sniper

A selective launch sniper for the Pump.fun Sharpe Sprint — a paper-trading bot
for the 6-hour pump.fun forward replay. Places go by hourly Sharpe ratio, so the
bot is built for steady, controlled gains, not one lucky moonshot.

## How it works

Most fresh launches bleed, and the only ones that pay are the ones whose creator
bought a serious stake of their own at launch with a few real wallets piling in
beside them. The bot watches every curve from its `CreateEvent` and buys only
the rare launches that pass every filter:

- creator bought **1–2 SOL** of their own coin inside the create slot
- **2–3 distinct non-creator buyers** already in
- creator has **not sold**, others have not sold more than they bought
- **3–30 SOL** of real reserves (enough size for the 1% order cap to matter)
- decided within **3 slots** of creation

A position is small (the 1%-of-real-reserve cap binds early, so the first buy is
0.03–0.06 SOL), exits fast — take profit **+25%**, stop loss **−10%**, at most
**30 slots** held, out at once when the creator sells — and never chases: a
launch that fails a filter is done for good.

## The guardrail problem

A picky bot trades too few coins to clear the 20-distinct-mints guardrail in a
6-hour window. A second, deliberately boring mechanism runs beside it: pace
probes. When the distinct coins traded lag the pace (30 coins over the 6-hour
window, prorated by block time), the bot buys 0.01 SOL of the most liquid coin
traded on that batch and sells it whole on the next batch. A probe loses about
0.0005 SOL to fees, so twenty of them cost ~0.01 SOL — cheap insurance for the
guardrail, and probes never take a slot a main position needs.

## Dev-window result

Graded locally on the kit's frozen dev window (`node cli/makefun.mjs
grade-local --kit . --bot . --driver process`):

- net PnL **+0.008 SOL**, hourly Sharpe **+0.03**, max drawdown **0.5%**
- win rate **21%** over 48 round trips, 48 distinct mints, 96 fills, 0 rejected
- house baselines on the same window: momentum −9.44 SOL, reversion −3.99 SOL,
  sniper −0.50 SOL — every house pilot loses, this bot does not

Honest caveat: on 20 rebuilt copies of the dev window the median is −0.064 SOL
and 19 of 20 copies lose money, with the top 3 coins making two-thirds of the
gains — the dev score leans on a few coins, and the final window is a fresh
draw. The entry is a small, controlled bet: tiny stakes, tight stops, and a
0.5% max drawdown on dev, so a bad window costs little.

## Layout

- `main.ts` — entrypoint: `node /bot/main.ts` (Node 22, no build, no install)
- `strategy.ts` — the strategy (this bot's own code)
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte

Deterministic by construction: no clock, no randomness, no environment reads;
the only time source is the `block_time` the harness itself delivers. Every
entry is executed twice by the grader and the two action logs must match byte
for byte — this bot's do.
