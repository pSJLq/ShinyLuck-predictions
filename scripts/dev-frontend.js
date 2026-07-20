// Tiny static server for the local predictions UI. No deps beyond Node.
//   node scripts/dev-frontend.js   →   http://127.0.0.1:5178
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "web");
const PORT = parseInt(process.env.PORT || "5178", 10);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/predictions.html";
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end("no"); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found: " + rel); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[dev-frontend] http://127.0.0.1:${PORT}`));
