/**
 * PM2 — jalankan:  pm2 start ecosystem.config.js && pm2 save
 *
 * Kalau di 1 VPS ada lebih dari 1 bot (misal area lain), cukup ganti
 * NAMA dan PORT di bawah supaya tidak bentrok.
 */
const NAMA       = "wa-bot-madura"; // nama proses di PM2
const PORT_PANEL = 3010;            // port panel web (arahkan nginx / cloudflared ke sini)
const PORT_BOT   = 3012;            // port internal bot (hanya localhost)

module.exports = {
  apps: [
    {
      name: NAMA,
      script: "index3.js",
      cwd: __dirname,
      env: { BOT_API_PORT: PORT_BOT },
      max_restarts: 1000,
      restart_delay: 5000,
      min_uptime: "10s",
      exp_backoff_restart_delay: 100,
    },
    {
      name: `${NAMA}-panel`,
      script: "admin-server.js",
      cwd: __dirname,
      env: { PORT: PORT_PANEL, BOT_API_PORT: PORT_BOT },
    },
    {
      name: `${NAMA}-watchdog`,
      script: "watchdog.js",
      cwd: __dirname,
      env: { BOT_NAME: NAMA },
    },
  ],
};
