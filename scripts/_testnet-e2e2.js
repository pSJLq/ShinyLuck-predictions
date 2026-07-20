// Live testnet E2E, generation 2 (post-RACE_ARGMAX redeploy): creates the two
// profile-grade markets the MVP plan calls for and places bets so both sides
// of each pool exist. Resolution is then driven by scripts/_testnet-resume.js
// (MARKET_ID=0 WIN_OUTCOME=0, MARKET_ID=1 WIN_OUTCOME=1) after the x-oracle
// publishes its JSONs to the public GitHub host.
//
//   npx hardhat run scripts/_testnet-e2e2.js --network somniaTestnet
//
// Market 0 - RACE_ARGMAX: which legendary tweet has the most likes.
//   All three measurement votes are JSON-agent reads of X's public
//   syndication endpoint; vote 0 reads the x-oracle's winner index.
// Market 1 - FOLLOWERS_GTE: @naval >= 3.6M followers (YES expected).
//   JSON read of the x-oracle mirror + LLM page-parse of x.com/naval.
//
// Burners are DETERMINISTIC (derived from the deployer key + a tag): keys are
// recoverable, funds never strand (lesson from the first E2E's createRandom).

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const E = (n) => ethers.parseEther(String(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(3000 + i * 1000); }
  }
  throw new Error(`${label}: ${last && (last.shortMessage || last.message)}`);
}

const TWEETS = {
  cola: "1519480761749016577",   // Musk "next I'm buying Coca-Cola" ~4.22M likes
  obama: "896523232098078720",   // Obama Charlottesville ~3.42M
  bird: "1585841080431321088",   // Musk "the bird is freed" ~2.18M
};
const synd = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);

  const bal = await withRetry(() => provider.getBalance(deployer.address), "balance");
  console.log(`deployer=${deployer.address} balance=${ethers.formatEther(bal)}`);
  console.log(`market=${man.addresses.predictionMarket}`);

  // deterministic burners (recoverable from the deployer key + tag)
  const burner = (tag) =>
    new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(process.env.PRIVATE_KEY + ":" + tag)), provider);
  const b1 = burner("e2e2-race");
  const b2 = burner("e2e2-followers");
  console.log(`burners: ${b1.address} (race), ${b2.address} (followers)`);

  const now = (await withRetry(() => provider.getBlock("latest"), "getBlock")).timestamp;
  const closeTs = now + 12 * 60;           // minLeadTime 10m + margin
  const deadline = closeTs + 45 * 60;      // minResolveBuffer 30m + margin
  const CV = E(0.5);                       // creationFee 0.2 + bond 0.3

  const count0 = Number(await withRetry(() => pm.marketCount(), "marketCount"));
  if (count0 !== 0) throw new Error(`expected a fresh deployment, marketCount=${count0}`);

  // ---- market 0: RACE ----
  console.log("creating market 0 (race: most-liked legendary tweet)...");
  await (await pm.createMarket(
    4,
    "Which legendary tweet has the most likes at close: Musk's Coca-Cola, Obama's Charlottesville, or Musk's bird-is-freed?",
    ["Musk Coca-Cola", "Obama love", "Musk bird freed", "nobody/tie"],
    closeTs, deadline,
    {
      primaryUrl: "0.json",
      primarySelector: "winner",
      secondaryUrl: "",
      secondarySelector: "",
      criteria: `Like counts of the three tweets at market close | x:race;tweets=${TWEETS.cola},${TWEETS.obama},${TWEETS.bird};metric=likes`,
      bucketBounds: [],
      raceUrls: [synd(TWEETS.cola), synd(TWEETS.obama), synd(TWEETS.bird)],
      raceSelectors: ["favorite_count", "favorite_count", "favorite_count"],
      raceThreshold: 0,
    },
    { value: CV }
  )).wait();

  // ---- market 1: FOLLOWERS_GTE (skippable: RACE_ONLY=1) ----
  // Live finding 2026-07-18: the Parse agent cannot extract from x.com
  // profile pages (2 rounds, 2 abstains) - profile markets stay OFF the
  // catalog until a second independent source exists.
  if (process.env.RACE_ONLY) {
    console.log("RACE_ONLY set: skipping the followers market");
  } else {
  console.log("creating market 1 (@naval >= 3.6M followers)...");
  await (await pm.createMarket(
    1,
    "Does @naval have at least 3,600,000 followers right now?",
    ["NO", "YES"],
    closeTs, deadline,
    {
      primaryUrl: "1.json",
      primarySelector: "value",
      secondaryUrl: "https://x.com/naval",
      secondarySelector: "",
      criteria: "Extract the exact total number of followers of the @naval account shown on this X profile page. Report the integer. | x:user=naval;metric=followers",
      bucketBounds: [3599999n],
      raceUrls: [],
      raceSelectors: [],
      raceThreshold: 0,
    },
    { value: CV }
  )).wait();
  }
  console.log(`markets created, closeTs=${new Date(closeTs * 1000).toISOString()}`);

  // ---- fund burners + bets (both sides of each pool) ----
  const burners = process.env.RACE_ONLY ? [[b1, "0.12"]] : [[b1, "0.12"], [b2, "0.12"]];
  for (const [w, amt] of burners) {
    if ((await provider.getBalance(w.address)) < E(0.1)) {
      await (await deployer.sendTransaction({ to: w.address, value: E(amt) })).wait();
    }
  }
  console.log("burners funded 0.12 STT each");

  await (await pm.connect(b1).bet(0, 1, { value: E(0.05) })).wait();   // Obama (expected loser)
  await (await pm.bet(0, 0, { value: E(0.1) })).wait();                // deployer on Coca-Cola (expected winner)
  if (!process.env.RACE_ONLY) {
    await (await pm.connect(b2).bet(1, 0, { value: E(0.05) })).wait(); // NO (expected loser)
    await (await pm.bet(1, 1, { value: E(0.1) })).wait();              // deployer on YES (expected winner)
  }
  console.log("bets placed");

  console.log(`
NEXT STEPS
  1. after ${new Date(closeTs * 1000).toLocaleTimeString()} run the oracle once:
       oracle/.venv/Scripts/python.exe oracle/xoracle.py --once
     verify: https://raw.githubusercontent.com/pSJLq/ShinyLuck-predictions/main/x-oracle/0.json and 1.json
  2. MARKET_ID=0 WIN_OUTCOME=0 npx hardhat run scripts/_testnet-resume.js --network somniaTestnet
  3. MARKET_ID=1 WIN_OUTCOME=1 npx hardhat run scripts/_testnet-resume.js --network somniaTestnet`);
}

main().catch((e) => { console.error(e); process.exit(1); });
