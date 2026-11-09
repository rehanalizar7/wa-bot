/**
 * Penyimpanan konfigurasi bersama untuk bot (index3.js) dan panel web (admin-server.js).
 *
 * Semua data yang bisa diubah dari web disimpan di folder data/ :
 *   data/config.json        → pengaturan umum, fitur, AI, template pesan, password panel
 *   data/admins.json        → daftar nomor admin WA
 *   data/re_list.json       → daftar RE (sales)
 *   data/spv_list.json      → daftar Supervisor
 *   data/manajer_list.json  → daftar Manajer
 *
 * Bot membaca ulang file-file ini otomatis tiap kali berubah, jadi
 * perubahan dari web langsung berlaku tanpa restart.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
// TEMPLATE PESAN
// ============================================================

const DEFAULT_PESAN = {
  belumTerdaftar:
    "Maaf, nomer sampeyan durung terdaftar di sistem kita. 🙏\n\nSilahkan hubungi sales di area sampeyan.",
  menuUtama:
    "Halo, selamat datang kembali! 👋\n" +
    "Toko   : *{toko}*\n" +
    "PIC    : *{pic}*\n" +
    "Poin   : *{poin}*\n\n" +
    "1️⃣  Cek Poin\n" +
    "2️⃣  Info Hadiah\n" +
    "3️⃣  Klaim Hadiah\n" +
    "4️⃣  Info Program{menu_tambahan}",
  cekPoin:
    "⭐ Poin kamu: *{poin} poin*\nKode Outlet: {kode}\n\nKetik *2* info hadiah, *3* klaim, *0* menu.",
  poinSedangDihitung:
    "Mohon maaf 🙏\n\nPoin kamu sedang dalam proses perhitungan.\nSilakan cek kembali beberapa saat lagi ya.\n\nKetik *0* untuk kembali ke menu.",
  klaimDitutup:
    "Mohon maaf 🙏\n\nKlaim hadiah sedang ditutup untuk sementara.\nNanti kami kabari lagi kalau sudah dibuka ya.\n\nKetik *0* untuk kembali ke menu.",
  klaimSudahPenuh:
    "Maaf, kamu sudah klaim *1 hadiah utama* dan *1 hadiah hiburan* 🙏\n\nSetiap toko hanya berhak 1 hadiah utama dan 1 hadiah hiburan per periode.\n\nKetik *0* untuk menu.",
  poinBelumCukup:
    "Maaf, poin kamu (*{poin} poin*) belum cukup untuk klaim hadiah yang tersisa 😔\n\nTerus semangat belanjanya ya! 💪\n\nKetik *2* lihat semua hadiah, *0* menu.",
  klaimBerhasil:
    "✅ Klaim berhasil! Matur nuwun! 🙏\n\n" +
    "🎁 *{hadiah}*\n" +
    "Poin terpotong : -{poin_hadiah}\n" +
    "Sisa poin      : *{sisa_poin}*\n\n" +
    "Tim kami akan segera menghubungi untuk pengiriman 🚚\n\nKetik *0* untuk menu.",
  tidakMengerti:
    "Maaf, aku kurang ngerti 😅\n\n1️⃣  Cek Poin\n2️⃣  Info Hadiah\n3️⃣  Klaim Hadiah\n4️⃣  Info Program{menu_tambahan}\n0️⃣  Menu",
  gangguan: "Maaf, sistem sedang gangguan. Coba lagi sebentar ya. 🙏",
};

// Keterangan untuk panel web: kapan pesan dikirim & kata isian yang bisa dipakai
const PESAN_META = [
  { key: "menuUtama",          judul: "Sapaan & menu utama",        kapan: "Toko ketik halo / menu / 0",                   isian: ["toko", "pic", "poin", "kode", "menu_tambahan"] },
  { key: "cekPoin",            judul: "Jawaban cek poin",           kapan: "Toko pilih menu 1 (Cek Poin)",                 isian: ["toko", "pic", "poin", "kode"] },
  { key: "poinSedangDihitung", judul: "Poin sedang dihitung",       kapan: "Toko cek poin saat fitur Cek Poin dimatikan",  isian: ["toko", "pic", "kode"] },
  { key: "klaimBerhasil",      judul: "Klaim berhasil",             kapan: "Toko selesai konfirmasi klaim hadiah",         isian: ["toko", "pic", "kode", "hadiah", "poin_hadiah", "sisa_poin"] },
  { key: "poinBelumCukup",     judul: "Poin belum cukup",           kapan: "Toko mau klaim tapi poinnya kurang",           isian: ["toko", "pic", "poin", "kode"] },
  { key: "klaimSudahPenuh",    judul: "Jatah klaim habis",          kapan: "Toko sudah klaim hadiah utama & hiburan",      isian: ["toko", "pic", "poin", "kode"] },
  { key: "klaimDitutup",       judul: "Klaim sedang ditutup",       kapan: "Toko mau klaim saat fitur Klaim dimatikan",    isian: ["toko", "pic", "poin", "kode"] },
  { key: "belumTerdaftar",     judul: "Nomor belum terdaftar",      kapan: "Ada nomor tak dikenal chat ke bot",            isian: [] },
  { key: "tidakMengerti",      judul: "Bot tidak paham",            kapan: "Toko ketik sesuatu yang bukan pilihan menu",   isian: ["toko", "pic", "poin", "kode", "menu_tambahan"] },
  { key: "gangguan",           judul: "Sistem gangguan",            kapan: "Google Sheets gagal dibaca",                   isian: [] },
];

// ============================================================
// KONFIGURASI
// ============================================================

const DEFAULT_CONFIG = {
  spreadsheetId: "",
  superAdmin: "",
  notifGroupId: "",
  notifGroupNama: "",
  fitur: {
    cekPoin: true,     // false = toko dapat pesan "poin sedang dihitung"
    klaim: true,       // false = toko dapat pesan "klaim ditutup"
    notifKeRE: true,   // kirim notif klaim langsung ke WA RE pemilik TSUB
  },
  ai: {
    aktif: false,
    apiKey: "",
    model: "gemini-2.5-flash",
    tester: [],        // nomor yang dapat jawaban AI
  },
  kategori: [
    { kode: "RTM",     label: "order via CITA/B2B" },
    { kode: "CC",      label: "beli Rokok V1" },
    { kode: "AMDK",    label: "beli Air EsErCe" },
    { kode: "METERAI", label: "beli Meterai" },
  ],
  pesan: { ...DEFAULT_PESAN },
  // Menu tambahan untuk toko: [{ id, nomor, judul, kataKunci: [], isi, gambar, aktif }]
  menuTambahan: [],
  // Poin toko otomatis dari transaksi program (1 pack = 1 poin). judul "" = mati.
  poinProgram: { judul: "Veev OM 2026", notif: true },
  panel: { passwordHash: "" },
};

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }

function merge(base, extra) {
  if (!isObj(extra)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isObj(base[k]) && isObj(v) ? merge(base[k], v) : v;
  }
  return out;
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let _cfg = null;
let _cfgMtime = 0;

function getConfig() {
  let st;
  try { st = fs.statSync(CONFIG_FILE); }
  catch {
    writeJsonAtomic(CONFIG_FILE, DEFAULT_CONFIG);
    st = fs.statSync(CONFIG_FILE);
  }
  if (!_cfg || st.mtimeMs !== _cfgMtime) {
    try {
      _cfg = merge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")));
      _cfgMtime = st.mtimeMs;
    } catch (e) {
      console.error("⚠️ config.json rusak, pakai versi terakhir yang valid:", e.message);
      if (!_cfg) _cfg = structuredClone(DEFAULT_CONFIG);
    }
  }
  return _cfg;
}

/** Ubah config: fn menerima salinan config dan mengubahnya langsung. */
function updateConfig(fn) {
  const draft = structuredClone(getConfig());
  fn(draft);
  writeJsonAtomic(CONFIG_FILE, draft);
  _cfg = null; // paksa baca ulang
  return getConfig();
}

/** Ganti {isian} di teks dengan nilai dari vars */
function isiTemplate(tpl, vars = {}) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (m, name) => (vars[name] !== undefined ? String(vars[name]) : m));
}

/** Isi template pesan: render("cekPoin", { poin: "1.000" }) */
function render(key, vars = {}) {
  return isiTemplate(getConfig().pesan?.[key] || DEFAULT_PESAN[key] || "", vars);
}

// ============================================================
// MENU TAMBAHAN
// ============================================================

const NOMOR_BAWAAN = ["0", "1", "2", "3", "4"];
const KATA_BAWAAN = ["menu", "halo", "hi", "hello", "hai", "cek", "poin", "hadiah", "info", "klaim", "program", "batal", "ya", "iya", "yes", "tidak", "no"];

/** "5" → "5️⃣", "12" → "1️⃣2️⃣" */
function emojiNomor(n) {
  return String(n).split("").map(d => (/\d/.test(d) ? `${d}\uFE0F\u20E3` : d)).join("");
}

function menuAktif() {
  return (getConfig().menuTambahan || [])
    .filter(m => m.aktif !== false && m.nomor && m.judul)
    .sort((a, b) => parseInt(a.nomor) - parseInt(b.nomor));
}

/** Baris menu tambahan untuk ditempel di daftar menu ("\n5️⃣  Kontak Sales") */
function teksMenuTambahan(list = menuAktif()) {
  return list.map(m => `\n${emojiNomor(m.nomor)}  ${m.judul}`).join("");
}

/** Cari menu tambahan dari ketikan toko. exact=true: nomor / kata kunci persis. */
function cariMenu(inp, exact, list = menuAktif()) {
  const t = String(inp || "").trim().toLowerCase();
  if (!t) return null;
  if (exact) return list.find(m => m.nomor === t || (m.kataKunci || []).some(k => k === t)) || null;
  return list.find(m => (m.kataKunci || []).some(k => k.length >= 3 && t.includes(k))) || null;
}

// ============================================================
// NOMOR WA
// ============================================================

/** "0812-3456 789" / "+62 812..." / "812..." → "62812..." */
function normWa(v) {
  let s = String(v || "").replace(/\D/g, "");
  if (s.startsWith("0")) s = "62" + s.slice(1);
  else if (s.startsWith("8")) s = "62" + s;
  return s;
}

function toList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? "").split(/[+,\s]+/);
  return arr.map(x => String(x).trim()).filter(Boolean);
}

// ============================================================
// DAFTAR TIM (admin, RE, supervisor, manajer)
// ============================================================

const ROLE_FILES = {
  admin:   "admins.json",
  re:      "re_list.json",
  spv:     "spv_list.json",
  manajer: "manajer_list.json",
};

// Pindahkan file lama dari folder utama ke data/ (sekali saja)
for (const name of Object.values(ROLE_FILES)) {
  const lama = path.join(ROOT, name);
  const baru = path.join(DATA_DIR, name);
  if (!fs.existsSync(baru) && fs.existsSync(lama)) {
    fs.copyFileSync(lama, baru);
    console.log(`📦 ${name} dipindah ke data/`);
  }
}

const _roleCache = {};

function readRole(role) {
  const file = path.join(DATA_DIR, ROLE_FILES[role]);
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const c = _roleCache[role];
  if (c && c.mtime === mtime) return c.data;
  let data = [];
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { data = c ? c.data : []; }
  if (!Array.isArray(data)) data = [];
  // Normalisasi
  if (role === "admin") data = data.map(normWa).filter(Boolean);
  else data = data.map(x => {
    const o = { ...x, wa: normWa(x.wa), nama: String(x.nama || "").trim() };
    if (role === "re")  o.tsub = toList(x.tsub).map(t => t.replace(/^TSUB/i, ""));
    if (role === "spv") o.dsub = toList(x.dsub).map(d => d.replace(/^DSUB/i, ""));
    return o;
  }).filter(x => x.wa);
  _roleCache[role] = { mtime, data };
  return data;
}

function writeRole(role, list) {
  writeJsonAtomic(path.join(DATA_DIR, ROLE_FILES[role]), list);
  delete _roleCache[role];
}

function loadAdmins() {
  const list = readRole("admin");
  const sa = normWa(getConfig().superAdmin);
  if (sa && !list.includes(sa)) return [sa, ...list];
  return list;
}

// ============================================================
// PASSWORD PANEL
// ============================================================

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(pw, stored) {
  const [algo, salt, hash] = String(stored || "").split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const cek = crypto.scryptSync(String(pw), salt, 64);
  const asli = Buffer.from(hash, "hex");
  return asli.length === cek.length && crypto.timingSafeEqual(asli, cek);
}

module.exports = {
  ROOT, DATA_DIR, CONFIG_FILE,
  DEFAULT_PESAN, PESAN_META, DEFAULT_CONFIG,
  getConfig, updateConfig, render, isiTemplate,
  NOMOR_BAWAAN, KATA_BAWAAN, emojiNomor, menuAktif, teksMenuTambahan, cariMenu,
  normWa, toList,
  readRole, writeRole, loadAdmins,
  hashPassword, verifyPassword,
};
