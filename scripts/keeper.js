// Predictions keeper (reveal-bot pattern, minimal): watches every market and
//   - fires resolver.startResolve once betting closes (and re-fires after a
//     failed/timed-out round, up to the contract's maxRounds),
//   - calls market.voidExpired past the resolve deadline so funds never stick,
//   - closes hung rounds via resolver.expireRound.
//
// Run:  node scripts/keeper.js            (defaults to somniaTestnet manifest)
//       NETWORK=localhost node scripts/keeper.js
//
// Single signer, sequential txs - the volumes here are tiny (a resolve round
// per market, not per bet), so no pipelining is needed.

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const NETWORK = process.env.NETWORK || "somniaTestnet";
const POLL_MS = parseInt(process.env.POLL_MS || "15000", 10);

const RPCS = {
  somniaTestnet: process.env.RPC_TESTNET || "https://api.infra.testnet.somnia.network",
  localhost: "http://127.0.0.1:8545",
};

const PM_ABI = [
  "function marketCount() view returns (uint256)",
  "function resolveData(uint256) view returns (uint8 state, uint8 template, uint64 closeTs, uint64 resolveDeadline, uint8 nOutcomes, uint256 total, (string,string,string,string,string,uint256[],string[],string[],uint256) spec, string[] labels)",
  "function voidExpired(uint256)",
];
const RES_ABI = [
  "function startResolve(uint256)",
  "function expireRound(uint256)",
  "function getRound(uint256) view returns (uint32 seq, bool active, uint8 fired, uint8 received, uint8 roundsUsed, uint8[8] votes, uint256[8] raw)",
  "function roundTimeout() view returns (uint64)",
  "function maxRounds() view returns (uint8)",
  "function quoteRoundCost(uint256) view returns (uint256)",
];

async function main() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${NETWORK}.json`), "utf8")
  );
  const provider = new ethers.JsonRpcProvider(RPCS[NETWORK]);
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const pm = new ethers.Contract(manifest.addresses.predictionMarket, PM_ABI, signer);
  const resolver = new ethers.Contract(manifest.addresses.xOracleResolver, RES_ABI, signer);

  console.log(`[keeper] network=${NETWORK} signer=${signer.address}`);
  console.log(`[keeper] market=${manifest.addresses.predictionMarket} resolver=${manifest.addresses.xOracleResolver}`);

  const roundTimeout = Number(await resolver.roundTimeout());
  const maxRounds = Number(await resolver.maxRounds());
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const count = Number(await pm.marketCount());
      for (let id = 0; id < count; id++) {
        let d;
        try { d = await pm.resolveData(id); } catch (e) { continue; }
        const state = Number(d[0]);
        if (state !== 0) continue; // only Open markets need us
        const closeTs = Number(d[2]);
        const deadline = Number(d[3]);
        const total = d[5];

        // Past the deadline: refunds for everyone, no questions asked.
        if (now > deadline) {
          try {
            const tx = await pm.voidExpired(id);
            await tx.wait();
            console.log(`[keeper] voided expired market ${id} tx=${tx.hash}`);
          } catch (e) { logSkip("voidExpired", id, e); }
          continue;
        }

        // Grace period after close: the x-oracle (60s poll) must publish its
        // measurement BEFORE the first round fires, or the JSON vote reads a
        // 404 and burns a round on nothing.
        const grace = parseInt(process.env.KEEPER_GRACE_S || "180", 10);
        if (now < closeTs + grace) continue;  // betting open / oracle publishing
        if (total === 0n) continue;          // zero-pool: let it void at deadline

        const round = await resolver.getRound(id);
        const active = round[1];
        const roundsUsed = Number(round[4]);

        if (active) {
          // hung round past its timeout -> close it (next tick restarts)
          const startedAt = await roundStartedAt(id);
          if (startedAt !== null && now >= startedAt + roundTimeout) {
            try {
              const tx = await resolver.expireRound(id);
              await tx.wait();
              console.log(`[keeper] expired hung round for market ${id}`);
            } catch (e) { logSkip("expireRound", id, e); }
          }
          continue;
        }

        if (roundsUsed >= maxRounds) continue; // exhausted: deadline void will handle it

        try {
          const tx = await resolver.startResolve(id);
          await tx.wait();
          console.log(`[keeper] startResolve market ${id} (round ${roundsUsed + 1}/${maxRounds}) tx=${tx.hash}`);
        } catch (e) { logSkip("startResolve", id, e); }
      }
    } catch (e) {
      console.warn(`[keeper] tick: ${e.shortMessage || e.message}`);
    } finally {
      busy = false;
    }
  }

  // getRound doesn't expose startedAt; read it from the public rounds mapping.
  const ROUNDS_ABI = ["function rounds(uint256) view returns (uint32 seq, uint8 fired, uint8 received, uint8 roundsUsed, uint64 startedAt, bool active, bool isRace)"];
  const resolverRounds = new ethers.Contract(manifest.addresses.xOracleResolver, ROUNDS_ABI, provider);
  async function roundStartedAt(id) {
    try {
      const r = await resolverRounds.rounds(id);
      return Number(r.startedAt);
    } catch (_) { return null; }
  }

  function logSkip(op, id, e) {
    const msg = e.shortMessage || e.message || "";
    // expected races/reverts are quiet
    if (/RoundInFlight|RoundsExhausted|NoBets|MarketNotResolvable|NotYetExpired|BadState|not expired/.test(msg)) return;
    console.warn(`[keeper] ${op}(${id}): ${msg}`);
  }

  await tick();
  setInterval(tick, POLL_MS);
}

main().catch((e) => { console.error(e); process.exit(1); });
