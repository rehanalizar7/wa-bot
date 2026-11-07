#!/usr/bin/env node
/**
 * Buat / reset password panel admin web.
 *
 *   node scripts/set-password.js            → diminta ketik password
 *   node scripts/set-password.js "rahasia"  → langsung set
 */
const readline = require("readline");
const store = require("../lib/store");

async function tanya(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a); }));
}

(async () => {
  let pw = process.argv[2];
  if (!pw) {
    pw = await tanya("Password baru panel (min. 8 karakter): ");
    const ulang = await tanya("Ulangi password: ");
    if (pw !== ulang) { console.error("❌ Password tidak sama."); process.exit(1); }
  }
  if (!pw || pw.length < 8) { console.error("❌ Password minimal 8 karakter."); process.exit(1); }
  store.updateConfig(c => { c.panel.passwordHash = store.hashPassword(pw); });
  console.log("✅ Password panel tersimpan. Restart panel tidak perlu, langsung bisa login.");
})();
