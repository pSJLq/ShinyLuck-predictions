#!/usr/bin/env python3
"""Quick health check for the accounts in oracle/accounts.db.

Confirms each account's cookies actually authenticate against X by doing one
real lookup. Run this right after add_accounts.py (and ideally from the same
machine/network where the cookies were minted — X often 401s an auth_token
replayed from a different IP/fingerprint).

    python check_account.py [screen_name]     # default: jack
"""
import os
import sys
import asyncio

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:
    pass

# twscrape's default httpx backend uses a 5s connect timeout + HTTP/1.1 that
# times out reaching x.com from some environments; the curl_cffi backend
# (browser-TLS impersonation) is far more reliable. Force it.
os.environ.setdefault("TWS_HTTP_BACKEND", "curl")


async def main():
    from twscrape import API
    target = sys.argv[1] if len(sys.argv) > 1 else "jack"
    proxy = os.environ.get("TWS_PROXY") or None
    api = API(os.path.join(os.path.dirname(__file__), "accounts.db"), proxy=proxy)
    if proxy:
        print(f"using proxy: {proxy.split('@')[-1]}")

    # A prior 401 (e.g. tested from a datacenter IP) flips accounts to
    # active=False, after which twscrape skips them entirely ("No active
    # accounts"). Re-activate before testing so the lookup actually runs from
    # THIS machine's IP and we get a real signal.
    infos = await api.pool.accounts_info()
    for i in infos:
        try:
            await api.pool.set_active(i["username"], True)
        except Exception:
            pass
    infos = await api.pool.accounts_info()
    print(f"pool: {len(infos)} account(s)")
    for i in infos:
        print(f"  @{i['username']} active={i['active']} last_used={i.get('last_used')}")

    print(f"\nlive lookup @{target} ...")
    u = await api.user_by_login(target)
    if u is None:
        print("RESULT: FAILED — no data. Cookies rejected (401), rate-limited, "
              "or the IP is flagged. See the WARNING lines above for the exact reason.")
        return
    print(f"RESULT: OK — @{u.username} followers={u.followersCount}. Cookies are live.")


if __name__ == "__main__":
    asyncio.run(main())
