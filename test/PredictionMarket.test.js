const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));

// Spec helper - numeric templates need bounds len == nOutcomes-1.
function spec({ primaryUrl = "https://example.com/a.json", primarySelector = "v",
                secondaryUrl = "https://example.com/b.json", secondarySelector = "v",
                criteria = "criteria text", bucketBounds = [],
                raceUrls = [], raceSelectors = [], raceThreshold = 0n } = {}) {
  return { primaryUrl, primarySelector, secondaryUrl, secondarySelector, criteria,
           bucketBounds, raceUrls, raceSelectors, raceThreshold };
}

const TWEET_METRIC = 0, FOLLOWERS_GTE = 1, POSTS_COUNT_DAY = 2, FREEFORM_LLM = 3, RACE_ARGMAX = 4;

describe("PredictionMarket", () => {
  let pm, owner, resolver, alice, bob, carol;
  let closeTs, deadline;
  const CREATE_VALUE = E(0.5); // creationFee 0.2 + bond 0.3

  beforeEach(async () => {
    [owner, resolver, alice, bob, carol] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PredictionMarket")).deploy();
    await pm.setResolver(resolver.address);
    const now = await time.latest();
    closeTs = now + 3600;
    deadline = closeTs + 3600;
  });

  async function createDefault(overrides = {}) {
    const s = spec({ bucketBounds: overrides.bucketBounds ?? [99n] });
    const tx = await pm.createMarket(
      overrides.template ?? TWEET_METRIC,
      overrides.question ?? "Will the tweet hit 100 likes?",
      overrides.outcomes ?? ["NO", "YES"],
      overrides.closeTs ?? closeTs,
      overrides.deadline ?? deadline,
      overrides.spec ?? s,
      { value: overrides.value ?? CREATE_VALUE }
    );
    await tx.wait();
    return (await pm.marketCount()) - 1n;
  }

  describe("createMarket", () => {
    it("creates a market and routes the creation fee to the resolver", async () => {
      const before = await ethers.provider.getBalance(resolver.address);
      const id = await createDefault();
      expect(id).to.equal(0n);
      const [m, q, outs] = await pm.getMarket(id);
      expect(m.creator).to.equal(owner.address);
      expect(q).to.include("100 likes");
      expect(outs).to.deep.equal(["NO", "YES"]);
      expect(m.creatorBond).to.equal(E(0.3));
      // creation fee 0.2 went to the resolver address
      expect(await ethers.provider.getBalance(resolver.address)).to.equal(before + E(0.2));
    });

    it("accrues the fee to platform when no resolver is set", async () => {
      const pm2 = await (await ethers.getContractFactory("PredictionMarket")).deploy();
      await pm2.createMarket(
        TWEET_METRIC, "q?", ["NO", "YES"], closeTs, deadline,
        spec({ bucketBounds: [99n] }), { value: CREATE_VALUE }
      );
      expect(await pm2.platformAccrued()).to.equal(E(0.2));
    });

    it("resolver wiring is one-shot: a second setResolver reverts", async () => {
      await expect(pm.setResolver(alice.address)).to.be.revertedWith("resolver locked");
    });

    it("curated mode blocks strangers, whitelist admits them", async () => {
      const s = spec({ bucketBounds: [99n] });
      await expect(
        pm.connect(alice).createMarket(TWEET_METRIC, "q?", ["NO", "YES"], closeTs, deadline, s, { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "NotAllowedCreator");
      await pm.setAllowedCreator(alice.address, true);
      await pm.connect(alice).createMarket(TWEET_METRIC, "q?", ["NO", "YES"], closeTs, deadline, s, { value: CREATE_VALUE });
      // permissionless once curated mode is off
      await pm.setCuratedMode(false);
      await pm.connect(bob).createMarket(TWEET_METRIC, "q?", ["NO", "YES"], closeTs, deadline, s, { value: CREATE_VALUE });
      expect(await pm.marketCount()).to.equal(2n);
    });

    it("validates params", async () => {
      const s = spec({ bucketBounds: [99n] });
      // wrong value
      await expect(createDefault({ value: E(0.4) })).to.be.revertedWithCustomError(pm, "BadValue");
      // one outcome
      await expect(
        pm.createMarket(TWEET_METRIC, "q?", ["YES"], closeTs, deadline, s, { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "BadParams");
      // close too soon
      await expect(createDefault({ closeTs: (await time.latest()) + 60 })).to.be.revertedWithCustomError(pm, "BadParams");
      // deadline too tight
      await expect(createDefault({ deadline: closeTs + 60 })).to.be.revertedWithCustomError(pm, "BadParams");
      // bounds length mismatch (2 outcomes need exactly 1 bound)
      await expect(createDefault({ bucketBounds: [1n, 2n] })).to.be.revertedWithCustomError(pm, "BadParams");
      // non-ascending bounds
      await expect(
        pm.createMarket(TWEET_METRIC, "q?", ["a", "b", "c"], closeTs, deadline,
          spec({ bucketBounds: [5n, 5n] }), { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "BadParams");
      // freeform must NOT carry bounds and must carry criteria
      await expect(
        pm.createMarket(FREEFORM_LLM, "q?", ["NO", "YES"], closeTs, deadline,
          spec({ bucketBounds: [1n] }), { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "BadParams");
      await expect(
        pm.createMarket(FREEFORM_LLM, "q?", ["NO", "YES"], closeTs, deadline,
          spec({ criteria: "" }), { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "BadParams");
      // numeric template needs a primary url
      await expect(
        pm.createMarket(TWEET_METRIC, "q?", ["NO", "YES"], closeTs, deadline,
          spec({ primaryUrl: "", bucketBounds: [99n] }), { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "BadParams");
      // non-race templates must not carry race sources
      await expect(
        pm.createMarket(TWEET_METRIC, "q?", ["NO", "YES"], closeTs, deadline,
          spec({ bucketBounds: [99n], raceUrls: ["u"], raceSelectors: ["s"] }), { value: CREATE_VALUE })
      ).to.be.revertedWithCustomError(pm, "BadParams");
    });

    it("race: creates with K contenders + mandatory fallback outcome", async () => {
      const s = spec({
        primarySelector: "winner",
        raceUrls: ["https://a.example/1.json", "https://a.example/2.json"],
        raceSelectors: ["likes", "likes"],
        raceThreshold: 1000n,
      });
      await pm.createMarket(RACE_ARGMAX, "Whose post gets more likes?",
        ["@alice", "@bob", "nobody/tie"], closeTs, deadline, s, { value: CREATE_VALUE });
      const [m, , outs] = await pm.getMarket(0);
      expect(Number(m.template)).to.equal(RACE_ARGMAX);
      expect(outs.length).to.equal(3);
      const stored = await pm.getSpec(0);
      expect(stored.raceUrls.length).to.equal(2);
      expect(stored.raceThreshold).to.equal(1000n);
    });

    it("race: validates contender/outcome wiring", async () => {
      const mk = (s, outs = ["@a", "@b", "nobody"]) =>
        pm.createMarket(RACE_ARGMAX, "q?", outs, closeTs, deadline, s, { value: CREATE_VALUE });
      // fewer than 2 contenders
      await expect(mk(spec({ raceUrls: ["u"], raceSelectors: ["s"] }), ["@a", "nobody"]))
        .to.be.revertedWithCustomError(pm, "BadParams");
      // outcomes must be contenders + 1 (fallback label required)
      await expect(mk(spec({ raceUrls: ["u1", "u2"], raceSelectors: ["s", "s"] }), ["@a", "@b"]))
        .to.be.revertedWithCustomError(pm, "BadParams");
      // selectors array must match contenders
      await expect(mk(spec({ raceUrls: ["u1", "u2"], raceSelectors: ["s"] })))
        .to.be.revertedWithCustomError(pm, "BadParams");
      // race must not carry bucket bounds
      await expect(mk(spec({ raceUrls: ["u1", "u2"], raceSelectors: ["s", "s"], bucketBounds: [1n, 2n] })))
        .to.be.revertedWithCustomError(pm, "BadParams");
      // race needs the x-oracle primary url and criteria
      await expect(mk(spec({ raceUrls: ["u1", "u2"], raceSelectors: ["s", "s"], primaryUrl: "" })))
        .to.be.revertedWithCustomError(pm, "BadParams");
      await expect(mk(spec({ raceUrls: ["u1", "u2"], raceSelectors: ["s", "s"], criteria: "" })))
        .to.be.revertedWithCustomError(pm, "BadParams");
    });
  });

  describe("betting", () => {
    let id;
    beforeEach(async () => { id = await createDefault(); });

    it("accepts bets and tracks pools/stakes", async () => {
      await pm.connect(alice).bet(id, 0, { value: E(1) });
      await pm.connect(bob).bet(id, 1, { value: E(2) });
      await pm.connect(alice).bet(id, 1, { value: E(0.5) });
      const pools = await pm.getPools(id);
      expect(pools[0]).to.equal(E(1));
      expect(pools[1]).to.equal(E(2.5));
      const st = await pm.stakesOf(id, alice.address);
      expect(st[0]).to.equal(E(1));
      expect(st[1]).to.equal(E(0.5));
      const [m] = await pm.getMarket(id);
      expect(m.total).to.equal(E(3.5));
    });

    it("rejects: below min, bad outcome, after close", async () => {
      await expect(pm.connect(alice).bet(id, 0, { value: E(0.001) }))
        .to.be.revertedWithCustomError(pm, "BadValue");
      await expect(pm.connect(alice).bet(id, 5, { value: E(1) }))
        .to.be.revertedWithCustomError(pm, "BadOutcome");
      await time.increaseTo(closeTs + 1);
      await expect(pm.connect(alice).bet(id, 0, { value: E(1) }))
        .to.be.revertedWithCustomError(pm, "BettingClosed");
    });
  });

  describe("resolve + claim", () => {
    let id;
    beforeEach(async () => {
      id = await createDefault();
      await pm.connect(alice).bet(id, 0, { value: E(1) });
      await pm.connect(bob).bet(id, 1, { value: E(2) });
      await pm.connect(carol).bet(id, 0, { value: E(1) });
    });

    it("only the resolver can resolve, and only after close", async () => {
      await expect(pm.connect(alice).resolve(id, 0)).to.be.revertedWithCustomError(pm, "NotResolver");
      await expect(pm.connect(resolver).resolve(id, 0)).to.be.revertedWithCustomError(pm, "BettingStillOpen");
    });

    it("pays winners pro-rata with fees carved from the losing pool", async () => {
      await time.increaseTo(closeTs + 1);
      await pm.connect(resolver).resolve(id, 0);

      // total 4, winning pool 2, losing 2. fees = 2 * (250+100)/10000 = 0.07
      // each winner: 1 * (4 - 0.07) / 2 = 1.965
      const expected = (E(1) * (E(4) - E(0.07))) / E(2);
      expect(await pm.claimableOf(id, alice.address)).to.equal(expected);
      expect(expected).to.be.greaterThan(E(1)); // winners never below stake

      const before = await ethers.provider.getBalance(alice.address);
      const rc = await (await pm.connect(alice).claim(id)).wait();
      const gas = rc.gasUsed * rc.gasPrice;
      expect(await ethers.provider.getBalance(alice.address)).to.equal(before + expected - gas);

      // loser has nothing; double-claim blocked
      await expect(pm.connect(bob).claim(id)).to.be.revertedWithCustomError(pm, "NothingToClaim");
      await expect(pm.connect(alice).claim(id)).to.be.revertedWithCustomError(pm, "NothingToClaim");

      // fee accounting: platform 2*2.5%=0.05, creator 2*1%=0.02 (+bond 0.3)
      expect(await pm.platformAccrued()).to.equal(E(0.05));
      expect(await pm.pendingFunds(owner.address)).to.equal(E(0.02) + E(0.3));
    });

    it("total payouts never exceed pool minus fees (dust stays in contract)", async () => {
      // odd amounts to force rounding
      await pm.connect(alice).bet(id, 0, { value: 333333333333333333n });
      await time.increaseTo(closeTs + 1);
      await pm.connect(resolver).resolve(id, 0);
      const a = await pm.claimableOf(id, alice.address);
      const c = await pm.claimableOf(id, carol.address);
      const [m] = await pm.getMarket(id);
      const losing = m.total - (E(2) + 333333333333333333n);
      const fees = (losing * 250n) / 10000n + (losing * 100n) / 10000n;
      expect(a + c).to.be.lessThanOrEqual(m.total - fees);
    });

    it("resolving to an outcome nobody backed voids the market", async () => {
      // create a 3-outcome market where outcome 2 has no bets
      const id2 = await createDefault({
        outcomes: ["a", "b", "c"], bucketBounds: [5n, 10n], question: "buckets?",
      });
      await pm.connect(alice).bet(id2, 0, { value: E(1) });
      await time.increaseTo(closeTs + 1);
      await expect(pm.connect(resolver).resolve(id2, 2)).to.emit(pm, "MarketVoided");
      expect(await pm.claimableOf(id2, alice.address)).to.equal(E(1)); // full refund
    });

    it("fee changes after creation do not affect existing markets (snapshot)", async () => {
      await pm.setFees(1000, 0);
      await time.increaseTo(closeTs + 1);
      await pm.connect(resolver).resolve(id, 0);
      // still the snapshot 2.5%+1% on losing 2
      expect(await pm.platformAccrued()).to.equal(E(0.05));
    });

    it("platform withdrawal is capped by accrued", async () => {
      await time.increaseTo(closeTs + 1);
      await pm.connect(resolver).resolve(id, 0);
      await expect(pm.withdrawPlatform(owner.address, E(1))).to.be.revertedWith("exceeds accrued");
      await pm.withdrawPlatform(owner.address, E(0.05));
      expect(await pm.platformAccrued()).to.equal(0n);
    });
  });

  describe("void paths", () => {
    let id;
    beforeEach(async () => {
      id = await createDefault();
      await pm.connect(alice).bet(id, 0, { value: E(1) });
      await pm.connect(bob).bet(id, 1, { value: E(2) });
    });

    it("resolver can void; all stakes refundable; bond returns to creator", async () => {
      await pm.connect(resolver).void(id, "sources disagree");
      expect(await pm.claimableOf(id, alice.address)).to.equal(E(1));
      expect(await pm.claimableOf(id, bob.address)).to.equal(E(2));
      expect(await pm.pendingFunds(owner.address)).to.equal(E(0.3));

      const before = await ethers.provider.getBalance(bob.address);
      const rc = await (await pm.connect(bob).claim(id)).wait();
      expect(await ethers.provider.getBalance(bob.address))
        .to.equal(before + E(2) - rc.gasUsed * rc.gasPrice);
    });

    it("voidExpired: permissionless only after the deadline", async () => {
      await expect(pm.connect(carol).voidExpired(id)).to.be.revertedWithCustomError(pm, "NotYetExpired");
      await time.increaseTo(deadline + 1);
      await pm.connect(carol).voidExpired(id);
      expect(await pm.claimableOf(id, alice.address)).to.equal(E(1));
      // late resolve after void must fail
      await expect(pm.connect(resolver).resolve(id, 0)).to.be.revertedWithCustomError(pm, "BadState");
    });

    it("claimFunds pays out creator bond", async () => {
      await pm.connect(resolver).void(id, "x");
      const before = await ethers.provider.getBalance(owner.address);
      const rc = await (await pm.claimFunds()).wait();
      expect(await ethers.provider.getBalance(owner.address))
        .to.equal(before + E(0.3) - rc.gasUsed * rc.gasPrice);
      await expect(pm.claimFunds()).to.be.revertedWithCustomError(pm, "NothingToClaim");
    });
  });
});
