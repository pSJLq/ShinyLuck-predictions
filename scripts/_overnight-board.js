// Overnight catalog: one live market of EVERY handoff format, timed to close
// through the night so the keeper + x-oracle resolve them by morning. Seed
// bets on both sides so no market auto-voids for lack of a counterparty.
//
//   npx hardhat run scripts/_overnight-board.js --network somniaTestnet
//
// Formats covered: viral-likes (dual-source), likes RACE (argmax),
// followers bucket, posts-per-day buckets, word/tag mention, reply-under-post,
// set-count (how many KOL posted X), posting streak, freeform-LLM, tweet
// deletion. All profile/search metrics are single-source (X login wall) and
// labeled so in the UI; likes/race use public syndication (dual-source).

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const E = (n) => ethers.parseEther(String(n));
const synd = (id) => `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`;

// live inputs gathered 2026-07-19 ~17:30 UTC
const ELON_FRESH = "2078880263556243538";               // ~8.5k likes, 1h old
const LEG = { cola: "1519480761749016577", obama: "896523232098078720", bird: "1585841080431321088" };
const SOMNIA_POST = "2077001571561242678";              // latest @Somnia_Network post

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [dep] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);
  const resolver = man.addresses.xOracleResolver;

  // top up the resolver so 10 markets' agent rounds are covered
  const rbal = await provider.getBalance(resolver);
  if (rbal < E(6)) {
    await (await dep.sendTransaction({ to: resolver, value: E(6) - rbal })).wait();
    console.log(`resolver topped up to 6 STT`);
  }

  const b = new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(process.env.PRIVATE_KEY + ":overnight")), provider);
  if ((await provider.getBalance(b.address)) < E(1)) {
    await (await dep.sendTransaction({ to: b.address, value: E(1.5) })).wait();
  }

  const now = (await provider.getBlock("latest")).timestamp;
  const M = 60, CV = E(0.5);
  const spec = (o) => ({
    primaryUrl: o.primaryUrl ?? "", primarySelector: o.primarySelector ?? "value",
    secondaryUrl: o.secondaryUrl ?? "", secondarySelector: o.secondarySelector ?? "",
    criteria: o.criteria ?? "", bucketBounds: o.bucketBounds ?? [],
    raceUrls: o.raceUrls ?? [], raceSelectors: o.raceSelectors ?? [], raceThreshold: o.raceThreshold ?? 0,
  });
  const at = (mins) => now + mins * M;

  // id assigned by the contract = current marketCount + index in this list
  const base = Number(await pm.marketCount());
  const jid = (i) => `${base + i}.json`;

  // [template, question, outcomes, closeMin, spec, seedOutcomes[2]]
  const L = [];
  // 0 viral likes (dual-source syndication)
  L.push([0, "Will Elon's latest post pass 10,000 likes by close?", ["NO", "YES"], 120,
    (i) => spec({ primaryUrl: jid(i), secondaryUrl: synd(ELON_FRESH), secondarySelector: "favorite_count",
      criteria: `Like count of the tweet at close | x:tweet=${ELON_FRESH};metric=likes`, bucketBounds: [9999n] }), [1, 0]]);
  // 1 likes RACE (argmax over 3 legendary tweets)
  L.push([4, "Most-liked at close: Musk's Coca-Cola, Obama's Charlottesville, or Musk's bird-is-freed?",
    ["Musk Coca-Cola", "Obama love", "Musk bird freed", "nobody/tie"], 75,
    (i) => spec({ primaryUrl: jid(i), primarySelector: "winner",
      criteria: `Like counts at close | x:race;tweets=${LEG.cola},${LEG.obama},${LEG.bird};metric=likes`,
      raceUrls: [synd(LEG.cola), synd(LEG.obama), synd(LEG.bird)], raceSelectors: ["favorite_count", "favorite_count", "favorite_count"] }), [0, 1]]);
  // 2 followers bucket (single-source)
  L.push([1, "Will @Somnia_Network reach 430,900 followers by close?", ["NO", "YES"], 105,
    (i) => spec({ primaryUrl: jid(i), criteria: "Followers at close | x:user=Somnia_Network;metric=followers", bucketBounds: [430899n] }), [1, 0]]);
  // 3 posts-per-day buckets (single-source) - closes after Jul 19 UTC ends
  L.push([2, "How many posts does @elonmusk publish on July 19 (UTC)?", ["0-9", "10-19", "20+"], 400,
    (i) => spec({ primaryUrl: jid(i), criteria: "Posts on 2026-07-19 UTC | x:user=elonmusk;metric=posts;date=2026-07-19", bucketBounds: [9n, 19n] }), [1, 2]]);
  // 4 word/tag mention (single-source, timeline scan)
  L.push([1, "Will @elonmusk post a tweet containing \"AI\" on July 19 (UTC)?", ["NO", "YES"], 135,
    (i) => spec({ primaryUrl: jid(i), criteria: "Own tweets containing AI | x:user=elonmusk;metric=mentions;q=AI;since=2026-07-19;until=2026-07-20", bucketBounds: [0n] }), [1, 0]]);
  // 5 reply-under-post (single-source)
  L.push([1, "Will @0xpaulthomas reply under @Somnia_Network's latest post by close?", ["NO", "YES"], 165,
    (i) => spec({ primaryUrl: jid(i), criteria: `Reply in the conversation | x:user=0xpaulthomas;metric=replied;post=${SOMNIA_POST}`, bucketBounds: [0n] }), [0, 1]]);
  // 6 set-count (how many of a KOL set posted the word)
  L.push([1, "How many of @dreamdexsomnia / @prophecysocial_ / @SomniaEco posted \"somnia\" on July 19?", ["0-1", "2", "3"], 195,
    (i) => spec({ primaryUrl: jid(i), criteria: "Set members posting somnia | x:setcount;users=dreamdexsomnia,prophecysocial_,SomniaEco;metric=setcount;q=somnia;since=2026-07-19;until=2026-07-20", bucketBounds: [1n, 2n] }), [1, 2]]);
  // 7 posting streak (single-source)
  L.push([1, "Did @elonmusk post every day from July 12 to 18 (UTC, 7 days)?", ["NO", "YES"], 225,
    (i) => spec({ primaryUrl: jid(i), criteria: "Distinct active days | x:user=elonmusk;metric=streak;since=2026-07-12;until=2026-07-19", bucketBounds: [6n] }), [1, 0]]);
  // 8 freeform LLM (3 votes, resolves from model knowledge - no live X)
  L.push([3, "Did Ethereum transition to proof-of-stake (The Merge) before 2023?", ["YES", "NO"], 255,
    () => spec({ criteria: "Answer strictly from established fact: did Ethereum complete its transition to proof-of-stake (The Merge, Sep 2022) before the year 2023?" }), [0, 1]]);
  // 9 tweet deletion (dual-source: twscrape + syndication)
  L.push([1, "Is Musk's Coca-Cola tweet still up (not deleted) at close?", ["Still up", "Deleted"], 285,
    (i) => spec({ primaryUrl: jid(i), criteria: `Deletion check | x:tweet=${LEG.cola};metric=deleted`, bucketBounds: [0n] }), [0, 1]]);

  for (let i = 0; i < L.length; i++) {
    const [tpl, q, outs, cmin, sfn, seed] = L[i];
    const close = at(cmin), deadline = close + 90 * M;
    await (await pm.createMarket(tpl, q, outs, close, deadline, sfn(i), { value: CV })).wait();
    // seed both sides so the winning outcome always has a counterparty
    await (await pm.bet(base + i, seed[0], { value: E(0.08) })).wait();
    await (await pm.connect(b).bet(base + i, seed[1], { value: E(0.05) })).wait();
    console.log(`#${base + i} [tpl ${tpl}] close +${cmin}m  ${q.slice(0, 46)}`);
  }

  console.log(`\ncreated ${L.length} markets (#${base}..#${base + L.length - 1})`);
  console.log(`deployer bal: ${ethers.formatEther(await provider.getBalance(dep.address))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
