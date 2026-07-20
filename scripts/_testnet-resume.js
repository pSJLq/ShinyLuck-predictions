// Resume/harden the live testnet E2E on an already-created market.
// Retries every RPC read (public Somnia RPC blips), proves the real agent
// resolve + a claim with a key we control (the deployer bets a small amount
// on the expected winner before close).
//
//   MARKET_ID=0 WIN_OUTCOME=1 npx hardhat run scripts/_testnet-resume.js --network somniaTestnet

const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

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

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);
  const resolver = await ethers.getContractAt("XOracleResolver", man.addresses.xOracleResolver);

  const id = BigInt(process.env.MARKET_ID || "0");
  const WIN = Number(process.env.WIN_OUTCOME || "1");
  console.log(`resuming market #${id} (expected winner outcome ${WIN})`);

  // --- controlled bet for a live claim proof (if still open) ---
  let d = await withRetry(() => pm.resolveData(id), "resolveData");
  let state = Number(d[0]);
  const closeTs = Number(d[2]);
  const now = (await withRetry(() => provider.getBlock("latest"), "getBlock")).timestamp;
  if (state === 0 && now < closeTs - 10) {
    const before = await withRetry(() => pm.stakesOf(id, deployer.address), "stakesOf");
    if (before[WIN] === 0n) {
      const tx = await pm.bet(id, WIN, { value: E(0.1) });
      await tx.wait();
      console.log(`deployer bet 0.1 STT on outcome ${WIN} (for claim proof)`);
    }
  }

  // --- wait for close ---
  console.log("waiting for closeTs...");
  while (true) {
    const t = (await withRetry(() => provider.getBlock("latest"), "getBlock")).timestamp;
    if (t >= closeTs + 3) break;
    await sleep(15000);
  }

  // --- fire the real agent round (if not already in flight / resolved) ---
  d = await withRetry(() => pm.resolveData(id), "resolveData");
  state = Number(d[0]);
  if (state === 0) {
    const round = await withRetry(() => resolver.getRound(id), "getRound");
    if (!round.active) {
      const cost = await withRetry(() => resolver.quoteRoundCost(id), "quote");
      const rbal = await withRetry(() => provider.getBalance(man.addresses.xOracleResolver), "rbal");
      console.log(`round cost ${ethers.formatEther(cost)} STT, resolver bal ${ethers.formatEther(rbal)}`);
      if (rbal < cost) { await (await deployer.sendTransaction({ to: man.addresses.xOracleResolver, value: cost })).wait(); }
      const tx = await resolver.startResolve(id);
      const rc = await tx.wait();
      const reqIds = [];
      for (const log of rc.logs) {
        try { const p = resolver.interface.parseLog(log); if (p && p.name === "VoteRequestFired") reqIds.push(p.args.requestId.toString()); } catch (_) {}
      }
      console.log(`round fired, requestIds: ${reqIds.join(", ")}`);
      console.log(`receipts: https://agents.testnet.somnia.network`);
    } else {
      console.log("a round is already in flight");
    }
  }

  // --- watch for resolution ---
  console.log("waiting for agent consensus (platform timeout ~15m)...");
  const deadlineMs = Date.now() + 22 * 60 * 1000;
  while (Date.now() < deadlineMs) {
    d = await withRetry(() => pm.resolveData(id), "resolveData");
    state = Number(d[0]);
    const round = await withRetry(() => resolver.getRound(id), "getRound");
    process.stdout.write(`\r  state=${state} votes=[${round.votes.join(",")}] received=${round.received} rounds=${round.roundsUsed}   `);
    if (state !== 0) break;
    // if a round finished without consensus, kick another (up to maxRounds)
    if (!round.active && round.roundsUsed < 4 && round.received >= round.fired && round.fired > 0) {
      try { await (await resolver.startResolve(id)).wait(); console.log("\n  retry round fired"); } catch (_) {}
    }
    await sleep(20000);
  }
  console.log();

  const [m] = await withRetry(() => pm.getMarket(id), "getMarket");
  console.log(`FINAL: state=${m.state} (1=Resolved 2=Voided) winner=${m.winner}`);

  if (Number(m.state) !== 0) {
    const claimable = await withRetry(() => pm.claimableOf(id, deployer.address), "claimable");
    if (claimable > 0n) {
      await (await pm.claim(id)).wait();
      console.log(`deployer CLAIMED ${ethers.formatEther(claimable)} STT`);
    } else {
      console.log("deployer had nothing claimable (lost the bet or didn't bet)");
    }
  }
  console.log("resume E2E done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
