<img width="1189" height="566" alt="image" src="https://github.com/user-attachments/assets/1135b683-c7c3-4357-9a68-357c82ad2dc5" /># ShinyLuck Predictions — how a market actually resolves

Prediction markets on **X (Twitter) events**, settled in real STT on **Somnia**,
resolved by **Somnia's on-chain agents**. Live at
**https://shinyluck.win/predictions**.

This document exists for one reason: to let you verify that the numbers behind
every settlement are **really measured from X**, not typed in by the operator.
Everything below is checkable by a stranger with a browser.

---

## 1. The path a number takes

```
     X (twitter.com)
          │  ① measured
          ▼
   x-oracle  (oracle/xoracle.py)          ← open source, in this repo
          │  ② published as a permanent public JSON
          ▼
   raw.githubusercontent.com/pSJLq/ShinyLuck-predictions/main/x-oracle/<id>.json
          │  ③ fetched by Somnia's JSON-API agent
          ▼
   Somnia agent platform  →  validator subcommittee votes
          │  ④ M-of-N consensus, receipts published
          ▼
   XOracleResolver.sol  →  PredictionMarket.sol   (payouts)
```

Every arrow leaves evidence you can inspect:

| Step | What you can check | Where |
|---|---|---|
| ① | the measurement code, line by line | [`oracle/xoracle.py`](oracle/xoracle.py) |
| ② | the published number **and its full history** | git commit log of `x-oracle/` in this repo |
| ③ | the exact URL + selector the agent fetched | agent receipt (see §3) |
| ④ | each validator's independent response | same receipt |
| — | the settlement itself | [Somnia explorer](https://shannon-explorer.somnia.network) |

**Why the git history matters:** the oracle publishes by committing to this
public repo. Commits are timestamped and immutable, so every measurement we
have ever made is on permanent public record. If we ever published a number
that disagreed with X, it would stay there forever as proof.

---

## 2. Where the data comes from (two channels)

**Public channel — no login, anyone can replay it.**
Tweet metrics (likes, reposts) come from X's public syndication endpoint. Try
it yourself right now:

```
https://cdn.syndication.twimg.com/tweet-result?id=1519480761749016577&token=a
```

For these markets the resolver fires **two independent votes**: one reads our
published JSON, the other reads that public endpoint **directly**. They must
land in the same outcome bucket or the market does not resolve. Our oracle
cannot move the outcome alone.

**Authenticated channel — profile & search data.**
Follower counts, posts-per-day, "did they write word X", "did they reply under
that post" are all behind X's login wall; no public endpoint serves them. Those
markets are resolved from our measurement alone and are **explicitly labeled
`SINGLE SOURCE` in the UI** — we do not pretend otherwise. What keeps them
honest: the method is open source, the number is permanently published, and
anyone can re-check it on X. A false number would be publicly provable.

---

## 3. Read a receipt (60 seconds)

Open any settled market on the site → the **Resolution** panel → click
**Receipt ↗** on any source card. The Somnia agent explorer shows:

* which agent ran (JSON API / LLM Parse / LLM Inference),
* the **exact URL and selector** it was given,
* the raw HTTP fetch and the extracted value,
* **each validator's own response**, and whether they agreed.

Example from a live settlement — market "which legendary tweet has the most
likes": four requests, `7193136`–`7193139`. Vote 0 read our published winner
index; votes 1-3 read the three tweets straight from X's syndication endpoint;
the chain then recomputed the argmax itself and required it to match.

```
https://agents.testnet.somnia.network/receipts/7193136
```

---

## 4. The operator cannot forge a result

This was hardened deliberately, and it is visible in the contract source:

* `XOracleResolver`: the agent platform, the market and the agent IDs are
  **`immutable` / `constant`** — set once at deploy, never changeable. The
  owner cannot swap in a puppet "platform" and fake a consensus.
* `PredictionMarket.setResolver` is **one-shot** — resolution authority is
  fixed the moment it is wired.
* The owner's only override on a live market is a **void**, which refunds
  everyone. There is no function that lets anyone name a winner directly.
* If agents disagree, the round retries (bounded); past the deadline
  **anyone** can call `voidExpired` and every bettor reclaims their full stake.

What still requires trust, stated plainly: the curator picks the sources when
creating a market (they are visible on-chain **before** you bet), and for
login-gated data our oracle is the single reader.

---

## 5. The inversion test — proof it reads reality

A pipeline that always answered "NO" would have looked fine for a whole night.
So we ran nine markets engineered so that **every true answer was the opposite
of the previous run**, and let the same automated pipeline settle them.

**Result: 9 / 9 correct, 0 wrong.**

| Format | previous run | inverted run |
|---|---|---|
| Reply under a given post | NO | **YES** |
| Wrote a given word | NO | **YES** |
| Follower threshold | NO | **YES** |
| Posted every day (streak) | YES | **NO** |
| Freeform LLM question | YES | **NO** |
| Race (contenders reordered) | index 0 | **index 2** |
| Viral like threshold | (voided) | **YES** |
| Tweet deleted / unavailable | Still up | **Deleted** |
| Posts-per-day bucket | 10-19 | **0-2** |

The race line is the sharpest one: the same three tweets, listed in a different
order. A hardcoded or lazy resolver returns index 0. The on-chain argmax
followed the data and returned index 2.

Reproduce it: [`scripts/_inverted-check.js`](scripts/_inverted-check.js).

---

## 6. Market formats

Objective (numeric → bucket, or argmax):
viral like/repost thresholds · follower thresholds · posts-per-day buckets ·
"wrote word X" · "replied under post Y" · "how many of these N accounts posted
about Z" · posting streaks · tweet deletion · **races** ("whose post wins").

Semantic: `FREEFORM_LLM` — three independent LLM votes, 2-of-3 required.
Note honestly: the LLM agent has **no internet access**; it answers from model
knowledge. It suits checkable facts, not live X events — for those it returns
UNRESOLVED and the market voids into refunds.

Races always carry a mandatory fallback outcome ("nobody / tie") so a tie or a
below-threshold race settles instead of voiding.

---

## 7. InfoFi — the same pipeline, pointed at the ecosystem

**Live: https://shinyluck.win/infofi** · code: [`infofi/collect.py`](infofi/collect.py)

The measurement layer that settles markets also produces a daily **mindshare
snapshot of the Somnia bubble on X** — a Kaito-style treemap plus two
leaderboards. It answers a question the ecosystem cannot currently answer:
*who is actually generating attention, and how much?*

Two boards, scored on deliberately different surfaces:

* **Ecosystem projects** (`infofi/projects.txt`) — measured on **all** their own
  posts in the window.
* **Community voices** (`infofi/voices.txt`) — measured **only** on
  ecosystem-tagged activity: posts/quotes mentioning a tag from
  `infofi/tags.txt`, replies under those accounts' posts. A voice's replies
  elsewhere on X do not count. Their own tagged comments count at half weight
  (contribution, not authorship).

```
engagement = likes + 2×(reposts+quotes) + 1.5×replies_received + 2×bookmarks
share      = engagement / total engagement of the board
```

It usually looks like this, I'm just redoing it a little differently now.
<img width="1189" height="566" alt="image" src="https://github.com/user-attachments/assets/df1c4f3f-1c82-4a22-b578-4aa9f988954e" />


Two decisions worth calling out, because both were bugs we found and fixed:

* Voices are discovered by **@-tag context**, not by the word "somnia" — the
  word alone pulled in unrelated accounts (other "Somnia"s, other languages).
* Curated voices are read **straight from their timelines**, not from X search.
  X search silently omits tweets from small accounts, which would have
  under-counted exactly the contributors this board exists to surface.

The snapshot is a plain JSON refreshed daily by cron; a handle listed in both
files is counted once (projects win). It is **not** on-chain — see the note in
§9.

## 8. Economics

Parimutuel pools. Fees are taken **from the losing pool only**, so a winning
bettor can never receive less than their stake:

* platform **2.5%**, market creator **1%** (both snapshotted at creation),
* the house takes **no directional risk** — payouts always come from the
  market's own pools,
* creating a market costs a fee (funds the agent deposits) plus an anti-spam
  bond that is returned on resolve **or** on void.

---

## 9. What is on-chain, and what is not

On-chain (Somnia): every market, every bet, the resolver's votes and the
settlement, plus the per-vote agent receipt ids. That is the money path, and it
is fully verifiable.

Off-chain: the **measurements themselves** live as JSON — published to this
public repo, so every value we have ever produced is in an immutable,
timestamped git history. The same holds for the InfoFi snapshot.

Why not push the raw data on-chain: it would cost gas for every number while
adding nothing a reader cannot already check — the JSON is public and the git
history is append-only. The upgrade that *would* add real value is cheap and is
on the roadmap: **anchor a hash of each daily snapshot on-chain**, so anyone can
prove a published file was never edited after the fact, while the payload stays
off-chain. Storing full history on-chain is the expensive way to buy the same
guarantee.

## 10. Run it yourself

```bash
npm install
npx hardhat test          # 49 tests: pool math, fees, consensus, races, security
npx hardhat node          # local chain
npx hardhat run scripts/deploy.js --network localhost
node scripts/dev-frontend.js        # UI on :5178

# the X measurement layer (needs its own bot-account cookies, see oracle/README.md)
oracle/.venv/bin/python oracle/xoracle.py --once
```

Live deployment (Somnia testnet, chainId 50312):

| Contract | Address |
|---|---|
| PredictionMarket | `0x8AA8E7D6D89b4D6a9C9a43C0f4Fa5a547a7974E5` |
| XOracleResolver | `0x4bfdCA75c535c6feE61A27209bbDFe215792de09` |
| Somnia agent platform | `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776` |

Agent IDs (identical on testnet and mainnet): JSON API `13174292974160097713`,
LLM Inference `12847293847561029384`, LLM Parse Website `12875401142070969085`.

No private keys, tokens or bot-account cookies are in this repository — see
`.gitignore`.
