// Copies the web app into www/ for Capacitor. The web app itself has no build step.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, ".."), out = path.join(root, "www");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
for (const f of ["index.html", "styles.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "sw.js", "js", "data"]) {
  fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
}
console.log("www/ ready");
