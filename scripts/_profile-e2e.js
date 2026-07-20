// Live proof that PROFILE markets now have a second independent source:
// X's public syndication timeline (syndication.twitter.com/srv/timeline-profile)
// serves followers_count without login, so the Parse agent can cross-check our
// x-oracle. Creates "@naval >= 3.6M followers?" on the current deployment.
//
//   npx hardhat run scripts/_profile-e2e.js --network somniaTestnet
// then after close: oracle --once + _testnet-resume.js MARKET_ID=<id> WIN_OUTCOME=1

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const E = (n) => ethers.parseEther(String(n));

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);

  const burner = new ethers.Wallet(
    ethers.keccak256(ethers.toUtf8Bytes(process.env.PRIVATE_KEY + ":e2e2-followers")), provider);

  const now = (await provider.getBlock("latest")).timestamp;
  const closeTs = now + 12 * 60;
  const deadline = closeTs + 45 * 60;

  const id = Number(await pm.marketCount());
  console.log(`creating market ${id}: @naval >= 3.6M followers (YES expected)`);
  await (await pm.createMarket(
    1, // FOLLOWERS_GTE
    "Does @naval have at least 3,600,000 followers right now?",
    ["NO", "YES"],
    closeTs, deadline,
    {
      primaryUrl: `${id}.json`,
      primarySelector: "value",
      secondaryUrl: "https://syndication.twitter.com/srv/timeline-profile/screen-name/naval",
      secondarySelector: "",
      criteria: "Extract the exact followers_count value of the @naval account from this page. Report the integer. | x:user=naval;metric=followers",
      bucketBounds: [3599999n],
      raceUrls: [],
      raceSelectors: [],
      raceThreshold: 0,
    },
    { value: E(0.5) }
  )).wait();

  if ((await provider.getBalance(burner.address)) < E(0.08)) {
    await (await deployer.sendTransaction({ to: burner.address, value: E(0.1) })).wait();
  }
  await (await pm.connect(burner).bet(id, 0, { value: E(0.05) })).wait(); // NO (expected loser)
  await (await pm.bet(id, 1, { value: E(0.1) })).wait();                  // deployer on YES
  console.log(`market ${id} live, closeTs=${new Date(closeTs * 1000).toISOString()}, bets 0.05 NO vs 0.1 YES`);
}

main().catch((e) => { console.error(e); process.exit(1); });
