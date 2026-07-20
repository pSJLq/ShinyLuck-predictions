#!/usr/bin/env python3
"""
x-oracle — the default proposer for ShinyLuck Predictions.

It is ONE of several independent votes the on-chain resolver consults; it never
resolves a market by itself. Its only job: read each open market from the chain
and publish a small public JSON with the measured X metric, e.g.

    GET  <base>/2.json
    ->   {"market": 2, "user": "naval", "metric": "posts_2026-07-16", "value": 23,
          "source": "twscrape", "ts": 1784200000}

The resolver's JSON-API agent vote reads `.value`; a second, independent vote
(public X syndication endpoint, or an LLM page-parse of x.com) is what keeps
this service honest — if it lies, its vote simply disagrees and the round fails.

Data sources, in order of preference per market:
  1. twscrape  — authenticated GraphQL via rotating bot-account cookies (exact
                 numbers: followers_count, tweet metrics, posts-on-a-day count)
  2. syndication.twimg.com — public, no auth (tweet likes/RT for TWEET_METRIC)

Publishing:
  - local  : writes oracle/out/<id>.json (default; use for testing + the
             shinyluck.win/x-oracle static host later)
  - github : commits <id>.json to a small PUBLIC repo via the contents API so
             the Somnia validators can fetch it during the interim before the
             VPS static host exists.

NOTHING here ever touches a private key of the casino/poker deployers, and the
bot-account cookies never leave this machine (they are only used to talk to X).
"""

import os
import re
import sys
import json
import time
import base64
import asyncio
import datetime as dt

import httpx
from dotenv import load_dotenv
from web3 import Web3

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# twscrape's default httpx backend times out reaching x.com from many hosts;
# curl_cffi (browser-TLS impersonation) is reliable. Default it on.
os.environ.setdefault("TWS_HTTP_BACKEND", "curl")

RPC = os.environ.get("RPC_TESTNET", "https://api.infra.testnet.somnia.network")
POLL_S = int(os.environ.get("XORACLE_POLL_S", "60"))
PUBLISH = os.environ.get("XORACLE_PUBLISH", "local")  # local | github
OUT_DIR = os.path.join(os.path.dirname(__file__), "out")
GH_TOKEN = os.environ.get("XORACLE_GH_TOKEN", "")
GH_REPO = os.environ.get("XORACLE_GH_REPO", "")  # "owner/repo"
GH_BRANCH = os.environ.get("XORACLE_GH_BRANCH", "main")
# subdir inside the repo so oracle JSONs never clutter the repo root
# (raw base url = https://raw.githubusercontent.com/<repo>/<branch>/<dir>/)
GH_DIR = os.environ.get("XORACLE_GH_DIR", "x-oracle").strip("/")

# Template enum mirrors PredictionMarket.sol.
TWEET_METRIC, FOLLOWERS_GTE, POSTS_COUNT_DAY, FREEFORM_LLM, RACE_ARGMAX = 0, 1, 2, 3, 4

PM_ABI = json.loads("""[
 {"type":"function","name":"marketCount","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
 {"type":"function","name":"resolveData","stateMutability":"view","inputs":[{"type":"uint256"}],
  "outputs":[{"name":"state","type":"uint8"},{"name":"template","type":"uint8"},
   {"name":"closeTs","type":"uint64"},{"name":"resolveDeadline","type":"uint64"},
   {"name":"nOutcomes","type":"uint8"},{"name":"total","type":"uint256"},
   {"name":"spec","type":"tuple","components":[
      {"name":"primaryUrl","type":"string"},{"name":"primarySelector","type":"string"},
      {"name":"secondaryUrl","type":"string"},{"name":"secondarySelector","type":"string"},
      {"name":"criteria","type":"string"},{"name":"bucketBounds","type":"uint256[]"},
      {"name":"raceUrls","type":"string[]"},{"name":"raceSelectors","type":"string[]"},
      {"name":"raceThreshold","type":"uint256"}]},
   {"name":"outcomeLabels","type":"string[]"}]}
]""")


def load_manifest():
    net = os.environ.get("NETWORK", "somniaTestnet")
    path = os.path.join(os.path.dirname(__file__), "..", "deployments", f"{net}.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------
# X data sources
# --------------------------------------------------------------------------

# The market's `criteria` string carries the parameters the oracle needs, in a
# tiny machine-readable tail we embed at creation time, e.g.
#   "... | x:user=naval;metric=posts;date=2026-07-16"
#   "... | x:user=elonmusk;metric=followers"
#   "... | x:tweet=1948123456789;metric=likes"
#   "... | x:user=elonmusk;metric=mentions;q=Somnia;since=2026-07-14;until=2026-07-21"
#   "... | x:user=bob;metric=replied;post=1948123456789;since=2026-07-16"
#   "... | x:race;users=a,b,c;metric=followers;threshold=500000"
#   "... | x:race;tweets=1,2,3;metric=likes"
# This keeps the human question readable while giving the oracle exact inputs.
# Bare keys (no "=") are flags: `race` marks a multi-contender argmax market.
def parse_directive(criteria: str) -> dict:
    m = re.search(r"x:([^|]+)$", criteria.strip())
    if not m:
        return {}
    out = {}
    for part in m.group(1).split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
        else:
            out[part] = True
    return out


def _aware(ts):
    return ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)


def _parse_day(s):
    if not s:
        return None
    return dt.datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)


async def _count_word(api, u, q, since, until):
    """How many of the user's OWN tweets (posts + replies, not retweets)
    contain `q` in [since, until). Direct timeline scan - X search is lossy
    for small accounts (proven live in the infofi work), so a search-based
    count would false-NEGATIVE and settle a money market wrong.
    Word/tag boundary match so "AI" does not hit "chain"/"said"."""
    ql = q.strip().lstrip("@").lower()
    if not ql:
        return 0
    pat = re.compile(r"(?<![0-9a-z_])" + re.escape(ql) + r"(?![0-9a-z_])", re.I)
    n, seen = 0, set()
    async for tw in api.user_tweets_and_replies(u.id, limit=400):
        if tw.id in seen:
            continue
        seen.add(tw.id)
        if tw.user is None or tw.user.id != u.id or tw.retweetedTweet is not None:
            continue
        ts = _aware(tw.date)
        if since and ts < since:
            continue  # keep scanning (pinned tweet can be old); don't break
        if until and ts >= until:
            continue
        if pat.search(tw.rawContent or ""):
            n += 1
    return n


async def measure_with_twscrape(d: dict):
    """Exact metrics via authenticated GraphQL. Requires bot-account cookies
    already added to twscrape's account pool (see oracle/README.md)."""
    from twscrape import API  # imported lazily so `local` testing needs no creds

    proxy = os.environ.get("TWS_PROXY") or None
    api = API(os.path.join(os.path.dirname(__file__), "accounts.db"), proxy=proxy)
    metric = d.get("metric")

    # ---- set-level metric (no single `user`) ----
    if metric == "setcount":
        # how many accounts in `users` posted the word `q` in the window
        users = [x.strip() for x in (d.get("users") or "").split(",") if x.strip()]
        q = d.get("q")
        if not users or not q:
            return None
        since, until = _parse_day(d.get("since")), _parse_day(d.get("until"))
        hit = 0
        for uh in users:
            uu = await api.user_by_login(uh)
            if uu is None:
                continue
            if await _count_word(api, uu, q, since, until) >= 1:
                hit += 1
        return hit

    if "tweet" in d:
        if metric == "deleted":
            # deletion is confirmed by TWO independent reads (twscrape +
            # public syndication); a lone transient None must never settle
            # "deleted". 1 => gone on both, 0 => still live somewhere.
            t = await api.tweet_details(int(d["tweet"]))
            if t is not None:
                return 0
            pub = await measure_public({"tweet": d["tweet"], "metric": "likes"})
            return 1 if pub is None else 0
        t = await api.tweet_details(int(d["tweet"]))
        if t is None:
            return None
        return {
            "likes": t.likeCount, "retweets": t.retweetCount,
            "replies": t.replyCount, "views": t.viewCount or 0,
        }.get(metric)

    user = d.get("user")
    if not user:
        return None
    u = await api.user_by_login(user)
    if u is None:
        return None
    if metric == "followers":
        return u.followersCount
    if metric == "posts":
        # count tweets authored on the given UTC date
        start = _parse_day(d.get("date"))
        if not start:
            return None
        end = start + dt.timedelta(days=1)
        n, seen = 0, set()
        async for tw in api.user_tweets(u.id, limit=200):
            if tw.id in seen:
                continue
            seen.add(tw.id)
            if tw.user is None or tw.user.id != u.id or tw.retweetedTweet is not None:
                continue
            ts = _aware(tw.date)
            if start <= ts < end:
                n += 1
        return n
    if metric == "streak":
        # number of distinct UTC days in [since, until) with >=1 own post;
        # a "posted every day for N days" market buckets on N.
        since, until = _parse_day(d.get("since")), _parse_day(d.get("until"))
        if not (since and until):
            return None
        days, seen = set(), set()
        async for tw in api.user_tweets(u.id, limit=400):
            if tw.id in seen:
                continue
            seen.add(tw.id)
            if tw.user is None or tw.user.id != u.id or tw.retweetedTweet is not None:
                continue
            ts = _aware(tw.date)
            if since <= ts < until:
                days.add(ts.date())
        return len(days)
    if metric == "mentions":
        # posts/replies by the user containing a word/tag inside a window.
        # Direct timeline scan (NOT lossy X search).
        q = d.get("q")
        if not q:
            return None
        return await _count_word(api, u, q, _parse_day(d.get("since")), _parse_day(d.get("until")))
    if metric == "replied":
        # 1 if the user has a reply inside the given post's conversation
        # (optionally not older than `since`), else 0. Timeline scan - the
        # search operator conversation_id: is unreliable on scraped GraphQL.
        post = d.get("post")
        if not post:
            return None
        post, start, seen = str(post), _parse_day(d.get("since")), set()
        async for tw in api.user_tweets_and_replies(u.id, limit=400):
            if tw.id in seen:
                continue
            seen.add(tw.id)
            ts = _aware(tw.date)
            if start and ts < start:
                continue
            conv = str(getattr(tw, "conversationIdStr", "") or getattr(tw, "conversationId", "") or "")
            parent = str(getattr(tw, "inReplyToTweetIdStr", "") or getattr(tw, "inReplyToTweetId", "") or "")
            if conv == post or parent == post:
                return 1
        return 0
    return None


async def measure_public(d: dict):
    """No-auth fallback for tweet metrics via X's public syndication endpoint.
    Good enough for TWEET_METRIC; profile-level metrics need twscrape."""
    if "tweet" not in d:
        return None
    tid = d["tweet"]
    url = f"https://cdn.syndication.twimg.com/tweet-result?id={tid}&token=a"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers={"user-agent": "Mozilla/5.0"})
        if r.status_code != 200 or not r.text.strip():
            return None
        j = r.json()
    metric = d.get("metric")
    return {
        "likes": j.get("favorite_count"),
        "retweets": j.get("retweet_count") or j.get("conversation_count"),
    }.get(metric)


async def measure(d: dict):
    # try authenticated first (exact), fall back to public
    try:
        v = await measure_with_twscrape(d)
        if v is not None:
            return v, "twscrape"
    except Exception as e:
        print(f"  twscrape failed ({e}); trying public")
    v = await measure_public(d)
    if v is not None:
        return v, "syndication"
    return None, None


async def measure_race(d: dict):
    """RACE_ARGMAX: measure one value per contender and pick the winner with
    EXACTLY the resolver's on-chain semantics (they must never diverge):
    unique max >= threshold => that contender's index, otherwise the fallback
    index K (the market's mandatory last outcome, "nobody/tie").
    Returns (values, winner, sources) or None if ANY contender failed - a
    partial race must not publish a winner."""
    metric = d.get("metric")
    contenders = []
    if d.get("users"):
        contenders = [{"user": u.strip(), "metric": metric} for u in d["users"].split(",") if u.strip()]
        # per-user directives inherit window params (posts/mentions races)
        for c in contenders:
            for k in ("date", "q", "since", "until"):
                if d.get(k):
                    c[k] = d[k]
    elif d.get("tweets"):
        contenders = [{"tweet": t.strip(), "metric": metric} for t in d["tweets"].split(",") if t.strip()]
    if len(contenders) < 2:
        return None

    values, sources = [], []
    for c in contenders:
        v, src = await measure(c)
        if v is None:
            print(f"  race contender failed: {c}")
            return None
        values.append(int(v))
        sources.append(src)

    threshold = int(d.get("threshold", 0))
    best = max(values)
    winner = len(values)  # fallback: "nobody/tie"
    if best >= threshold and values.count(best) == 1:
        winner = values.index(best)
    return values, winner, sources


# --------------------------------------------------------------------------
# Publishing
# --------------------------------------------------------------------------

def publish_local(market_id: int, payload: dict):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, f"{market_id}.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f)
    print(f"  wrote {OUT_DIR}/{market_id}.json")


def publish_github(market_id: int, payload: dict):
    if not (GH_TOKEN and GH_REPO):
        raise RuntimeError("XORACLE_GH_TOKEN and XORACLE_GH_REPO required for github publish")
    path = f"{GH_DIR}/{market_id}.json" if GH_DIR else f"{market_id}.json"
    api = f"https://api.github.com/repos/{GH_REPO}/contents/{path}"
    hdr = {"authorization": f"Bearer {GH_TOKEN}", "accept": "application/vnd.github+json"}
    content = base64.b64encode(json.dumps(payload).encode()).decode()
    with httpx.Client(timeout=20) as c:
        # need the existing sha to update
        sha = None
        g = c.get(api, headers=hdr, params={"ref": GH_BRANCH})
        if g.status_code == 200:
            sha = g.json().get("sha")
        body = {"message": f"x-oracle market {market_id}", "content": content, "branch": GH_BRANCH}
        if sha:
            body["sha"] = sha
        r = c.put(api, headers=hdr, json=body)
        r.raise_for_status()
    base_dir = f"{GH_DIR}/" if GH_DIR else ""
    print(f"  published {GH_REPO}/{path} (raw base: https://raw.githubusercontent.com/{GH_REPO}/{GH_BRANCH}/{base_dir})")


def publish(market_id: int, payload: dict):
    (publish_github if PUBLISH == "github" else publish_local)(market_id, payload)


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------

# market_id -> last publish ts; caps re-measurement so a market awaiting agent
# consensus is not re-scraped every 60s (one bot account = tight rate limits).
_last_pub = {}
REPUBLISH_S = int(os.environ.get("XORACLE_REPUBLISH_S", "900"))


async def tick(w3, pm):
    count = pm.functions.marketCount().call()
    now = int(time.time())
    for mid in range(count):
        try:
            data = pm.functions.resolveData(mid).call()
        except Exception:
            continue
        state, template, close_ts = data[0], data[1], data[2]
        if state != 0:
            continue
        # Only publish once the market is closing/closed and its metric is final.
        if now < close_ts:
            continue
        # already measured recently? leave it for the agents to consume.
        if mid in _last_pub and now - _last_pub[mid] < REPUBLISH_S:
            continue
        spec = data[6]
        criteria = spec[4]
        d = parse_directive(criteria)
        if not d:
            print(f"market {mid}: no x-directive in criteria; skipping (freeform LLM handles itself)")
            continue
        if d.get("race"):
            res = await measure_race(d)
            if res is None:
                print(f"market {mid}: race incomplete {d}; leaving for retry")
                continue
            values, winner, sources = res
            # the resolver's winner-index vote reads `.winner`; `values` is
            # published alongside for transparency/receipts
            payload = {
                "market": mid,
                "directive": d,
                "values": values,
                "winner": winner,
                "source": ",".join(sorted(set(sources))),
                "ts": now,
            }
            print(f"market {mid}: race {d} -> values={values} winner={winner}")
        else:
            value, src = await measure(d)
            if value is None:
                print(f"market {mid}: could not measure {d}; leaving for retry")
                continue
            payload = {
                "market": mid,
                "directive": d,
                "value": int(value),
                "source": src,
                "ts": now,
            }
            print(f"market {mid}: {d} -> {value} ({src})")
        publish(mid, payload)
        _last_pub[mid] = now


async def main():
    man = load_manifest()
    w3 = Web3(Web3.HTTPProvider(RPC))
    pm = w3.eth.contract(address=Web3.to_checksum_address(man["addresses"]["predictionMarket"]), abi=PM_ABI)
    once = "--once" in sys.argv
    print(f"[x-oracle] rpc={RPC} market={man['addresses']['predictionMarket']} publish={PUBLISH} once={once}")
    while True:
        try:
            await tick(w3, pm)
        except Exception as e:
            print(f"[x-oracle] tick error: {e}")
        if once:
            break
        await asyncio.sleep(POLL_S)


if __name__ == "__main__":
    asyncio.run(main())
