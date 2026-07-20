#!/usr/bin/env python3
"""
Somnia InfoFi collector - a daily X-mindshare snapshot of the Somnia bubble
(Kaito-style, before Kaito went full token-arena).

For every tracked account it measures the last 24h on X:
  posts, likes, retweets, quotes, replies, bookmarks, views, followers
then computes an engagement score and each account's SHARE of the whole
bubble's engagement (the "mindshare pie").

Two account sources:
  1. infofi/projects.txt - curated ecosystem accounts, measured on ALL their
                           own posts in the window
  2. --discover          - the "voices" board, scoped by CONTEXT TAGS
                           (infofi/tags.txt): a voice earns credit only from
                           X activity that mentions an ecosystem handle -
                             posts with a tag        (full engagement weight)
                             replies with a tag      (half weight - comments
                                                      are contribution too,
                                                      but not authorship)
                           This kills the word-"somnia" noise (other somnias,
                           unrelated languages) and ignores voices' replies
                           under non-ecosystem posts. NOTE: "mentioned by
                           others" scoring was tried and removed - X copies
                           every thread participant into each reply's
                           mentions, so the counter measured thread length,
                           not recognition.

Output:
  web/infofi-data.json    - latest snapshot (the treemap page reads this)
  infofi/history.json     - per-handle daily history (share sparklines/deltas)

Run daily (Task Scheduler / cron / keeper host):
  oracle/.venv/Scripts/python.exe infofi/collect.py --discover

Reuses the x-oracle bot pool (oracle/accounts.db) and its gotchas: curl
backend, no logouts, optional TWS_PROXY.
"""

import os
import sys
import json
import asyncio
import datetime as dt

os.environ.setdefault("TWS_HTTP_BACKEND", "curl")

BASE = os.path.dirname(__file__)
ROOT = os.path.dirname(BASE)
ACCOUNTS_DB = os.path.join(ROOT, "oracle", "accounts.db")
PROJECTS_TXT = os.path.join(BASE, "projects.txt")
VOICES_TXT = os.path.join(BASE, "voices.txt")
TAGS_TXT = os.path.join(BASE, "tags.txt")
HISTORY_JSON = os.path.join(BASE, "history.json")
OUT_JSON = os.path.join(ROOT, "web", "infofi-data.json")

WINDOW_H = 168  # a week by default; override: --hours N
DISCOVER_LIMIT = 400       # tagged tweets scanned in search
DISCOVER_TOP = 12          # voices kept
MIN_DISCOVER_SCORE = 15    # ignore zero-traction voices (small ecosystem: keep the floor low)
COMMENT_WEIGHT = 0.5       # tagged replies count at half weight

# Transparent scoring formula (shown on the page): reposts and quotes spread
# the message, bookmarks signal depth, likes are the base pulse.
def score_of(m):
    return (m["likes"]
            + 2.0 * (m["retweets"] + m["quotes"])
            + 1.5 * m["replies"]
            + 2.0 * m["bookmarks"])


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def in_window(ts, start):
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=dt.timezone.utc)
    return ts >= start


def read_handles(path):
    handles = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip().lstrip("@")
                if line and not line.startswith("#"):
                    handles.append(line)
    return handles


async def measure_user(api, handle, start):
    """24h engagement of one account's own posts."""
    try:
        u = await api.user_by_login(handle)
    except Exception as e:
        print(f"  @{handle}: lookup failed ({e})")
        return None
    if u is None:
        print(f"  @{handle}: not found")
        return None
    m = {"handle": u.username, "name": u.displayname, "followers": u.followersCount,
         "posts": 0, "likes": 0, "retweets": 0, "quotes": 0, "replies": 0,
         "bookmarks": 0, "views": 0}
    seen = set()
    try:
        # NOTE: no early break - the timeline opens with the PINNED tweet,
        # which is usually old and would end the scan before it starts.
        # The pinned tweet also appears TWICE (top + chronological slot) and
        # timelines can include other authors' tweets in conversation
        # modules - hence the id-dedupe and the author check.
        async for tw in api.user_tweets(u.id, limit=200):
            if tw.id in seen:
                continue
            seen.add(tw.id)
            if tw.user is None or tw.user.id != u.id:
                continue
            ts = tw.date
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=dt.timezone.utc)
            if ts < start:
                continue
            if tw.retweetedTweet is not None:
                continue  # count own posts, not reposts of others
            m["posts"] += 1
            m["likes"] += tw.likeCount or 0
            m["retweets"] += tw.retweetCount or 0
            m["quotes"] += tw.quoteCount or 0
            m["replies"] += tw.replyCount or 0
            m["bookmarks"] += getattr(tw, "bookmarkedCount", 0) or 0
            m["views"] += tw.viewCount or 0
    except Exception as e:
        print(f"  @{handle}: timeline failed ({e})")
    return m


def _is_tagged(tw, tags_l):
    """Ecosystem-tagged activity: an explicit @tag mention, a reply under a
    tag account's post, or a quote of a tag account's post."""
    mentioned = {(getattr(mu, "username", "") or "").lower()
                 for mu in (getattr(tw, "mentionedUsers", None) or [])}
    if mentioned & tags_l:
        return True
    iru = getattr(tw, "inReplyToUser", None)
    if iru is not None and (getattr(iru, "username", "") or "").lower() in tags_l:
        return True
    qt = getattr(tw, "quotedTweet", None)
    if qt is not None and qt.user and qt.user.username.lower() in tags_l:
        return True
    text = (tw.rawContent or "").lower()
    return any(("@" + t) in text for t in tags_l)


async def measure_voice(api, handle, start, tags_l):
    """Direct timeline measurement of a curated voice (infofi/voices.txt).
    X search silently skips many small-account tweets, so listed voices are
    read straight from their own timeline - nothing gets missed and no score
    floor applies. Only ecosystem-tagged activity counts."""
    try:
        u = await api.user_by_login(handle)
    except Exception as e:
        print(f"  voice @{handle}: lookup failed ({e})")
        return None
    if u is None:
        print(f"  voice @{handle}: not found")
        return None
    b = {"handle": u.username, "name": u.displayname, "followers": u.followersCount,
         "posts": 0, "comments": 0,
         "likes": 0, "retweets": 0, "quotes": 0, "replies": 0,
         "bookmarks": 0, "views": 0, "p_score": 0.0, "c_score": 0.0}
    seen = set()
    try:
        # pinned-first timeline: filter by window, never break early.
        # CRITICAL: the Tweets-and-Replies timeline delivers whole
        # conversation modules - the PARENT tweets by OTHER authors ride
        # along and must never count toward this voice; tweets also repeat
        # across modules/pages, hence the id-dedupe.
        async for tw in api.user_tweets_and_replies(u.id, limit=300):
            if tw.id in seen:
                continue
            seen.add(tw.id)
            if tw.user is None or tw.user.id != u.id:
                continue
            ts = tw.date
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=dt.timezone.utc)
            if ts < start:
                continue
            if tw.retweetedTweet is not None:
                continue
            if not _is_tagged(tw, tags_l):
                continue
            m = {"likes": tw.likeCount or 0, "retweets": tw.retweetCount or 0,
                 "quotes": tw.quoteCount or 0, "replies": tw.replyCount or 0,
                 "bookmarks": getattr(tw, "bookmarkedCount", 0) or 0}
            is_reply = bool(getattr(tw, "inReplyToTweetIdStr", None)
                            or getattr(tw, "inReplyToTweetId", None)
                            or getattr(tw, "inReplyToUser", None))
            if is_reply:
                b["comments"] += 1
                b["c_score"] += score_of(m)
            else:
                b["posts"] += 1
                b["p_score"] += score_of(m)
            for k in ("likes", "retweets", "quotes", "replies", "bookmarks"):
                b[k] += m[k]
            b["views"] += tw.viewCount or 0
    except Exception as e:
        print(f"  voice @{handle}: timeline failed ({e})")
    return b


async def discover(api, start, known, tags, curated_voices=None):
    """The voices board, scoped by ecosystem tags (see module doc):
    tagged posts (full weight) + tagged replies (half weight) + being
    mentioned by others inside tagged posts (flat points)."""
    tags_l = {t.lower() for t in tags}
    cv = curated_voices or {}
    buckets = {}

    def bucket(handle, name="", followers=0):
        b = buckets.get(handle.lower())
        if b is None:
            b = {"handle": handle, "name": name, "followers": followers,
                 "posts": 0, "comments": 0,
                 "likes": 0, "retweets": 0, "quotes": 0, "replies": 0,
                 "bookmarks": 0, "views": 0, "p_score": 0.0, "c_score": 0.0}
            buckets[handle.lower()] = b
        if name and not b["name"]:
            b["name"] = name
        if followers and not b["followers"]:
            b["followers"] = followers
        return b

    # GraphQL search silently returns nothing for a long parenthesized OR of
    # mentions, and also for queries WITHOUT a since: operator - so we run one
    # "@tag since:date" search per tag and merge, de-duplicating by tweet id
    # (a tweet mentioning two tags must count once).
    seen = set()
    per_tag = max(50, DISCOVER_LIMIT // max(1, len(tags)))
    for tag in tags:
        q = f"@{tag} since:{start:%Y-%m-%d}"
        try:
            async for tw in api.search(q, limit=per_tag, kv={"product": "Latest"}):
                if tw.id in seen:
                    continue
                seen.add(tw.id)
                ts = tw.date
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=dt.timezone.utc)
                if ts < start:
                    continue
                if tw.retweetedTweet is not None:
                    continue  # plain reposts: engagement belongs to the original
                author = tw.user.username
                al = author.lower()
                m = {"likes": tw.likeCount or 0, "retweets": tw.retweetCount or 0,
                     "quotes": tw.quoteCount or 0, "replies": tw.replyCount or 0,
                     "bookmarks": getattr(tw, "bookmarkedCount", 0) or 0}

                if al not in known and al not in tags_l and al not in cv:
                    b = bucket(author, tw.user.displayname, tw.user.followersCount)
                    is_reply = bool(getattr(tw, "inReplyToTweetIdStr", None)
                                    or getattr(tw, "inReplyToTweetId", None)
                                    or getattr(tw, "inReplyToUser", None))
                    if is_reply:
                        b["comments"] += 1
                        b["c_score"] += score_of(m)
                    else:
                        b["posts"] += 1
                        b["p_score"] += score_of(m)
                    for k in ("likes", "retweets", "quotes", "replies", "bookmarks"):
                        b[k] += m[k]
                    b["views"] += tw.viewCount or 0
        except Exception as e:
            print(f"  discover @{tag} failed ({e})")

    for b in buckets.values():
        b["score"] = round(b["p_score"] + COMMENT_WEIGHT * b["c_score"], 1)
    ranked = sorted(buckets.values(), key=lambda b: b["score"], reverse=True)
    top = [b for b in ranked if b["score"] >= MIN_DISCOVER_SCORE][:DISCOVER_TOP]
    for b in top:
        if not b["followers"]:
            try:
                u = await api.user_by_login(b["handle"])
                if u:
                    b["followers"] = u.followersCount
                    b["name"] = b["name"] or u.displayname
            except Exception:
                pass
        del b["p_score"]
        del b["c_score"]
    return top


async def main():
    from twscrape import API
    api = API(ACCOUNTS_DB, proxy=os.environ.get("TWS_PROXY") or None)
    hours = WINDOW_H
    if "--hours" in sys.argv:
        hours = int(sys.argv[sys.argv.index("--hours") + 1])
    start = utcnow() - dt.timedelta(hours=hours)
    today = f"{utcnow():%Y-%m-%d}"

    curated = read_handles(PROJECTS_TXT)
    tags = read_handles(TAGS_TXT)
    print(f"[infofi] window {hours}h, curated: {curated}")
    print(f"[infofi] context tags: {tags}")

    rows = []
    for h in curated:
        m = await measure_user(api, h, start)
        if m:
            m["kind"] = "project"
            m["comments"] = 0
            rows.append(m)
            print(f"  @{m['handle']}: {m['posts']} posts, {m['likes']} likes, {m['followers']} followers")

    tags_l = {t.lower() for t in tags}
    curated_voices = {}
    # a handle listed in BOTH files would be counted twice (once on all its
    # posts as a project, once on its tagged activity as a voice) - projects.txt
    # wins, so moving an account between boards is a one-line edit there.
    project_l = {h.lower() for h in curated}
    voice_handles = [h for h in read_handles(VOICES_TXT) if h.lower() not in project_l]
    if voice_handles:
        print("[infofi] measuring curated voices (direct timelines, no floor)...")
        for h in voice_handles:
            b = await measure_voice(api, h, start, tags_l)
            if b:
                curated_voices[b["handle"].lower()] = b

    if "--discover" in sys.argv:
        print("[infofi] discovering new voices (tag-scoped search)...")
        known = {h.lower() for h in curated}
        for b in await discover(api, start, known, tags, curated_voices):
            b["kind"] = "voice"
            rows.append(b)
            print(f"  found @{b['handle']}: {b['posts']} tagged posts, {b['comments']} tagged replies, "
                  f"score {b['score']:.0f}")

    # curated voices measured on their own timelines; the search pass only
    # discovers NEW people (it never counts curated voices' authorship)
    for b in curated_voices.values():
        b["kind"] = "voice"
        b["score"] = round(b["p_score"] + COMMENT_WEIGHT * b["c_score"], 1)
        del b["p_score"]
        del b["c_score"]
        rows.append(b)
        print(f"  voice @{b['handle']}: {b['posts']} tagged posts, {b['comments']} tagged replies, "
              f"score {b['score']:.0f}")

    for r in rows:
        if "score" not in r:
            r["score"] = round(score_of(r), 1)
    total = sum(r["score"] for r in rows) or 1.0
    for r in rows:
        r["share"] = round(100.0 * r["score"] / total, 2)
    rows.sort(key=lambda r: r["score"], reverse=True)

    # history for sparklines + share deltas
    hist = {}
    if os.path.exists(HISTORY_JSON):
        with open(HISTORY_JSON, "r", encoding="utf-8") as f:
            hist = json.load(f)
    for r in rows:
        arr = hist.setdefault(r["handle"], [])
        arr = [p for p in arr if p["date"] != today]
        arr.append({"date": today, "share": r["share"], "score": r["score"]})
        hist[r["handle"]] = arr[-30:]
        r["history"] = [p["share"] for p in hist[r["handle"]]]
        r["delta"] = round(r["share"] - hist[r["handle"]][-2]["share"], 2) if len(hist[r["handle"]]) > 1 else None
    with open(HISTORY_JSON, "w", encoding="utf-8") as f:
        json.dump(hist, f)

    out = {
        "generated": utcnow().isoformat(timespec="seconds"),
        "window_hours": hours,
        "formula": "likes + 2x(reposts+quotes) + 1.5x replies + 2x bookmarks",
        "voice_rule": "voices earn only from tag-scoped activity: tagged posts (full weight) + tagged comments (x0.5)",
        "tags": tags,
        "projects": rows,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"[infofi] wrote {OUT_JSON} ({len(rows)} accounts)")


if __name__ == "__main__":
    asyncio.run(main())
