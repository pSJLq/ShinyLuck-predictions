// Gen-5 board: one demo race (short close, resolved live by agents) + three
// OPEN markets with real horizons so the board is a living product, not a
// museum. Seed bets on both sides come from the deployer + a deterministic
// burner - normal market-making, visible on-chain as any other bet.
//
//   npx hardhat run scripts/_board-gen5.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const E = (n) => ethers.parseEther(String(n));

const TWEETS = {
  cola: "1519480761749016577",
  obama: "896523232098078720",
  bird: "1585841080431321088",
  fresh: "2078692662345888102", // Elon's latest original tweet, ~1.9k likes at creation
};
const synd = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;
const CV = E(0.5);

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);
  const b1 = new ethers.Wallet(
    ethers.keccak256(ethers.toUtf8Bytes(process.env.PRIVATE_KEY + ":e2e2-race")), provider);

  const now = (await provider.getBlock("latest")).timestamp;
  console.log(`deployer bal: ${ethers.formatEther(await provider.getBalance(deployer.address))}`);

  // ---- market 0: DEMO RACE, closes in 12 min, resolved live by agents ----
  await (await pm.createMarket(
    4,
    "Which legendary tweet has the most likes at close: Musk's Coca-Cola, Obama's Charlottesville, or Musk's bird-is-freed?",
    ["Musk Coca-Cola", "Obama love", "Musk bird freed", "nobody/tie"],
    now + 12 * 60, now + 12 * 60 + 45 * 60,
    {
      primaryUrl: "0.json", primarySelector: "winner", secondaryUrl: "", secondarySelector: "",
      criteria: `Like counts of the three tweets at market close | x:race;tweets=${TWEETS.cola},${TWEETS.obama},${TWEETS.bird};metric=likes`,
      bucketBounds: [],
      raceUrls: [synd(TWEETS.cola), synd(TWEETS.obama), synd(TWEETS.bird)],
      raceSelectors: ["favorite_count", "favorite_count", "favorite_count"],
      raceThreshold: 0,
    }, { value: CV })).wait();
  console.log("market 0: demo race created (close +12m)");

  // ---- market 1: viral threshold on a FRESH tweet, closes in 20h ----
  await (await pm.createMarket(
    0,
    "Will Elon's latest post pass 50,000 likes within 20 hours?",
    ["NO", "YES"],
    now + 20 * 3600, now + 24 * 3600,
    {
      primaryUrl: "1.json", primarySelector: "value",
      secondaryUrl: synd(TWEETS.fresh), secondarySelector: "favorite_count",
      criteria: `Like count of the tweet at market close | x:tweet=${TWEETS.fresh};metric=likes`,
      bucketBounds: [49999n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
    }, { value: CV })).wait();
  console.log("market 1: viral threshold created (close +20h)");

  // ---- market 2: SINGLE-SOURCE followers market, closes in 24h ----
  await (await pm.createMarket(
    1,
    "Does @Somnia_Network reach 431,000 followers within 24 hours?",
    ["NO", "YES"],
    now + 24 * 3600, now + 28 * 3600,
    {
      primaryUrl: "2.json", primarySelector: "value",
      secondaryUrl: "", secondarySelector: "", // single-source: labeled openly in the UI
      criteria: "Follower count of @Somnia_Network at market close | x:user=Somnia_Network;metric=followers",
      bucketBounds: [430999n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
    }, { value: CV })).wait();
  console.log("market 2: followers single-source created (close +24h)");

  // ---- market 3: posts-per-day buckets, closes after Jul 20 UTC ends ----
  const close3 = Math.floor(Date.parse("2026-07-21T00:05:00Z") / 1000);
  await (await pm.createMarket(
    2,
    "How many posts does @elonmusk publish on July 20 (UTC)?",
    ["0-9", "10-19", "20+"],
    close3, close3 + 2 * 3600,
    {
      primaryUrl: "3.json", primarySelector: "value",
      secondaryUrl: "", secondarySelector: "", // single-source
      criteria: "Number of posts authored by @elonmusk dated 2026-07-20 UTC | x:user=elonmusk;metric=posts;date=2026-07-20",
      bucketBounds: [9n, 19n], raceUrls: [], raceSelectors: [], raceThreshold: 0,
    }, { value: CV })).wait();
  console.log("market 3: posts buckets created (close Jul 21 00:05 UTC)");

  // ---- seed liquidity: deployer + burner on opposite sides ----
  if ((await provider.getBalance(b1.address)) < E(0.25)) {
    await (await deployer.sendTransaction({ to: b1.address, value: E(0.3) })).wait();
  }
  await (await pm.bet(0, 0, { value: E(0.1) })).wait();
  await (await pm.connect(b1).bet(0, 1, { value: E(0.05) })).wait();
  await (await pm.bet(1, 1, { value: E(0.1) })).wait();
  await (await pm.connect(b1).bet(1, 0, { value: E(0.06) })).wait();
  await (await pm.bet(2, 0, { value: E(0.08) })).wait();
  await (await pm.connect(b1).bet(2, 1, { value: E(0.06) })).wait();
  await (await pm.bet(3, 1, { value: E(0.08) })).wait();
  await (await pm.connect(b1).bet(3, 2, { value: E(0.05) })).wait();
  console.log("seed bets placed on all markets");

  const d0 = await pm.resolveData(0);
  console.log(`demo race closeTs: ${new Date(Number(d0[2]) * 1000).toISOString()}`);
  console.log(`deployer bal: ${ethers.formatEther(await provider.getBalance(deployer.address))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
