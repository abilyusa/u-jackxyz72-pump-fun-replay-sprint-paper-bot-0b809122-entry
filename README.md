# Pump.fun Replay Sprint — Strict Launch-Snipe Bot

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/abilyusa/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/abilyusa/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the `pumpfun-replay/v2` harness. It replays Pump.fun
bonding-curve data and trades it with a fixed rule set — no model, no network,
no randomness beyond the harness seed.

## Strategy (in plain words)

Buy only the cleanest fresh launches, once, and exit fast. A coin is buyable
only within 3 slots of its create, while its real SOL is 0.3–30, the creator's
own buys total at most 2.5 SOL, zero distinct non-creator buyers have appeared,
and the creator has not sold. Stake 0.01 SOL per coin in a single order (no
top-ups — a partial fill is accepted as-is, never chased). Sell everything at
+10% take-profit, −8% stop-loss, after 6 slots held, if still below entry
after 3 slots, or the moment the creator sells. Max 5 open positions, never
re-enter an exited coin.

Why this shape: on the 24h dev window (1,222 coins) the median coin dumps
~−16% from launch, so loose rules bleed. A 16-variant sweep through the real
harness found this config least-negative at −0.0199 SOL over 33 coins (win
rate 6.1%, guardrails met): looser entry trades 120 coins but loses −0.055,
and a tighter creator cap loses less (−0.011) but trades only 17 coins and
fails the 20-coin guardrail. No rule tested is profitable on dev — this entry
wins only if the final window runs hotter than the dev one.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts`; the bot reads the hello/batch stream on
stdin and writes one JSON reply per batch on stdout.
