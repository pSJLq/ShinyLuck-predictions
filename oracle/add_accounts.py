#!/usr/bin/env python3
"""
Register X bot accounts into twscrape's local pool (oracle/accounts.db).

Reads oracle/accounts.secret.txt (gitignored) — one account per line. Two
supported line formats, each with an OPTIONAL trailing proxy:

  COOKIE FORMAT (preferred — no password handling, no login step here):
      username | auth_token=<...>; ct0=<...>
      username | auth_token=<...>; ct0=<...> | http://user:pass@host:port

  CREDENTIAL FORMAT (you run the login yourself; twscrape mints cookies):
      username:password:email:email_password[:mfa_base32_secret]
      ...same... | http://user:pass@host:port

PROXY: give bot accounts a proxy that is SEPARATE from where your main X
account browses — X links accounts by IP/fingerprint, so a flagged bot on your
main IP can drag the main account down. Residential/mobile proxies survive; most
datacenter proxies (incl. many v2rayN nodes and VPS IPs) get flagged fast. If no
per-line proxy is given, the TWS_PROXY env applies to all accounts.

Run:
    python add_accounts.py            # add accounts from the file
    python add_accounts.py --login    # ALSO log in credential-format accounts
                                       # (authenticates to X — run this only
                                       #  yourself; it needs 2FA/email access)

The cookie-format path never authenticates and needs no password. Cookies and
the secret file stay on this machine and are gitignored.
"""

import os
import sys
import asyncio

HERE = os.path.dirname(__file__)
SECRET = os.path.join(HERE, "accounts.secret.txt")
DB = os.path.join(HERE, "accounts.db")


async def main():
    do_login = "--login" in sys.argv
    if not os.path.exists(SECRET):
        print(f"missing {SECRET}\n"
              f"create it with one account per line (see this script's docstring).")
        return

    from twscrape import API
    api = API(DB)

    default_proxy = os.environ.get("TWS_PROXY") or None

    def split_proxy(s):
        """Peel an optional trailing '| http://...proxy' off any line."""
        if "|" in s:
            head, tail = s.rsplit("|", 1)
            if "://" in tail:
                return head.strip(), tail.strip()
        return s, default_proxy

    added_cred = 0
    for raw in open(SECRET, encoding="utf-8"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        # cookie format: "username | auth_token=...; ct0=..."  (proxy already peeled)
        core, proxy = split_proxy(line)
        if "|" in core and ("auth_token" in core or "ct0" in core):
            user, cookies = [p.strip() for p in core.split("|", 1)]
            await api.pool.add_account(user, "", "", "", cookies=cookies, proxy=proxy)
            print(f"added (cookies): {user}" + (f" via proxy" if proxy else ""))
            continue

        # credential format: username:password:email:email_password[:mfa]
        parts = core.split(":")
        if len(parts) < 4:
            print(f"skip (unrecognized line): {parts[0] if parts else '?'}")
            continue
        user, pwd, email, email_pwd = parts[0], parts[1], parts[2], parts[3]
        mfa = parts[4] if len(parts) > 4 else None
        await api.pool.add_account(user, pwd, email, email_pwd, mfa_code=mfa, proxy=proxy)
        added_cred += 1
        print(f"added (credentials): {user}" + (f" via proxy" if proxy else ""))

    if do_login and added_cred:
        print("logging in credential-format accounts (this authenticates to X)…")
        await api.pool.login_all()

    print("\npool status:")
    await api.pool.accounts_info()


if __name__ == "__main__":
    asyncio.run(main())
