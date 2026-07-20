# x-oracle — default proposer for ShinyLuck Predictions

One of several independent votes the on-chain resolver consults. It reads open
markets from the chain, measures the X metric, and publishes a small public
JSON. It never resolves a market by itself — a second independent vote keeps it
honest, and terminal disagreement voids the market (full refunds).

## Setup

```bash
cd oracle
python -m venv .venv && . .venv/Scripts/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # edit RPC / publish target
```

### Bot accounts (for exact metrics via twscrape)

twscrape talks to X's internal GraphQL as a logged-in user. Add 1–3 bot
accounts (yours) once — cookies stay in `oracle/accounts.db`, gitignored, and
never touch the chain:

```bash
# cookie method (most stable): grab auth_token + ct0 from a logged-in browser
twscrape add_accounts /dev/stdin username:password:email:email_password <<< ""   # or:
python -c "import asyncio; from twscrape import API; api=API('accounts.db'); \
  asyncio.run(api.pool.add_account('BOTUSER','','', '', cookies='auth_token=...; ct0=...'))"
twscrape accounts     # verify
```

Public tweet metrics (likes/RT) work with **no accounts** via X's syndication
endpoint — only profile-level metrics (followers, posts-on-a-day) need accounts.

Verify an account authenticates before relying on it:

```bash
python check_account.py            # looks up @jack via the pool
```

**Two gotchas learned the hard way:**
- twscrape needs the **curl backend** (`TWS_HTTP_BACKEND=curl`, installed via
  `twscrape[curl]`). The default httpx backend uses a 5s connect timeout that
  fails reaching x.com from many hosts. The scripts here default it on.
- X frequently **401s an `auth_token` replayed from a different IP/fingerprint**
  than where it was minted. Cookies grabbed in your browser may authenticate on
  **your machine** but get rejected from a datacenter IP (this includes most
  VPS hosts). If `check_account.py` says FAILED with a 401, run it from the
  machine/network where you logged in, or use a residential proxy for the
  oracle. Cheap bot accounts also often arrive already rate-limited/flagged.

## Run

```bash
python xoracle.py         # polls the chain, publishes <marketId>.json
```

## How a market tells the oracle what to measure

The market's on-chain `criteria` string ends with a compact directive the oracle
parses (the human question stays readable):

| Directive | Meaning |
|---|---|
| `... \| x:tweet=1948123456789;metric=likes` | likes of a specific tweet |
| `... \| x:user=elonmusk;metric=followers` | follower count of a profile |
| `... \| x:user=naval;metric=posts;date=2026-07-16` | posts authored on a UTC date |

The resolver's JSON-API agent vote reads `.value` from the published JSON; its
`primaryUrl` is `<oracleBaseUrl><marketId>.json` (relative → the migratable base
set by `setOracleBaseUrl`). The freeform LLM template needs no directive — those
markets resolve purely through the LLM votes.

## Hosting the JSON so Somnia validators can read it

`XORACLE_PUBLISH=local` writes `out/<id>.json` — serve that directory statically.
Interim (before the VPS): `XORACLE_PUBLISH=github` commits to a small PUBLIC repo,
raw base `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/`. Point the
resolver at it once with `setOracleBaseUrl(base)`; migrating to
`https://shinyluck.win/x-oracle/` later is a single tx.
