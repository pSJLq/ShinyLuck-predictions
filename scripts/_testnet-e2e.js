// Live testnet E2E: create a real TWEET_METRIC market, bet from two burner
// wallets, fire a REAL Somnia-agent resolve round (2 JSON votes over X's
// public syndication endpoint - no x-oracle infra needed), watch the
// callbacks land, then claim.
//
//   TWEET_ID=<id> THRESHOLD=<likes> npx hardhat run scripts/_testnet-e2e.js --network somniaTestnet
//
// Notes:
//  - The market question is "will tweet X have >= THRESHOLD likes at close".
//    For the E2E we pick a CLOSED-IN-MINUTES market on an old viral tweet, so
//    the metric is stable and both agent votes must land in the same bucket.
//  - closeTs must respect minLeadTime (10 min default), so the script waits
//    that long. Total runtime ~15-20 min; run it in the background.
//  - Both votes hit the same public endpoint from independent validator
//    subcommittees (vote0 via primaryUrl, vote1 via secondaryUrl - same URL,
//    two consensus groups). That's the no-own-infra variant; once the
//    x-oracle publishes JSON, vote0 switches to our mirror for source
//    diversity.

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const E = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const man = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8")
  );
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);
  const resolver = await ethers.getContractAt("XOracleResolver", man.addresses.xOracleResolver);

  console.log(`deployer ${deployer.address} bal ${ethers.formatEther(await provider.getBalance(deployer.address))}`);
  console.log(`market ${man.addresses.predictionMarket} resolver ${man.addresses.xOracleResolver}`);

  // --- burner bettors funded from the deployer (E2E-local funds, swept back) ---
  const alice = ethers.Wallet.createRandom().connect(provider);
  const bob = ethers.Wallet.createRandom().connect(provider);
  console.log(`bettors: alice=${alice.address} bob=${bob.address}`);
  for (const w of [alice, bob]) {
    const tx = await deployer.sendTransaction({ to: w.address, value: E(0.6) });
    await tx.wait();
  }

  // --- market on a stable old tweet (default: a known viral tweet id) ---
  const TWEET_ID = process.env.TWEET_ID || "20"; // "just setting up my twttr"
  const THRESHOLD = BigInt(process.env.THRESHOLD || "100000");
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${TWEET_ID}&token=a`;
  const selector = "favorite_count";

  const now = (await provider.getBlock("latest")).timestamp;
  const closeTs = now + 11 * 60;         // minLeadTime 10m + margin
  const deadline = closeTs + 2 * 3600;

  const fee = await pm.creationFee();
  const bond = await pm.creatorBondAmount();
  const spec = {
    primaryUrl: url, primarySelector: selector,
    secondaryUrl: url, secondarySelector: selector,
    criteria: `Does tweet ${TWEET_ID} have >= ${THRESHOLD} likes? | x:tweet=${TWEET_ID};metric=likes`,
    bucketBounds: [THRESHOLD - 1n],
  };
  let tx = await pm.createMarket(
    0, // TWEET_METRIC
    `Does tweet #${TWEET_ID} have ${THRESHOLD}+ likes right now?`,
    ["NO", "YES"], closeTs, deadline, spec, { value: fee + bond }
  );
  await tx.wait();
  const id = (await pm.marketCount()) - 1n;
  console.log(`market #${id} created, closes in ~11m`);

  // --- bets ---
  tx = await pm.connect(alice).bet(id, 1, { value: E(0.3) }); await tx.wait();
  tx = await pm.connect(bob).bet(id, 0, { value: E(0.2) }); await tx.wait();
  console.log("bets placed: alice 0.3 YES, bob 0.2 NO");

  // --- wait for close ---
  console.log("waiting for closeTs...");
  while ((await provider.getBlock("latest")).timestamp < closeTs + 5) await sleep(15000);

  // --- fire the real agent round ---
  const cost = await resolver.quoteRoundCost(id);
  const rbal = await provider.getBalance(man.addresses.xOracleResolver);
  console.log(`round cost ${ethers.formatEther(cost)} STT, resolver bal ${ethers.formatEther(rbal)}`);
  if (rbal < cost) {
    tx = await deployer.sendTransaction({ to: man.addresses.xOracleResolver, value: cost });
    await tx.wait();
    console.log("resolver topped up");
  }
  tx = await resolver.startResolve(id);
  const rc = await tx.wait();
  const reqIds = [];
  for (const log of rc.logs) {
    try {
      const p = resolver.interface.parseLog(log);
      if (p && p.name === "VoteRequestFired") reqIds.push(p.args.requestId.toString());
    } catch (_) {}
  }
  console.log(`round fired, requestIds: ${reqIds.join(", ")}`);
  console.log(`receipts: https://agents.testnet.somnia.network (platform ${man.addresses.agentPlatform})`);

  // --- watch for the callbacks / resolution (platform timeout is 15 min) ---
  console.log("waiting for agent consensus...");
  const deadlineMs = Date.now() + 20 * 60 * 1000;
  let resolved = false;
  while (Date.now() < deadlineMs) {
    const [m] = await pm.getMarket(id);
    const round = await resolver.getRound(id);
    process.stdout.write(`\r  state=${m.state} votes=[${round.votes.join(",")}] received=${round.received}   `);
    if (Number(m.state) !== 0) { resolved = true; console.log(); break; }
    await sleep(20000);
  }
  if (!resolved) {
    console.log("\nno resolution within 20m - check receipts, round can be retried by the keeper");
    return;
  }

  const [m] = await pm.getMarket(id);
  console.log(`RESOLVED: state=${m.state} winner=${m.winner} (0=NO 1=YES)`);

  // --- claims + sweep back ---
  const winner = Number(m.state) === 1 ? (Number(m.winner) === 1 ? alice : bob) : null;
  const claimants = Number(m.state) === 2 ? [alice, bob] : [winner].filter(Boolean);
  for (const w of claimants) {
    const claimable = await pm.claimableOf(id, w.address);
    if (claimable > 0n) {
      tx = await pm.connect(w).claim(id); await tx.wait();
      console.log(`${w.address.slice(0, 8)} claimed ${ethers.formatEther(claimable)} STT`);
    }
  }
  // sweep burners back to the deployer (leave dust for gas estimation quirks)
  for (const w of [alice, bob]) {
    const bal = await provider.getBalance(w.address);
    if (bal > E(0.02)) {
      const t = await w.sendTransaction({ to: deployer.address, value: bal - E(0.02) });
      await t.wait();
    }
  }
  console.log("burners swept back. E2E complete.");
}

main().catch((e) => { console.error(e); process.exit(1); });
