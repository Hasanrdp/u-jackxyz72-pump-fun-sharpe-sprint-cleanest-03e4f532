// Clean Sharpe Sniper: a selective launch sniper for the pump.fun Sharpe sprint.
//
// The bot watches every new bonding curve from its CreateEvent and buys only the
// launches where the creator put serious money in (1-2 SOL of their own buy in the
// create slot) with a small crowd of real early buyers behind them. It takes profit
// fast, cuts losers fast, never holds a launch more than a few seconds, and tops the
// coin count up with tiny probe round trips so the entry always clears the
// 20-distinct-mints guardrail. Everything is deterministic: no clock, no randomness,
// no I/O beyond the harness stream; iteration follows insertion order only.
//
// Runs as `node /bot/main.ts` (Node 22 strips the types; no build, no install).
// The SDK shim is vendored beside it (vendor/makefun-bot.ts, the kit's sdk/ts file).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
