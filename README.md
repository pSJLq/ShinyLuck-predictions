# ShinyLuck Predictions

Social prediction markets on **X (Twitter) events**, settled in real STT and
resolved by **Somnia on-chain agents**.

**Live:** https://shinyluck.win/predictions
**Start here:** [**HOW-IT-WORKS.md**](HOW-IT-WORKS.md) — how to verify that every
settlement is really measured from X (data path, agent receipts, the 9/9
inversion test, and what still requires trust).

## Why this shape

Fetching X data can never be trustless (X is a closed platform), so we don't try
to decentralize the *fetch* — we decentralize the *verification*. Where a public
second source exists (tweet metrics via X's syndication endpoint), each market is
resolved by **several independent agent votes over different sources** and only
settles when they agree. Where none exists (profile/search data behind the login
wall), the market is resolved from our published measurement and is **labeled
`SINGLE SOURCE` in the UI** — never silently.

Our own oracle is one vote. The operator cannot name a winner: the resolver's
wiring is immutable and the only owner override is a void into full refunds.

## Pieces

| Path | What |
|---|---|
| `contracts/PredictionMarket.sol` | Parimutuel STT markets: create (fee + anti-spam bond), bet, pull-payment claim, resolver-gated resolve/void, permissionless `voidExpired`. House takes no directional risk. |
| `contracts/XOracleResolver.sol` | Agent oracle: fires 2–8 votes per market by template, M-of-N consensus (races: oracle winner index vs on-chain argmax), numeric→bucket / string→label normalization, retry→void. Platform, market and agent IDs are `immutable`/`constant`. |
| `oracle/xoracle.py` | The X measurement layer (twscrape + public syndication) → publishes `x-oracle/<marketId>.json` to this repo. |
| `infofi/collect.py` | Daily Somnia X-mindshare snapshot (same pipeline) → https://shinyluck.win/infofi |
| `scripts/keeper.js` | Watches markets, fires `startResolve` after close, `voidExpired` after deadline. |
| `web/` | Standalone dev UI. The production view lives in the main site repo. |
| `x-oracle/` | **Live oracle output.** Its git history is the permanent public record of every measurement. |

## Market formats

Viral like/repost thresholds · follower thresholds · posts-per-day buckets ·
"wrote word X" · "replied under post Y" · "how many of these N accounts posted
about Z" · posting streaks · tweet deletion · **races** (argmax across
contenders, with a mandatory "nobody/tie" fallback) · freeform LLM questions
(3 votes, 2-of-3; answers from model knowledge, not live X).

## InfoFi — Somnia mindshare on X

**Live: https://shinyluck.win/infofi**

The same X measurement layer, pointed at the ecosystem instead of at a market:
a daily treemap + two leaderboards showing who actually generates attention in
the Somnia bubble.

* **Ecosystem projects** (`infofi/projects.txt`) — scored on all their own posts.
* **Community voices** (`infofi/voices.txt`) — scored **only** on
  ecosystem-tagged activity (tags in `infofi/tags.txt`): tagged posts at full
  weight, their own tagged comments at half. Replies outside the tag context are
  ignored on purpose.

```bash
oracle/.venv/bin/python infofi/collect.py --discover          # last 7 days
oracle/.venv/bin/python infofi/collect.py --discover --hours 24
```

Writes `web/infofi-data.json` (+ `infofi/history.json` for day-over-day deltas).
`--discover` also surfaces new voices via tag-scoped search. Details and the
scoring rationale: [HOW-IT-WORKS.md §7](HOW-IT-WORKS.md).

## Dev

```bash
npm install
npx hardhat test                 # 49 tests: pool math, fees, consensus, races, security
npx hardhat node                 # local chain (separate terminal)
npx hardhat run scripts/deploy.js --network localhost
node scripts/dev-frontend.js     # http://127.0.0.1:5178
```

Testnet deploy needs a **dedicated** deployer wallet — never reuse the
casino/poker deployer keys.

## Network

Somnia testnet (chainId 50312).

| | |
|---|---|
| PredictionMarket | `0x8AA8E7D6D89b4D6a9C9a43C0f4Fa5a547a7974E5` |
| XOracleResolver | `0x4bfdCA75c535c6feE61A27209bbDFe215792de09` |
| Agent platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |

Agent IDs (same on mainnet): JSON API `13174292974160097713` · LLM Inference
`12847293847561029384` · LLM Parse Website `12875401142070969085`.

No private keys, API tokens or bot-account cookies are in this repository.
