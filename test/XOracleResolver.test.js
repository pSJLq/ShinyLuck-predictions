const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const abi = ethers.AbiCoder.defaultAbiCoder();

const TWEET_METRIC = 0, FOLLOWERS_GTE = 1, POSTS_COUNT_DAY = 2, FREEFORM_LLM = 3, RACE_ARGMAX = 4;
const ABSTAIN = 255;

const CREATE_VALUE = E(0.5);

function spec(over = {}) {
  return {
    primaryUrl: over.primaryUrl ?? "https://example.com/a.json",
    primarySelector: over.primarySelector ?? "value",
    secondaryUrl: over.secondaryUrl ?? "https://example.com/b.json",
    secondarySelector: over.secondarySelector ?? "value",
    criteria: over.criteria ?? "Extract the metric",
    bucketBounds: over.bucketBounds ?? [],
    raceUrls: over.raceUrls ?? [],
    raceSelectors: over.raceSelectors ?? [],
    raceThreshold: over.raceThreshold ?? 0n,
  };
}

describe("XOracleResolver", () => {
  let pm, resolver, mock, owner, alice, bob;
  let closeTs, deadline;

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    mock = await (await ethers.getContractFactory("MockAgentPlatform")).deploy();
    pm = await (await ethers.getContractFactory("PredictionMarket")).deploy();
    resolver = await (await ethers.getContractFactory("XOracleResolver"))
      .deploy(await mock.getAddress(), await pm.getAddress());
    await pm.setResolver(await resolver.getAddress());
    // fund the resolver for agent deposits
    await owner.sendTransaction({ to: await resolver.getAddress(), value: E(5) });

    const now = await time.latest();
    closeTs = now + 3600;
    deadline = closeTs + 7200;
  });

  async function createMarket(template, outcomes, s, question = "q?") {
    await pm.createMarket(template, question, outcomes, closeTs, deadline, s, { value: CREATE_VALUE });
    return (await pm.marketCount()) - 1n;
  }

  async function betAndClose(id) {
    await pm.connect(alice).bet(id, 0, { value: E(1) });
    await pm.connect(bob).bet(id, 1, { value: E(2) });
    await time.increaseTo(closeTs + 1);
  }

  // grab requestIds fired by the LAST startResolve
  async function firedRequests(txPromise) {
    const rc = await (await txPromise).wait();
    const ids = [];
    for (const log of rc.logs) {
      try {
        const parsed = resolver.interface.parseLog(log);
        if (parsed && parsed.name === "VoteRequestFired") {
          ids.push({ requestId: parsed.args.requestId, voteIdx: Number(parsed.args.voteIdx), agentId: parsed.args.agentId });
        }
      } catch (_) {}
    }
    return ids;
  }

  const encU = (v) => abi.encode(["uint256"], [v]);
  const encS = (s) => abi.encode(["string"], [s]);

  describe("startResolve", () => {
    it("rejects while betting is open, with no bets, or mid-round", async () => {
      const id = await createMarket(TWEET_METRIC, ["NO", "YES"], spec({ bucketBounds: [99999n] }));
      await expect(resolver.startResolve(id)).to.be.revertedWithCustomError(resolver, "MarketNotResolvable");
      await time.increaseTo(closeTs + 1);
      await expect(resolver.startResolve(id)).to.be.revertedWithCustomError(resolver, "NoBets");
    });

    it("fires 2 JSON votes for TWEET_METRIC and applies the oracle base url to relative paths", async () => {
      await resolver.setOracleBaseUrl("https://raw.example.com/oracle/");
      const id = await createMarket(
        TWEET_METRIC, ["NO", "YES"],
        spec({ primaryUrl: "7.json", primarySelector: "likes", bucketBounds: [99999n] })
      );
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      expect(reqs.length).to.equal(2);

      // decode the stored payload of vote 0: url must be base + "7.json"
      const stored = await mock.stored(reqs[0].requestId);
      const json = new ethers.Interface([
        "function fetchUint(string url, string selector, uint8 decimals) returns (uint256)",
      ]);
      const dec = json.decodeFunctionData("fetchUint", stored.payload);
      expect(dec[0]).to.equal("https://raw.example.com/oracle/7.json");
      expect(dec[1]).to.equal("likes");
      // absolute secondary url passes through untouched
      const stored1 = await mock.stored(reqs[1].requestId);
      const dec1 = json.decodeFunctionData("fetchUint", stored1.payload);
      expect(dec1[0]).to.equal("https://example.com/b.json");
    });

    it("reverts mid-flight, allows a new round after the timeout, caps total rounds", async () => {
      const id = await createMarket(TWEET_METRIC, ["NO", "YES"], spec({ bucketBounds: [99n] }));
      await betAndClose(id);
      await resolver.startResolve(id);
      await expect(resolver.startResolve(id)).to.be.revertedWithCustomError(resolver, "RoundInFlight");

      // after timeout a new round is allowed (rounds 2..4)
      for (let i = 2; i <= 4; i++) {
        await time.increase(26 * 60);
        await resolver.startResolve(id);
      }
      await time.increase(26 * 60);
      await expect(resolver.startResolve(id)).to.be.revertedWithCustomError(resolver, "RoundsExhausted");
    });

    it("reverts when the resolver balance cannot cover the round", async () => {
      const id = await createMarket(TWEET_METRIC, ["NO", "YES"], spec({ bucketBounds: [99n] }));
      await betAndClose(id);
      const bal = await ethers.provider.getBalance(await resolver.getAddress());
      await resolver.ownerWithdraw(owner.address, bal);
      await expect(resolver.startResolve(id)).to.be.revertedWithCustomError(resolver, "InsufficientFunding");
    });
  });

  describe("numeric consensus (2-of-2)", () => {
    let id, reqs;
    beforeEach(async () => {
      id = await createMarket(
        TWEET_METRIC, ["NO", "YES"],
        spec({ primarySelector: "likes", bucketBounds: [99999n] }) // YES when >= 100000
      );
      await betAndClose(id);
      reqs = await firedRequests(resolver.startResolve(id));
    });

    it("both votes agree -> market resolves to the bucketed outcome", async () => {
      await mock.respond(reqs[0].requestId, encU(150000n));
      await expect(mock.respond(reqs[1].requestId, encU(163000n)))
        .to.emit(resolver, "ConsensusReached");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1); // Resolved
      expect(m.winner).to.equal(1); // YES
    });

    it("votes in different buckets -> round fails, market stays open, retry succeeds", async () => {
      await mock.respond(reqs[0].requestId, encU(50n));       // bucket 0
      await expect(mock.respond(reqs[1].requestId, encU(150000n))) // bucket 1
        .to.emit(resolver, "RoundFailed");
      let [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0);

      const reqs2 = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs2[0].requestId, encU(120000n));
      await mock.respond(reqs2[1].requestId, encU(120001n));
      [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(1);
    });

    it("timeout/failed vote counts as abstain -> no consensus at 2-of-2", async () => {
      await mock.respond(reqs[0].requestId, encU(150000n));
      await expect(mock.respondWithStatus(reqs[1].requestId, "0x", 4)) // TimedOut
        .to.emit(resolver, "RoundFailed");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0);
    });

    it("undecodable result counts as abstain", async () => {
      await mock.respond(reqs[0].requestId, encU(150000n));
      await expect(mock.respond(reqs[1].requestId, "0xdeadbeef"))
        .to.emit(resolver, "RoundFailed");
    });
  });

  describe("freeform LLM (2-of-3)", () => {
    let id, reqs;
    beforeEach(async () => {
      id = await createMarket(
        FREEFORM_LLM, ["YES", "NO"],
        spec({ criteria: "Did @user post about the merge before July 20?" })
      );
      await betAndClose(id);
      reqs = await firedRequests(resolver.startResolve(id));
    });

    it("fires 3 LLM votes; 2 matching labels resolve the market", async () => {
      expect(reqs.length).to.equal(3);
      await mock.respond(reqs[0].requestId, encS("YES"));
      await mock.respond(reqs[1].requestId, encS("UNRESOLVED"));
      await expect(mock.respond(reqs[2].requestId, encS("YES")))
        .to.emit(resolver, "ConsensusReached");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(0);
    });

    it("YES/NO/UNRESOLVED -> no consensus", async () => {
      await mock.respond(reqs[0].requestId, encS("YES"));
      await mock.respond(reqs[1].requestId, encS("NO"));
      await expect(mock.respond(reqs[2].requestId, encS("UNRESOLVED")))
        .to.emit(resolver, "RoundFailed");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0);
    });

    it("labels not in the outcome set are abstains", async () => {
      await mock.respond(reqs[0].requestId, encS("MAYBE"));
      await mock.respond(reqs[1].requestId, encS("YES"));
      await expect(mock.respond(reqs[2].requestId, encS("YES")))
        .to.emit(resolver, "ConsensusReached"); // 2 real YES votes suffice
    });
  });

  describe("security", () => {
    let id, reqs;
    beforeEach(async () => {
      id = await createMarket(TWEET_METRIC, ["NO", "YES"], spec({ bucketBounds: [99n] }));
      await betAndClose(id);
      reqs = await firedRequests(resolver.startResolve(id));
    });

    it("resolution wiring is immutable: no setters for platform/market/agent ids", async () => {
      expect(resolver.setPlatform).to.equal(undefined);
      expect(resolver.setMarket).to.equal(undefined);
      expect(resolver.setAgentIds).to.equal(undefined);
      expect(await resolver.platform()).to.equal(await mock.getAddress());
      expect(await resolver.market()).to.equal(await pm.getAddress());
    });

    it("rejects callbacks from anyone but the platform", async () => {
      const responses = [];
      await expect(
        resolver.connect(alice).handleResponse(reqs[0].requestId, responses, 2, {
          id: 0, requester: ethers.ZeroAddress, callbackAddress: ethers.ZeroAddress,
          callbackSelector: "0x00000000", subcommittee: [], responses: [],
          responseCount: 0, failureCount: 0, threshold: 0, createdAt: 0, deadline: 0,
          status: 0, consensusType: 0, remainingBudget: 0, perAgentBudget: 0,
        })
      ).to.be.revertedWithCustomError(resolver, "NotPlatform");
    });

    it("replayed callback for the same request is ignored", async () => {
      await mock.respond(reqs[0].requestId, encU(150n));
      await mock.respond(reqs[0].requestId, encU(10n)); // replay with a different value
      const round = await resolver.getRound(id);
      expect(round.received).to.equal(1); // still one vote
      expect(round.votes[0]).to.equal(1); // first value won (150 > 99 -> bucket 1)
    });

    it("stale callbacks from a superseded round are dropped", async () => {
      await mock.respond(reqs[0].requestId, encU(150n));
      // round times out; a new round starts
      await time.increase(26 * 60);
      const reqs2 = await firedRequests(resolver.startResolve(id));
      // old round's second vote lands late - must not touch the new round
      await mock.respond(reqs[1].requestId, encU(150n));
      const round = await resolver.getRound(id);
      expect(round.received).to.equal(0);
      // the new round proceeds normally
      await mock.respond(reqs2[0].requestId, encU(150n));
      await mock.respond(reqs2[1].requestId, encU(151n));
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
    });

    it("consensus after the market was voided does not revert the callback", async () => {
      // owner voids the market through the resolver's escape hatch
      await resolver.ownerVoidMarket(id, "spec broken");
      await mock.respond(reqs[0].requestId, encU(150n));
      await expect(mock.respond(reqs[1].requestId, encU(151n)))
        .to.emit(resolver, "RoundFailed"); // "market.resolve reverted"
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(2); // stays voided
    });

    it("expireRound closes a hung round after the timeout", async () => {
      await expect(resolver.expireRound(id)).to.be.revertedWith("not expired");
      await time.increase(26 * 60);
      await resolver.expireRound(id);
      const round = await resolver.getRound(id);
      expect(round.active).to.equal(false);
    });
  });

  describe("single-source profile markets (no secondary reader)", () => {
    it("empty secondaryUrl -> one oracle vote resolves 1-of-1", async () => {
      const id = await createMarket(
        FOLLOWERS_GTE, ["NO", "YES"],
        spec({ primaryUrl: "1.json", primarySelector: "value", secondaryUrl: "", bucketBounds: [3599999n] })
      );
      await betAndClose(id);
      const cj = await resolver.quoteJsonCost();
      expect(await resolver.quoteRoundCost(id)).to.equal(cj); // single vote priced
      const reqs = await firedRequests(resolver.startResolve(id));
      expect(reqs.length).to.equal(1);
      await expect(mock.respond(reqs[0].requestId, encU(3656864n)))
        .to.emit(resolver, "ConsensusReached");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(1); // YES
    });

    it("a failed oracle vote fails the round (retry, then deadline void)", async () => {
      const id = await createMarket(
        FOLLOWERS_GTE, ["NO", "YES"],
        spec({ secondaryUrl: "", bucketBounds: [99n] })
      );
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      await expect(mock.respondWithStatus(reqs[0].requestId, "0x", 4))
        .to.emit(resolver, "RoundFailed");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0); // still open, retry available
    });
  });

  describe("mixed template (JSON + Parse)", () => {
    it("Parse payload carries a sane max bound (2^256 crashes the agent runtime)", async () => {
      const id = await createMarket(
        POSTS_COUNT_DAY, ["0-5", "6+"],
        spec({ secondaryUrl: "https://x.com/someuser", criteria: "Count posts", bucketBounds: [5n] })
      );
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      const stored = await mock.stored(reqs[1].requestId);
      const parseIface = new ethers.Interface([
        "function ExtractANumber(string key,string description,uint256 min,uint256 max,string prompt,string url,bool resolveUrl,uint8 numPages,uint8 confidenceThreshold) returns (uint256)",
      ]);
      const dec = parseIface.decodeFunctionData("ExtractANumber", stored.payload);
      expect(dec[3]).to.equal(1000000000000000n); // 1e15, not type(uint256).max
    });

    it("POSTS_COUNT_DAY fires one JSON and one Parse vote and resolves buckets", async () => {
      const id = await createMarket(
        POSTS_COUNT_DAY, ["0-5", "6-10", "11+"],
        spec({
          primaryUrl: "https://oracle.example.com/2.json",
          primarySelector: "posts",
          secondaryUrl: "https://x.com/someuser",
          criteria: "Count posts dated 2026-07-17 UTC on this profile",
          bucketBounds: [5n, 10n],
        })
      );
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      expect(reqs.length).to.equal(2);
      // vote 1 goes to the Parse agent
      expect(reqs[1].agentId).to.equal(await resolver.parseAgentId());

      await mock.respond(reqs[0].requestId, encU(7n)); // bucket 1
      await mock.respond(reqs[1].requestId, encU(8n)); // bucket 1
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(1); // "6-10"
    });
  });

  describe("race argmax (oracle winner vs on-chain argmax)", () => {
    const OUTS = ["@alice", "@bob", "@carol", "nobody/tie"];
    const raceSpec = (over = {}) => spec({
      primaryUrl: "5.json",
      primarySelector: "winner",
      criteria: "Measure the like count of each contender's pinned post",
      raceUrls: over.raceUrls ?? [
        "https://cdn.syndication.twimg.com/tweet-result?id=1&token=a",
        "https://cdn.syndication.twimg.com/tweet-result?id=2&token=a",
        "https://x.com/carol",
      ],
      raceSelectors: over.raceSelectors ?? ["favorite_count", "favorite_count", ""],
      raceThreshold: over.raceThreshold ?? 0n,
    });

    it("fires 1 winner vote + K measurements; empty selector routes to the Parse agent with the label in the prompt", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "Whose post gets the most likes?");
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      expect(reqs.length).to.equal(4);
      expect(reqs[0].agentId).to.equal(await resolver.jsonAgentId());
      expect(reqs[1].agentId).to.equal(await resolver.jsonAgentId());
      expect(reqs[2].agentId).to.equal(await resolver.jsonAgentId());
      expect(reqs[3].agentId).to.equal(await resolver.parseAgentId());

      const stored = await mock.stored(reqs[3].requestId);
      const parseIface = new ethers.Interface([
        "function ExtractANumber(string key,string description,uint256 min,uint256 max,string prompt,string url,bool resolveUrl,uint8 numPages,uint8 confidenceThreshold) returns (uint256)",
      ]);
      const dec = parseIface.decodeFunctionData("ExtractANumber", stored.payload);
      expect(dec[4]).to.include("@carol");
      expect(dec[5]).to.equal("https://x.com/carol");
    });

    it("resolves when the oracle's winner equals the measured argmax", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(1n));      // oracle: @bob
      await mock.respond(reqs[1].requestId, encU(100n));    // @alice
      await mock.respond(reqs[2].requestId, encU(500n));    // @bob <- max
      await expect(mock.respond(reqs[3].requestId, encU(300n))) // @carol
        .to.emit(resolver, "ConsensusReached");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(1); // @bob
    });

    it("nobody past the threshold -> fallback outcome wins", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec({ raceThreshold: 1000n }), "q?");
      await pm.connect(alice).bet(id, 3, { value: E(1) }); // someone backs "nobody"
      await pm.connect(bob).bet(id, 0, { value: E(2) });
      await time.increaseTo(closeTs + 1);
      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(3n));      // oracle: fallback
      await mock.respond(reqs[1].requestId, encU(100n));
      await mock.respond(reqs[2].requestId, encU(500n));
      await mock.respond(reqs[3].requestId, encU(300n));
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(3);
    });

    it("tie at the top -> fallback outcome wins", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      await pm.connect(alice).bet(id, 3, { value: E(1) });
      await pm.connect(bob).bet(id, 1, { value: E(2) });
      await time.increaseTo(closeTs + 1);
      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(3n));      // oracle: tie -> fallback
      await mock.respond(reqs[1].requestId, encU(500n));
      await mock.respond(reqs[2].requestId, encU(500n));    // tie with @alice
      await mock.respond(reqs[3].requestId, encU(300n));
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(3);
    });

    it("oracle disagrees with the measured argmax -> round fails, retry can succeed", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(0n));      // oracle claims @alice
      await mock.respond(reqs[1].requestId, encU(100n));
      await mock.respond(reqs[2].requestId, encU(500n));    // but @bob measured higher
      await expect(mock.respond(reqs[3].requestId, encU(300n)))
        .to.emit(resolver, "RoundFailed");
      let [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0);

      const reqs2 = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs2[0].requestId, encU(1n));
      await mock.respond(reqs2[1].requestId, encU(100n));
      await mock.respond(reqs2[2].requestId, encU(500n));
      await mock.respond(reqs2[3].requestId, encU(300n));
      [m] = await pm.getMarket(id);
      expect(m.state).to.equal(1);
      expect(m.winner).to.equal(1);
    });

    it("a failed measurement aborts the round (no argmax over partial data)", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(1n));
      await mock.respond(reqs[1].requestId, encU(100n));
      await mock.respond(reqs[2].requestId, encU(500n));
      await expect(mock.respondWithStatus(reqs[3].requestId, "0x", 4)) // TimedOut
        .to.emit(resolver, "RoundFailed");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0);
    });

    it("an out-of-range oracle winner index is an abstain", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(9n));      // 9 >= nOutcomes
      await mock.respond(reqs[1].requestId, encU(100n));
      await mock.respond(reqs[2].requestId, encU(500n));
      await expect(mock.respond(reqs[3].requestId, encU(300n)))
        .to.emit(resolver, "RoundFailed");
      const [m] = await pm.getMarket(id);
      expect(m.state).to.equal(0);
    });

    it("getVoteMeta exposes requestId + agentId + subcommittee stats for the provenance UI", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      await betAndClose(id);
      const reqs = await firedRequests(resolver.startResolve(id));
      let meta = await resolver.getVoteMeta(id);
      for (let i = 0; i < 4; i++) {
        expect(meta.requestIds[i]).to.equal(reqs[i].requestId);
        expect(meta.agentIds[i]).to.equal(reqs[i].agentId);
        expect(meta.responded[i]).to.equal(0); // callbacks not in yet
      }
      expect(meta.requestIds[4]).to.equal(0n); // unused slots stay empty

      await mock.respond(reqs[0].requestId, encU(1n));
      meta = await resolver.getVoteMeta(id);
      expect(meta.responded[0]).to.equal(3); // mock subcommittee of 3
      expect(meta.agreed[0]).to.equal(1);    // mock passes one consensus response
      expect(meta.responded[1]).to.equal(0); // untouched slots stay zero
    });

    it("quoteRoundCost prices JSON vs Parse contenders correctly", async () => {
      const id = await createMarket(RACE_ARGMAX, OUTS, raceSpec(), "q?");
      const cj = await resolver.quoteJsonCost();
      const cp = await resolver.quoteParseCost();
      // winner vote + 2 JSON contenders + 1 Parse contender
      expect(await resolver.quoteRoundCost(id)).to.equal(cj * 3n + cp);
    });
  });

  describe("full cycle with payouts", () => {
    it("create -> bet -> agents resolve -> winners claim", async () => {
      const id = await createMarket(TWEET_METRIC, ["NO", "YES"], spec({ bucketBounds: [99999n] }));
      await pm.connect(alice).bet(id, 1, { value: E(1) });
      await pm.connect(bob).bet(id, 0, { value: E(3) });
      await time.increaseTo(closeTs + 1);

      const reqs = await firedRequests(resolver.startResolve(id));
      await mock.respond(reqs[0].requestId, encU(250000n));
      await mock.respond(reqs[1].requestId, encU(250100n));

      // YES won; alice takes (4 - fees(3*3.5%=0.105)) = 3.895
      const expected = (E(1) * (E(4) - E(0.105))) / E(1);
      expect(await pm.claimableOf(id, alice.address)).to.equal(expected);
      const before = await ethers.provider.getBalance(alice.address);
      const rc = await (await pm.connect(alice).claim(id)).wait();
      expect(await ethers.provider.getBalance(alice.address))
        .to.equal(before + expected - rc.gasUsed * rc.gasPrice);
    });
  });
});
