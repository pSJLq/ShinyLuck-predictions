/* ShinyLuck Predictions — local dev UI.
 * Reads window.PREDICTIONS_CONFIG (web/config.js, written by scripts/deploy.js).
 * Wallet: injected EIP-1193 (MetaMask) for local dev; on the real site this
 * page is embedded in the ShinyLuck shell and signs through PrivySigner.
 *
 * Layout: Polymarket-style market grid; clicking a card opens a detail view
 * with an odds-history chart (rebuilt from on-chain BetPlaced logs — no
 * indexer) and a trade panel. Parimutuel: "price" of an outcome is its pool
 * share; payouts split the losing pools, fees come off the losing side only.
 */

const CFG = window.PREDICTIONS_CONFIG || {};
const E = ethers;

const PM_ABI = [
  "function marketCount() view returns (uint256)",
  "function curatedMode() view returns (bool)",
  "function creationFee() view returns (uint256)",
  "function creatorBondAmount() view returns (uint256)",
  "function minBet() view returns (uint256)",
  "function getMarket(uint256) view returns (tuple(address creator,uint64 closeTs,uint64 resolveDeadline,uint8 nOutcomes,uint8 winner,uint8 state,uint8 template,uint16 platformFeeBps,uint16 creatorFeeBps,uint256 creatorBond,uint256 total) m, string question, string[] outcomeLabels)",
  "function getPools(uint256) view returns (uint256[8])",
  "function claimableOf(uint256,address) view returns (uint256)",
  "function stakesOf(uint256,address) view returns (uint256[8])",
  "function claimed(uint256,address) view returns (bool)",
  "function createMarket(uint8 template,string question,string[] outcomeLabels,uint64 closeTs,uint64 resolveDeadline,tuple(string primaryUrl,string primarySelector,string secondaryUrl,string secondarySelector,string criteria,uint256[] bucketBounds,string[] raceUrls,string[] raceSelectors,uint256 raceThreshold) spec) payable returns (uint256)",
  "function bet(uint256,uint8) payable",
  "function claim(uint256)",
  "event BetPlaced(uint256 indexed marketId, address indexed player, uint8 outcome, uint256 amount)",
  "event MarketCreated(uint256 indexed marketId, address indexed creator, uint8 template, string question, uint64 closeTs, uint64 resolveDeadline)",
  "function getSpec(uint256) view returns (tuple(string primaryUrl,string primarySelector,string secondaryUrl,string secondarySelector,string criteria,uint256[] bucketBounds,string[] raceUrls,string[] raceSelectors,uint256 raceThreshold))",
];

// View-calls only: Somnia's public RPC caps eth_getLogs at 1000 blocks, so
// provenance lives in resolver state (getVoteMeta/getRound), not log scans.
const RES_ABI = [
  "function getRound(uint256) view returns (uint32 seq, bool active, uint8 fired, uint8 received, uint8 roundsUsed, uint8[8] votes, uint256[8] raw)",
  "function getVoteMeta(uint256) view returns (uint256[8] requestIds, uint256[8] agentIds, uint32[8] responded, uint32[8] agreed)",
  "function oracleBaseUrl() view returns (string)",
  "function maxRounds() view returns (uint8)",
  "function subSize() view returns (uint8)",
];
// pre-stats resolver generations return 2 arrays; used as a decode fallback
const RES_ABI_LEGACY = [
  "function getVoteMeta(uint256) view returns (uint256[8] requestIds, uint256[8] agentIds)",
];

// Somnia base agents (IDs identical on testnet and mainnet)
const AGENT_NAMES = {
  "13174292974160097713": "JSON API",
  "12847293847561029384": "LLM Inference",
  "12875401142070969085": "LLM Parse Website",
};
const VOTE_ABSTAIN = 255, VOTE_PENDING = 254, VOTE_MEASURED = 253;

const STATE = ["Open", "Resolved", "Voided"];
const TEMPLATES = ["Tweet metric", "Followers", "Posts/day", "Freeform", "Race"];

// Categorical series palette, gold-first, validated for this dark surface
// (dataviz six checks: lightness band, chroma, CVD separation, contrast).
// Identity is never color-alone: legend + direct labels ride along.
const SERIES = ["#C98500", "#3987E5", "#D55181", "#008300", "#9085E9", "#E66767", "#199E70", "#D95926"];

let provider, signer, account, pm, pmRead, resolverRead;
let detailId = null;   // market open in the detail view
let tradeSel = 0;      // selected outcome index in the trade panel
let blockTsCache = new Map();
let oracleBase = "";   // resolver.oracleBaseUrl, fetched once
let subSizeVal = 3;    // resolver.subSize, fetched once

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const fmt = (wei) => Number(E.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const pctOf = (pool, total) => (total > 0n ? Number((pool * 10000n) / total) / 100 : 0);

function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = ""), kind === "err" ? 6000 : 3500);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function readProvider() {
  return new E.JsonRpcProvider(CFG.rpc);
}

// payout per 1 STT staked on outcome i at current pools; extraStake simulates
// the bettor's own addition (their bet joins pool i, losing side is unchanged)
function payoutPerUnit(total, pool, feeBps, extraStake = 0n) {
  const p = pool + extraStake;
  const t = total + extraStake;
  if (p === 0n) return null;
  const fees = ((t - p) * feeBps) / 10000n;
  return Number(((t - fees) * 10000n) / p) / 10000;
}

async function init() {
  if (!CFG.predictionMarket) {
    $("marketList").innerHTML = '<div class="empty">No deployment config found.<br>Run <code>scripts/deploy.js</code> first.</div>';
    return;
  }
  provider = readProvider();
  pmRead = new E.Contract(CFG.predictionMarket, PM_ABI, provider);
  if (CFG.xOracleResolver) {
    resolverRead = new E.Contract(CFG.xOracleResolver, RES_ABI, provider);
    resolverRead.oracleBaseUrl().then((b) => { oracleBase = b; }).catch(() => {});
    resolverRead.subSize().then((s) => { subSizeVal = Number(s); }).catch(() => {});
  }
  try {
    const net = await provider.getNetwork();
    $("netPill").innerHTML = `chain <b>${net.chainId}</b>`;
  } catch (e) {
    $("netPill").textContent = "rpc offline";
  }
  await renderMarkets();
  setInterval(() => {
    renderMarkets();
    if (detailId !== null) renderDetail(detailId, { keepChart: true });
  }, 12000);
  await refreshCreateMeta();
}

// ---------- wallet ----------
$("connectBtn").onclick = async () => {
  if (!window.ethereum) { toast("No injected wallet. Use MetaMask on Somnia testnet for local dev.", "err"); return; }
  try {
    const bp = new E.BrowserProvider(window.ethereum);
    await bp.send("eth_requestAccounts", []);
    signer = await bp.getSigner();
    account = await signer.getAddress();
    pm = new E.Contract(CFG.predictionMarket, PM_ABI, signer);
    $("connectBtn").textContent = short(account);
    const bal = await provider.getBalance(account);
    $("balPill").style.display = "";
    $("balPill").innerHTML = `<b>${fmt(bal)}</b> STT`;
    toast("Connected " + short(account), "ok");
    renderMarkets();
    if (detailId !== null) renderDetail(detailId, { keepChart: true });
  } catch (e) { toast(e.shortMessage || e.message, "err"); }
};

// ---------- market grid ----------
async function renderMarkets() {
  let count;
  try { count = Number(await pmRead.marketCount()); }
  catch (e) { return; }
  if (count === 0) {
    $("marketList").innerHTML = '<div class="empty">No markets yet. Create the first one.</div>';
    return;
  }
  const cards = [];
  for (let id = count - 1; id >= 0; id--) {
    try { cards.push(await marketCard(id)); } catch (e) { /* skip */ }
  }
  $("marketList").innerHTML = cards.join("");
  wireCards();
}

function stateBadge(m, now) {
  const state = Number(m.state);
  if (state === 1) return ["Resolved", "resolved"];
  if (state === 2) return ["Voided", "voided"];
  if (now >= Number(m.closeTs)) return ["Resolving", "closing"];
  return ["Open", "open"];
}

async function marketCard(id) {
  const [m, question, labels] = await pmRead.getMarket(id);
  const pools = await pmRead.getPools(id);
  const total = m.total;
  const now = Math.floor(Date.now() / 1000);
  const state = Number(m.state);
  const [badge, badgeCls] = stateBadge(m, now);
  const canBet = state === 0 && now < Number(m.closeTs);

  const MAXROWS = 3;
  const rows = labels.slice(0, MAXROWS).map((lbl, i) => {
    const pct = pctOf(pools[i], total);
    const isWin = state === 1 && Number(m.winner) === i;
    const btn = canBet
      ? `<button class="mini" data-bet-open="${id}-${i}">Bet</button>`
      : (isWin ? `<span class="winmark">✓</span>` : "");
    return `<div class="mrow ${isWin ? "win" : ""}">
      <span class="dot" style="background:${SERIES[i]}"></span>
      <span class="ml">${esc(lbl)}</span>
      <span class="mp">${pct.toFixed(0)}%</span>
      ${btn}
    </div>`;
  }).join("");
  const more = labels.length > MAXROWS
    ? `<div class="mrow more">+${labels.length - MAXROWS} more outcomes</div>` : "";

  let claimChip = "";
  if (account && state !== 0) {
    try {
      const claimable = await pmRead.claimableOf(id, account);
      if (claimable > 0n) claimChip = `<span class="chip gold">Claim ${fmt(claimable)} STT</span>`;
    } catch (e) {}
  }

  const closeStr = new Date(Number(m.closeTs) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `<div class="mcard" data-open="${id}">
    <div class="mhead">
      <div class="mico">𝕏</div>
      <h3>${esc(question)}</h3>
      <span class="badge ${badgeCls}">${badge}</span>
    </div>
    <div class="mocs">${rows}${more}</div>
    <div class="mfoot">
      <span>${fmt(total)} STT Vol</span>
      <span>${TEMPLATES[Number(m.template)]}</span>
      <span>closes ${closeStr}</span>
      ${claimChip}
    </div>
  </div>`;
}

function wireCards() {
  document.querySelectorAll("[data-open]").forEach((c) => {
    c.onclick = () => openDetail(Number(c.dataset.open), 0);
  });
  document.querySelectorAll("[data-bet-open]").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const [id, i] = b.dataset.betOpen.split("-").map(Number);
      openDetail(id, i);
    };
  });
}

// ---------- detail view ----------
function showSection(name) {
  $("tab-markets").style.display = name === "markets" ? "" : "none";
  $("tab-detail").style.display = name === "detail" ? "" : "none";
  $("tab-create").style.display = name === "create" ? "" : "none";
}

$("backBtn").onclick = () => { detailId = null; showSection("markets"); renderMarkets(); };

async function openDetail(id, outcome = 0) {
  detailId = id;
  tradeSel = outcome;
  showSection("detail");
  await renderDetail(id);
}

async function renderDetail(id, opts = {}) {
  if (detailId !== id) return;
  let m, question, labels, pools;
  try {
    [m, question, labels] = await pmRead.getMarket(id);
    pools = await pmRead.getPools(id);
  } catch (e) { return; }
  const total = m.total;
  const now = Math.floor(Date.now() / 1000);
  const state = Number(m.state);
  const [badge, badgeCls] = stateBadge(m, now);
  const feeBps = BigInt(m.platformFeeBps) + BigInt(m.creatorFeeBps);

  $("dQuestion").textContent = question;
  $("dBadge").className = "badge " + badgeCls;
  $("dBadge").textContent = badge;
  $("dMeta").innerHTML = [
    `<span><span class="k">#</span>${id}</span>`,
    `<span><span class="k">type</span> ${TEMPLATES[Number(m.template)]}</span>`,
    `<span><span class="k">pool</span> ${fmt(total)} STT</span>`,
    `<span><span class="k">closes</span> ${new Date(Number(m.closeTs) * 1000).toLocaleString()}</span>`,
    `<span><span class="k">deadline</span> ${new Date(Number(m.resolveDeadline) * 1000).toLocaleString()}</span>`,
  ].join("");

  // legend (identity never color-alone: chip + label, text in text tokens)
  $("dLegend").innerHTML = labels.map((lbl, i) =>
    `<span class="lg"><i style="background:${SERIES[i]}"></i>${esc(lbl)}</span>`).join("");

  // full outcome list
  $("dOutcomes").innerHTML = labels.map((lbl, i) => {
    const pct = pctOf(pools[i], total);
    const isWin = state === 1 && Number(m.winner) === i;
    const mult = payoutPerUnit(total, pools[i], feeBps);
    const multStr = mult ? `×${mult.toFixed(2)}` : "first bet";
    return `<div class="oc ${isWin ? "win" : ""} ${i === tradeSel ? "sel" : ""}" data-sel="${i}">
      <div class="fill" style="width:${pct}%"></div>
      <div class="lbl"><span class="dot" style="background:${SERIES[i]}"></span>${esc(lbl)}${isWin ? " ✓" : ""}</div>
      <div class="pct">${pct.toFixed(1)}%</div>
      <span class="mult ${mult ? "" : "empty"}">${multStr}</span>
      <div class="pct">${fmt(pools[i])} STT</div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-sel]").forEach((r) => {
    r.onclick = () => { tradeSel = Number(r.dataset.sel); renderDetail(id, { keepChart: true }); };
  });

  const receipt = CFG.agentsExplorer
    ? `<span class="receipts"><a href="${CFG.agentsExplorer}" target="_blank" rel="noopener">agent receipts ↗</a></span>` : "";
  $("dFoot").innerHTML = `${receipt}<span>parimutuel · fees ${Number(feeBps) / 100}% off the losing pool only</span>`;

  renderTradePanel(m, labels, pools, now);
  renderResolution(id, m, labels).catch(() => {});
  if (!opts.keepChart) await renderChart(id, labels, m, pools);
}

// ---------- resolution provenance (Prophecy-style, from on-chain data) ----------
const resolveUrl = (u) => (u && !u.startsWith("http") ? oracleBase + u : u);
const urlHost = (u) => { try { return new URL(u).host; } catch (e) { return u; } };
const urlPath = (u) => { try { const p = new URL(u); return (p.pathname + p.search).slice(0, 44); } catch (e) { return ""; } };

function sourceCards(t, spec, labels) {
  // one card per agent vote, in vote order - mirrors XOracleResolver.startResolve
  if (t === 3) {
    return [0, 1, 2].map(() => ({ kind: "LLM", url: "", note: "answers an outcome label from the criteria" }));
  }
  if (t === 4) {
    const cards = [{ kind: "JSON", url: resolveUrl(spec.primaryUrl), sel: spec.primarySelector, note: "x-oracle winner index" }];
    spec.raceUrls.forEach((u, i) => cards.push({
      kind: spec.raceSelectors[i] ? "JSON" : "PARSE",
      url: u, sel: spec.raceSelectors[i] || "",
      note: labels[i],
    }));
    return cards;
  }
  const cards = [{ kind: "JSON", url: resolveUrl(spec.primaryUrl), sel: spec.primarySelector, note: "x-oracle mirror" }];
  if (t === 0) cards.push({ kind: "JSON", url: spec.secondaryUrl, sel: spec.secondarySelector, note: "independent public source" });
  else if (spec.secondaryUrl) cards.push({ kind: "PARSE", url: spec.secondaryUrl, sel: "", note: "LLM page extraction" });
  return cards; // profile markets without a secondary reader: single card
}

const CONSENSUS_RULES = {
  0: "Both independent JSON reads must land in the same outcome bucket.",
  1: "The x-oracle read and the page extraction must land in the same bucket.",
  2: "The x-oracle read and the page extraction must land in the same bucket.",
  3: "2 of 3 independent LLM votes must return the same outcome label.",
  4: "The x-oracle's winner index must equal the argmax the chain recomputes itself from the independent per-contender measurements.",
};

async function renderResolution(id, m, labels) {
  const box = $("dResolution");
  if (!box || !resolverRead) return;
  const t = Number(m.template);
  const state = Number(m.state);

  let spec, round, meta;
  try {
    [spec, round] = await Promise.all([pmRead.getSpec(id), resolverRead.getRound(id)]);
    try {
      meta = await resolverRead.getVoteMeta(id);
    } catch (e) {
      // pre-stats resolver generation: same data, no subcommittee columns
      const legacy = new E.Contract(CFG.xOracleResolver, RES_ABI_LEGACY, provider);
      const lm = await legacy.getVoteMeta(id);
      meta = { requestIds: lm.requestIds, agentIds: lm.agentIds, responded: new Array(8).fill(0), agreed: new Array(8).fill(0) };
    }
  } catch (e) { return; }
  if (detailId !== id) return;

  const cards = sourceCards(t, spec, labels);
  const voteHtml = cards.map((c, i) => {
    const requestId = meta.requestIds[i];
    const fired = requestId !== 0n;
    const agent = fired
      ? (AGENT_NAMES[meta.agentIds[i].toString()] || "Agent")
      : ({ JSON: "JSON API", PARSE: "LLM Parse Website", LLM: "LLM Inference" })[c.kind];

    // status + extracted value, in plain words
    let status = ["wait", "waiting"], valueHtml = `<span class="vv pending">-</span>`;
    if (fired) {
      const o = Number(round.votes[i]);
      if (o === VOTE_PENDING) { status = ["run", "running"]; valueHtml = `<span class="vv pending">measuring…</span>`; }
      else if (o === VOTE_ABSTAIN) { status = ["bad", "no data"]; valueHtml = `<span class="vv abstain">could not read the source</span>`; }
      else if (o === VOTE_MEASURED) { status = ["ok", "complete"]; valueHtml = `<span class="vv num">${Number(round.raw[i]).toLocaleString()}</span>`; }
      else if (o < labels.length) { status = ["ok", "complete"]; valueHtml = `<span class="vv ok">${esc(labels[o])}</span>`; }
    }

    const readsLine = c.kind === "JSON"
      ? `reads <code>${esc(c.sel)}</code>${c.note ? " · " + esc(c.note) : ""}`
      : c.kind === "PARSE"
        ? `AI extracts the value from the page${c.note ? " · " + esc(c.note) : ""}`
        : `AI answers one of the outcomes from the resolution criteria`;

    const nResp = Number(meta.responded[i] ?? 0);
    const statHtml = nResp > 0
      ? `<span class="vstat">${nResp}/${subSizeVal} validators · ${Number(meta.agreed[i])} agreed</span>` : "<span></span>";
    const receipt = fired && CFG.agentsExplorer
      ? `<a class="receipt" href="${CFG.agentsExplorer}/receipts/${requestId}" target="_blank" rel="noopener">Receipt ↗</a>`
      : "";
    const srcLine = c.url
      ? `<a class="vsrc" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.url)}"><b>${esc(urlHost(c.url))}</b><span class="path">${esc(urlPath(c.url))}</span></a>`
      : `<div class="vsrc off">no external source</div>`;

    return `<div class="vcard">
      <div class="vhead">
        <span class="chipk">SOURCE ${String(i + 1).padStart(2, "0")}</span>
        <span class="vstatus ${status[0]}">${status[1]}</span>
      </div>
      ${srcLine}
      <div class="vread">${readsLine}</div>
      <div class="vagent">⬡ Somnia Agent · ${esc(agent)}</div>
      <div class="vout">${valueHtml}</div>
      <div class="vfoot">${statHtml}${receipt}</div>
    </div>`;
  }).join("");

  let verdict, verdictCls;
  if (state === 1) { verdict = `REACHED · ${esc(labels[Number(m.winner)])}`; verdictCls = "reached"; }
  else if (state === 2) { verdict = "VOIDED · full refunds"; verdictCls = "voided"; }
  else if (round.active) { verdict = "ROUND IN FLIGHT"; verdictCls = "pending"; }
  else if (Number(round.roundsUsed) > 0) { verdict = "NO CONSENSUS YET · retrying"; verdictCls = "failed"; }
  else { verdict = "AWAITING CLOSE"; verdictCls = "pending"; }

  // profile markets may run without a second independent reader (X keeps
  // profile data behind login) - say so out loud instead of pretending
  const isSingle = (t === 1 || t === 2) && !spec.secondaryUrl;
  const rule = isSingle
    ? "Single source: resolves from the x-oracle's published measurement. The measurement method is open, the published JSON is permanent, and anyone can re-check the number on X - a mismatch would be publicly provable."
    : (CONSENSUS_RULES[t] || "");
  const singleChip = isSingle ? `<span class="rz-single">SINGLE SOURCE</span>` : "";

  box.innerHTML = `
    <div class="rz-title">Resolution · verifiable on-chain ${singleChip}</div>
    <div class="rz-sub">Every vote is executed by a Somnia validator subcommittee reaching its own consensus; the resolver contract is immutable wiring - the operator cannot dictate a winner, only void for refunds. Click any receipt to verify the raw request, sources and validator responses.</div>
    <div class="rz-votes">${voteHtml}</div>
    <div class="rz-consensus ${verdictCls}">
      <div class="rz-row"><span>Rule</span><b>${rule}</b></div>
      <div class="rz-row"><span>Rounds used</span><b>${round.roundsUsed} / 4</b></div>
      <div class="rz-row"><span>Verdict</span><b class="rz-verdict">${verdict}</b></div>
    </div>`;
}

// ---------- trade panel ----------
function renderTradePanel(m, labels, pools, now) {
  const el = $("dTrade");
  const state = Number(m.state);
  const total = m.total;
  const feeBps = BigInt(m.platformFeeBps) + BigInt(m.creatorFeeBps);
  const canBet = state === 0 && now < Number(m.closeTs);

  if (canBet) {
    const btns = labels.map((lbl, i) => {
      const pct = pctOf(pools[i], total);
      return `<button class="tsel ${i === tradeSel ? "on" : ""}" data-tsel="${i}" style="--c:${SERIES[i]}">
        <span>${esc(lbl)}</span><b>${pct.toFixed(0)}%</b>
      </button>`;
    }).join("");
    el.innerHTML = `
      <div class="ttitle">Buy · <span class="tname">${esc(labels[tradeSel])}</span></div>
      <div class="tsels">${btns}</div>
      <label class="tam">Amount (STT)
        <input id="tAmount" type="number" step="0.01" min="0.01" placeholder="0.00" />
      </label>
      <div class="tchips">
        <button data-add="0.1">+0.1</button><button data-add="0.5">+0.5</button>
        <button data-add="1">+1</button><button data-add="5">+5</button>
      </div>
      <div class="tsums">
        <div><span>Current payout</span><b id="tOdds"></b></div>
        <div><span>You receive if won</span><b id="tPayout" class="goldtxt">0.00 STT</b></div>
      </div>
      <button class="gold big" id="tBet">Place bet</button>
      <div class="hint">Parimutuel pool: winners split the losing side, fees come off the losing side only. Odds move with every bet until close.</div>`;

    document.querySelectorAll("[data-tsel]").forEach((b) => {
      b.onclick = () => { tradeSel = Number(b.dataset.tsel); renderDetail(detailId, { keepChart: true }); };
    });
    const amountEl = $("tAmount");
    const recalc = () => {
      const v = Number(amountEl.value || 0);
      const stake = v > 0 ? E.parseEther(String(v)) : 0n;
      const per = payoutPerUnit(total, pools[tradeSel], feeBps, stake);
      const perNow = payoutPerUnit(total, pools[tradeSel], feeBps);
      $("tOdds").textContent = perNow ? `×${perNow.toFixed(2)}` : "first bet takes the pool";
      $("tPayout").textContent = v > 0 && per ? `${(v * per).toFixed(4)} STT (×${per.toFixed(2)})` : "0.00 STT";
    };
    amountEl.oninput = recalc;
    document.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => { amountEl.value = (Number(amountEl.value || 0) + Number(b.dataset.add)).toFixed(2); recalc(); };
    });
    recalc();
    $("tBet").onclick = async () => {
      const v = Number(amountEl.value || 0);
      if (!v || v <= 0) { toast("Enter an amount", "err"); return; }
      await doTx($("tBet"), () => pm.bet(detailId, tradeSel, { value: E.parseEther(String(v)) }), "Bet placed");
      renderDetail(detailId);
    };
    return;
  }

  // closed / resolved / voided
  let inner = "";
  if (state === 0) {
    inner = `<div class="ttitle">Resolving</div>
      <div class="hint">Betting is closed. Somnia agents are measuring the outcome; the market resolves when independent votes agree.</div>`;
  } else if (state === 1) {
    inner = `<div class="ttitle">Resolved · <span class="tname">${esc(labels[Number(m.winner)])}</span></div>`;
  } else {
    inner = `<div class="ttitle">Voided</div><div class="hint">Could not be resolved before the deadline. Every stake is refundable in full.</div>`;
  }
  el.innerHTML = inner + `<div id="tClaimZone"></div>`;
  if (account && state !== 0) {
    pmRead.claimableOf(detailId, account).then((claimable) => {
      if (claimable > 0n) {
        $("tClaimZone").innerHTML = `<button class="gold big" id="tClaim">Claim ${fmt(claimable)} STT</button>`;
        $("tClaim").onclick = () => doTx($("tClaim"), () => pm.claim(detailId), "Claimed").then(() => renderDetail(detailId));
      } else {
        $("tClaimZone").innerHTML = `<div class="hint">Nothing to claim on this wallet.</div>`;
      }
    }).catch(() => {});
  } else if (!account) {
    $("tClaimZone").innerHTML = `<div class="hint">Connect a wallet to claim winnings.</div>`;
  }
}

// ---------- odds history chart (from on-chain BetPlaced logs) ----------
async function loadHistory(id, nOutcomes) {
  const events = await pmRead.queryFilter(pmRead.filters.BetPlaced(id));
  const pts = [];
  const pools = new Array(nOutcomes).fill(0n);
  let total = 0n;
  for (const ev of events) {
    if (!blockTsCache.has(ev.blockNumber)) {
      const b = await provider.getBlock(ev.blockNumber);
      blockTsCache.set(ev.blockNumber, b.timestamp);
    }
    pools[Number(ev.args.outcome)] += ev.args.amount;
    total += ev.args.amount;
    pts.push({
      t: blockTsCache.get(ev.blockNumber),
      shares: pools.map((p) => (total > 0n ? Number((p * 10000n) / total) / 100 : 0)),
    });
  }
  return pts;
}

async function renderChart(id, labels, m, pools) {
  const svg = $("dChart");
  const tip = $("dTip");
  tip.style.display = "none";
  svg.innerHTML = "";
  let pts;
  let historyOk = true;
  try { pts = await loadHistory(id, labels.length); }
  catch (e) {
    // public RPC caps eth_getLogs ranges: degrade to the CURRENT distribution
    // as a flat line instead of pretending there is no market activity
    historyOk = false;
    pts = [];
    const total = m.total;
    if (total > 0n) {
      const shares = labels.map((_, i) => pctOf(pools[i], total));
      const nowS = Math.floor(Date.now() / 1000);
      pts = [{ t: nowS - 3600, shares }, { t: nowS, shares }];
    }
  }
  if (detailId !== id) return;

  const W = svg.clientWidth || 620, H = 240;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const padL = 8, padR = 74, padT = 10, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;

  if (pts.length === 0) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="cempty">No bets yet - odds appear with the first bet</text>`;
    return;
  }

  // extend the last state to "now" (or to close, whichever is earlier)
  const nowT = Math.min(Math.floor(Date.now() / 1000), Number(m.closeTs));
  const t0 = pts[0].t, t1 = Math.max(nowT, pts[pts.length - 1].t + 1);
  const x = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (pct) => padT + (1 - pct / 100) * ih;

  let g = "";
  // recessive grid: 0/25/50/75/100
  for (const gv of [0, 25, 50, 75, 100]) {
    g += `<line x1="${padL}" y1="${y(gv)}" x2="${padL + iw}" y2="${y(gv)}" class="cgrid"/>`;
    g += `<text x="${padL + iw + 6}" y="${y(gv) + 3}" class="ctick">${gv}%</text>`;
  }
  // x ticks: start / end
  const ft = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  g += `<text x="${padL}" y="${H - 6}" class="ctick">${ft(t0)}</text>`;
  g += `<text x="${padL + iw}" y="${H - 6}" text-anchor="end" class="ctick">${ft(t1)}</text>`;
  if (!historyOk) g += `<text x="${padL + iw / 2}" y="${H - 6}" text-anchor="middle" class="ctick">current odds (history unavailable on this RPC)</text>`;

  // step lines per outcome
  labels.forEach((lbl, i) => {
    let d = "";
    pts.forEach((p, k) => {
      const px = x(p.t), py = y(p.shares[i]);
      if (k === 0) d += `M${px.toFixed(1)},${py.toFixed(1)}`;
      else d += `H${px.toFixed(1)}V${py.toFixed(1)}`;
    });
    d += `H${x(t1).toFixed(1)}`;
    g += `<path d="${d}" fill="none" stroke="${SERIES[i]}" stroke-width="2" stroke-linejoin="round"/>`;
  });

  // direct labels at the right edge (<=4 series), text in text tokens + dot
  if (labels.length <= 4) {
    const last = pts[pts.length - 1].shares;
    const placed = [];
    labels.forEach((lbl, i) => {
      let ly = y(last[i]);
      // nudge collisions apart
      while (placed.some((p) => Math.abs(p - ly) < 12)) ly += 12;
      placed.push(ly);
      g += `<circle cx="${x(t1)}" cy="${y(last[i])}" r="3.2" fill="${SERIES[i]}"/>`;
      g += `<text x="${x(t1) + 7}" y="${ly + 3.5}" class="clabel">${last[i].toFixed(0)}%</text>`;
    });
  }

  // crosshair layer
  g += `<line id="cxLine" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" class="cx" style="display:none"/>`;
  svg.innerHTML = g;

  const wrap = $("dChartWrap");
  wrap.onmousemove = (ev) => {
    const r = wrap.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    if (mx < padL || mx > padL + iw) { wrap.onmouseleave(); return; }
    // nearest point at or before the cursor time
    const tt = t0 + ((mx - padL) / iw) * (t1 - t0);
    let p = pts[0];
    for (const q of pts) { if (q.t <= tt) p = q; else break; }
    const line = $("cxLine");
    line.setAttribute("x1", mx); line.setAttribute("x2", mx);
    line.style.display = "";
    tip.style.display = "";
    tip.style.left = Math.min(mx + 12, W - 170) + "px";
    tip.innerHTML = `<div class="tt-t">${new Date(p.t * 1000).toLocaleTimeString()}</div>` +
      labels.map((lbl, i) =>
        `<div class="tt-r"><i style="background:${SERIES[i]}"></i><span>${esc(lbl)}</span><b>${p.shares[i].toFixed(1)}%</b></div>`).join("");
  };
  wrap.onmouseleave = () => {
    tip.style.display = "none";
    const line = $("cxLine");
    if (line) line.style.display = "none";
  };
}

// ---------- tx helper ----------
async function doTx(btn, fn, okMsg) {
  if (!signer) { toast("Connect a wallet first", "err"); return; }
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = "…";
  try {
    const tx = await fn();
    toast("Submitted " + tx.hash.slice(0, 10) + "…");
    await tx.wait();
    toast(okMsg, "ok");
    await renderMarkets();
  } catch (e) {
    toast(e.shortMessage || e.reason || e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

// ---------- tabs ----------
document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    detailId = null;
    showSection(b.dataset.tab);
    if (b.dataset.tab === "markets") renderMarkets();
  };
});

// ---------- create ----------
const templateSel = $("fTemplate");
templateSel.onchange = updateCreateForm;

// race contender rows: label + independent source url + selector ("" = parse)
function raceRow(label = "", url = "", sel = "") {
  const row = document.createElement("div");
  row.className = "race-row";
  row.innerHTML = `
    <input placeholder="@handle" class="rLbl" value="${label}" />
    <input placeholder="https://cdn.syndication.twimg.com/tweet-result?id=… or https://x.com/user" class="rUrl" value="${url}" />
    <input placeholder="selector (or empty)" class="rSel" value="${sel}" />
    <button type="button" class="ghost rDel">×</button>`;
  row.querySelector(".rDel").onclick = () => {
    if (document.querySelectorAll(".race-row").length > 2) row.remove();
    else toast("A race needs at least 2 contenders", "err");
  };
  return row;
}
$("raceAdd").onclick = () => {
  if (document.querySelectorAll(".race-row").length >= 7) { toast("Max 7 contenders (8 outcomes incl. fallback)", "err"); return; }
  $("raceRows").appendChild(raceRow());
};

function updateCreateForm() {
  const t = Number(templateSel.value);
  $("primaryBlock").style.display = t === 3 ? "none" : "";
  $("numericBlock").style.display = (t === 3 || t === 4) ? "none" : "";
  $("raceBlock").style.display = t === 4 ? "" : "none";
  $("outcomesLabel").style.display = t === 4 ? "none" : "";
  $("fSecSel").parentElement.style.display = t === 0 ? "" : "none";
  $("fPrimarySel").value = t === 4 ? "winner" : "value";
  if (t === 4 && $("raceRows").children.length === 0) {
    $("raceRows").appendChild(raceRow());
    $("raceRows").appendChild(raceRow());
  }
  const hints = {
    0: "Two independent JSON reads of a tweet metric. Secondary can be <code>cdn.syndication.twimg.com/tweet-result?id=…</code> (public, no key).",
    1: "Follower count vs buckets. Leave the secondary URL empty for SINGLE-SOURCE mode (x-oracle only, labeled openly in the market) - X keeps profile data behind login, so a second public reader rarely exists.",
    2: "Posts-per-day vs buckets. Same single-source rule as followers: empty secondary URL = x-oracle only, labeled openly.",
    3: "Three independent LLM votes over your criteria; 2-of-3 must agree, else the market voids and refunds. No buckets - the model answers a label directly.",
    4: "Race: the x-oracle publishes per-contender values and its winner index (primary URL, selector <code>winner</code>); the chain re-computes the argmax from one independent vote per contender and must agree. Tie or below threshold resolves to the fallback outcome. Put the machine directive in criteria, e.g. <code>… | x:race;tweets=1,2,3;metric=likes</code>.",
  };
  $("createHint").innerHTML = hints[t] || "";
}

async function refreshCreateMeta() {
  try {
    const [fee, bond, curated] = await Promise.all([
      pmRead.creationFee(), pmRead.creatorBondAmount(), pmRead.curatedMode(),
    ]);
    $("feeLabel").textContent = `${fmt(fee + bond)} STT (fee ${fmt(fee)} + bond ${fmt(bond)})`;
    if (curated) {
      $("createHint").innerHTML = "⚠ Curated mode is ON - only the owner/whitelist can create markets right now.";
    }
  } catch (e) {}
  // default datetimes: close in 1h, resolve in 3h
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("fClose").value = iso(new Date(Date.now() + 3600e3));
  $("fDeadline").value = iso(new Date(Date.now() + 3 * 3600e3));
  updateCreateForm();
}

$("createForm").onsubmit = async (ev) => {
  ev.preventDefault();
  if (!signer) { toast("Connect a wallet first", "err"); return; }
  try {
    const t = Number(templateSel.value);
    const closeTs = Math.floor(new Date($("fClose").value).getTime() / 1000);
    const deadline = Math.floor(new Date($("fDeadline").value).getTime() / 1000);

    let outcomes, bounds = [], raceUrls = [], raceSelectors = [], raceThreshold = 0n;
    if (t === 4) {
      const rows = [...document.querySelectorAll(".race-row")];
      const labels = rows.map((r) => r.querySelector(".rLbl").value.trim());
      raceUrls = rows.map((r) => r.querySelector(".rUrl").value.trim());
      raceSelectors = rows.map((r) => r.querySelector(".rSel").value.trim());
      if (labels.some((l) => !l) || raceUrls.some((u) => !u))
        throw new Error("Every contender needs a label and a source URL");
      const fallback = $("fRaceFallback").value.trim();
      if (!fallback) throw new Error("Fallback outcome label is required");
      outcomes = [...labels, fallback];
      raceThreshold = BigInt($("fRaceThreshold").value || "0");
    } else {
      outcomes = $("fOutcomes").value.split(",").map((s) => s.trim()).filter(Boolean);
      if (outcomes.length < 2) throw new Error("Need at least 2 outcomes");
      bounds = t === 3 ? [] :
        $("fBounds").value.split(",").map((s) => s.trim()).filter(Boolean).map((s) => BigInt(s));
      if (t !== 3 && bounds.length !== outcomes.length - 1)
        throw new Error(`Need exactly ${outcomes.length - 1} bucket bound(s)`);
    }

    const spec = {
      primaryUrl: t === 3 ? "" : $("fPrimaryUrl").value.trim(),
      primarySelector: t === 3 ? "" : $("fPrimarySel").value.trim(),
      secondaryUrl: (t === 3 || t === 4) ? "" : $("fSecUrl").value.trim(),
      secondarySelector: t === 0 ? $("fSecSel").value.trim() : "",
      criteria: $("fCriteria").value.trim(),
      bucketBounds: bounds,
      raceUrls,
      raceSelectors,
      raceThreshold,
    };
    const [fee, bond] = await Promise.all([pmRead.creationFee(), pmRead.creatorBondAmount()]);
    await doTx($("createBtn"),
      () => pm.createMarket(t, $("fQuestion").value.trim(), outcomes, closeTs, deadline, spec, { value: fee + bond }),
      "Market created");
    document.querySelector('.tabs button[data-tab="markets"]').click();
  } catch (e) { toast(e.shortMessage || e.message, "err"); }
};

init();
