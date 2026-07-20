// E2E gen-2 cleanup: void the expired followers market (its Parse vote cannot
// land - x.com profile pages defeat the Parse agent, both live rounds proved
// it), reclaim every refundable STT, and sweep the deterministic burners back
// into the deployer so nothing strands on testnet.
//
//   npx hardhat run scripts/_e2e2-cleanup.js --network somniaTestnet

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

async function main() {
  const man = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const pm = await ethers.getContractAt("PredictionMarket", man.addresses.predictionMarket);

  const burner = (tag) =>
    new ethers.Wallet(ethers.keccak256(ethers.toUtf8Bytes(process.env.PRIVATE_KEY + ":" + tag)), provider);
  const b1 = burner("e2e2-race");
  const b2 = burner("e2e2-followers");

  // --- wait for market 1's resolve deadline, then void for refunds ---
  const d = await withRetry(() => pm.resolveData(1), "resolveData");
  const deadline = Number(d[3]);
  if (Number(d[0]) === 0) {
    console.log(`waiting for market 1 deadline (${new Date(deadline * 1000).toISOString()})...`);
    while (true) {
      const t = (await withRetry(() => provider.getBlock("latest"), "getBlock")).timestamp;
      if (t > deadline + 2) break;
      await sleep(15000);
    }
    await (await pm.voidExpired(1)).wait();
    console.log("market 1 voidExpired -> full refunds");
  } else {
    console.log(`market 1 already settled (state=${d[0]})`);
  }

  // --- deployer refunds: stake on market 1 + accrued bonds/creator fees ---
  const c1 = await withRetry(() => pm.claimableOf(1, deployer.address), "claimable d1");
  if (c1 > 0n) {
    await (await pm.claim(1)).wait();
    console.log(`deployer reclaimed ${ethers.formatEther(c1)} STT stake from market 1`);
  }
  const pend = await withRetry(() => pm.pendingFunds(deployer.address), "pendingFunds");
  if (pend > 0n) {
    await (await pm.claimFunds()).wait();
    console.log(`deployer claimed ${ethers.formatEther(pend)} STT pending (bonds + creator fees)`);
  }

  // --- burner refunds + sweep everything back to the deployer ---
  for (const [w, tag, marketId] of [[b1, "race", 0], [b2, "followers", 1]]) {
    const cl = await withRetry(() => pm.claimableOf(marketId, w.address), `claimable ${tag}`);
    if (cl > 0n) {
      await (await pm.connect(w).claim(marketId)).wait();
      console.log(`burner ${tag} reclaimed ${ethers.formatEther(cl)} STT`);
    }
    const bal = await withRetry(() => provider.getBalance(w.address), `bal ${tag}`);
    if (bal > E(0.01)) {
      // legacy-type tx: exact upfront cost is gasLimit * gasPrice, so the
      // whole remainder can be swept (1559's maxFeePerGas reserves more)
      const fee = await provider.getFeeData();
      const gasPrice = fee.gasPrice ?? E(0.000000006);
      const gas = 21000n * gasPrice;
      await (await w.sendTransaction({
        to: deployer.address, value: bal - gas, gasLimit: 21000, gasPrice, type: 0,
      })).wait();
      console.log(`burner ${tag} swept ${ethers.formatEther(bal - gas)} STT -> deployer`);
    }
  }

  const final = await withRetry(() => provider.getBalance(deployer.address), "final bal");
  const rbal = await withRetry(() => provider.getBalance(man.addresses.xOracleResolver), "resolver bal");
  console.log(`FINAL balances: deployer ${ethers.formatEther(final)} STT, resolver ${ethers.formatEther(rbal)} STT`);
  console.log("cleanup done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
