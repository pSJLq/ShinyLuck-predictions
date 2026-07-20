// Local-only: populate the UI with markets in each state. Uses the mock
// platform (only present on localhost) to drive a real agent-consensus resolve.
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const abi = ethers.AbiCoder.defaultAbiCoder();
const E = (n) => ethers.parseEther(String(n));

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "localhost.json"), "utf8"));
  const [deployer, a, b] = await ethers.getSigners();
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);
  const resolver = await ethers.getContractAt("XOracleResolver", man.addresses.xOracleResolver);
  const mock = await ethers.getContractAt("MockAgentPlatform", man.addresses.agentPlatform);

  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const spec = (o) => ({
    primaryUrl: o.primaryUrl ?? "1.json", primarySelector: o.primarySelector ?? "value",
    secondaryUrl: o.secondaryUrl ?? "https://cdn.syndication.twimg.com/tweet-result?id=1",
    secondarySelector: o.secondarySelector ?? "value", criteria: o.criteria ?? "extract",
    bucketBounds: o.bucketBounds ?? [],
    raceUrls: o.raceUrls ?? [], raceSelectors: o.raceSelectors ?? [],
    raceThreshold: o.raceThreshold ?? 0n,
  });
  const CV = E(0.5);

  // Market 0: OPEN, betting well into the future.
  await (await pm.createMarket(0, "Will @elonmusk's pinned tweet pass 500k likes by Friday?",
    ["NO", "YES"], now + 6 * 3600, now + 12 * 3600,
    spec({ primarySelector: "likes", bucketBounds: [499999n] }), { value: CV })).wait();
  await (await pm.connect(a).bet(0, 1, { value: E(3) })).wait();
  await (await pm.connect(b).bet(0, 0, { value: E(1) })).wait();

  // Market 1: freeform LLM, OPEN.
  await (await pm.createMarket(3, "Does @VitalikButerin post about zk before July 20 (UTC)?",
    ["YES", "NO"], now + 4 * 3600, now + 20 * 3600,
    spec({ criteria: "Did @VitalikButerin post anything mentioning zk before 2026-07-20 UTC?" }), { value: CV })).wait();
  await (await pm.connect(a).bet(1, 0, { value: E(2) })).wait();

  // Market 2: RESOLVED via real agent consensus (short close).
  await (await pm.createMarket(2, "How many posts did @naval make on 2026-07-16 (UTC)?",
    ["0-5", "6-10", "11+"], now + 700, now + 8 * 3600,
    spec({ primaryUrl: "2.json", primarySelector: "posts",
           secondaryUrl: "https://x.com/naval", criteria: "count posts", bucketBounds: [5n, 10n] }),
    { value: CV })).wait();
  await (await pm.connect(a).bet(2, 1, { value: E(2) })).wait();
  await (await pm.connect(b).bet(2, 0, { value: E(1) })).wait();

  // fast-forward past its close, fire the resolve round, answer both votes = 7 (bucket "6-10")
  await ethers.provider.send("evm_increaseTime", [750]);
  await ethers.provider.send("evm_mine", []);
  const rc = await (await resolver.startResolve(2)).wait();
  const reqIds = [];
  for (const log of rc.logs) {
    try { const p = resolver.interface.parseLog(log); if (p && p.name === "VoteRequestFired") reqIds.push(p.args.requestId); } catch (_) {}
  }
  for (const rid of reqIds) await (await mock.respond(rid, abi.encode(["uint256"], [7n]))).wait();
  const [m2] = await pm.getMarket(2);
  console.log(`market 2 state=${m2.state} winner=${m2.winner} (expect state=1 winner=1)`);

  // Market 3: RACE, OPEN - likes race between three tweets, bets across outcomes.
  const raceSpec = spec({
    primaryUrl: "3.json", primarySelector: "winner",
    criteria: "Whose announcement tweet collects the most likes by close | x:race;tweets=1948000000000000001,1948000000000000002,1948000000000000003;metric=likes",
    raceUrls: [
      "https://cdn.syndication.twimg.com/tweet-result?id=1948000000000000001&token=a",
      "https://cdn.syndication.twimg.com/tweet-result?id=1948000000000000002&token=a",
      "https://cdn.syndication.twimg.com/tweet-result?id=1948000000000000003&token=a",
    ],
    raceSelectors: ["favorite_count", "favorite_count", "favorite_count"],
  });
  await (await pm.createMarket(4, "Whose launch tweet gets the most likes - @elonmusk, @VitalikButerin or @naval?",
    ["@elonmusk", "@VitalikButerin", "@naval", "nobody/tie"], now + 5 * 3600, now + 10 * 3600,
    raceSpec, { value: CV })).wait();
  await (await pm.connect(a).bet(3, 0, { value: E(2.5) })).wait();
  await (await pm.connect(b).bet(3, 1, { value: E(1.5) })).wait();
  await (await pm.connect(a).bet(3, 2, { value: E(0.5) })).wait();

  // Market 4: RACE resolved through real mock-agent consensus (oracle winner
  // index + per-contender measurements, on-chain argmax must agree).
  // Chain time moved past `now` while resolving market 2 - re-read it.
  const now2 = (await ethers.provider.getBlock("latest")).timestamp;
  await (await pm.createMarket(4, "Follower race: who is highest by tonight - @a16z or @paradigm?",
    ["@a16z", "@paradigm", "nobody/tie"], now2 + 700, now2 + 9 * 3600,
    spec({
      primaryUrl: "4.json", primarySelector: "winner",
      criteria: "Extract the follower count | x:race;users=a16z,paradigm;metric=followers",
      raceUrls: ["https://x.com/a16z", "https://x.com/paradigm"],
      raceSelectors: ["", ""],
    }), { value: CV })).wait();
  await (await pm.connect(a).bet(4, 1, { value: E(2) })).wait();
  await (await pm.connect(b).bet(4, 0, { value: E(1) })).wait();

  await ethers.provider.send("evm_increaseTime", [850]);
  await ethers.provider.send("evm_mine", []);
  const rc4 = await (await resolver.startResolve(4)).wait();
  const raceReqs = [];
  for (const log of rc4.logs) {
    try { const p = resolver.interface.parseLog(log); if (p && p.name === "VoteRequestFired") raceReqs.push(p.args.requestId); } catch (_) {}
  }
  // vote 0: oracle says index 1 (@paradigm); votes 1-2: measurements agree
  await (await mock.respond(raceReqs[0], abi.encode(["uint256"], [1n]))).wait();
  await (await mock.respond(raceReqs[1], abi.encode(["uint256"], [1200000n]))).wait();
  await (await mock.respond(raceReqs[2], abi.encode(["uint256"], [1350000n]))).wait();
  const [m4] = await pm.getMarket(4);
  console.log(`market 4 state=${m4.state} winner=${m4.winner} (expect state=1 winner=1)`);

  console.log(`seeded ${await pm.marketCount()} markets`);
}
main().catch((e) => { console.error(e); process.exit(1); });
