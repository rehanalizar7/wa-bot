/**
 * Bot WhatsApp Poin Toko
 * whatsapp-web.js + Google Sheets + Foto Hadiah
 *
 * Sheet "Data Toko"   → A:ID, B:DSUB, C:TSUB, D:KODE_TOKO, E:NAMA_TOKO, F:PIC_TOKO, G:WA, H:POIN
 * Sheet "List_Hadiah" → A:ID, B:NAMA, C:POIN, D:GAMBAR, E:STOK
 * Sheet "LOG_KLAIM"   → A:TANGGAL, B:NAMA_TOKO, C:PIC_TOKO, D:KODE_TOKO, E:AKSI, F:KETERANGAN, G:POIN_DIUBAH, H:SISA_POIN
 */

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const qrcode = require("qrcode-terminal");
const { google } = require("googleapis");
const axios = require("axios");
const fs = require("fs");

// Hapus SingletonLock jika ada (mencegah bot stuck setelah crash)
const SINGLETON_LOCK = "./auth_session/session/SingletonLock";
if (fs.existsSync(SINGLETON_LOCK)) {
  fs.unlinkSync(SINGLETON_LOCK);
  console.log("🔓 SingletonLock dihapus otomatis");
}

function parsePoin(val) {
  const s = String(val || "").toLowerCase().replace(/\s|\./g, "").replace(",", ".");
  if (s.includes("jt")) return Math.round(parseFloat(s) * 1_000_000);
  if (s.includes("rb") || s.includes("k")) return Math.round(parseFloat(s) * 1_000);
  return parseInt(s) || 0;
}

function fmt(n) {
  return Number(n).toLocaleString("id-ID");
}

// ============================================================
// KONFIGURASI — semua diatur lewat panel web (data/config.json)
// ============================================================

const store = require("./lib/store");
const pencapaian = require("./lib/pencapaian");
const cfg = () => store.getConfig();
const { render, normWa } = store;

const CREDENTIALS_PATH = "./credentials.json";

// Path Chromium di VPS Linux
const CHROMIUM_PATH = "/usr/bin/chromium";

// Spreadsheet ID — kalau diganti dari web, cache otomatis dikosongkan
let _lastSid = null;
function SID() {
  const id = cfg().spreadsheetId;
  if (_lastSid !== null && id !== _lastSid) clearCache();
  _lastSid = id;
  if (!id) throw new Error("Spreadsheet ID belum diisi di panel (Pengaturan → Lanjutan)");
  return id;
}

// ── Admin ─────────────────────────────────────────────────────
const superAdmin = () => normWa(cfg().superAdmin);
const loadAdmins = () => store.loadAdmins();
const saveAdmins = list => store.writeRole("admin", list.map(normWa).filter(a => a && a !== superAdmin()));
const isAdmin    = wa => loadAdmins().includes(wa);

// ── AI tester ─────────────────────────────────────────────────
const isAITester = wa => {
  const ai = cfg().ai;
  return !!(ai.aktif && ai.apiKey && (ai.tester || []).map(normWa).includes(wa));
};

// ── RE (Sales) ────────────────────────────────────────────────
const loadRE     = () => store.readRole("re");
const saveRE     = list => store.writeRole("re", list);
const isRE       = wa => loadRE().some(r => r.wa === wa);
const getREInfo  = wa => loadRE().find(r => r.wa === wa);

// ── Supervisor (ngawasin 1+ DSUB, beberapa RE sekaligus) ───────
const loadSPV    = () => store.readRole("spv");
const saveSPV    = list => store.writeRole("spv", list);
const isSPV      = wa => loadSPV().some(s => s.wa === wa);
const getSPVInfo = wa => loadSPV().find(s => s.wa === wa);

// ── Manajer (scope semua wilayah) ─────────────────────────────
const loadManajer    = () => store.readRole("manajer");
const saveManajer    = list => store.writeRole("manajer", list);
const isManajer      = wa => loadManajer().some(m => m.wa === wa);
const getManajerInfo = wa => loadManajer().find(m => m.wa === wa);

// ============================================================
// GOOGLE SHEETS
// ============================================================

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ── Cache ─────────────────────────────────────────────────────
const CACHE_TTL_TOKO   = 60  * 1000; // 60 detik
const CACHE_TTL_HADIAH = 300 * 1000; // 5 menit
const CACHE_TTL_INFO   = 300 * 1000; // 5 menit

const cache = {
  toko:   { data: null, at: 0 },
  hadiah: { data: null, at: 0 },
  info:   { data: null, at: 0 },
  tabProgram: new Map(), // nama tab → { data, at }
};
function clearCache() { cache.toko.at = 0; cache.hadiah.at = 0; cache.info.at = 0; cache.tabProgram.clear(); }

async function getTokoDB() {
  const now = Date.now();
  if (cache.toko.data && now - cache.toko.at < CACHE_TTL_TOKO) return cache.toko.data;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:I" });
  cache.toko.data = (res.data.values || []).filter(r => r && r[0]).map(r => ({
    id:          r[0] || "",
    dsub:        r[1] || "",
    tsub:        String(r[2] || "").replace(/^TSUB/i, ""),
    code:        r[3] || "",
    nama:        r[4] || "",
    penjaga:     r[5] || "",
    wa:          String(r[6] || "").trim(),
    poin:        parsePoin(r[7]),
    kontributor: r[8] || "",
  }));
  cache.toko.at = now;
  return cache.toko.data;
}

async function getHadiahDB() {
  const now = Date.now();
  if (cache.hadiah.data && now - cache.hadiah.at < CACHE_TTL_HADIAH) return cache.hadiah.data;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "List_Hadiah!A2:F" });
  cache.hadiah.data = (res.data.values || []).filter(r => r && r[0]).map((r, i) => ({
    id:     r[0] || `H${i+1}`,
    nama:   r[1] || "",
    poin:   parsePoin(r[2]),
    gambar: r[3] || "",
    stok:   (r[4] !== undefined && r[4] !== "") ? parseInt(r[4]) : null,
    tipe:   (r[5] || "utama").toLowerCase().trim(), // "utama" atau "hiburan"
    rowNum: i + 2,
  }));
  cache.hadiah.at = now;
  return cache.hadiah.data;
}

// Sheet Info_Program:
// A JUDUL, B DESKRIPSI, C GAMBAR, D MEKANISME, E PERIODE, F KODE_PROGRAM, G TARGET, H SATUAN
async function getInfoProgram() {
  const now = Date.now();
  if (cache.info.data && now - cache.info.at < CACHE_TTL_INFO) return cache.info.data;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Info_Program!A2:H", valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  cache.info.data = (res.data.values || []).filter(r => r && r[0]).map(r => ({
    judul:     String(r[0] ?? "").trim(),
    deskripsi: String(r[1] ?? ""),
    gambar:    String(r[2] ?? "").trim(),
    mekanisme: String(r[3] ?? ""),
    periode:   String(r[4] ?? "").trim(),
    kode:      String(r[5] || "").trim(),
    target:    pencapaian.parseAngka(r[6]),
    satuan:    String(r[7] || "").trim(),
  }));
  cache.info.at = now;
  return cache.info.data;
}

// Tab pencapaian 1 program (nama tab = judul program) — format ada di lib/pencapaian.js.
// Return null kalau tab belum dibuat.
async function getTabProgram(program) {
  const tab = pencapaian.namaTab(program.judul);
  if (!tab) return null;
  const now = Date.now();
  const c = cache.tabProgram.get(tab);
  if (c && now - c.at < CACHE_TTL_INFO) return c.data;
  let data = null;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SID(), range: `'${tab.replace(/'/g, "''")}'!A1:Z`,
      valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING",
    });
    data = pencapaian.parseTab(res.data.values);
  } catch (err) {
    if (!/Unable to parse range/i.test(err.message)) throw err;
  }
  cache.tabProgram.set(tab, { data, at: now });
  return data;
}

async function getHadiahSheetId() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SID() });
  const sheet = res.data.sheets.find(s => s.properties.title === "List_Hadiah");
  return sheet ? sheet.properties.sheetId : null;
}

async function tambahHadiah(nama, poin, gambar, stok) {
  const id = Date.now().toString();
  const stokVal = (stok === null || stok === undefined || stok === "") ? "" : stok;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(),
    range: "List_Hadiah!A:E",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[id, nama, poin, gambar, stokVal]] },
  });
  cache.hadiah.at = 0;
}

async function editHadiah(nomor, nama, poin, gambar, stok) {
  const sheetRow = nomor + 1; // +1 karena baris 1 adalah header
  const stokVal = (stok === null || stok === undefined) ? "" : stok;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(),
    range: `List_Hadiah!B${sheetRow}:E${sheetRow}`,
    valueInputOption: "RAW",
    requestBody: { values: [[nama, poin, gambar, stokVal]] },
  });
  cache.hadiah.at = 0;
}

async function hapusHadiah(nomor) {
  const sheetId = await getHadiahSheetId();
  if (sheetId === null) throw new Error("Sheet List_Hadiah tidak ditemukan");
  const rowIndex = nomor; // 0-based: nomor 1 = index 1 (skip header)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SID(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      }],
    },
  });
  cache.hadiah.at = 0;
}

async function updateStokHadiah(hadiah) {
  if (hadiah.stok === null) return; // tidak terbatas, tidak perlu update
  const newStok = Math.max(0, hadiah.stok - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(),
    range: `List_Hadiah!E${hadiah.rowNum}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newStok]] },
  });
  cache.hadiah.at = 0; // invalidate cache
}

async function gantiWaToko(waLama, waBaru) {
  const tokoDB = await getTokoDB();
  const toko = tokoDB.find(t => t.wa === waLama.trim());
  if (!toko) return { sukses: false, alasan: "tidak_ditemukan" };
  if (tokoDB.find(t => t.wa === waBaru.trim())) return { sukses: false, alasan: "wa_baru_sudah_ada" };
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!G2:G" });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r && String(r[0] || "").trim() === waLama.trim());
  if (rowIndex === -1) return { sukses: false, alasan: "tidak_ditemukan" };
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(),
    range: `Data Toko!G${rowIndex + 2}`,
    valueInputOption: "RAW",
    requestBody: { values: [[waBaru]] },
  });
  cache.toko.at = 0; // invalidate cache
  return { sukses: true, toko };
}

async function updatePoin(wa, poinBaru) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!G2:G" });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r && String(r[0] || "").trim() === String(wa).trim());
  if (rowIndex === -1) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(),
    range: `Data Toko!H${rowIndex + 2}`,
    valueInputOption: "RAW",
    requestBody: { values: [[poinBaru]] },
  });
  // Sync cache supaya tidak perlu fetch ulang
  if (cache.toko.data) {
    const t = cache.toko.data.find(t => t.wa === wa);
    if (t) t.poin = poinBaru;
  }
  return true;
}

async function tambahPoinByWa(wa, jumlah) {
  const tokoDB = await getTokoDB();
  const toko = tokoDB.find(t => t.wa === wa);
  if (!toko) return null;
  const poinBaru = toko.poin + jumlah;
  await updatePoin(wa, poinBaru);
  return { toko, poinLama: toko.poin, poinBaru };
}

async function daftarToko(wa, kode, nama, pic) {
  const tokoDB = await getTokoDB();
  if (tokoDB.find(t => t.wa === wa)) return { sudahAda: true, alasan: "wa" };
  const tokoSUBSama = tokoDB.find(t => String(t.code).trim().toUpperCase() === String(kode).trim().toUpperCase());
  if (tokoSUBSama && !tokoSUBSama.wa) {
    // Toko sudah ada (mis. dari upload HO) tapi WA belum diisi → lengkapi barisnya, poin tetap
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!D2:G" });
    const i = (res.data.values || []).findIndex(r => r && String(r[0] || "").trim().toUpperCase() === String(kode).trim().toUpperCase() && !String(r[3] || "").trim());
    if (i !== -1) {
      const namaBaru = tokoSUBSama.nama || nama, picBaru = tokoSUBSama.penjaga || pic;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SID(), range: `Data Toko!E${i + 2}:G${i + 2}`,
        valueInputOption: "RAW", requestBody: { values: [[namaBaru, picBaru, wa]] },
      });
      cache.toko.at = 0;
      return { sudahAda: false, dilengkapi: true, wa, kode: tokoSUBSama.code, nama: namaBaru, pic: picBaru, poin: tokoSUBSama.poin };
    }
  }
  if (tokoSUBSama) return { sudahAda: true, alasan: "kode", tokoExisting: tokoSUBSama };
  const id = Date.now().toString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(),
    range: "Data Toko!A:H",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[id, "", "", kode, nama, pic, wa, 0]] },
  });
  // Invalidate cache supaya data terbaru langsung terbaca
  cache.toko.at = 0;
  return { sudahAda: false, wa, kode, nama, pic };
}

// Cek apakah toko sudah klaim tipe tertentu (utama/hiburan)
async function cekSudahKlaim(kode, hadiahDB) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SID(),
    range: "LOG_KLAIM!D2:F",
  });
  const rows = res.data.values || [];
  const klaimToko = rows.filter(r => String(r[0] || "").trim().toUpperCase() === kode.toUpperCase() && String(r[1] || "").trim() === "KLAIM");
  const namaKlaim = klaimToko.map(r => String(r[2] || "").trim().toLowerCase());
  const hadiahMap = new Map(hadiahDB.map(h => [h.nama.toLowerCase(), h.tipe]));
  let sudahUtama = false, sudahHiburan = false;
  for (const nama of namaKlaim) {
    const tipe = hadiahMap.get(nama);
    if (tipe === "utama") sudahUtama = true;
    if (tipe === "hiburan") sudahHiburan = true;
  }
  return { sudahUtama, sudahHiburan };
}

// Kirim notif ke RE berdasarkan TSUB toko
async function notifKlaimKeRE(toko, hadiah, sisaPoin) {
  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  if (!cfg().fitur.notifKeRE) return;
  const reList = loadRE();
  const tsub = String(toko.tsub || "").replace(/^0+/, ""); // strip leading zero
  const re = reList.find(r => r.tsub.some(t => String(t).replace(/^0+/, "") === tsub));

  const pesanRE =
    `🔔 *KLAIM HADIAH - TOKO KAMU*\n\n` +
    `📅 Waktu         : ${tgl}\n` +
    `🏪 Toko          : ${toko.nama}\n` +
    `👤 PIC           : ${toko.penjaga || "-"}\n` +
    `📦 Kode          : ${toko.code}\n` +
    `🎁 Hadiah        : ${hadiah.nama}\n` +
    `🏷️  Tipe          : ${hadiah.tipe}\n` +
    `⭐ Poin dipotong : ${fmt(hadiah.poin)}\n` +
    `💰 Sisa poin     : ${fmt(sisaPoin)}`;

  if (re && re.wa) {
    const waRe = String(re.wa).replace(/[\s\+\-]/g, "");
    if (/^\d{9,15}$/.test(waRe)) {
      try {
        await client.sendMessage(`${waRe}@c.us`, pesanRE);
        console.log(`📨 Notif klaim terkirim ke RE ${re.nama} (${waRe})`);
        return;
      } catch (e) {
        console.error("Gagal kirim notif RE:", e.message);
      }
    }
  }
  // RE tidak ada atau gagal → notif ke grup dengan keterangan
  const namaRE = re ? re.nama : `Territory Code ${toko.tsub}`;
  await kirimNotif(
    pesanRE + `\n\n⚠️ *RE: ${namaRE}* — belum ada nomor RE yang tertaut`
  );
}

async function catatLog(toko, aksi, keterangan, poinDiubah, sisaPoin) {
  const tanggal = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(),
    range: "LOG_KLAIM!A:H",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[tanggal, toko.nama, toko.penjaga, toko.code, aksi, keterangan, poinDiubah, sisaPoin]],
    },
  });
}

// ============================================================
// KIRIM FOTO
// ============================================================

async function kirimFoto(chatId, hadiah, caption) {
  // Validasi URL dulu — harus diawali http:// atau https://
  if (!hadiah.gambar || !/^https?:\/\//i.test(hadiah.gambar)) return false;
  try {
    const response = await axios.get(hadiah.gambar, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const b64 = Buffer.from(response.data).toString("base64");
    const mime = response.headers["content-type"] || "image/jpeg";
    const media = new MessageMedia(mime, b64);
    await client.sendMessage(chatId, media, { caption });
    console.log(`🖼️  Foto terkirim: ${hadiah.nama}`);
    return true;
  } catch (err) {
    console.error(`❌ Gagal kirim foto ${hadiah.nama}:`, err.message);
    return false;
  }
}

// ============================================================
// NOTIFIKASI GROUP
// ============================================================

async function kirimNotif(pesan) {
  const groupId = cfg().notifGroupId;
  if (!groupId) return;
  try {
    await client.sendMessage(groupId, pesan);
    console.log("📣 Notifikasi terkirim ke group.");
  } catch (err) {
    console.error("❌ Gagal kirim notif group:", err.message);
  }
}

async function notifKlaim(toko, hadiah, sisaPoin) {
  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await kirimNotif(
    `🔔 *KLAIM HADIAH*\n\n` +
    `📅 Waktu         : ${tgl}\n` +
    `🏪 Toko          : ${toko.nama}\n` +
    `👤 PIC           : ${toko.penjaga}\n` +
    `📦 Kode          : ${toko.code}\n` +
    `🎁 Hadiah        : ${hadiah.nama}\n` +
    `🏷️  Tipe          : ${hadiah.tipe}\n` +
    `⭐ Poin dipotong : ${fmt(hadiah.poin)}\n` +
    `💰 Sisa poin     : ${fmt(sisaPoin)}`
  );
  await notifKlaimKeRE(toko, hadiah, sisaPoin);
}

async function notifTambah(toko, jumlah, poinBaru, byAdmin) {
  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await kirimNotif(
    `➕ *TAMBAH POIN*\n\n` +
    `📅 Waktu     : ${tgl}\n` +
    `👤 Admin     : ${byAdmin}\n` +
    `🏪 Toko      : ${toko.nama}\n` +
    `📦 Kode      : ${toko.code}\n` +
    `⭐ Ditambah  : +${fmt(jumlah)}\n` +
    `💰 Poin baru : ${fmt(poinBaru)}`
  );
}

async function notifKurangi(toko, jumlah, poinBaru, byAdmin) {
  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await kirimNotif(
    `➖ *KURANGI POIN*\n\n` +
    `📅 Waktu     : ${tgl}\n` +
    `👤 Admin     : ${byAdmin}\n` +
    `🏪 Toko      : ${toko.nama}\n` +
    `📦 Kode      : ${toko.code}\n` +
    `⭐ Dikurangi : -${fmt(jumlah)}\n` +
    `💰 Poin baru : ${fmt(poinBaru)}`
  );
}

async function notifDaftar(toko, byAdmin) {
  const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  await kirimNotif(
    `${toko.dilengkapi ? "📱 *WA TOKO DILENGKAPI*" : "🆕 *TOKO BARU TERDAFTAR*"}\n\n` +
    `📅 Waktu  : ${tgl}\n` +
    `👤 Admin  : ${byAdmin}\n` +
    `🏪 Toko   : ${toko.nama}\n` +
    `👤 PIC    : ${toko.pic}\n` +
    `📦 Kode   : ${toko.kode}\n` +
    `📱 WA     : ${toko.wa}`
  );
}

// ============================================================
// FIFO QUEUE PER USER
// ============================================================

const msgQueue = {};
const msgProcessing = {};

async function enqueue(wa, fn) {
  if (!msgQueue[wa]) msgQueue[wa] = [];
  return new Promise((resolve, reject) => {
    msgQueue[wa].push({ fn, resolve, reject });
    if (!msgProcessing[wa]) drainQueue(wa);
  });
}

async function drainQueue(wa) {
  msgProcessing[wa] = true;
  while (msgQueue[wa] && msgQueue[wa].length > 0) {
    const { fn, resolve, reject } = msgQueue[wa].shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
  }
  msgProcessing[wa] = false;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

const userState = {};
function getState(wa) {
  if (!userState[wa]) userState[wa] = { step: "start", pendingKlaim: null, opsiHadiah: [] };
  return userState[wa];
}
function setState(wa, update) {
  userState[wa] = { ...getState(wa), ...update };
}

// ============================================================
// LOGIKA BOT TOKO
// ============================================================

async function callGemini(systemPrompt, pesanUser) {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${cfg().ai.model || "gemini-2.5-flash"}:generateContent?key=${cfg().ai.apiKey}`,
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: pesanUser }] }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
      },
      { timeout: 10000 }
    );
    const candidate = res.data?.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") console.warn("⚠️ Gemini MAX_TOKENS — respons terpotong");
    return candidate?.content?.parts?.[0]?.text?.trim()
      || "Maaf, aku lagi gangguan sebentar. Coba lagi ya! 🙏";
  } catch (err) {
    console.error("Gemini error:", err.response?.data || err.message);
    return "Maaf, aku lagi gangguan sebentar. Coba lagi ya! 🙏";
  }
}

function buildPromptToko(toko, hadiahDB, infoList) {
  const hadiahText = hadiahDB.length
    ? hadiahDB.map(h => `- ${h.nama} (${fmt(h.poin)} poin, stok: ${h.stok === null ? "∞" : h.stok})`).join("\n")
    : "Belum ada hadiah tersedia.";
  const infoText = infoList.length
    ? infoList.map(i => `- ${i.judul}${i.periode ? ` (${i.periode})` : ""}: ${i.deskripsi}${i.mekanisme ? ` Mekanisme: ${i.mekanisme}` : ""}`).join("\n")
    : "Tidak ada info program aktif saat ini.";
  return (
    `Kamu adalah CS bot WhatsApp untuk program loyalitas toko. ` +
    `Jawab singkat, ramah, natural (gaya WhatsApp). Bahasa Indonesia santai. Jangan sebut kamu AI. Format: *bold* (bukan **bold**), _italic_. Jangan pakai markdown lain.\n\n` +
    `Data toko:\n- Nama: ${toko.nama}\n- PIC: ${toko.penjaga}\n- Poin: ${fmt(toko.poin)} poin\n- Kode: ${toko.code}\n\n` +
    `Program aktif:\n${infoText}\n\nHadiah tersedia:\n${hadiahText}\n\n` +
    `Panduan: tanya poin → sebutkan poin mereka. Tanya hadiah → sebutkan yang bisa/belum bisa diklaim. ` +
    `Mau klaim → minta ketik "klaim". Menu → minta ketik "0". Jawaban maks 3-4 kalimat.`
  );
}

function buildPromptRE(re, tokoArea) {
  const tsubList = Array.isArray(re.tsub) ? re.tsub : [String(re.tsub)];
  const aktif = tokoArea.filter(t => t.poin > 0).length;
  const totalPoin = tokoArea.reduce((s, t) => s + t.poin, 0);
  const topToko = [...tokoArea].sort((a, b) => b.poin - a.poin).slice(0, 3)
    .map(t => `${t.nama} (${t.code}): ${fmt(t.poin)} poin`).join(", ");
  return (
    `Kamu adalah asisten RE (Sales) WhatsApp. Jawab singkat, ramah, natural. Bahasa Indonesia santai. Jangan sebut kamu AI. Format: *bold* (bukan **bold**), _italic_. Jangan pakai markdown lain.\n\n` +
    `Data RE:\n- Nama: ${re.nama}\n- Territory Code: ${tsubList.join(", ")}\n` +
    `- Total toko: ${tokoArea.length} | Aktif: ${aktif} | Total poin: ${fmt(totalPoin)}\n` +
    `- Top toko: ${topToko || "-"}\n\n` +
    `Perintah yang tersedia: CEK [kode], LIST, RINGKASAN.\n` +
    `Panduan: bantu RE memahami data territory-nya. Jawaban maks 3-4 kalimat.`
  );
}

function buildPromptSPV(spv, dsubList, tokoArea, reArea, ranking) {
  const aktif = tokoArea.filter(t => t.poin > 0).length;
  const totalPoin = tokoArea.reduce((s, t) => s + t.poin, 0);
  const rankingText = ranking.slice(0, 3)
    .map((r, i) => `${i+1}. ${r.nama} (${fmt(r.totalPoin)} poin, ${r.aktif}/${r.totalToko} toko aktif)`).join(", ");
  return (
    `Kamu adalah asisten Supervisor WhatsApp. Jawab singkat, ramah, natural. Bahasa Indonesia santai. Jangan sebut kamu AI. Format: *bold* (bukan **bold**), _italic_. Jangan pakai markdown lain.\n\n` +
    `Data Supervisor:\n- Nama: ${spv.nama}\n- District Code: ${dsubList.join(", ")}\n` +
    `- Total toko: ${tokoArea.length} | Aktif: ${aktif} | Total poin: ${fmt(totalPoin)}\n` +
    `- Total RE: ${reArea.length}\n- Ranking RE: ${rankingText || "-"}\n\n` +
    `Perintah yang tersedia: CEK [kode], LIST, LIST RE, RINGKASAN.\n` +
    `Panduan: bantu SPV memahami kondisi area dan performa RE-nya. Jawaban maks 3-4 kalimat.`
  );
}

function buildPromptManajer(mgr, tokoDB, ranking) {
  const aktif = tokoDB.filter(t => t.poin > 0).length;
  const totalPoin = tokoDB.reduce((s, t) => s + t.poin, 0);
  const rankingText = ranking.slice(0, 3)
    .map((d, i) => `${i+1}. District ${d.dsub} (${fmt(d.totalPoin)} poin, ${d.aktif}/${d.totalToko} toko aktif)`).join(", ");
  return (
    `Kamu adalah asisten Manajer WhatsApp. Jawab singkat, ramah, natural. Bahasa Indonesia santai. Jangan sebut kamu AI. Format: *bold* (bukan **bold**), _italic_. Jangan pakai markdown lain.\n\n` +
    `Data Manajer:\n- Nama: ${mgr.nama}\n- Scope: semua wilayah\n` +
    `- Total toko: ${tokoDB.length} | Aktif: ${aktif} | Total poin: ${fmt(totalPoin)}\n` +
    `- Ranking District Code: ${rankingText || "-"}\n\n` +
    `Perintah yang tersedia: CEK [kode], LIST, LIST [District Code], RINGKASAN.\n` +
    `Panduan: bantu Manajer memahami kondisi global dan performa per District Code. Jawaban maks 3-4 kalimat.`
  );
}

// Kirim isi menu tambahan (dengan gambar kalau ada). Return null = sudah terkirim sendiri.
async function kirimMenuTambahan(chatId, menu, vars) {
  const teks = store.isiTemplate(menu.isi, vars);
  if (menu.gambar) {
    const terkirim = await kirimFoto(chatId, { gambar: menu.gambar, nama: menu.judul }, teks);
    if (terkirim) return null;
  }
  return teks;
}

// ── INFO PROGRAM + PENCAPAIAN ─────────────────────────────────
/** Kirim detail 1 program (+ pencapaian toko). Return teks penutup untuk di-reply. */
async function kirimDetailProgram(chatId, program, toko, adaLainnya) {
  let tab = null;
  try { tab = await getTabProgram(program); }
  catch (err) { console.error("Gagal baca pencapaian:", err.message); }

  const bagian = [`📢 *${program.judul}*` + (program.periode ? `\n🗓️ Periode: ${program.periode}` : "")];
  if (program.deskripsi) bagian.push(program.deskripsi);
  if (program.mekanisme) bagian.push(`📋 *Mekanisme:*\n${program.mekanisme}`);
  const capai = pencapaian.teksWa(program, toko, tab);
  if (capai) bagian.push(capai);
  const isi = bagian.join("\n\n");
  const penutup = adaLainnya
    ? `Ketik nomor program lain untuk lihat detailnya, atau *0* untuk menu.`
    : `Ketik *0* untuk kembali ke menu.`;

  if (/^https?:\/\//i.test(program.gambar)) {
    // Caption WA dibatasi ±1000 karakter; kalau lebih, foto + judul saja lalu teks lengkap
    const panjang = isi.length > 1000;
    const terkirim = await kirimFoto(chatId, { gambar: program.gambar, nama: program.judul }, panjang ? `📢 *${program.judul}*` : isi);
    if (terkirim) return panjang ? `${isi}\n\n${penutup}` : penutup;
  }
  return `${isi}\n\n${penutup}`;
}

async function prosesToko(wa, chatId, teks) {
  const inp = teks.trim().toLowerCase();
  const st = getState(wa);

  let tokoDB, hadiahDB, toko;
  try {
    tokoDB   = await getTokoDB();
    hadiahDB = await getHadiahDB();
    toko     = tokoDB.find(t => t.wa === wa);
  } catch (err) {
    console.error("Gagal baca Sheets:", err.message);
    return render("gangguan");
  }

  if (!toko) {
    return render("belumTerdaftar");
  }

  const fitur = cfg().fitur;
  const menuExtra = store.menuAktif();
  const v = {
    toko: toko.nama, pic: toko.penjaga || "-", kode: toko.code,
    poin: fmt(toko.poin),
    menu_tambahan: store.teksMenuTambahan(menuExtra),
  };
  // Saat fitur cek poin dimatikan, poin di menu & menu tambahan disembunyikan
  const vTampil = { ...v, poin: fitur.cekPoin ? v.poin : "sedang dihitung ⏳" };

  const menuUtama = () => {
    let teksMenu = render("menuUtama", vTampil);
    // Kalau template menu diubah dan {menu_tambahan} terhapus, tetap tampilkan di bawah
    if (!(cfg().pesan.menuUtama || "").includes("{menu_tambahan}")) teksMenu += v.menu_tambahan;
    return teksMenu;
  };

  // ── MENU UTAMA ────────────────────────────────────────────
  // Chat pertama (atau setelah bot restart) yang berupa salam → tampilkan menu.
  // Kalau chat pertama sudah berisi perintah ("info hadiah", "2", ...) → langsung diproses.
  const chatPertama = st.step === "start";
  if (["menu","0","halo","hi","hello","hai","p"].includes(inp)) {
    setState(wa, { step: "menu" });
    return menuUtama();
  }
  if (chatPertama) setState(wa, { step: "menu" });

  // ── PILIH PROGRAM (setelah daftar program ditampilkan) ─────
  let step = st.step;
  if (step === "pilih_program") {
    const opsi = st.opsiProgram || [];
    const n = /^\d+$/.test(inp) ? parseInt(inp) : 0;
    if (n >= 1 && n <= opsi.length) return kirimDetailProgram(chatId, opsi[n - 1], toko, opsi.length > 1);
    // Bukan nomor program → proses sebagai perintah menu biasa
    setState(wa, { step: "menu", opsiProgram: [] });
    step = "menu";
  }

  // ── MENU ─────────────────────────────────────────────────
  if (chatPertama || step === "menu") {

    // Menu tambahan — nomor / kata kunci persis didahulukan
    const menuPersis = store.cariMenu(inp, true, menuExtra);
    if (menuPersis) return kirimMenuTambahan(chatId, menuPersis, vTampil);

    // Urutan pengecekan penting: kata yang lebih spesifik dulu.
    // "klaim hadiah" → klaim, "info program" → program, "cek hadiah" → hadiah, baru "poin"/"cek".
    const mauKlaim   = inp === "3" || inp.includes("klaim");
    const mauProgram = !mauKlaim && (inp === "4" || inp.includes("program"));
    const mauHadiah  = !mauKlaim && !mauProgram && (inp === "2" || inp.includes("hadiah") || inp === "info");
    const mauPoin    = !mauKlaim && !mauProgram && !mauHadiah && (inp === "1" || inp.includes("poin") || inp.includes("cek"));

    // Cek poin
    if (mauPoin) {
      if (!fitur.cekPoin) return render("poinSedangDihitung", v);
      return render("cekPoin", v);
    }

    // Info hadiah — tampilkan yang stok > 0 (+ foto kalau ada)
    if (mauHadiah) {
      const hadiahTersedia = hadiahDB.filter(h => h.stok === null || h.stok > 0);
      if (hadiahTersedia.length === 0) {
        return `😔 Saat ini belum ada hadiah yang tersedia.\n\nKetik *0* untuk menu.`;
      }
      // Hadiah yang punya foto dikirim sebagai foto; yang tidak punya / fotonya gagal
      // dikumpulkan jadi daftar teks (dulu hilang begitu saja → yang tampil cuma poin).
      const tanpaFoto = [];
      for (const h of hadiahTersedia) {
        const bisa = toko.poin >= h.poin ? "✅" : "❌";
        const stok = h.stok === null ? "" : ` · stok ${h.stok}`;
        const baris = `${bisa} *${h.nama}*\n⭐ ${fmt(h.poin)} poin${stok}`;
        const terkirim = await kirimFoto(chatId, h, baris);
        if (!terkirim) tanpaFoto.push(baris);
      }
      const daftar = tanpaFoto.length ? `🎁 *Daftar Hadiah*\n\n${tanpaFoto.join("\n\n")}\n\n` : "";
      const poinKamu = fitur.cekPoin ? `Poin kamu: *${fmt(toko.poin)} poin*\n` : "";
      return `${daftar}${poinKamu}✅ = poin cukup, ❌ = poin belum cukup\n\nKetik *3* untuk klaim hadiah, *0* menu.`;
    }

    // Info program — 1 program langsung detail, lebih dari 1 tampilkan daftar dulu
    if (mauProgram) {
      let infoList;
      try {
        infoList = await getInfoProgram();
      } catch (err) {
        console.error("Gagal ambil info program:", err.message);
        return "Maaf, gagal ambil info program. Coba lagi ya. 🙏";
      }
      if (infoList.length === 0) {
        return `ℹ️ Belum ada info program saat ini.\n\nKetik *0* untuk menu.`;
      }
      if (infoList.length === 1) return kirimDetailProgram(chatId, infoList[0], toko, false);
      setState(wa, { step: "pilih_program", opsiProgram: infoList });
      const daftar = infoList.map((p, i) => `${i + 1}. *${p.judul}*` + (p.periode ? `\n    _${p.periode}_` : "")).join("\n");
      return `📢 *Program Aktif*\n\n${daftar}\n\nKetik nomornya (1–${infoList.length}) untuk lihat detail & pencapaian toko kamu.\nKetik *0* untuk menu.`;
    }

    // Klaim hadiah — filter yang stok tersedia, cukup poin, dan belum klaim tipe yg sama
    if (mauKlaim) {
      if (!fitur.klaim) return render("klaimDitutup", v);
      const { sudahUtama, sudahHiburan } = await cekSudahKlaim(toko.code, hadiahDB);

      if (sudahUtama && sudahHiburan) return render("klaimSudahPenuh", v);

      const bisaDiklaim = hadiahDB.filter(h => {
        if (h.stok !== null && h.stok <= 0) return false;
        if (toko.poin < h.poin) return false;
        if (h.tipe === "utama" && sudahUtama) return false;
        if (h.tipe === "hiburan" && sudahHiburan) return false;
        return true;
      });

      if (bisaDiklaim.length === 0) return render("poinBelumCukup", v);

      let infoKlaim = "";
      if (sudahUtama) infoKlaim = `_(Hadiah utama sudah diklaim, pilih hadiah hiburan)_\n\n`;
      else if (sudahHiburan) infoKlaim = `_(Hadiah hiburan sudah diklaim, pilih hadiah utama)_\n\n`;

      setState(wa, { step: "pilih_hadiah", opsiHadiah: bisaDiklaim });
      const listHadiah = bisaDiklaim.map((h, i) => `${i+1}. *${h.nama}* — ${fmt(h.poin)} poin _(${h.tipe})_`).join("\n");
      return `${infoKlaim}Pilih hadiah yang mau diklaim:\n\n${listHadiah}\n\nKetik nomernya (1–${bisaDiklaim.length}) ya, Mas/Mbak.\nKetik *0* untuk batal.`;
    }

    // Menu tambahan — kata kunci yang terkandung di kalimat
    const menuMirip = store.cariMenu(inp, false, menuExtra);
    if (menuMirip) return kirimMenuTambahan(chatId, menuMirip, vTampil);

    if (isAITester(wa)) {
      let infoList = [];
      try { infoList = await getInfoProgram(); } catch {}
      return callGemini(buildPromptToko(toko, hadiahDB, infoList), teks);
    }
    // Chat pertama yang tidak dikenali → sambut dengan menu, bukan "kurang ngerti"
    if (chatPertama) return menuUtama();
    return render("tidakMengerti", v);
  }

  // ── PILIH HADIAH ──────────────────────────────────────────
  if (st.step === "pilih_hadiah") {
    if (inp === "0" || inp === "batal" || inp === "menu") {
      setState(wa, { step: "menu" });
      return `Oke, batal ya 😊\n\n${menuUtama()}`;
    }
    const opsi = st.opsiHadiah || [];
    const num = parseInt(inp);
    if (num >= 1 && num <= opsi.length) {
      const hadiah = opsi[num - 1];
      setState(wa, { step: "konfirmasi", pendingKlaim: hadiah });
      return (
        `Konfirmasi klaim:\n\n` +
        `🎁 *${hadiah.nama}*\n` +
        `Poin dibutuhkan : ${fmt(hadiah.poin)}\n` +
        `Poin kamu       : ${fmt(toko.poin)}\n` +
        `Sisa setelah    : *${fmt(toko.poin - hadiah.poin)} poin*\n\n` +
        `Ketik *YA* untuk konfirmasi atau *TIDAK* untuk batal.`
      );
    }
    return `Pilihannya 1 sampai ${opsi.length} ya 😊\nAtau ketik *0* untuk batal.`;
  }

  // ── KONFIRMASI ────────────────────────────────────────────
  if (st.step === "konfirmasi") {
    if (inp === "ya" || inp === "iya" || inp === "yes") {
      if (!fitur.klaim) {
        setState(wa, { step: "menu", pendingKlaim: null });
        return render("klaimDitutup", v);
      }
      // Cek ulang dengan data terbaru: poin / stok / jatah klaim bisa berubah
      // selama toko menunggu sebelum ketik YA.
      const hadiah = hadiahDB.find(h => h.id === st.pendingKlaim?.id) || null;
      if (!hadiah) {
        setState(wa, { step: "menu", pendingKlaim: null });
        return `Maaf, hadiah itu sudah tidak tersedia. 🙏\n\nKetik *3* untuk lihat hadiah lain, *0* menu.`;
      }
      if (hadiah.stok !== null && hadiah.stok <= 0) {
        setState(wa, { step: "menu", pendingKlaim: null });
        return `Maaf, stok *${hadiah.nama}* baru saja habis. 🙏\n\nKetik *3* untuk pilih hadiah lain, *0* menu.`;
      }
      if (toko.poin < hadiah.poin) {
        setState(wa, { step: "menu", pendingKlaim: null });
        return render("poinBelumCukup", v);
      }
      try {
        const { sudahUtama, sudahHiburan } = await cekSudahKlaim(toko.code, hadiahDB);
        if ((hadiah.tipe === "utama" && sudahUtama) || (hadiah.tipe === "hiburan" && sudahHiburan)) {
          setState(wa, { step: "menu", pendingKlaim: null });
          return `Hadiah ${hadiah.tipe} sudah pernah kamu klaim ya. 😊\n\nKetik *0* untuk menu.`;
        }
      } catch (err) {
        console.error("Gagal cek riwayat klaim:", err.message);
        return "Maaf, gagal menyimpan klaim. Coba lagi ya. 🙏";
      }
      const poinBefore = toko.poin;
      const poinBaru = poinBefore - hadiah.poin;
      try {
        if (!(await updatePoin(wa, poinBaru))) throw new Error("baris toko tidak ditemukan saat update poin");
        await updateStokHadiah(hadiah); // kurangi stok 1
        await catatLog(toko, "KLAIM", hadiah.nama, hadiah.poin, poinBaru);
        await notifKlaim(toko, hadiah, poinBaru);
      } catch (err) {
        console.error("Gagal proses klaim:", err.message);
        return "Maaf, gagal menyimpan klaim. Coba lagi ya. 🙏";
      }
      setState(wa, { step: "menu", pendingKlaim: null });
      return render("klaimBerhasil", { ...v, hadiah: hadiah.nama, poin_hadiah: fmt(hadiah.poin), sisa_poin: fmt(poinBaru) });
    }
    if (inp === "tidak" || inp === "batal" || inp === "no") {
      setState(wa, { step: "menu", pendingKlaim: null });
      return `Dibatalkan ya 😊\n\nKetik *0* untuk menu.`;
    }
    return `Ketik *YA* untuk konfirmasi atau *TIDAK* untuk batal ya.`;
  }

  setState(wa, { step: "menu" });
  if (isAITester(wa)) {
    let infoList = [];
    try { infoList = await getInfoProgram(); } catch {}
    return callGemini(buildPromptToko(toko, hadiahDB, infoList), teks);
  }
  return render("tidakMengerti", v);
}

// ============================================================
// Q&A HADIAH ADMIN
// ============================================================

async function handleHadiahQA(wa, inp, st) {
  const inpLower = inp.toLowerCase();
  const isBatal = ["batal", "cancel", "q"].includes(inpLower);

  if (isBatal) {
    setState(wa, { step: "start" });
    return `❌ Dibatalkan.`;
  }

  // ── TAMBAH ────────────────────────────────────────────────
  if (st.step === "hadiah_tambah_nama") {
    setState(wa, { step: "hadiah_tambah_poin", hadiahDraft: { nama: inp } });
    return `Poin yang dibutuhkan?\n\nContoh: *25rb* atau *25000*`;
  }

  if (st.step === "hadiah_tambah_poin") {
    const poin = parsePoin(inp);
    if (!poin) return `❌ Poin tidak valid. Coba lagi.\n\nContoh: *25rb* atau *25000*`;
    setState(wa, { step: "hadiah_tambah_foto", hadiahDraft: { ...st.hadiahDraft, poin } });
    return `URL foto?\n\nKetik *-* kalau tidak ada foto.`;
  }

  if (st.step === "hadiah_tambah_foto") {
    const gambar = inpLower === "-" ? "" : inp;
    setState(wa, { step: "hadiah_tambah_stok", hadiahDraft: { ...st.hadiahDraft, gambar } });
    return `Stok hadiah?\n\nKetik angka (misal: *10*) atau *-* jika tidak terbatas.\n\n_Ketik *BATAL* untuk keluar._`;
  }

  if (st.step === "hadiah_tambah_stok") {
    let stok = null;
    if (inpLower !== "-") {
      const parsed = parseInt(inp);
      if (!isNaN(parsed)) stok = parsed;
    }
    const draft = { ...st.hadiahDraft, stok };
    setState(wa, { step: "hadiah_tambah_konfirmasi", hadiahDraft: draft });
    return (
      `Konfirmasi tambah hadiah:\n\n` +
      `🎁 *${draft.nama}*\n` +
      `⭐ ${fmt(draft.poin)} poin\n` +
      `📦 Stok: ${draft.stok === null ? "∞ tidak terbatas" : draft.stok}\n` +
      `🖼️ ${draft.gambar || "_tidak ada foto_"}\n\n` +
      `Ketik *YA* untuk simpan atau *BATAL*.`
    );
  }

  if (st.step === "hadiah_tambah_konfirmasi") {
    if (["ya", "iya", "yes"].includes(inpLower)) {
      const { nama, poin, gambar, stok } = st.hadiahDraft;
      try {
        await tambahHadiah(nama, poin, gambar, stok);
        setState(wa, { step: "start" });
        return `✅ Hadiah *${nama}* (${fmt(poin)} poin) berhasil ditambahkan!`;
      } catch (err) {
        setState(wa, { step: "start" });
        return `❌ Gagal simpan hadiah.`;
      }
    }
    setState(wa, { step: "start" });
    return `❌ Dibatalkan.`;
  }

  // ── EDIT ──────────────────────────────────────────────────
  if (st.step === "hadiah_edit_pilih") {
    const nomor = parseInt(inp);
    const hadiahDB = await getHadiahDB();
    if (isNaN(nomor) || nomor < 1 || nomor > hadiahDB.length)
      return `❌ Pilih nomor 1–${hadiahDB.length}.`;
    const asli = hadiahDB[nomor - 1];
    setState(wa, { step: "hadiah_edit_nama", hadiahEditNomor: nomor, hadiahDraft: { ...asli } });
    return `Nama baru?\n\n_Sekarang: *${asli.nama}*_\n\nKetik *-* untuk tidak ubah.`;
  }

  if (st.step === "hadiah_edit_nama") {
    const nama = inpLower === "-" ? st.hadiahDraft.nama : inp;
    setState(wa, { step: "hadiah_edit_poin", hadiahDraft: { ...st.hadiahDraft, nama } });
    return `Poin baru?\n\n_Sekarang: *${fmt(st.hadiahDraft.poin)} poin*_\n\nKetik *-* untuk tidak ubah.`;
  }

  if (st.step === "hadiah_edit_poin") {
    const poin = inpLower === "-" ? st.hadiahDraft.poin : parsePoin(inp);
    if (!poin) return `❌ Poin tidak valid. Coba lagi atau ketik *-* untuk skip.`;
    setState(wa, { step: "hadiah_edit_foto", hadiahDraft: { ...st.hadiahDraft, poin } });
    return `URL foto baru?\n\n_Sekarang: ${st.hadiahDraft.gambar || "_tidak ada_"}_\n\nKetik *-* untuk tidak ubah, *hapus* untuk hapus foto.`;
  }

  if (st.step === "hadiah_edit_foto") {
    let gambar = st.hadiahDraft.gambar;
    if (inpLower === "hapus") gambar = "";
    else if (inpLower !== "-") gambar = inp;
    setState(wa, { step: "hadiah_edit_stok", hadiahDraft: { ...st.hadiahDraft, gambar } });
    const stokSekarang = st.hadiahDraft.stok === null ? "∞ tidak terbatas" : st.hadiahDraft.stok;
    return `Stok baru?\n\n_Sekarang: *${stokSekarang}*_\n\nKetik angka, *-* untuk tidak ubah, atau *bebas* untuk tidak terbatas.\n\n_Ketik *BATAL* untuk keluar._`;
  }

  if (st.step === "hadiah_edit_stok") {
    let stok = st.hadiahDraft.stok; // default: tidak ubah
    if (inpLower === "bebas") stok = null;
    else if (inpLower !== "-") {
      const parsed = parseInt(inp);
      if (!isNaN(parsed)) stok = parsed;
    }
    const draft = { ...st.hadiahDraft, stok };
    setState(wa, { step: "hadiah_edit_konfirmasi", hadiahDraft: draft });
    return (
      `Konfirmasi update hadiah:\n\n` +
      `🎁 *${draft.nama}*\n` +
      `⭐ ${fmt(draft.poin)} poin\n` +
      `📦 Stok: ${draft.stok === null ? "∞ tidak terbatas" : draft.stok}\n` +
      `🖼️ ${draft.gambar || "_tidak ada foto_"}\n\n` +
      `Ketik *YA* untuk simpan atau *BATAL*.`
    );
  }

  if (st.step === "hadiah_edit_konfirmasi") {
    if (["ya", "iya", "yes"].includes(inpLower)) {
      const { nama, poin, gambar, stok } = st.hadiahDraft;
      try {
        await editHadiah(st.hadiahEditNomor, nama, poin, gambar, stok);
        setState(wa, { step: "start" });
        return `✅ Hadiah *${nama}* berhasil diupdate!`;
      } catch (err) {
        setState(wa, { step: "start" });
        return `❌ Gagal update hadiah.`;
      }
    }
    setState(wa, { step: "start" });
    return `❌ Dibatalkan.`;
  }

  // ── HAPUS ─────────────────────────────────────────────────
  if (st.step === "hadiah_hapus_pilih") {
    const nomor = parseInt(inp);
    const hadiahDB = await getHadiahDB();
    if (isNaN(nomor) || nomor < 1 || nomor > hadiahDB.length)
      return `❌ Pilih nomor 1–${hadiahDB.length}.`;
    const target = hadiahDB[nomor - 1];
    setState(wa, { step: "hadiah_hapus_konfirmasi", hadiahEditNomor: nomor, hadiahDraft: target });
    return (
      `Konfirmasi hapus hadiah:\n\n` +
      `🎁 *${target.nama}*\n` +
      `⭐ ${fmt(target.poin)} poin\n\n` +
      `Ketik *YA* untuk hapus atau *BATAL*.`
    );
  }

  if (st.step === "hadiah_hapus_konfirmasi") {
    if (["ya", "iya", "yes"].includes(inpLower)) {
      const { nama, poin } = st.hadiahDraft;
      try {
        await hapusHadiah(st.hadiahEditNomor);
        setState(wa, { step: "start" });
        return `✅ Hadiah *${nama}* (${fmt(poin)} poin) berhasil dihapus.`;
      } catch (err) {
        setState(wa, { step: "start" });
        return `❌ Gagal hapus hadiah.`;
      }
    }
    setState(wa, { step: "start" });
    return `❌ Dibatalkan.`;
  }

  setState(wa, { step: "start" });
  return `❌ State tidak dikenal. Ketik perintah admin.`;
}

// ============================================================
// LOGIKA BOT ADMIN
// ============================================================

async function prosesAdmin(wa, teks) {
  const st = getState(wa);

  // Kalau sedang di flow Q&A hadiah, teruskan ke handler-nya
  if (st.step && st.step.startsWith("hadiah_")) {
    return await handleHadiahQA(wa, teks.trim(), st);
  }

  const parts = teks.trim().split(/\s+/);
  const perintah = parts[0].toUpperCase();

  if (perintah === "HADIAH") {
    const sub = (parts[1] || "").toUpperCase();
    const sisaTeks = teks.trim().slice(("HADIAH " + sub).length).trim();

    if (sub === "LIST") {
      try {
        const hadiahDB = await getHadiahDB();
        if (hadiahDB.length === 0) return `📦 Belum ada hadiah di list.`;
        const list = hadiahDB.map((h, i) =>
          `${i + 1}. *${h.nama}*\n   ⭐ ${fmt(h.poin)} poin\n   📦 Stok: ${h.stok === null ? "∞" : h.stok}${h.gambar ? `\n   🖼️ ${h.gambar}` : "\n   🖼️ _tidak ada foto_"}`
        ).join("\n\n");
        return `📦 *List Hadiah (${hadiahDB.length})*\n\n${list}`;
      } catch (err) {
        return "❌ Gagal ambil list hadiah.";
      }
    }

    if (sub === "TAMBAH") {
      setState(wa, { step: "hadiah_tambah_nama", hadiahDraft: {} });
      return `🎁 *Tambah Hadiah Baru*\n\nNama hadiah?\n\n_Ketik *BATAL* untuk keluar._`;
    }

    if (sub === "EDIT") {
      const hadiahDB = await getHadiahDB();
      if (hadiahDB.length === 0) return `📦 Belum ada hadiah di list.`;
      const list = hadiahDB.map((h, i) => `${i + 1}. *${h.nama}* — ${fmt(h.poin)} poin`).join("\n");
      setState(wa, { step: "hadiah_edit_pilih" });
      return `📦 *Edit Hadiah*\n\n${list}\n\nKetik nomor hadiah yang mau diedit:\n\n_Ketik *BATAL* untuk keluar._`;
    }

    if (sub === "HAPUS") {
      const hadiahDB = await getHadiahDB();
      if (hadiahDB.length === 0) return `📦 Belum ada hadiah di list.`;
      const list = hadiahDB.map((h, i) => `${i + 1}. *${h.nama}* — ${fmt(h.poin)} poin`).join("\n");
      setState(wa, { step: "hadiah_hapus_pilih" });
      return `📦 *Hapus Hadiah*\n\n${list}\n\nKetik nomor hadiah yang mau dihapus:\n\n_Ketik *BATAL* untuk keluar._`;
    }

    return `📦 *Kelola Hadiah*\n\nHADIAH LIST\nHADIAH TAMBAH\nHADIAH EDIT\nHADIAH HAPUS`;
  }

  if (perintah === "DAFTAR") {
    const sisaTeks = teks.trim().slice("DAFTAR".length).trim();
    const bagian = sisaTeks.split(",").map(s => s.trim());
    if (bagian.length < 4 || bagian.some(b => !b)) {
      return (
        `Format: *DAFTAR [wa],[kode],[nama toko],[nama pic]*\n\n` +
        `Contoh:\nDAFTAR 628123456789,TK001,Toko Maju,Budi`
      );
    }
    const [waInput, kode, nama, pic] = bagian;
    const targetWa = normWa(waInput);
    if (!/^\d{10,15}$/.test(targetWa)) return `❌ Nomor WA *${waInput}* tidak valid.`;
    try {
      const result = await daftarToko(targetWa, kode, nama, pic);
      if (result.sudahAda && result.alasan === "wa") {
        return `❌ Nomor WA *${targetWa}* sudah terdaftar di sistem.`;
      }
      if (result.sudahAda && result.alasan === "kode") {
        const ex = result.tokoExisting;
        return (
          `⚠️ Kode SUB *${kode}* sudah terdaftar!\n\n` +
          `🏪 Toko   : ${ex.nama}\n` +
          `👤 PIC    : ${ex.penjaga}\n` +
          `📱 WA     : ${ex.wa}\n` +
          `⭐ Poin   : ${fmt(ex.poin)}\n\n` +
          `Kalau mau ganti nomor WA-nya, gunakan perintah:\n*GANTIWA ${ex.wa} [wa_baru]*`
        );
      }
      await notifDaftar(result, wa);
      return (
        `✅ ${result.dilengkapi ? "Nomor WA toko berhasil dilengkapi" : "Toko berhasil didaftarkan"}!\n\n` +
        `📱 WA    : ${targetWa}\n` +
        `📦 Kode  : ${result.kode}\n` +
        `🏪 Toko  : ${result.nama}\n` +
        `👤 PIC   : ${result.pic}\n` +
        `⭐ Poin  : ${fmt(result.poin || 0)}`
      );
    } catch (err) {
      console.error("Gagal daftar toko:", err.message);
      return "❌ Gagal mendaftarkan toko. Cek koneksi Sheets.";
    }
  }

  if (perintah === "TAMBAH") {
    if (parts.length < 3) return `Format: *TAMBAH [wa] [poin]*\nContoh: TAMBAH 6281234567890 100`;
    const targetWa = parts[1].trim();
    const jumlah = parseInt(parts[2]);
    if (isNaN(jumlah) || jumlah <= 0) return `Jumlah poin harus angka positif ya.`;
    try {
      const result = await tambahPoinByWa(targetWa, jumlah);
      if (!result) return `❌ Nomor *${targetWa}* tidak ditemukan.`;
      await catatLog(result.toko, "TAMBAH", `Admin ${wa}`, jumlah, result.poinBaru);
      await notifTambah(result.toko, jumlah, result.poinBaru, wa);
      return (
        `✅ Poin ditambah!\n\n` +
        `🏪 ${result.toko.nama}\n` +
        `👤 ${result.toko.penjaga}\n` +
        `📦 ${result.toko.code}\n` +
        `⭐ ${fmt(result.poinLama)} → *${fmt(result.poinBaru)}* (+${fmt(jumlah)})`
      );
    } catch (err) {
      console.error("Gagal tambah poin:", err.message);
      return "❌ Gagal tambah poin.";
    }
  }

  if (perintah === "KURANGI") {
    if (parts.length < 3) return `Format: *KURANGI [wa] [poin]*\nContoh: KURANGI 6281234567890 50`;
    const targetWa = parts[1].trim();
    const jumlah = parseInt(parts[2]);
    if (isNaN(jumlah) || jumlah <= 0) return `Jumlah poin harus angka positif ya.`;
    try {
      const tokoDB = await getTokoDB();
      const toko = tokoDB.find(t => t.wa === targetWa);
      if (!toko) return `❌ Nomor *${targetWa}* tidak ditemukan.`;
      const poinBaru = Math.max(0, toko.poin - jumlah);
      await updatePoin(targetWa, poinBaru);
      await catatLog(toko, "KURANGI", `Admin ${wa}`, -jumlah, poinBaru);
      await notifKurangi(toko, jumlah, poinBaru, wa);
      return (
        `✅ Poin dikurangi!\n\n` +
        `🏪 ${toko.nama}\n` +
        `⭐ ${fmt(toko.poin)} → *${fmt(poinBaru)}* (-${fmt(jumlah)})`
      );
    } catch (err) {
      return "❌ Gagal kurangi poin.";
    }
  }

  if (perintah === "CEK") {
    const query = parts.slice(1).join(" ").trim();
    if (!query) return `Format: *CEK [wa / kode / nama toko]*\nContoh:\nCEK 6281234567890\nCEK SUB62754\nCEK toko maju`;
    try {
      const tokoDB = await getTokoDB();
      // Coba WA exact match dulu
      const byWa = tokoDB.find(t => t.wa === query);
      if (byWa) return formatDetailToko(byWa);
      // Fallback ke kode/nama
      const hasil = cariToko(query, tokoDB);
      if (!hasil) return `❌ Toko *${query}* tidak ditemukan.`;
      if (hasil.list) return formatListCari(hasil, query);
      return formatDetailToko(hasil.toko);
    } catch (err) {
      return "❌ Gagal cek toko.";
    }
  }

  if (perintah === "RE") {
    const sub = (parts[1] || "").toUpperCase();

    if (sub === "LIST") {
      const reList = loadRE();
      if (!reList.length) return `👥 Belum ada RE terdaftar.`;
      const list = reList.map((r, i) => {
        const tsub = Array.isArray(r.tsub) ? r.tsub.join(", ") : r.tsub;
        return `${i+1}. *${r.nama}*\n   📱 ${r.wa}\n   📍 Territory Code: ${tsub}`;
      }).join("\n\n");
      return `👥 *Daftar RE (${reList.length})*\n\n${list}`;
    }

    if (sub === "TAMBAH") {
      // Format: RE TAMBAH [wa],[nama],[tsub] atau [tsub1+tsub2]
      const sisaTeks = teks.trim().slice(("RE TAMBAH").length).trim();
      const bagian = sisaTeks.split(",").map(s => s.trim());
      if (bagian.length < 3 || bagian.some(b => !b))
        return `Format: *RE TAMBAH [wa],[nama],[territory code]*\nTerritory Code bisa lebih dari 1: *033+034*\nContoh: RE TAMBAH 628123456789,Budi,033`;
      const [reWaRaw, reNama, tsubRaw] = bagian; const reWa = normWa(reWaRaw);
      const tsubArr = tsubRaw.split("+").map(s => s.trim().replace(/^TSUB/i, "")).filter(Boolean);
      const reList = loadRE();
      if (reList.find(r => r.wa === reWa)) return `❌ Nomor *${reWa}* sudah terdaftar sebagai RE.`;
      reList.push({ wa: reWa, nama: reNama, tsub: tsubArr.length === 1 ? tsubArr[0] : tsubArr });
      saveRE(reList);
      return `✅ RE *${reNama}* (${reWa}) berhasil ditambahkan!\nTerritory Code: ${tsubArr.join(", ")}`;
    }

    if (sub === "HAPUS") {
      const reWa = normWa(parts[2]);
      if (!reWa) return `Format: *RE HAPUS [wa]*`;
      const reList = loadRE();
      if (!reList.find(r => r.wa === reWa)) return `❌ Nomor *${reWa}* tidak ditemukan sebagai RE.`;
      saveRE(reList.filter(r => r.wa !== reWa));
      return `✅ RE *${reWa}* berhasil dihapus.`;
    }

    if (sub === "EDIT") {
      // RE EDIT [wa],[nama],[tsub baru]
      const sisaTeks = teks.trim().slice(("RE EDIT").length).trim();
      const bagian = sisaTeks.split(",").map(s => s.trim());
      if (bagian.length < 3) return `Format: *RE EDIT [wa],[nama baru],[tsub baru]*`;
      const [reWaRaw, reNama, tsubRaw] = bagian; const reWa = normWa(reWaRaw);
      const tsubArr = tsubRaw.split("+").map(s => s.trim().replace(/^TSUB/i, "")).filter(Boolean);
      const reList = loadRE();
      const idx = reList.findIndex(r => r.wa === reWa);
      if (idx === -1) return `❌ Nomor *${reWa}* tidak ditemukan.`;
      reList[idx] = { wa: reWa, nama: reNama, tsub: tsubArr.length === 1 ? tsubArr[0] : tsubArr };
      saveRE(reList);
      return `✅ Data RE *${reWa}* diupdate!\nNama: ${reNama} | Territory Code: ${tsubArr.join(", ")}`;
    }

    return `👥 *Kelola RE*\n\nRE LIST\nRE TAMBAH [wa],[nama],[territory code]\nRE EDIT [wa],[nama],[territory code]\nRE HAPUS [wa]\n\n_Territory Code lebih dari 1: pisah dengan + contoh 033+034_`;
  }

  if (perintah === "SPV") {
    const sub = (parts[1] || "").toUpperCase();

    if (sub === "LIST") {
      const spvList = loadSPV();
      if (!spvList.length) return `👥 Belum ada Supervisor terdaftar.`;
      const list = spvList.map((s, i) => {
        const dsub = Array.isArray(s.dsub) ? s.dsub.join(", ") : s.dsub;
        return `${i+1}. *${s.nama}*\n   📱 ${s.wa}\n   📍 District Code: ${dsub}`;
      }).join("\n\n");
      return `👥 *Daftar Supervisor (${spvList.length})*\n\n${list}`;
    }

    if (sub === "TAMBAH") {
      // Format: SPV TAMBAH [wa],[nama],[dsub] atau [dsub1+dsub2]
      const sisaTeks = teks.trim().slice(("SPV TAMBAH").length).trim();
      const bagian = sisaTeks.split(",").map(s => s.trim());
      if (bagian.length < 3 || bagian.some(b => !b))
        return `Format: *SPV TAMBAH [wa],[nama],[district code]*\nDistrict Code bisa lebih dari 1: *01+02*\nContoh: SPV TAMBAH 628123456789,Budi,01`;
      const [spvWaRaw, spvNama, dsubRaw] = bagian; const spvWa = normWa(spvWaRaw);
      const dsubArr = dsubRaw.split("+").map(s => s.trim().replace(/^DSUB/i, "")).filter(Boolean);
      const spvList = loadSPV();
      if (spvList.find(s => s.wa === spvWa)) return `❌ Nomor *${spvWa}* sudah terdaftar sebagai Supervisor.`;
      spvList.push({ wa: spvWa, nama: spvNama, dsub: dsubArr.length === 1 ? dsubArr[0] : dsubArr });
      saveSPV(spvList);
      return `✅ Supervisor *${spvNama}* (${spvWa}) berhasil ditambahkan!\nDistrict Code: ${dsubArr.join(", ")}`;
    }

    if (sub === "HAPUS") {
      const spvWa = normWa(parts[2]);
      if (!spvWa) return `Format: *SPV HAPUS [wa]*`;
      const spvList = loadSPV();
      if (!spvList.find(s => s.wa === spvWa)) return `❌ Nomor *${spvWa}* tidak ditemukan sebagai Supervisor.`;
      saveSPV(spvList.filter(s => s.wa !== spvWa));
      return `✅ Supervisor *${spvWa}* berhasil dihapus.`;
    }

    if (sub === "EDIT") {
      // SPV EDIT [wa],[nama],[dsub baru]
      const sisaTeks = teks.trim().slice(("SPV EDIT").length).trim();
      const bagian = sisaTeks.split(",").map(s => s.trim());
      if (bagian.length < 3) return `Format: *SPV EDIT [wa],[nama baru],[dsub baru]*`;
      const [spvWaRaw, spvNama, dsubRaw] = bagian; const spvWa = normWa(spvWaRaw);
      const dsubArr = dsubRaw.split("+").map(s => s.trim().replace(/^DSUB/i, "")).filter(Boolean);
      const spvList = loadSPV();
      const idx = spvList.findIndex(s => s.wa === spvWa);
      if (idx === -1) return `❌ Nomor *${spvWa}* tidak ditemukan.`;
      spvList[idx] = { wa: spvWa, nama: spvNama, dsub: dsubArr.length === 1 ? dsubArr[0] : dsubArr };
      saveSPV(spvList);
      return `✅ Data Supervisor *${spvWa}* diupdate!\nNama: ${spvNama} | District Code: ${dsubArr.join(", ")}`;
    }

    return `👥 *Kelola Supervisor*\n\nSPV LIST\nSPV TAMBAH [wa],[nama],[district code]\nSPV EDIT [wa],[nama],[district code]\nSPV HAPUS [wa]\n\n_District Code lebih dari 1: pisah dengan + contoh 01+02_`;
  }

  if (perintah === "MANAJER") {
    const sub = (parts[1] || "").toUpperCase();

    if (sub === "LIST") {
      const mgrList = loadManajer();
      if (!mgrList.length) return `👥 Belum ada Manajer terdaftar.`;
      const list = mgrList.map((m, i) => `${i+1}. *${m.nama}*\n   📱 ${m.wa}`).join("\n\n");
      return `👥 *Daftar Manajer (${mgrList.length})*\n\n${list}`;
    }

    if (sub === "TAMBAH") {
      // Format: MANAJER TAMBAH [wa],[nama]
      const sisaTeks = teks.trim().slice(("MANAJER TAMBAH").length).trim();
      const bagian = sisaTeks.split(",").map(s => s.trim());
      if (bagian.length < 2 || bagian.some(b => !b))
        return `Format: *MANAJER TAMBAH [wa],[nama]*\nContoh: MANAJER TAMBAH 628123456789,Andi`;
      const [mgrWaRaw, mgrNama] = bagian; const mgrWa = normWa(mgrWaRaw);
      const mgrList = loadManajer();
      if (mgrList.find(m => m.wa === mgrWa)) return `❌ Nomor *${mgrWa}* sudah terdaftar sebagai Manajer.`;
      mgrList.push({ wa: mgrWa, nama: mgrNama });
      saveManajer(mgrList);
      return `✅ Manajer *${mgrNama}* (${mgrWa}) berhasil ditambahkan!\nScope: semua wilayah.`;
    }

    if (sub === "HAPUS") {
      const mgrWa = normWa(parts[2]);
      if (!mgrWa) return `Format: *MANAJER HAPUS [wa]*`;
      const mgrList = loadManajer();
      if (!mgrList.find(m => m.wa === mgrWa)) return `❌ Nomor *${mgrWa}* tidak ditemukan sebagai Manajer.`;
      saveManajer(mgrList.filter(m => m.wa !== mgrWa));
      return `✅ Manajer *${mgrWa}* berhasil dihapus.`;
    }

    if (sub === "EDIT") {
      // MANAJER EDIT [wa],[nama baru]
      const sisaTeks = teks.trim().slice(("MANAJER EDIT").length).trim();
      const bagian = sisaTeks.split(",").map(s => s.trim());
      if (bagian.length < 2) return `Format: *MANAJER EDIT [wa],[nama baru]*`;
      const [mgrWaRaw, mgrNama] = bagian; const mgrWa = normWa(mgrWaRaw);
      const mgrList = loadManajer();
      const idx = mgrList.findIndex(m => m.wa === mgrWa);
      if (idx === -1) return `❌ Nomor *${mgrWa}* tidak ditemukan.`;
      mgrList[idx] = { wa: mgrWa, nama: mgrNama };
      saveManajer(mgrList);
      return `✅ Data Manajer *${mgrWa}* diupdate!\nNama: ${mgrNama}`;
    }

    return `👥 *Kelola Manajer*\n\nMANAJER LIST\nMANAJER TAMBAH [wa],[nama]\nMANAJER EDIT [wa],[nama]\nMANAJER HAPUS [wa]`;
  }

  if (perintah === "ADMIN") {
    const sub = (parts[1] || "").toUpperCase();

    if (sub === "LIST") {
      const admins = loadAdmins();
      const list = admins.map((a, i) =>
        `${i + 1}. ${a}${a === superAdmin() ? " 👑 (super admin)" : ""}`
      ).join("\n");
      return `👥 *Daftar Admin (${admins.length})*\n\n${list}`;
    }

    if (sub === "TAMBAH") {
      const targetWa = normWa(parts[2]);
      if (!targetWa) return `Format: *ADMIN TAMBAH [wa]*\nContoh: ADMIN TAMBAH 6281234567890`;
      const admins = loadAdmins();
      if (admins.includes(targetWa)) return `❌ Nomor *${targetWa}* sudah jadi admin.`;
      admins.push(targetWa);
      saveAdmins(admins);
      return `✅ *${targetWa}* berhasil ditambahkan sebagai admin.`;
    }

    if (sub === "HAPUS") {
      const targetWa = normWa(parts[2]);
      if (!targetWa) return `Format: *ADMIN HAPUS [wa]*\nContoh: ADMIN HAPUS 6281234567890`;
      if (targetWa === superAdmin()) return `❌ Super admin tidak bisa dihapus.`;
      const admins = loadAdmins();
      if (!admins.includes(targetWa)) return `❌ Nomor *${targetWa}* bukan admin.`;
      saveAdmins(admins.filter(a => a !== targetWa));
      return `✅ *${targetWa}* berhasil dihapus dari daftar admin.`;
    }

    return `👥 *Kelola Admin*\n\nADMIN LIST\nADMIN TAMBAH [wa]\nADMIN HAPUS [wa]`;
  }

  if (perintah === "GANTIWA") {
    if (parts.length < 3) return `Format: *GANTIWA [wa_lama] [wa_baru]*\nContoh: GANTIWA 6281234567890 6289876543210`;
    const waLama = parts[1].replace(/[^0-9]/g, "");
    const waBaru = parts[2].replace(/[^0-9]/g, "");
    if (waLama === waBaru) return `❌ Nomor lama dan baru sama.`;
    try {
      const result = await gantiWaToko(waLama, waBaru);
      if (!result.sukses && result.alasan === "tidak_ditemukan")
        return `❌ Nomor *${waLama}* tidak ditemukan di sistem.`;
      if (!result.sukses && result.alasan === "wa_baru_sudah_ada")
        return `❌ Nomor *${waBaru}* sudah terdaftar untuk toko lain.`;
      const tgl = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
      await kirimNotif(
        `🔄 *GANTI NOMOR WA*\n\n` +
        `📅 Waktu  : ${tgl}\n` +
        `👤 Admin  : ${wa}\n` +
        `🏪 Toko   : ${result.toko.nama}\n` +
        `📦 Kode   : ${result.toko.code}\n` +
        `📱 WA Lama: ${waLama}\n` +
        `📱 WA Baru: ${waBaru}`
      );
      await catatLog(result.toko, "GANTI WA", `${waLama} → ${waBaru} (Admin ${wa})`, 0, result.toko.poin);
      return (
        `✅ Nomor WA berhasil diganti!\n\n` +
        `🏪 Toko    : ${result.toko.nama}\n` +
        `👤 PIC     : ${result.toko.penjaga}\n` +
        `📦 Kode    : ${result.toko.code}\n` +
        `📱 WA Lama : ${waLama}\n` +
        `📱 WA Baru : ${waBaru}\n` +
        `⭐ Poin    : ${fmt(result.toko.poin)}`
      );
    } catch (err) {
      console.error("Gagal ganti WA:", err.message);
      return "❌ Gagal ganti nomor WA. Cek koneksi Sheets.";
    }
  }

  return (
    `🔧 *Menu Admin*\n\n` +
    `*Toko:*\n` +
    `DAFTAR [wa],[kode],[nama],[pic]\n` +
    `TAMBAH [wa] [poin]\n` +
    `KURANGI [wa] [poin]\n` +
    `CEK [wa]\n` +
    `GANTIWA [wa_lama] [wa_baru]\n\n` +
    `*Hadiah:*\n` +
    `HADIAH LIST\n` +
    `HADIAH TAMBAH\n` +
    `HADIAH EDIT\n` +
    `HADIAH HAPUS\n\n` +
    `*Admin:*\n` +
    `ADMIN LIST\n` +
    `ADMIN TAMBAH [wa]\n` +
    `ADMIN HAPUS [wa]\n\n` +
    `*RE (Sales):*\n` +
    `RE LIST\n` +
    `RE TAMBAH [wa],[nama],[tsub]\n` +
    `RE EDIT [wa],[nama],[tsub]\n` +
    `RE HAPUS [wa]\n\n` +
    `*Supervisor:*\n` +
    `SPV LIST\n` +
    `SPV TAMBAH [wa],[nama],[dsub]\n` +
    `SPV EDIT [wa],[nama],[dsub]\n` +
    `SPV HAPUS [wa]\n\n` +
    `*Manajer:*\n` +
    `MANAJER LIST\n` +
    `MANAJER TAMBAH [wa],[nama]\n` +
    `MANAJER EDIT [wa],[nama]\n` +
    `MANAJER HAPUS [wa]`
  );
}

// ============================================================
// ANALISA & RANKING — dipakai bareng RE / Supervisor / Manajer
// ============================================================

// Kategori kontributor — diatur dari panel (Pengaturan → Lanjutan)
const getKategori = () => (cfg().kategori || []).map(k => String(k.kode || "").toUpperCase()).filter(Boolean);
const getLabelKategori = () => Object.fromEntries((cfg().kategori || []).map(k => [String(k.kode || "").toUpperCase(), k.label || ""]));

function parseKontrib(str) {
  return str ? str.split(" - ").map(s => s.trim().toUpperCase()).filter(Boolean) : [];
}

// Bangun body analisa kategori + cross-sell + rekomendasi utk 1 kumpulan toko
function buildRingkasanBody(tokoArea, labelAksi) {
  const KATEGORI = getKategori();
  const LABEL_KATEGORI = getLabelKategori();
  const inactive  = tokoArea.filter(t => t.poin === 0);
  const active    = tokoArea.filter(t => t.poin > 0);
  const totalPoin = tokoArea.reduce((s, t) => s + t.poin, 0);

  const nol = () => Object.fromEntries(KATEGORI.map(k => [k, 0]));
  const kategoriCount = nol();
  const primaryCount  = nol();
  const crossSell     = nol();

  active.forEach(t => {
    const kontribs = parseKontrib(t.kontributor);
    const kontribSet = new Set(kontribs);
    KATEGORI.forEach(k => {
      if (kontribSet.has(k)) kategoriCount[k]++;
      else crossSell[k]++; // aktif tapi belum punya kategori ini
    });
    if (kontribs[0] && primaryCount[kontribs[0]] !== undefined) primaryCount[kontribs[0]]++;
  });

  let msg = `📦 ${tokoArea.length} toko | ⭐ ${fmt(totalPoin)} total poin\n`;

  if (inactive.length > 0) {
    msg += `\n🔴 *Belum ada transaksi (${inactive.length} toko):*\n`;
    msg += inactive.slice(0, 5).map(t => `• ${t.nama} (${t.code})`).join("\n");
    if (inactive.length > 5) msg += `\n  _...dan ${inactive.length - 5} toko lainnya_`;
    msg += `\n→ *Aksi:* Kunjungi & aktifkan pembelian`;
  }

  msg += `\n\n📈 *Kategori aktif (${active.length} toko aktif):*\n`;
  KATEGORI.forEach(k => {
    const count = kategoriCount[k];
    const bar = "█".repeat(Math.round(count / Math.max(active.length, 1) * 8)).padEnd(8, "░");
    msg += `• ${k.padEnd(7)}: ${bar} ${count} toko\n`;
  });

  const peluang = KATEGORI.filter(k => crossSell[k] > 0 && active.length > 0)
    .sort((a, b) => crossSell[b] - crossSell[a]);
  if (peluang.length > 0) {
    msg += `\n🎯 *Peluang cross-sell:*\n`;
    peluang.forEach(k => {
      msg += `• ${crossSell[k]} toko belum ${k} → ajak ${LABEL_KATEGORI[k]}\n`;
    });
  }

  const primaries = KATEGORI.filter(k => primaryCount[k] > 0)
    .sort((a, b) => primaryCount[b] - primaryCount[a]);
  if (primaries.length > 0) {
    msg += `\n🥇 *Poin terbesar dari:*\n`;
    primaries.forEach(k => {
      msg += `• ${k}: jadi sumber utama di ${primaryCount[k]} toko\n`;
    });
  }

  msg += `\n💡 *Prioritas ${labelAksi}:*\n`;
  let no = 1;
  if (inactive.length > 0) msg += `${no++}. Aktivasi ${inactive.length} toko yg belum transaksi\n`;
  if (peluang[0]) msg += `${no++}. Cross-sell ${peluang[0]}: ${crossSell[peluang[0]]} toko potensial\n`;

  return msg.trim();
}

// Cari toko berdasarkan kode (exact/parsial) atau nama (contains)
function cariToko(query, db) {
  const q = query.trim().toUpperCase();

  const normCode = (k) => {
    const m = String(k).match(/^(SUB)0*(\d+)$/i);
    return m ? `SUB${m[2]}` : k.toUpperCase();
  };

  // 1. Exact code match
  const exact = db.find(t => normCode(t.code) === normCode(q));
  if (exact) return { toko: exact };

  // 2. Partial code match — angka saja atau SUB parsial
  const qNum = q.replace(/^SUB0*/i, "");
  if (qNum) {
    const partialCode = db.filter(t => normCode(t.code).replace("SUB", "").includes(qNum));
    if (partialCode.length === 1) return { toko: partialCode[0] };
    if (partialCode.length > 1) return { list: partialCode.slice(0, 5), total: partialCode.length };
  }

  // 3. Nama contains (case-insensitive)
  const byNama = db.filter(t => t.nama.toUpperCase().includes(q));
  if (byNama.length === 1) return { toko: byNama[0] };
  if (byNama.length > 1) return { list: byNama.slice(0, 5), total: byNama.length };

  return null;
}

function formatDetailToko(toko) {
  const kontrib = toko.kontributor
    ? `\n\n📊 *Top Kontributor:*\n${toko.kontributor.split(" - ").map((k, i) => `${i+1}. ${k.trim()}`).join("\n")}`
    : `\n\n📊 *Kontributor:* _Data belum tersedia_`;
  return (
    `📋 *Detail Toko*\n\n` +
    `🏪 Nama  : ${toko.nama}\n` +
    `👤 PIC   : ${toko.penjaga || "-"}\n` +
    `📦 Kode  : ${toko.code}\n` +
    `📍 District Code : ${toko.dsub || "-"} | Territory Code: ${toko.tsub || "-"}\n` +
    `📱 WA    : ${toko.wa}\n` +
    `⭐ Poin  : *${fmt(toko.poin)}*` +
    kontrib
  );
}

function formatListCari(hasil, query) {
  const list = hasil.list.map((t, i) =>
    `${i+1}. *${t.nama}* (${t.code})\n    ⭐ ${fmt(t.poin)} poin`
  ).join("\n\n");
  const lebih = hasil.total > 5 ? `\n_...dan ${hasil.total - 5} lainnya_` : "";
  return `🔍 Ditemukan *${hasil.total} toko* dengan "${query}":\n\n${list}${lebih}\n\nKetik *CEK [kode]* untuk detail lengkap.`;
}

// Ranking performa tiap RE (dipakai Supervisor) berdasarkan toko di tokoArea
function rankingRE(reList, tokoArea) {
  return reList.map(r => {
    const tsubR  = Array.isArray(r.tsub) ? r.tsub : [String(r.tsub)];
    const tokoRE = tokoArea.filter(t => tsubR.includes(String(t.tsub)));
    const aktif  = tokoRE.filter(t => t.poin > 0).length;
    const totalPoin = tokoRE.reduce((s, t) => s + t.poin, 0);
    return { nama: r.nama, tsub: tsubR, totalToko: tokoRE.length, aktif, totalPoin };
  }).sort((a, b) => b.totalPoin - a.totalPoin);
}

// Ranking performa tiap DSUB (dipakai Manajer)
function rankingDSUB(tokoDB) {
  const map = new Map();
  tokoDB.forEach(t => {
    const key = String(t.dsub || "-");
    if (!map.has(key)) map.set(key, { dsub: key, totalToko: 0, aktif: 0, totalPoin: 0 });
    const d = map.get(key);
    d.totalToko++;
    if (t.poin > 0) d.aktif++;
    d.totalPoin += t.poin;
  });
  return [...map.values()].sort((a, b) => b.totalPoin - a.totalPoin);
}

// ============================================================
// LOGIKA BOT RE (SALES)
// ============================================================

async function prosesRE(wa, teks) {
  const re = getREInfo(wa);
  const inp = teks.trim().toUpperCase();
  const parts = teks.trim().split(/\s+/);
  const perintah = parts[0].toUpperCase();

  let tokoDB;
  try { tokoDB = await getTokoDB(); }
  catch { return render("gangguan"); }

  // Filter toko sesuai territory RE (tsub)
  // re.tsub bisa string "033" atau array ["033","034"]
  const tsubList = Array.isArray(re.tsub) ? re.tsub : [String(re.tsub)];
  const tokoArea = tokoDB.filter(t => tsubList.includes(String(t.tsub)));

  if (["HALO", "MENU", "HI", "HELLO", "HAI", "0"].includes(inp) || inp === "") {
    return (
      `Halo *${re.nama}*! 👋\n` +
      `Territory Code: *${tsubList.join(", ")}*\n` +
      `Total toko: *${tokoArea.length}*\n\n` +
      `📋 *Menu RE:*\n` +
      `CEK [kode outlet] — detail toko + kontributor\n` +
      `LIST — semua toko di territory kamu\n` +
      `LIST POIN — urut dari poin terbesar`
    );
  }

  // CEK [kode/nama] — detail 1 toko
  if (perintah === "CEK") {
    const query = parts.slice(1).join(" ").trim();
    if (!query) return `Format: *CEK [kode atau nama toko]*\nContoh: CEK SUB62754 atau CEK toko maju`;

    const hasil = cariToko(query, tokoArea);
    if (!hasil) {
      const luarArea = cariToko(query, tokoDB);
      if (luarArea?.toko) return `⛔ Toko *${luarArea.toko.nama}* (${luarArea.toko.code}) ada tapi di luar territory kamu (Territory Code ${luarArea.toko.tsub}).`;
      return `❌ Toko *${query}* tidak ditemukan di territory kamu.`;
    }
    if (hasil.list) return formatListCari(hasil, query);
    return formatDetailToko(hasil.toko);
  }

  // LIST — daftar toko di area, urut poin terbanyak
  if (perintah === "LIST") {
    if (tokoArea.length === 0) return `Tidak ada toko di territory kamu.`;
    const list = [...tokoArea]
      .sort((a, b) => b.poin - a.poin)
      .map((t, i) => {
        const kontrib = t.kontributor ? `\n    📊 ${t.kontributor}` : "";
        return `${i+1}. *${t.nama}* (${t.code})\n    ⭐ ${fmt(t.poin)} poin${kontrib}`;
      }).join("\n\n");

    return (
      `📋 *Toko Territory Code ${tsubList.join("/")}* (${tokoArea.length} toko) _urut poin terbesar_\n` +
      `\n${list}`
    );
  }

  // RINGKASAN — analisa kondisi territory + rekomendasi aksi
  if (perintah === "RINGKASAN") {
    if (tokoArea.length === 0) return `Tidak ada toko di territory kamu.`;
    return `📊 *Ringkasan Territory Code ${tsubList.join("/")}*\n` + buildRingkasanBody(tokoArea, "RE");
  }

  if (isAITester(wa)) return callGemini(buildPromptRE(re, tokoArea), teks);
  return (
    `📋 *Menu RE:*\n` +
    `CEK [kode outlet] — detail toko + kontributor\n` +
    `LIST — semua toko di territory (urut poin terbesar)\n` +
    `RINGKASAN — analisa kondisi & rekomendasi aksi`
  );
}

// ============================================================
// LOGIKA BOT SUPERVISOR (ngawasin 1+ DSUB, beberapa RE)
// ============================================================

async function prosesSupervisor(wa, teks) {
  const spv = getSPVInfo(wa);
  const inp = teks.trim().toUpperCase();
  const parts = teks.trim().split(/\s+/);
  const perintah = parts[0].toUpperCase();

  let tokoDB;
  try { tokoDB = await getTokoDB(); }
  catch { return render("gangguan"); }

  // Filter toko sesuai area Supervisor (dsub)
  const dsubList = Array.isArray(spv.dsub) ? spv.dsub : [String(spv.dsub)];
  const tokoArea = tokoDB.filter(t => dsubList.includes(String(t.dsub)));

  // RE yang TSUB-nya berada di bawah area DSUB Supervisor ini
  const tsubArea = new Set(tokoArea.map(t => String(t.tsub)));
  const reArea = loadRE().filter(r => {
    const tsubR = Array.isArray(r.tsub) ? r.tsub : [String(r.tsub)];
    return tsubR.some(ts => tsubArea.has(String(ts)));
  });

  if (["HALO", "MENU", "HI", "HELLO", "HAI", "0"].includes(inp) || inp === "") {
    return (
      `Halo *${spv.nama}*! 👋\n` +
      `District Code: *${dsubList.join(", ")}*\n` +
      `Total toko: *${tokoArea.length}* | Total RE: *${reArea.length}*\n\n` +
      `📋 *Menu Supervisor:*\n` +
      `CEK [kode outlet] — detail toko + kontributor\n` +
      `LIST — semua toko di area kamu (urut poin terbesar)\n` +
      `LIST RE — ranking performa RE di bawah kamu\n` +
      `RINGKASAN — analisa kondisi & rekomendasi aksi`
    );
  }

  // CEK [kode/nama] — detail 1 toko
  if (perintah === "CEK") {
    const query = parts.slice(1).join(" ").trim();
    if (!query) return `Format: *CEK [kode atau nama toko]*\nContoh: CEK SUB62754 atau CEK toko maju`;

    const hasil = cariToko(query, tokoArea);
    if (!hasil) {
      const luarArea = cariToko(query, tokoDB);
      if (luarArea?.toko) return `⛔ Toko *${luarArea.toko.nama}* (${luarArea.toko.code}) ada tapi di luar area kamu (District Code ${luarArea.toko.dsub}).`;
      return `❌ Toko *${query}* tidak ditemukan di area kamu.`;
    }
    if (hasil.list) return formatListCari(hasil, query);
    return formatDetailToko(hasil.toko);
  }

  // LIST RE — ranking performa RE di bawah area Supervisor
  if (perintah === "LIST" && (parts[1] || "").toUpperCase() === "RE") {
    if (reArea.length === 0) return `Belum ada RE terdaftar di area kamu.`;
    const ranking = rankingRE(reArea, tokoArea);
    const list = ranking.map((r, i) =>
      `${i+1}. *${r.nama}* (Territory Code ${r.tsub.join("/")})\n    ⭐ ${fmt(r.totalPoin)} poin | 🏪 ${r.aktif}/${r.totalToko} toko aktif`
    ).join("\n\n");
    return `🏆 *Ranking RE — District Code ${dsubList.join("/")}*\n\n${list}`;
  }

  // LIST — daftar toko di area, urut poin terbanyak
  if (perintah === "LIST") {
    if (tokoArea.length === 0) return `Tidak ada toko di area kamu.`;
    const list = [...tokoArea]
      .sort((a, b) => b.poin - a.poin)
      .map((t, i) => {
        const kontrib = t.kontributor ? `\n    📊 ${t.kontributor}` : "";
        return `${i+1}. *${t.nama}* (${t.code})\n    ⭐ ${fmt(t.poin)} poin${kontrib}`;
      }).join("\n\n");

    return (
      `📋 *Toko District Code ${dsubList.join("/")}* (${tokoArea.length} toko) _urut poin terbesar_\n` +
      `\n${list}`
    );
  }

  // RINGKASAN — analisa kondisi area + ranking performa RE
  if (perintah === "RINGKASAN") {
    if (tokoArea.length === 0) return `Tidak ada toko di area kamu.`;

    let msg = `📊 *Ringkasan District Code ${dsubList.join("/")}*\n` + buildRingkasanBody(tokoArea, "Supervisor");

    if (reArea.length > 0) {
      const ranking = rankingRE(reArea, tokoArea);
      msg += `\n\n🏆 *Performa RE:*\n`;
      ranking.forEach((r, i) => {
        msg += `${i+1}. ${r.nama}: ⭐ ${fmt(r.totalPoin)} poin | ${r.aktif}/${r.totalToko} toko aktif\n`;
      });
      const lemah = ranking[ranking.length - 1];
      if (ranking.length > 1 && lemah.totalPoin < ranking[0].totalPoin) {
        msg += `→ *Perhatian:* ${lemah.nama} performa paling rendah, perlu pendampingan.`;
      }
    }

    return msg.trim();
  }

  if (isAITester(wa)) {
    const ranking = rankingRE(reArea, tokoArea);
    return callGemini(buildPromptSPV(spv, dsubList, tokoArea, reArea, ranking), teks);
  }
  return (
    `📋 *Menu Supervisor:*\n` +
    `CEK [kode outlet] — detail toko + kontributor\n` +
    `LIST — semua toko di area (urut poin terbesar)\n` +
    `LIST RE — ranking performa RE\n` +
    `RINGKASAN — analisa kondisi & rekomendasi aksi`
  );
}

// ============================================================
// LOGIKA BOT MANAJER (scope semua wilayah)
// ============================================================

async function prosesManajer(wa, teks) {
  const mgr = getManajerInfo(wa);
  const inp = teks.trim().toUpperCase();
  const parts = teks.trim().split(/\s+/);
  const perintah = parts[0].toUpperCase();

  let tokoDB;
  try { tokoDB = await getTokoDB(); }
  catch { return render("gangguan"); }

  if (["HALO", "MENU", "HI", "HELLO", "HAI", "0"].includes(inp) || inp === "") {
    return (
      `Halo *${mgr.nama}*! 👋\n` +
      `Scope: *Semua wilayah*\n` +
      `Total toko: *${tokoDB.length}*\n\n` +
      `📋 *Menu Manajer:*\n` +
      `CEK [kode outlet] — detail toko (semua wilayah)\n` +
      `LIST — ranking performa per District Code\n` +
      `LIST [District Code] — toko di District Code tertentu (urut poin terbesar)\n` +
      `RINGKASAN — analisa global & ranking District Code`
    );
  }

  // CEK [kode/nama] — detail 1 toko, scope global (semua wilayah)
  if (perintah === "CEK") {
    const query = parts.slice(1).join(" ").trim();
    if (!query) return `Format: *CEK [kode atau nama toko]*\nContoh: CEK SUB62754 atau CEK toko maju`;

    const hasil = cariToko(query, tokoDB);
    if (!hasil) return `❌ Toko *${query}* tidak ditemukan.`;
    if (hasil.list) return formatListCari(hasil, query);
    return formatDetailToko(hasil.toko);
  }

  // LIST [DSUB] — tanpa argumen: ranking semua DSUB. Dengan argumen: drill ke toko di DSUB itu
  if (perintah === "LIST") {
    const dsubArg = parts.slice(1).join(" ").trim().toUpperCase().replace(/^(DSUB|DISTRICT(\s*CODE)?)\s*/, "");

    if (!dsubArg) {
      const ranking = rankingDSUB(tokoDB);
      const list = ranking.map((d, i) =>
        `${i+1}. *District Code ${d.dsub}*\n    ⭐ ${fmt(d.totalPoin)} poin | 🏪 ${d.aktif}/${d.totalToko} toko aktif`
      ).join("\n\n");
      return `🏆 *Ranking Performa District Code*\n_Ketik LIST [District Code] buat lihat toko di dalamnya_\n\n${list}`;
    }

    const tokoArea = tokoDB.filter(t => String(t.dsub) === dsubArg);
    if (tokoArea.length === 0) return `Tidak ada toko di District Code ${dsubArg}.`;
    const list = [...tokoArea]
      .sort((a, b) => b.poin - a.poin)
      .map((t, i) => {
        const kontrib = t.kontributor ? `\n    📊 ${t.kontributor}` : "";
        return `${i+1}. *${t.nama}* (${t.code})\n    ⭐ ${fmt(t.poin)} poin${kontrib}`;
      }).join("\n\n");

    return `📋 *Toko District Code ${dsubArg}* (${tokoArea.length} toko) _urut poin terbesar_\n\n${list}`;
  }

  // RINGKASAN — analisa global + ranking performa per DSUB
  if (perintah === "RINGKASAN") {
    if (tokoDB.length === 0) return `Belum ada data toko.`;

    let msg = `📊 *Ringkasan Global*\n` + buildRingkasanBody(tokoDB, "Manajer");

    const ranking = rankingDSUB(tokoDB);
    msg += `\n\n🏆 *Performa per District Code:*\n`;
    ranking.slice(0, 10).forEach((d, i) => {
      msg += `${i+1}. District Code ${d.dsub}: ⭐ ${fmt(d.totalPoin)} poin | ${d.aktif}/${d.totalToko} toko aktif\n`;
    });
    if (ranking.length > 10) msg += `  _...dan ${ranking.length - 10} District Code lainnya_\n`;

    const lemah = ranking[ranking.length - 1];
    if (ranking.length > 1) msg += `→ *Perhatian:* District Code ${lemah.dsub} performa paling rendah, perlu evaluasi.`;

    return msg.trim();
  }

  if (isAITester(wa)) {
    const ranking = rankingDSUB(tokoDB);
    return callGemini(buildPromptManajer(mgr, tokoDB, ranking), teks);
  }
  return (
    `📋 *Menu Manajer:*\n` +
    `CEK [kode outlet] — detail toko (semua wilayah)\n` +
    `LIST — ranking performa per District Code\n` +
    `LIST [District Code] — toko di District Code tertentu (urut poin terbesar)\n` +
    `RINGKASAN — analisa global & ranking District Code`
  );
}

// ============================================================
// WHATSAPP CLIENT
// ============================================================

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./auth_session" }),
  puppeteer: {
    headless: true,
    executablePath: CHROMIUM_PATH,
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--single-process",
      "--no-zygote",
    ],
  },
});

// ── Status koneksi (dibaca panel web lewat internal API) ──────
const waStatus = { state: "starting", qr: null, qrAt: null, nomor: null, nama: null, sejak: Date.now(), alasan: null };
function setWaState(state, extra = {}) {
  Object.assign(waStatus, { state, sejak: Date.now() }, extra);
}

client.on("qr", qr => {
  console.log("\n📱 Scan QR Code (atau buka menu Koneksi WA di panel web):\n");
  qrcode.generate(qr, { small: true });
  setWaState("qr", { qr, qrAt: Date.now() });
});

client.on("loading_screen", (pct, msg) => {
  console.log(`⏳ ${pct}% — ${msg}`);
  if (waStatus.state !== "ready") setWaState("loading", { qr: null, alasan: `${pct}%` });
});

client.on("ready", async () => {
  console.log("✅ Bot siap!");
  setWaState("ready", {
    qr: null,
    alasan: null,
    nomor: client.info?.wid?.user || null,
    nama: client.info?.pushname || null,
  });
  try {
    const t = await getTokoDB();
    const h = await getHadiahDB();
    console.log(`📊 Sheets OK! ${t.length} toko, ${h.length} hadiah.`);
    if (!cfg().notifGroupId) console.log("⚠️  Grup notifikasi belum dipilih (panel → Koneksi WA)");
  } catch (err) {
    console.error("❌ Gagal konek Sheets:", err.message);
  }
  console.log("📋 Menunggu pesan...\n");
});

client.on("authenticated", () => {
  console.log("🔐 Autentikasi OK.");
  setWaState("authenticated", { qr: null });
});
client.on("auth_failure", msg => {
  console.error("❌ Auth gagal:", msg);
  setWaState("auth_failure", { qr: null, alasan: String(msg) });
});
client.on("disconnected", async reason => {
  console.log("⚠️ Terputus:", reason);
  setWaState("disconnected", { qr: null, alasan: String(reason) });
  // Logout dari HP / sesi dicabut: data sesi lama membuat WA Web macet saat start
  // berikutnya, jadi bersihkan lalu restart supaya langsung tampil QR baru.
  if (/LOGOUT|UNPAIRED/i.test(String(reason))) {
    try { await withTimeout(client.destroy(), 15000); } catch (_) {}
    hapusSesi();
    process.exit(1);
  }
});

// Hapus profil browser + sesi WA (dipakai setelah logout / sesi tidak valid)
function hapusSesi() {
  try {
    fs.rmSync("./auth_session", { recursive: true, force: true });
    console.log("🧹 Sesi WA lama dihapus.");
  } catch (e) { console.error("Gagal hapus sesi:", e.message); }
}

process.on("uncaughtException", err => { console.error("❌ Uncaught:", err.message); });
process.on("unhandledRejection", err => { console.error("❌ Unhandled:", err?.message || err); });

const HEARTBEAT_FILE = "./watchdog_heartbeat";
function updateHeartbeat() {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (_) {}
}

// Update heartbeat tiap 5 menit agar watchdog tahu bot masih hidup
setInterval(updateHeartbeat, 5 * 60 * 1000);

client.on("message", async (msg) => {
  updateHeartbeat();
  // Abaikan Status WA kontak, channel, dan siaran — jangan pernah dibalas
  if (msg.isStatus || msg.fromMe || /@(broadcast|newsletter)$/.test(msg.from)) return;
  // Pesan dari group — hanya balas !groupid
  if (msg.from.endsWith("@g.us")) {
    if (msg.body.trim() === "!groupid") {
      await msg.reply(`ID group ini:\n*${msg.from}*\n\nPilih grup ini di panel web → menu Koneksi WA → Grup Notifikasi.`);
    }
    return;
  }

  if (!msg.body) return;

  const contact = await msg.getContact();
  const wa = contact.id.user;
  const chatId = msg.from;
  console.log(`📨 Dari ${wa} (${contact.pushname}): ${msg.body.slice(0, 60)}`);

  try {
    const balasan = await enqueue(wa, () =>
      isAdmin(wa)
        ? prosesAdmin(wa, msg.body)
        : isManajer(wa)
          ? prosesManajer(wa, msg.body)
          : isSPV(wa)
            ? prosesSupervisor(wa, msg.body)
            : isRE(wa)
              ? prosesRE(wa, msg.body)
              : prosesToko(wa, chatId, msg.body)
    );
    if (!balasan) return; // sudah dikirim langsung (mis. foto + caption)
    await msg.reply(balasan);
    console.log(`📤 Reply: ${balasan.slice(0, 60).replace(/\n/g," ")}...`);
  } catch (err) {
    console.error("❌ Error:", err);
  }
});

// ============================================================
// INTERNAL HTTP API — hanya bisa diakses dari VPS ini sendiri (127.0.0.1)
// Dipakai panel web & script luar.
// ============================================================
const http = require("http");
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || "3002");

function kirimJson(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function bacaBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 20e6) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

async function matikanLaluRestart(logout) {
  try {
    if (logout) await withTimeout(client.logout(), 20000);
  } catch (e) { console.error("Gagal logout:", e.message); }
  try { await withTimeout(client.destroy(), 15000); } catch (_) {}
  if (logout) hapusSesi();
  console.log(logout ? "🚪 Logout dari WA, restart untuk scan QR baru..." : "🔄 Restart diminta dari panel...");
  // PM2 akan menyalakan ulang proses ini otomatis
  process.exit(1);
}

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    // ── GET ────────────────────────────────────────────────
    if (req.method === "GET" && (url === "/" || url === "/status")) {
      return kirimJson(res, 200, {
        state: waStatus.state,
        nomor: waStatus.nomor,
        nama: waStatus.nama,
        sejak: waStatus.sejak,
        alasan: waStatus.alasan,
        adaQr: !!waStatus.qr,
        uptime: Math.round(process.uptime()),
      });
    }
    if (req.method === "GET" && url === "/qr") {
      if (!waStatus.qr) return kirimJson(res, 404, { error: "Tidak ada QR" });
      const QRCode = require("qrcode");
      const dataUrl = await QRCode.toDataURL(waStatus.qr, { width: 320, margin: 2 });
      return kirimJson(res, 200, { dataUrl, qrAt: waStatus.qrAt });
    }
    if (req.method === "GET" && url === "/groups") {
      if (waStatus.state !== "ready") return kirimJson(res, 409, { error: "Bot belum tersambung ke WhatsApp" });
      // Baca langsung dari data WA Web di browser. client.getChats() meminta
      // metadata tiap grup ke server satu per satu → timeout di akun yang chat-nya banyak.
      const groups = await withTimeout(client.pupPage.evaluate(() =>
        window.require("WAWebCollections").Chat.getModelsArray()
          .filter(c => c.id?.server === "g.us")
          .map(c => ({
            id: c.id._serialized,
            nama: c.formattedTitle || c.name || c.id.user,
            anggota: c.groupMetadata?.participants?.length ?? null,
          }))
      ), 20000);
      groups.sort((a, b) => String(a.nama).localeCompare(String(b.nama)));
      return kirimJson(res, 200, groups);
    }

    if (req.method !== "POST") return kirimJson(res, 404, { error: "Not found" });

    // ── POST ───────────────────────────────────────────────
    if (url === "/cache/clear") {
      clearCache();
      return kirimJson(res, 200, { ok: true });
    }
    if (url === "/restart" || url === "/logout") {
      kirimJson(res, 200, { ok: true });
      setTimeout(() => matikanLaluRestart(url === "/logout"), 300);
      return;
    }
    if (url === "/notif" || url === "/send") {
      const { pesan, to, media } = await bacaBody(req);
      const chatId = url === "/send"
        ? (to ? (to.includes("@") ? to : `${normWa(to)}@c.us`) : null)
        : (to || cfg().notifGroupId);
      if (!chatId) return kirimJson(res, 400, { error: url === "/send" ? "to required" : "Grup notifikasi belum dipilih" });
      if (waStatus.state !== "ready") return kirimJson(res, 409, { error: "Bot belum tersambung ke WhatsApp" });

      if (media && media.data && media.mimetype) {
        const m = new MessageMedia(media.mimetype, media.data, media.filename || "file");
        await client.sendMessage(chatId, m, { caption: pesan || "" });
        console.log(`📎 File terkirim ke ${chatId}`);
      } else {
        if (!pesan) return kirimJson(res, 400, { error: "pesan required" });
        await client.sendMessage(chatId, pesan);
        console.log(`📤 Pesan terkirim ke ${chatId}`);
      }
      return kirimJson(res, 200, { ok: true });
    }
    return kirimJson(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("❌ Internal API error:", e.message);
    if (!res.headersSent) kirimJson(res, 500, { error: e.message });
  }
}).listen(BOT_API_PORT, "127.0.0.1", () => console.log(`🔌 Internal API aktif di port ${BOT_API_PORT}`));

console.log("🚀 Memulai Bot WA + Google Sheets...\n");
client.initialize().catch(async err => {
  console.error("❌ Gagal start WA:", err?.message || err);
  // Kalau halaman sudah menampilkan QR login, sesi tersimpan memang sudah tidak
  // valid (sisa logout) dan justru membuat WA Web macet → aman dihapus.
  let halamanLogin = false;
  try {
    halamanLogin = await withTimeout(client.pupPage.evaluate(() =>
      !!document.querySelector("div[data-ref]") ||
      /Scan to log in|Link with phone number|Pindai untuk masuk|Tautkan dengan nomor telepon/i.test(document.body?.innerText || "")
    ), 10000);
  } catch (_) {}
  try { await withTimeout(client.destroy(), 15000); } catch (_) {}
  if (halamanLogin) hapusSesi();
  // Keluar supaya PM2 menyalakan ulang (daripada macet di "sedang dinyalakan")
  process.exit(1);
});
