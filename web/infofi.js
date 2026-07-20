/* ShinyLuck InfoFi - Somnia mindshare treemap.
 * Reads web/infofi-data.json (written by infofi/collect.py). Squarified
 * treemap, tiles sized by engagement share; gold = curated ecosystem
 * projects, green = auto-discovered voices talking about Somnia. */

const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);

// validated categorical fills tuned for the dark surface, low-alpha so text
// tokens stay readable on top
const FILL = {
  project: ["rgba(201,133,0,.34)", "rgba(201,133,0,.22)"],
  voice: ["rgba(25,158,112,.30)", "rgba(25,158,112,.18)"],
};
const STROKE = { project: "#C98500", voice: "#199E70" };

// --- squarified treemap (Bruls et al.) ---
function squarify(items, x, y, w, h, out) {
  if (!items.length) return;
  if (items.length === 1) { out.push({ ...items[0], x, y, w, h }); return; }
  const total = items.reduce((s, it) => s + it.v, 0);
  const scale = (w * h) / total;
  let row = [], rest = items.slice();
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b.v * scale, 0);
    let mx = 0;
    for (const r of row) {
      const a = r.v * scale;
      mx = Math.max(mx, Math.max((side * side * a) / (s * s), (s * s) / (side * side * a)));
    }
    return mx;
  };
  const side = Math.min(w, h);
  while (rest.length) {
    const next = [...row, rest[0]];
    if (row.length && worst(next, side) > worst(row, side)) break;
    row = next; rest.shift();
  }
  const rowArea = row.reduce((a, b) => a + b.v * scale, 0);
  if (w >= h) {
    const rw = rowArea / h;
    let cy = y;
    for (const r of row) {
      const rh = (r.v * scale) / rw;
      out.push({ ...r, x, y: cy, w: rw, h: rh });
      cy += rh;
    }
    squarify(rest, x + rw, y, w - rw, h, out);
  } else {
    const rh = rowArea / w;
    let cx = x;
    for (const r of row) {
      const rw = (r.v * scale) / rh;
      out.push({ ...r, x: cx, y, w: rw, h: rh });
      cx += rw;
    }
    squarify(rest, x, y + rh, w, h - rh, out);
  }
}

async function main() {
  let data;
  try {
    data = await (await fetch("infofi-data.json?" + Date.now())).json();
  } catch (e) {
    document.getElementById("ifMeta").textContent = "no snapshot yet - run infofi/collect.py";
    return;
  }
  const rows = data.projects; // table shows everyone, even quiet accounts
  const active = rows.filter((p) => p.score > 0);
  const gen = new Date(data.generated).toLocaleString();
  document.getElementById("ifMeta").textContent =
    `${data.window_hours}h window · ${rows.length} accounts · generated ${gen}`;

  // --- treemap (active accounts only - a zero-score tile has no area) ---
  const svg = document.getElementById("tmap");
  const W = svg.clientWidth || 1100, H = +svg.getAttribute("height");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const tiles = [];
  squarify(active.map((p, i) => ({ v: Math.max(p.score, 0.001), p, rank: i + 1 })), 0, 0, W, H, tiles);

  const tip = document.getElementById("ifTip");
  let g = "";
  tiles.forEach((t, ti) => {
    const p = t.p;
    const fills = FILL[p.kind] || FILL.voice;
    const fill = fills[t.rank % 2];
    const big = t.w > 150 && t.h > 92;
    const mid = t.w > 96 && t.h > 56;
    const tiny = !mid && t.w > 58 && t.h > 34; // small tiles still get a handle
    const shortName = p.name ? esc(p.name).slice(0, big ? 18 : 11) : "@" + esc(p.handle);
    g += `<g class="tile" data-i="${ti}" transform="translate(${t.x},${t.y})">
      <rect width="${t.w}" height="${t.h}" fill="${fill}" stroke="${STROKE[p.kind] || STROKE.voice}" stroke-opacity=".35"/>
      ${mid ? `<text class="tl-name" x="12" y="26" font-size="${big ? 17 : 13}">${shortName}</text>` : ""}
      ${mid ? `<text class="tl-share" x="12" y="${big ? 48 : 42}" font-size="${big ? 13 : 11}">${p.share.toFixed(2)}%</text>` : ""}
      ${tiny ? `<text class="tl-name" x="8" y="18" font-size="10">${esc(p.handle).slice(0, Math.floor(t.w / 7))}</text>` : ""}
      ${tiny && t.h > 48 ? `<text class="tl-share" x="8" y="32" font-size="9.5">${p.share.toFixed(1)}%</text>` : ""}
      ${t.rank <= 3 && mid ? `<text class="tl-rank" x="${t.w - 14}" y="27" text-anchor="end" font-size="${big ? 19 : 14}">${t.rank}</text>` : ""}
      ${big ? `<text class="tl-kind" x="12" y="${t.h - 12}">${p.kind === "project" ? "ECOSYSTEM" : "VOICE"} · ${p.posts} posts · ${fmtN(p.likes)} likes</text>` : ""}
    </g>`;
  });
  svg.innerHTML = g;

  svg.querySelectorAll(".tile").forEach((el) => {
    el.addEventListener("mousemove", (ev) => {
      const p = tiles[+el.dataset.i].p;
      tip.style.display = "block";
      tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 240) + "px";
      tip.style.top = (ev.clientY + 14) + "px";
      const voiceRows = p.kind === "voice"
        ? `<div class="row"><span>Own tagged comments</span><span>${p.comments}</span></div>` : "";
      tip.innerHTML = `<b>${esc(p.name || p.handle)}</b> <span class="kbadge ${p.kind}">${p.kind}</span>
        <div class="row"><span>@${esc(p.handle)}</span><span>${fmtN(p.followers)} followers</span></div>
        <div class="row"><span>${p.kind === "voice" ? "Tagged posts" : "Posts"} (${data.window_hours}h)</span><span>${p.posts}</span></div>
        ${voiceRows}
        <div class="row"><span>Likes</span><span>${fmtN(p.likes)}</span></div>
        <div class="row"><span>Reposts + quotes</span><span>${fmtN(p.retweets + p.quotes)}</span></div>
        <div class="row"><span>Replies received</span><span>${fmtN(p.replies)}</span></div>
        <div class="row"><span>Bookmarks</span><span>${fmtN(p.bookmarks)}</span></div>
        <div class="row"><span>Views</span><span>${fmtN(p.views)}</span></div>
        <div class="row"><span>Mindshare</span><span>${p.share.toFixed(2)}%</span></div>`;
    });
    el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  });

  // --- breakdown table ---
  document.getElementById("ifTable").style.display = "";
  document.getElementById("ifRows").innerHTML = rows.map((p, i) => `<tr>
    <td class="acc">${i + 1}. ${esc(p.name || p.handle)}<span class="h">@${esc(p.handle)}</span><span class="kbadge ${p.kind}">${p.kind}</span></td>
    <td>${p.posts}</td><td>${p.kind === "voice" ? p.comments : "-"}</td>
    <td>${fmtN(p.likes)}</td><td>${fmtN(p.retweets + p.quotes)}</td>
    <td>${fmtN(p.replies)}</td><td>${fmtN(p.bookmarks)}</td><td>${fmtN(p.views)}</td>
    <td>${p.score.toFixed(0)}</td><td>${p.share.toFixed(2)}%</td>
  </tr>`).join("");

  const tagsLine = (data.tags || []).map((t) => "@" + t).join(", ");
  document.getElementById("ifNote").innerHTML =
    `Engagement = ${esc(data.formula)}, where "replies" means replies RECEIVED under the content. ` +
    `Gold tiles are curated ecosystem accounts (<code>infofi/projects.txt</code>, all their own posts). ` +
    `Green tiles are voices, scoped strictly to the ecosystem context tags (${esc(tagsLine)}): ` +
    `their tagged posts count at full weight, their own tagged comments at half weight ("Comments" column). ` +
    `Comments outside the tag context are ignored on purpose. ` +
    `Data collected by the same x-oracle pipeline that resolves ShinyLuck prediction markets.`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

main();
