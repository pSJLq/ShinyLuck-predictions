// Inversion check: every market here is engineered so the TRUE answer is the
// OPPOSITE of last night's run. If the pipeline were hardcoded/lucky rather
// than actually reading reality, these would come back wrong.
// All facts are already settled, so each resolves on the first agent round.
//
//   npx hardhat run scripts/_inverted-check.js --network somniaTestnet
//
// last night -> tonight
//   replied  NO       -> YES  (@ShinyViq did reply under djaikoku's post)
//   mentions NO       -> YES  (@ShinyViq wrote "morning" on Jul 19)
//   followers NO      -> YES  (threshold set below the real count)
//   streak   YES      -> NO   (@ShinyLuck_ does not post daily)
//   freeform YES      -> NO   (Bitcoin never moved to proof-of-stake)
//   race     index 0  -> index 2 (contenders reordered; argmax must follow)
//   viral    VOIDED   -> YES  (stable legendary tweet, no hot-tweet rate limit)
//   deleted  Still up -> Deleted (non-existent tweet id)
//   posts    10-19    -> 0-2  (quiet account instead of @elonmusk)

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const E = (n) => ethers.parseEther(String(n));
const synd = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;
const LEG = { cola: "1519480761749016577", obama: "896523232098078720", bird: "1585841080431321088" };
const DJ_POST = "2078380433880780895";   // @djaikoku post @ShinyViq replied under
const GHOST = "1111111111111111111";     // valid-shaped id that does not exist

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [dep] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);
  const b = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(process.env.PRIVATE_KEY + ":overnight")), provider);
  if ((await provider.getBalance(b.address)) < E(0.5)) {
    await (await dep.sendTransaction({ to: b.address, value: E(1) })).wait();
  }
  const rbal = await provider.getBalance(man.addresses.xOracleResolver);
  if (rbal < E(5)) {
    await (await dep.sendTransaction({ to: man.addresses.xOracleResolver, value: E(5) - rbal })).wait();
    console.log("resolver topped up to 5 STT");
  }

  const now = (await provider.getBlock("latest")).timestamp;
  const CV = E(0.5), M = 60;
  const base = Number(await pm.marketCount());
  const jid = (i) => `${base + i}.json`;
  const spec = (o) => ({
    primaryUrl: o.primaryUrl ?? "", primarySelector: o.primarySelector ?? "value",
    secondaryUrl: o.secondaryUrl ?? "", secondarySelector: o.secondarySelector ?? "",
    criteria: o.criteria ?? "", bucketBounds: o.bucketBounds ?? [],
    raceUrls: o.raceUrls ?? [], raceSelectors: o.raceSelectors ?? [], raceThreshold: o.raceThreshold ?? 0,
  });

  // [template, question, outcomes, closeMin, specFn, betOutcomes, expected]
  const L = [
    [1, "Did @ShinyViq reply under @djaikoku's post (2078380433880780895)?", ["NO", "YES"], 11,
      (i) => spec({ primaryUrl: jid(i), bucketBounds: [0n],
        criteria: `Reply in that conversation | x:user=ShinyViq;metric=replied;post=${DJ_POST}` }), [0, 1], "YES"],
    [1, "Did @ShinyViq post a tweet containing \"morning\" since July 19?", ["NO", "YES"], 12,
      (i) => spec({ primaryUrl: jid(i), bucketBounds: [0n],
        criteria: "Own tweets containing morning | x:user=ShinyViq;metric=mentions;q=morning;since=2026-07-19" }), [0, 1], "YES"],
    [1, "Does @Somnia_Network have at least 430,000 followers?", ["NO", "YES"], 13,
      (i) => spec({ primaryUrl: jid(i), bucketBounds: [429999n],
        criteria: "Followers now | x:user=Somnia_Network;metric=followers" }), [0, 1], "YES"],
    [1, "Did @ShinyLuck_ post every day from July 12 to 18 (UTC, 7 days)?", ["NO", "YES"], 14,
      (i) => spec({ primaryUrl: jid(i), bucketBounds: [6n],
        criteria: "Distinct active days | x:user=ShinyLuck_;metric=streak;since=2026-07-12;until=2026-07-19" }), [0, 1], "NO"],
    [3, "Did Bitcoin transition to proof-of-stake before 2023?", ["YES", "NO"], 15,
      () => spec({ criteria: "Answer strictly from established fact: did the Bitcoin network transition from proof-of-work to proof-of-stake before the year 2023?" }), [0, 1], "NO"],
    [4, "Most-liked of these three tweets (order reshuffled)?",
      ["Musk bird freed", "Obama love", "Musk Coca-Cola", "nobody/tie"], 16,
      (i) => spec({ primaryUrl: jid(i), primarySelector: "winner",
        criteria: `Like counts | x:race;tweets=${LEG.bird},${LEG.obama},${LEG.cola};metric=likes`,
        raceUrls: [synd(LEG.bird), synd(LEG.obama), synd(LEG.cola)],
        raceSelectors: ["favorite_count", "favorite_count", "favorite_count"] }), [2, 0], "Musk Coca-Cola"],
    [0, "Does Musk's Coca-Cola tweet have at least 1,000,000 likes?", ["NO", "YES"], 17,
      (i) => spec({ primaryUrl: jid(i), secondaryUrl: synd(LEG.cola), secondarySelector: "favorite_count",
        bucketBounds: [999999n], criteria: `Like count | x:tweet=${LEG.cola};metric=likes` }), [0, 1], "YES"],
    [1, "Is tweet 1111111111111111111 unavailable (deleted / never existed)?", ["Still up", "Deleted"], 18,
      (i) => spec({ primaryUrl: jid(i), bucketBounds: [0n],
        criteria: `Availability check | x:tweet=${GHOST};metric=deleted` }), [0, 1], "Deleted"],
    [2, "How many posts did @ShinyLuck_ publish on July 19 (UTC)?", ["0-2", "3-9", "10+"], 19,
      (i) => spec({ primaryUrl: jid(i), bucketBounds: [2n, 9n],
        criteria: "Posts on 2026-07-19 UTC | x:user=ShinyLuck_;metric=posts;date=2026-07-19" }), [0, 1], "0-2"],
  ];

  for (let i = 0; i < L.length; i++) {
    const [tpl, q, outs, cmin, sfn, bets, exp] = L[i];
    const close = now + cmin * M, deadline = close + 35 * M;
    await (await pm.createMarket(tpl, q, outs, close, deadline, sfn(i), { value: CV })).wait();
    await (await pm.bet(base + i, bets[0], { value: E(0.06) })).wait();
    await (await pm.connect(b).bet(base + i, bets[1], { value: E(0.05) })).wait();
    console.log(`#${base + i} close +${cmin}m  expect ${exp.padEnd(16)} | ${q.slice(0, 44)}`);
  }
  console.log(`\ncreated ${L.length} inversion markets #${base}..#${base + L.length - 1}`);
  console.log(`deployer: ${ethers.formatEther(await provider.getBalance(dep.address))} STT`);
}

main().catch((e) => { console.error(e); process.exit(1); });
