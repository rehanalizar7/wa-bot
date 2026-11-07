const { execSync } = require("child_process");
const fs = require("fs");

const path = require("path");
const BOT_NAME  = process.env.BOT_NAME || "wa-bot";   // nama proses bot di PM2
const LOG       = path.join(__dirname, "watchdog.log");
const HEARTBEAT = path.join(__dirname, "watchdog_heartbeat");
const INTERVAL   = 3 * 60 * 1000;   // cek tiap 3 menit
const HANG_LIMIT = 10 * 60 * 1000;  // bot dianggap hang jika >10 menit tidak update heartbeat

function log(msg) {
  const line = `[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
}

function run(cmd) {
  execSync(cmd, { stdio: "ignore", shell: true });
}

function isBotStopped() {
  try {
    const out = execSync("pm2 jlist", { encoding: "utf8", shell: true });
    const list = JSON.parse(out);
    const bot = list.find(p => p.name === BOT_NAME);
    return !bot || bot.pm2_env.status !== "online";
  } catch (_) { return false; }
}

function isBotHang() {
  try {
    if (!fs.existsSync(HEARTBEAT)) return false;
    const ts = parseInt(fs.readFileSync(HEARTBEAT, "utf8"));
    return (Date.now() - ts) > HANG_LIMIT;
  } catch (_) { return false; }
}

function fixBot(reason) {
  try {
    log(`${reason} -- restart...`);
    run(`pm2 restart ${BOT_NAME}`);
    try { if (fs.existsSync(HEARTBEAT)) fs.unlinkSync(HEARTBEAT); } catch (_) {}
    log("Bot direstart.");
  } catch (e) {
    log("Error saat fix: " + e.message);
  }
}

log("Watchdog aktif -- cek tiap 3 menit (stopped + hang >10 menit).");

setInterval(() => {
  try {
    if (isBotStopped()) {
      fixBot("Bot stopped/crash");
    } else if (isBotHang()) {
      fixBot("Bot hang >10 menit tidak ada aktivitas");
    }
  } catch (e) {
    log("Error cek: " + e.message);
  }
}, INTERVAL);
