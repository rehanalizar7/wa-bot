/**
 * Panel Admin Web — Bot Poin Toko
 *
 * Yang bisa diatur dari web:
 *   - Data toko, poin, hadiah, info program, log
 *   - Tim: admin WA, RE, supervisor, manajer
 *   - Koneksi WA: status, scan QR, ganti nomor bot, restart, grup notifikasi
 *   - Template pesan bot
 *   - Pengaturan: fitur on/off, AI, spreadsheet, kategori, password panel
 *
 * Env (opsional):
 *   PORT=3000           port panel web
 *   BOT_API_PORT=3002   port internal API bot (harus sama dengan bot)
 */

const express = require("express");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const store = require("./lib/store");
const pencapaian = require("./lib/pencapaian");
const dataToko = require("./lib/dataToko");
const XLSX = require("xlsx");

const cfg = () => store.getConfig();
const { normWa, toList } = store;

const PORT = parseInt(process.env.PORT || "3000");
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || "3002");
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const HEARTBEAT_FILE = path.join(__dirname, "watchdog_heartbeat");

const app = express();
app.set("trust proxy", true);
// Upload file HO (base64) butuh batas lebih besar — hanya untuk rute upload
const jsonKecil = express.json({ limit: "1mb" });
const jsonBesar = express.json({ limit: "15mb" });
app.use((req, res, next) => (/^\/api\/(info\/\d+|toko)\/upload$/.test(req.path) ? jsonBesar : jsonKecil)(req, res, next));

// Hanya folder public/ yang boleh diakses browser.
// (JANGAN pakai express.static(__dirname) — itu membuka credentials.json & semua file bot)
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/", (req, res) => res.redirect("/admin.html"));

// ============================================================
// AUTH
// ============================================================

const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 jam
const sessions = new Map(); // token → expiresAt
const loginGagal = new Map(); // ip → { count, until }

function clientIp(req) {
  return req.headers["cf-connecting-ip"] || req.ip || "?";
}

function requireAuth(req, res, next) {
  const token = req.headers["authorization"];
  const exp = token && sessions.get(token);
  if (exp && exp > Date.now()) {
    sessions.set(token, Date.now() + SESSION_TTL);
    return next();
  }
  if (token) sessions.delete(token);
  res.status(401).json({ error: "Sesi habis, silakan login lagi" });
}

app.post("/api/login", (req, res) => {
  const ip = clientIp(req);
  const g = loginGagal.get(ip);
  if (g && g.lockUntil > Date.now()) {
    const menit = Math.ceil((g.lockUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi ${menit} menit lagi.` });
  }
  const hash = cfg().panel.passwordHash;
  if (!hash) {
    return res.status(503).json({ error: "Password panel belum dibuat. Jalankan di VPS: node scripts/set-password.js" });
  }
  if (!store.verifyPassword(req.body.password || "", hash)) {
    const rec = g && Date.now() - g.first < 15 * 60000 ? g : { count: 0, first: Date.now(), lockUntil: 0 };
    rec.count++;
    if (rec.count >= 5) { rec.lockUntil = Date.now() + 15 * 60000; rec.count = 0; rec.first = Date.now(); }
    loginGagal.set(ip, rec);
    return res.status(401).json({ error: "Password salah" });
  }
  loginGagal.delete(ip);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL);
  res.json({ token });
});

app.post("/api/logout", (req, res) => {
  sessions.delete(req.headers["authorization"]);
  res.json({ ok: true });
});

app.post("/api/password", requireAuth, (req, res) => {
  const { lama, baru } = req.body;
  if (!store.verifyPassword(lama || "", cfg().panel.passwordHash))
    return res.status(400).json({ error: "Password lama salah" });
  if (!baru || String(baru).length < 8)
    return res.status(400).json({ error: "Password baru minimal 8 karakter" });
  store.updateConfig(c => { c.panel.passwordHash = store.hashPassword(baru); });
  // Keluarkan semua sesi lain
  const current = req.headers["authorization"];
  for (const t of sessions.keys()) if (t !== current) sessions.delete(t);
  res.json({ ok: true });
});

// ============================================================
// GOOGLE SHEETS
// ============================================================

const auth = new google.auth.GoogleAuth({
  keyFile: CREDENTIALS_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function SID() {
  const id = cfg().spreadsheetId;
  if (!id) {
    const e = new Error("Spreadsheet belum diatur. Buka menu Pengaturan → Spreadsheet.");
    e.status = 400;
    throw e;
  }
  return id;
}

function serviceAccountEmail() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8")).client_email || null; }
  catch { return null; }
}

// Struktur sheet yang dipakai bot
const SHEET_STRUKTUR = {
  "Data Toko":    ["ID", "DSUB", "TSUB", "KODE_TOKO", "NAMA_TOKO", "PIC_TOKO", "WA", "POIN", "KONTRIBUTOR"],
  "List_Hadiah":  ["ID", "NAMA", "POIN", "GAMBAR", "STOK", "TIPE"],
  "LOG_KLAIM":    ["TANGGAL", "NAMA_TOKO", "PIC_TOKO", "KODE_TOKO", "AKSI", "KETERANGAN", "POIN_DIUBAH", "SISA_POIN"],
  "Info_Program": ["JUDUL", "DESKRIPSI", "GAMBAR", "MEKANISME", "PERIODE", "KODE_PROGRAM", "TARGET", "SATUAN"],
};

/**
 * Tab yang sudah ada tapi header-nya versi lama → bisa diperbarui otomatis tanpa merusak data:
 *  - kolom lama sama persis dengan awal header baru (tinggal tambah kolom di kanan), atau
 *  - tab masih kosong (belum ada baris data) → header boleh ditulis ulang.
 */
async function cariHeaderLama(id, adaTab) {
  const tabs = Object.keys(SHEET_STRUKTUR).filter(t => adaTab.includes(t));
  if (!tabs.length) return [];
  const r = await sheets.spreadsheets.values.batchGet({ spreadsheetId: id, ranges: tabs.map(t => `'${t}'!A1:Z2`) });
  return tabs.filter((t, i) => {
    const rows = r.data.valueRanges[i].values || [];
    const sekarang = (rows[0] || []).map(h => String(h).trim().toUpperCase());
    const harus = SHEET_STRUKTUR[t];
    if (sekarang.length === harus.length && sekarang.every((h, j) => h === harus[j])) return false;
    const kosong = !(rows[1] || []).some(v => String(v ?? "").trim() !== "");
    const awalanSama = sekarang.length < harus.length && sekarang.every((h, j) => h === harus[j]);
    return awalanSama || kosong;
  });
}

function pesanErrorSheets(e) {
  const code = e.code || e.response?.status;
  if (code === 403) return `Bot tidak punya akses ke spreadsheet ini. Share spreadsheet ke email ${serviceAccountEmail() || "service account"} sebagai Editor.`;
  if (code === 404) return "Spreadsheet tidak ditemukan. Cek lagi link / ID-nya.";
  if (e.code === "ENOENT" && String(e.message).includes("credentials")) return "File credentials.json belum ada di folder bot (VPS).";
  return e.message;
}

function kirimError(res, e) {
  res.status(e.status || 500).json({ error: e.status ? e.message : pesanErrorSheets(e) });
}

async function catatLog(tanggal, nama, pic, kode, aksi, keterangan, poinDiubah, sisaPoin) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SID(), range: "LOG_KLAIM!A:H",
    valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[tanggal, nama, pic, kode, aksi, keterangan, poinDiubah, sisaPoin]] },
  });
}

async function getSheetId(title) {
  const r = await sheets.spreadsheets.get({ spreadsheetId: SID() });
  const s = r.data.sheets.find(s => s.properties.title === title);
  if (!s) throw Object.assign(new Error(`Tab "${title}" tidak ada di spreadsheet`), { status: 400 });
  return s.properties.sheetId;
}

async function hapusBaris(title, rowIndex0) {
  const sheetId = await getSheetId(title);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SID(),
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowIndex0, endIndex: rowIndex0 + 1 } } }] },
  });
}

function parsePoin(val) {
  const s = String(val || "").toLowerCase().replace(/\s|\./g, "").replace(",", ".");
  if (s.includes("jt")) return Math.round(parseFloat(s) * 1_000_000);
  if (s.includes("rb") || s.includes("k")) return Math.round(parseFloat(s) * 1_000);
  return parseInt(s) || 0;
}

const parseAngka = pencapaian.parseAngka;

const now = () => new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

// ============================================================
// INTERNAL API BOT
// ============================================================

function botApi(method, urlPath, body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1", port: BOT_API_PORT, path: urlPath, method, timeout,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
    }, res => {
      let out = "";
      res.on("data", d => out += d);
      res.on("end", () => {
        let json; try { json = JSON.parse(out); } catch { json = { raw: out }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on("error", () => reject(Object.assign(new Error("Bot tidak jalan / tidak bisa dihubungi"), { status: 503 })));
    req.on("timeout", () => { req.destroy(); reject(Object.assign(new Error("Bot tidak merespons"), { status: 504 })); });
    if (data) req.write(data);
    req.end();
  });
}

// Minta bot buang cache supaya perubahan dari web langsung kebaca
function segarkanBot() { botApi("POST", "/cache/clear").catch(() => {}); }

// ============================================================
// SPREADSHEET — cek & siapkan otomatis
// ============================================================

function ambilSpreadsheetId(input) {
  const s = String(input || "").trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : s;
}

app.get("/api/sheet/cek", requireAuth, async (req, res) => {
  const email = serviceAccountEmail();
  if (!email) return res.json({ ok: false, error: "File credentials.json belum ada di folder bot.", email: null });
  const id = cfg().spreadsheetId;
  if (!id) return res.json({ ok: false, error: "Spreadsheet belum diatur.", email });
  try {
    const r = await sheets.spreadsheets.get({ spreadsheetId: id });
    const ada = r.data.sheets.map(s => s.properties.title);
    const kurang = Object.keys(SHEET_STRUKTUR).filter(t => !ada.includes(t));
    const headerLama = await cariHeaderLama(id, ada);
    res.json({ ok: kurang.length === 0 && headerLama.length === 0, headerLama, judul: r.data.properties.title, tab: ada, kurang, email, url: `https://docs.google.com/spreadsheets/d/${id}/edit` });
  } catch (e) {
    res.json({ ok: false, error: pesanErrorSheets(e), email });
  }
});

app.post("/api/sheet/siapkan", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.get({ spreadsheetId: SID() });
    const ada = r.data.sheets.map(s => s.properties.title);
    const kurang = Object.keys(SHEET_STRUKTUR).filter(t => !ada.includes(t));
    if (kurang.length) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SID(),
        requestBody: { requests: kurang.map(title => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) },
      });
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SID(),
        requestBody: {
          valueInputOption: "RAW",
          data: kurang.map(title => ({ range: `'${title}'!A1`, values: [SHEET_STRUKTUR[title]] })),
        },
      });
    }
    const headerLama = await cariHeaderLama(SID(), ada);
    if (headerLama.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SID(),
        requestBody: {
          valueInputOption: "RAW",
          data: headerLama.map(title => ({ range: `'${title}'!A1`, values: [SHEET_STRUKTUR[title]] })),
        },
      });
    }
    segarkanBot();
    res.json({ ok: true, dibuat: kurang, dilengkapi: headerLama });
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// PENGATURAN
// ============================================================

function settingsPublik() {
  const c = cfg();
  return {
    spreadsheetId: c.spreadsheetId,
    superAdmin: c.superAdmin,
    notifGroupId: c.notifGroupId,
    notifGroupNama: c.notifGroupNama,
    fitur: c.fitur,
    ai: { aktif: c.ai.aktif, model: c.ai.model, tester: c.ai.tester, apiKeyTersimpan: !!c.ai.apiKey },
    kategori: c.kategori,
    pesan: c.pesan,
    pesanDefault: store.DEFAULT_PESAN,
    pesanMeta: store.PESAN_META,
    menuTambahan: c.menuTambahan,
    serviceAccountEmail: serviceAccountEmail(),
  };
}

app.get("/api/settings", requireAuth, (req, res) => res.json(settingsPublik()));

app.put("/api/settings", requireAuth, (req, res) => {
  const b = req.body || {};
  try {
    store.updateConfig(c => {
      if (b.spreadsheetId !== undefined) c.spreadsheetId = ambilSpreadsheetId(b.spreadsheetId);
      if (b.superAdmin !== undefined) {
        const sa = normWa(b.superAdmin);
        if (b.superAdmin && !/^\d{10,15}$/.test(sa)) throw Object.assign(new Error("Nomor super admin tidak valid"), { status: 400 });
        c.superAdmin = sa;
      }
      if (b.notifGroupId !== undefined) {
        c.notifGroupId = String(b.notifGroupId || "").trim();
        c.notifGroupNama = c.notifGroupId ? String(b.notifGroupNama || "").trim() : "";
      }
      if (b.fitur) {
        for (const k of Object.keys(store.DEFAULT_CONFIG.fitur)) {
          if (typeof b.fitur[k] === "boolean") c.fitur[k] = b.fitur[k];
        }
      }
      if (b.ai) {
        if (typeof b.ai.aktif === "boolean") c.ai.aktif = b.ai.aktif;
        if (b.ai.model) c.ai.model = String(b.ai.model).trim();
        if (b.ai.tester !== undefined) {
          const daftar = Array.isArray(b.ai.tester) ? b.ai.tester : String(b.ai.tester).split(/[\n,;]+/);
          c.ai.tester = [...new Set(daftar.map(normWa).filter(w => /^\d{10,15}$/.test(w)))];
        }
        if (b.ai.apiKey) c.ai.apiKey = String(b.ai.apiKey).trim();
        if (b.ai.hapusKey) c.ai.apiKey = "";
      }
      if (Array.isArray(b.kategori)) {
        c.kategori = b.kategori
          .map(k => ({ kode: String(k.kode || "").trim().toUpperCase(), label: String(k.label || "").trim() }))
          .filter(k => k.kode);
      }
      if (b.pesan && typeof b.pesan === "object") {
        for (const k of Object.keys(store.DEFAULT_PESAN)) {
          if (typeof b.pesan[k] === "string") {
            const teks = b.pesan[k].trim();
            c.pesan[k] = teks || store.DEFAULT_PESAN[k];
          }
        }
      }
    });
    res.json(settingsPublik());
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// MENU TAMBAHAN (menu toko yang dibuat sendiri dari panel)
// ============================================================

function salahInput(msg) { return Object.assign(new Error(msg), { status: 400 }); }

function bentukMenu(body, idSendiri) {
  const lain = (cfg().menuTambahan || []).filter(m => m.id !== idSendiri);
  const nomor = String(body.nomor ?? "").trim().replace(/^0+(?=\d)/, "");
  if (!/^\d{1,2}$/.test(nomor)) throw salahInput("Nomor menu harus angka (contoh: 5)");
  if (store.NOMOR_BAWAAN.includes(nomor)) throw salahInput(`Nomor ${nomor} sudah dipakai menu bawaan (0–4). Pakai nomor 5 ke atas.`);
  if (lain.some(m => m.nomor === nomor)) throw salahInput(`Nomor ${nomor} sudah dipakai menu lain`);

  const judul = String(body.judul || "").trim();
  if (!judul) throw salahInput("Nama menu wajib diisi");
  if (judul.length > 40) throw salahInput("Nama menu maksimal 40 huruf");

  const isi = String(body.isi || "").trim();
  if (!isi) throw salahInput("Isi balasan wajib diisi");

  const gambar = String(body.gambar || "").trim();
  if (gambar && !/^https?:\/\//i.test(gambar)) throw salahInput("Link gambar harus diawali http:// atau https://");

  const mentah = Array.isArray(body.kataKunci) ? body.kataKunci : String(body.kataKunci || "").split(/[\n,]+/);
  const kataKunci = [...new Set(mentah.map(k => k.trim().toLowerCase()).filter(Boolean))];
  for (const k of kataKunci) {
    if (/^\d+$/.test(k)) throw salahInput(`Kata kunci "${k}" tidak boleh angka saja — pakai kolom nomor menu`);
    if (store.KATA_BAWAAN.includes(k)) throw salahInput(`Kata kunci "${k}" sudah dipakai menu bawaan`);
    const bentrok = lain.find(m => (m.kataKunci || []).includes(k));
    if (bentrok) throw salahInput(`Kata kunci "${k}" sudah dipakai menu "${bentrok.judul}"`);
  }
  const peringatan = kataKunci
    .filter(k => ["cek", "poin", "hadiah", "info", "klaim", "program"].some(b => k.includes(b)))
    .map(k => `Kata kunci "${k}" mengandung kata menu bawaan. Kalau toko mengetiknya dalam kalimat, bisa masuk ke menu bawaan; kalau diketik persis tetap ke menu ini.`);

  return {
    menu: { id: idSendiri || crypto.randomBytes(4).toString("hex"), nomor, judul, kataKunci, isi, gambar, aktif: body.aktif !== false },
    peringatan,
  };
}

app.get("/api/menu", requireAuth, (req, res) => res.json(cfg().menuTambahan || []));

app.post("/api/menu", requireAuth, (req, res) => {
  try {
    const { menu, peringatan } = bentukMenu(req.body);
    store.updateConfig(c => { c.menuTambahan = [...(c.menuTambahan || []), menu]; });
    res.json({ ok: true, menu, peringatan });
  } catch (e) { kirimError(res, e); }
});

app.put("/api/menu/:id", requireAuth, (req, res) => {
  try {
    const list = cfg().menuTambahan || [];
    if (!list.some(m => m.id === req.params.id)) return res.status(404).json({ error: "Menu tidak ditemukan" });
    const { menu, peringatan } = bentukMenu(req.body, req.params.id);
    store.updateConfig(c => { c.menuTambahan = c.menuTambahan.map(m => (m.id === menu.id ? menu : m)); });
    res.json({ ok: true, menu, peringatan });
  } catch (e) { kirimError(res, e); }
});

app.delete("/api/menu/:id", requireAuth, (req, res) => {
  const list = cfg().menuTambahan || [];
  if (!list.some(m => m.id === req.params.id)) return res.status(404).json({ error: "Menu tidak ditemukan" });
  store.updateConfig(c => { c.menuTambahan = c.menuTambahan.filter(m => m.id !== req.params.id); });
  res.json({ ok: true });
});

// ============================================================
// TIM (admin, RE, supervisor, manajer)
// ============================================================

const ROLE_LABEL = { admin: "Admin", manajer: "Manajer", spv: "Supervisor", re: "RE" };

function cariPeranLain(wa, kecualiRole) {
  for (const role of Object.keys(ROLE_LABEL)) {
    if (role === kecualiRole) continue;
    const list = store.readRole(role);
    const ada = role === "admin" ? list.includes(wa) : list.some(x => x.wa === wa);
    if (ada) return ROLE_LABEL[role];
  }
  if (wa === normWa(cfg().superAdmin) && kecualiRole !== "admin") return "Super Admin";
  return null;
}

app.get("/api/tim", requireAuth, (req, res) => {
  const sa = normWa(cfg().superAdmin);
  res.json({
    superAdmin: sa,
    admin: store.readRole("admin").filter(a => a !== sa).map(wa => ({ wa })),
    re: store.readRole("re"),
    spv: store.readRole("spv"),
    manajer: store.readRole("manajer"),
  });
});

function bentukAnggota(role, body) {
  const wa = normWa(body.wa);
  if (!/^\d{10,15}$/.test(wa)) throw Object.assign(new Error("Nomor WA tidak valid. Contoh: 081234567890"), { status: 400 });
  if (role === "admin") return wa;
  const nama = String(body.nama || "").trim();
  if (!nama) throw Object.assign(new Error("Nama wajib diisi"), { status: 400 });
  const o = { wa, nama };
  if (role === "re") {
    o.tsub = toList(body.wilayah).map(t => t.replace(/^TSUB/i, ""));
    if (!o.tsub.length) throw Object.assign(new Error("Isi minimal 1 TSUB"), { status: 400 });
  }
  if (role === "spv") {
    o.dsub = toList(body.wilayah).map(d => d.replace(/^DSUB/i, ""));
    if (!o.dsub.length) throw Object.assign(new Error("Isi minimal 1 DSUB"), { status: 400 });
  }
  return o;
}

const waDari = x => (typeof x === "string" ? x : x.wa);

app.post("/api/tim/:role", requireAuth, (req, res) => {
  const { role } = req.params;
  if (!ROLE_LABEL[role]) return res.status(404).json({ error: "Peran tidak dikenal" });
  try {
    const baru = bentukAnggota(role, req.body);
    const wa = waDari(baru);
    const list = store.readRole(role);
    if (list.some(x => waDari(x) === wa) || (role === "admin" && wa === normWa(cfg().superAdmin)))
      return res.status(409).json({ error: `Nomor ${wa} sudah terdaftar sebagai ${ROLE_LABEL[role]}` });
    const lain = cariPeranLain(wa, role);
    if (lain) return res.status(409).json({ error: `Nomor ${wa} sudah terdaftar sebagai ${lain}. Satu nomor hanya boleh 1 peran.` });
    store.writeRole(role, [...list, baru]);
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.put("/api/tim/:role/:wa", requireAuth, (req, res) => {
  const { role } = req.params;
  if (!ROLE_LABEL[role] || role === "admin") return res.status(404).json({ error: "Peran tidak dikenal" });
  try {
    const waLama = normWa(req.params.wa);
    const list = store.readRole(role);
    const idx = list.findIndex(x => x.wa === waLama);
    if (idx === -1) return res.status(404).json({ error: "Data tidak ditemukan" });
    const baru = bentukAnggota(role, req.body);
    if (baru.wa !== waLama) {
      if (list.some(x => x.wa === baru.wa)) return res.status(409).json({ error: `Nomor ${baru.wa} sudah dipakai` });
      const lain = cariPeranLain(baru.wa, role);
      if (lain) return res.status(409).json({ error: `Nomor ${baru.wa} sudah terdaftar sebagai ${lain}` });
    }
    list[idx] = baru;
    store.writeRole(role, list);
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.delete("/api/tim/:role/:wa", requireAuth, (req, res) => {
  const { role } = req.params;
  if (!ROLE_LABEL[role]) return res.status(404).json({ error: "Peran tidak dikenal" });
  const wa = normWa(req.params.wa);
  const list = store.readRole(role);
  const sisa = list.filter(x => waDari(x) !== wa);
  if (sisa.length === list.length) return res.status(404).json({ error: "Data tidak ditemukan" });
  store.writeRole(role, sisa);
  res.json({ ok: true });
});

// ============================================================
// KONEKSI WHATSAPP
// ============================================================

app.get("/api/wa/status", requireAuth, async (req, res) => {
  let lastSeen = null, heartbeatAge = null;
  try {
    const ts = parseInt(fs.readFileSync(HEARTBEAT_FILE, "utf8").trim());
    if (!isNaN(ts)) { lastSeen = new Date(ts).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }); heartbeatAge = Math.round((Date.now() - ts) / 1000); }
  } catch (_) {}
  try {
    const r = await botApi("GET", "/status");
    res.json({ jalan: true, ...r.data, lastSeen, heartbeatAge });
  } catch (e) {
    res.json({ jalan: false, state: "mati", lastSeen, heartbeatAge });
  }
});

// Kompatibel dengan panel lama
app.get("/api/bot-status", requireAuth, async (req, res) => {
  try {
    const r = await botApi("GET", "/status");
    res.json({ status: r.data.state === "ready" ? "online" : "degraded" });
  } catch { res.json({ status: "offline" }); }
});

app.get("/api/wa/qr", requireAuth, async (req, res) => {
  try {
    const r = await botApi("GET", "/qr");
    res.status(r.status).json(r.data);
  } catch (e) { kirimError(res, e); }
});

app.get("/api/wa/groups", requireAuth, async (req, res) => {
  try {
    const r = await botApi("GET", "/groups", null, 40000);
    res.status(r.status).json(r.data);
  } catch (e) { kirimError(res, e); }
});

app.post("/api/wa/restart", requireAuth, async (req, res) => {
  try { await botApi("POST", "/restart"); res.json({ ok: true }); }
  catch (e) { kirimError(res, e); }
});

app.post("/api/wa/logout", requireAuth, async (req, res) => {
  try { await botApi("POST", "/logout"); res.json({ ok: true }); }
  catch (e) { kirimError(res, e); }
});

app.post("/api/wa/tes-notif", requireAuth, async (req, res) => {
  const to = String(req.body.groupId || cfg().notifGroupId || "");
  if (!to) return res.status(400).json({ error: "Pilih grup dulu" });
  try {
    const r = await botApi("POST", "/notif", { to, pesan: `✅ *Tes notifikasi*\n\nGrup ini sudah tersambung ke bot.\n📅 ${now()}` }, 20000);
    res.status(r.status).json(r.data);
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// TOKO
// ============================================================

app.get("/api/toko", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const data = (r.data.values || []).filter(row => row && row[0]).map(row => ({
      id:   row[0] || "",
      dsub: row[1] || "",
      tsub: row[2] || "",
      kode: row[3] || "",
      nama: row[4] || "",
      pic:  row[5] || "",
      wa:   String(row[6] || "").trim(),
      poin: parsePoin(row[7]),
    }));
    res.json(data);
  } catch (e) { kirimError(res, e); }
});

app.post("/api/toko", requireAuth, async (req, res) => {
  try {
    const { kode, nama, pic, dsub, tsub } = req.body;
    const wa = normWa(req.body.wa);
    if (!wa || !kode || !nama || !pic) return res.status(400).json({ error: "Field tidak lengkap" });
    if (!/^\d{10,15}$/.test(wa)) return res.status(400).json({ error: "Nomor WA tidak valid" });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const rows = r.data.values || [];
    if (rows.find(row => String(row[6] || "").trim() === wa)) return res.status(409).json({ error: "Nomor WA sudah terdaftar" });
    const kodeExist = rows.find(row => String(row[3] || "").trim() === kode);
    if (kodeExist) return res.status(409).json({
      error: `Kode ${kode} sudah terdaftar atas nama "${kodeExist[4] || "-"}" (WA: ${kodeExist[6] || "-"})`,
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SID(), range: "Data Toko!A:H",
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[Date.now().toString(), dsub || "", tsub || "", kode, nama, pic, wa, 0]] },
    });
    await catatLog(now(), nama, pic, kode, "DAFTAR", `WA: ${wa} — Via Admin Web`, 0, 0);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

// ---------- Template & upload massal Data Toko ----------
function bacaFileUpload(body) {
  const { data } = body || {};
  if (!data) throw salahInput("File belum dipilih");
  let wb;
  try { wb = XLSX.read(Buffer.from(String(data), "base64"), { type: "buffer" }); }
  catch { throw salahInput("File tidak bisa dibaca. Pakai format .xlsx, .xls, atau .csv"); }
  const namaSheet = wb.SheetNames.find(n => n.trim().toUpperCase() === "DATA") || wb.SheetNames[0];
  // raw:true → nomor WA yang tersimpan sebagai angka dibaca utuh (bukan "6.28E+12" sesuai tampilan Excel)
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[namaSheet], { defval: "", raw: true })
    .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? v.toLocaleString("fullwide", { useGrouping: false }) : v])));
  if (!rows.length) throw salahInput(`Sheet "${namaSheet}" kosong`);
  if (rows.length > 5000) throw salahInput("Maksimal 5.000 baris per upload");
  return { namaSheet, rows };
}

app.get("/api/toko/template", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:I" });
    const aoa = dataToko.barisTemplate(r.data.values || []);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Semua sel sebagai teks supaya nomor WA / kode tidak berubah format di Excel
    for (const ref of Object.keys(ws)) if (ref[0] !== "!") { ws[ref].t = "s"; ws[ref].z = "@"; }
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 22 }, { wch: 17 }, { wch: 14 }, { wch: 14 }];
    const petunjuk = [
      ["Template upload — Data Toko"],
      [],
      ["1. Satu baris per toko. KODE_TOKO wajib diisi dan jadi kunci pencocokan."],
      ["2. Kode yang sudah ada → datanya diperbarui. Kode baru → toko ditambahkan. Cukup isi KODE_TOKO; kolom lain (mis. WA) boleh kosong dan dilengkapi nanti lewat Edit di panel."],
      ["3. Sel yang dikosongkan tidak mengubah data lama. Urutan kolom boleh diubah, nama header jangan."],
      ["4. WA boleh ditulis 08xx, 628xx, atau +62 8xx — otomatis disesuaikan. Satu nomor WA hanya untuk satu toko."],
      ["5. POIN tidak bisa diubah lewat upload (pakai menu Poin). Kolom POIN di file akan diabaikan."],
      ["6. Toko tidak dihapus lewat upload. Hapus toko lewat tombol Hapus di panel."],
      ["7. Upload lewat panel: tab Toko → tombol \"Upload Data Toko\". Akan ada pratinjau sebelum disimpan."],
    ];
    const wsP = XLSX.utils.aoa_to_sheet(petunjuk);
    wsP["!cols"] = [{ wch: 100 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.utils.book_append_sheet(wb, wsP, "Petunjuk");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Template_Data_Toko.xlsx"`);
    res.send(buf);
  } catch (e) { kirimError(res, e); }
});

/** Tanpa ?simpan=1 → pratinjau saja. Dengan ?simpan=1 → tulis ke Data Toko. */
app.post("/api/toko/upload", requireAuth, async (req, res) => {
  try {
    const { namaSheet, rows } = bacaFileUpload(req.body);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:I" });
    let hasil;
    try { hasil = dataToko.gabung(r.data.values || [], rows); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const ringkasan = { ...hasil.ringkasan, sheet: namaSheet, barisFile: rows.length };
    if (req.query.simpan !== "1") return res.json({ simpan: false, ringkasan });
    if (!hasil.update.length && !hasil.baru.length) return res.status(400).json({ error: "Tidak ada perubahan untuk disimpan", ringkasan });

    if (hasil.update.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SID(),
        requestBody: { valueInputOption: "RAW", data: hasil.update.map(u => ({ range: `Data Toko!B${u.baris}:G${u.baris}`, values: [u.nilai] })) },
      });
    }
    if (hasil.baru.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SID(), range: "Data Toko!A:H",
        valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: hasil.baru },
      });
    }
    await catatLog(now(), "-", "", "-", "UPLOAD TOKO",
      `${ringkasan.diperbarui} toko diperbarui, ${ringkasan.ditambah} ditambah — file ${String(req.body.nama || "-").slice(0, 80)} — Via Admin Web`, 0, 0);
    segarkanBot();
    res.json({ simpan: true, ringkasan });
  } catch (e) { kirimError(res, e); }
});

/**
 * Cari baris toko: pakai nomor WA, atau KODE_TOKO (?kode=) untuk toko yang WA-nya belum ada.
 * Param :wa berisi "-" kalau toko belum punya WA.
 */
function cariIdxToko(rows, wa, kode) {
  wa = String(wa || "").trim();
  if (wa && wa !== "-") {
    const i = rows.findIndex(r => String((r || [])[6] || "").trim() === wa);
    if (i !== -1) return i;
  }
  kode = String(kode || "").trim().toUpperCase();
  if (!kode) return -1;
  return rows.findIndex(r => String((r || [])[3] || "").trim().toUpperCase() === kode);
}

app.put("/api/toko/:wa", requireAuth, async (req, res) => {
  try {
    const { dsub, tsub, kode, nama, poin } = req.body;
    const pic = req.body.pic || "";
    if (!kode || !nama) return res.status(400).json({ error: "Kode dan nama toko wajib diisi" });
    const waToWrite = normWa(req.body.newWa);
    if (waToWrite && !/^\d{10,15}$/.test(waToWrite)) return res.status(400).json({ error: "Nomor WA tidak valid" });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const rows = r.data.values || [];
    const idx = cariIdxToko(rows, req.params.wa, req.query.kode);
    if (idx === -1) return res.status(404).json({ error: "Toko tidak ditemukan" });
    if (waToWrite) {
      const bentrok = rows.findIndex(row => String(row[6] || "").trim() === waToWrite);
      if (bentrok !== -1 && bentrok !== idx)
        return res.status(409).json({ error: `Nomor WA ${waToWrite} sudah dipakai toko ${rows[bentrok][4] || rows[bentrok][3] || "lain"}` });
    }
    const kodeBentrok = rows.findIndex(row => String(row[3] || "").trim().toUpperCase() === String(kode).trim().toUpperCase());
    if (kodeBentrok !== -1 && kodeBentrok !== idx)
      return res.status(409).json({ error: `Kode ${kode} sudah dipakai toko ${rows[kodeBentrok][4] || "lain"}` });
    const sheetRow = idx + 2;
    const old = (rows[idx] || []).slice(1);
    const oldWa = String(old[5] || "").trim();
    const oldPoin = old[6] || 0;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `Data Toko!B${sheetRow}:H${sheetRow}`,
      valueInputOption: "RAW", requestBody: { values: [[dsub || "", tsub || "", kode, nama, pic, waToWrite, poin]] },
    });

    const perubahan = [];
    if (waToWrite !== oldWa) perubahan.push(`WA: ${oldWa || "-"} → ${waToWrite || "-"}`);
    if (String(poin) !== String(oldPoin)) perubahan.push(`Poin: ${oldPoin} → ${poin}`);
    if (nama !== old[3]) perubahan.push(`Nama: ${old[3]} → ${nama}`);
    if ((dsub || "") !== (old[0] || "")) perubahan.push(`DSUB: ${old[0] || "-"} → ${dsub || "-"}`);
    if ((tsub || "") !== (old[1] || "")) perubahan.push(`TSUB: ${old[1] || "-"} → ${tsub || "-"}`);
    const ket = (perubahan.length ? perubahan.join(", ") : "Edit data") + " — Via Admin Web";
    await catatLog(now(), nama, pic, kode, "EDIT TOKO", ket, 0, poin || oldPoin);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.delete("/api/toko/:wa", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const rows = r.data.values || [];
    const idx = cariIdxToko(rows, req.params.wa, req.query.kode);
    if (idx === -1) return res.status(404).json({ error: "Toko tidak ditemukan" });
    const delRow = rows[idx] || [];
    await hapusBaris("Data Toko", idx + 1);
    await catatLog(now(), delRow[4] || "-", delRow[5] || "", delRow[3] || "-", "HAPUS TOKO", `WA: ${delRow[6] || "-"} — Via Admin Web`, 0, 0);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// POIN
// ============================================================

app.post("/api/poin", requireAuth, async (req, res) => {
  try {
    const { wa, kode, aksi } = req.body;
    const jumlah = parseInt(req.body.jumlah);
    if (!jumlah || jumlah <= 0) return res.status(400).json({ error: "Jumlah poin tidak valid" });
    if (!["tambah", "kurangi"].includes(aksi)) return res.status(400).json({ error: "Aksi tidak valid" });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const rows = r.data.values || [];
    const idx = cariIdxToko(rows, wa, kode);
    if (idx === -1) return res.status(404).json({ error: "Toko tidak ditemukan" });
    const poinLama = parsePoin(rows[idx][7]);
    const poinBaru = aksi === "tambah" ? poinLama + jumlah : Math.max(0, poinLama - jumlah);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `Data Toko!H${idx + 2}`,
      valueInputOption: "RAW", requestBody: { values: [[poinBaru]] },
    });
    await catatLog(now(), rows[idx][4], rows[idx][5], rows[idx][3], aksi.toUpperCase(), "Via Admin Web", jumlah, poinBaru);
    segarkanBot();
    res.json({ ok: true, poinLama, poinBaru });
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// HADIAH  (index = nomor baris data, 1 = baris ke-2 di sheet)
// ============================================================

function tipeHadiah(t) { return String(t || "").toLowerCase().trim() === "hiburan" ? "hiburan" : "utama"; }

app.get("/api/hadiah", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "List_Hadiah!A2:F" });
    const data = (r.data.values || []).map((row, i) => ({ row, index: i + 1 })).filter(x => x.row && x.row[0]).map(({ row, index }) => ({
      index,
      id:     row[0] || "",
      nama:   row[1] || "",
      poin:   parsePoin(row[2]),
      gambar: row[3] || "",
      stok:   (row[4] !== undefined && row[4] !== "") ? parseInt(row[4]) : null,
      tipe:   tipeHadiah(row[5]),
    }));
    res.json(data);
  } catch (e) { kirimError(res, e); }
});

function nilaiStok(stok) { return (stok === null || stok === undefined || stok === "") ? "" : parseInt(stok); }

app.post("/api/hadiah", requireAuth, async (req, res) => {
  try {
    const { nama, poin, gambar, stok, tipe } = req.body;
    if (!nama || !poin) return res.status(400).json({ error: "Nama dan poin wajib diisi" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SID(), range: "List_Hadiah!A:F",
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[Date.now().toString(), nama, poin, gambar || "", nilaiStok(stok), tipeHadiah(tipe)]] },
    });
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.put("/api/hadiah/:index", requireAuth, async (req, res) => {
  try {
    const { nama, poin, gambar, stok, tipe } = req.body;
    const sheetRow = parseInt(req.params.index) + 1;
    if (!(sheetRow >= 2)) return res.status(400).json({ error: "Index tidak valid" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `List_Hadiah!B${sheetRow}:F${sheetRow}`,
      valueInputOption: "RAW", requestBody: { values: [[nama, poin, gambar || "", nilaiStok(stok), tipeHadiah(tipe)]] },
    });
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.delete("/api/hadiah/:index", requireAuth, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!(index >= 1)) return res.status(400).json({ error: "Index tidak valid" });
    await hapusBaris("List_Hadiah", index);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// INFO PROGRAM  (sheet Info_Program: A JUDUL, B DESKRIPSI, C GAMBAR,
//                D MEKANISME, E PERIODE, F (tidak dipakai), G TARGET TOTAL, H (tidak dipakai))
// Pencapaian tiap program ada di TAB SENDIRI bernama judul program (lihat lib/pencapaian.js).
// ============================================================

const OPSI_ANGKA = { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" };
const kutipTab = t => `'${String(t).replace(/'/g, "''")}'`;

/** { judulTab: sheetId } semua tab di spreadsheet */
async function daftarTab() {
  const r = await sheets.spreadsheets.get({ spreadsheetId: SID(), fields: "sheets.properties(sheetId,title)" });
  return new Map(r.data.sheets.map(x => [x.properties.title, x.properties.sheetId]));
}

/** Cari tab tanpa peduli huruf besar/kecil → [judulAsli, sheetId] atau null */
function cariTab(tabs, nama) {
  const k = String(nama).trim().toUpperCase();
  for (const [t, id] of tabs) if (t.trim().toUpperCase() === k) return [t, id];
  return null;
}

function barisInfo(b) {
  return [b.judul, b.deskripsi, b.gambar || "", b.mekanisme || "", b.periode || "", "", "", ""];
}

/**
 * Bersihkan & validasi pengaturan target dari form →
 * { pakaiTier, tiers: [{nama,total}], brands: [{brand, opsional, target:[per tier]}] } atau string error
 */
function bersihkanTarget(body) {
  const angka = (v, label) => {
    const t = String(v ?? "").trim();
    if (t === "") return null;
    const n = parseAngka(t);
    if (n === null) throw `${label} harus angka`;
    return n;
  };
  try {
    const pakaiTier = !!body.pakaiTier;
    let tiers = (Array.isArray(body.tiers) ? body.tiers : []).map(t => ({
      nama: String(t.nama ?? "").replace(/\s+/g, " ").trim(), total: t.total,
    }));
    if (pakaiTier) {
      tiers = tiers.filter(t => t.nama || String(t.total ?? "").trim());
      if (!tiers.length) return "Isi minimal 1 tier, atau matikan pilihan tier";
      const sudahTier = new Set();
      for (const t of tiers) {
        if (!t.nama) return "Nama tier tidak boleh kosong";
        const k = pencapaian.kunciTier(t.nama);
        if (sudahTier.has(k)) return `Tier "${t.nama}" ditulis dua kali`;
        sudahTier.add(k);
      }
    } else {
      tiers = [{ nama: "", total: tiers[0]?.total }];
    }
    tiers = tiers.map(t => ({ nama: t.nama, total: angka(t.total, `Target total ${t.nama || ""}`.trim()) }));

    const brands = [];
    const sudah = new Set();
    for (const x of Array.isArray(body.brands) ? body.brands : []) {
      const brand = String(x.brand ?? "").replace(/\s*\(\s*opsional\s*\)\s*$/i, "").replace(/\s+/g, " ").trim();
      const target = Array.isArray(x.target) ? x.target : [x.target];
      if (!brand && target.every(v => String(v ?? "").trim() === "")) continue;
      if (!brand) return "Nama brand tidak boleh kosong";
      if (pencapaian.KOL_TETAP.includes(brand.toUpperCase())) return `"${brand}" tidak bisa dipakai sebagai nama brand`;
      if (sudah.has(brand.toUpperCase())) return `Brand "${brand}" ditulis dua kali`;
      sudah.add(brand.toUpperCase());
      brands.push({ brand, opsional: !!x.opsional, target: tiers.map((t, i) => angka(target[i], `Target ${brand}${t.nama ? " " + t.nama : ""}`)) });
    }
    return { pakaiTier, tiers, brands };
  } catch (e) {
    if (typeof e === "string") return e;
    throw e;
  }
}

/** Program ini perlu tab pencapaian? (ada brand, atau ada target total) */
const perluTab = cfg => cfg.brands.length > 0 || cfg.pakaiTier || cfg.tiers.some(t => t.total != null);

async function bacaInfoRows() {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Info_Program!A2:H", ...OPSI_ANGKA });
  return r.data.values || [];
}

/** Validasi form. Return pesan error atau null. */
function cekInfo(b, infoRows, indexSendiri) {
  if (!b.judul || !b.deskripsi) return "Judul dan isi wajib diisi";
  const tab = pencapaian.namaTab(b.judul);
  if (!tab) return "Judul tidak valid";
  const terlarang = [...Object.keys(SHEET_STRUKTUR), "Sheet1"].map(t => t.toUpperCase());
  if (terlarang.includes(tab.toUpperCase())) return `Judul "${b.judul}" bentrok dengan nama tab bawaan bot`;
  const dobel = infoRows.findIndex((r, i) => r && r[0] && i + 1 !== indexSendiri &&
    pencapaian.namaTab(r[0]).toUpperCase() === tab.toUpperCase());
  if (dobel >= 0) return `Sudah ada program dengan judul "${infoRows[dobel][0]}"`;
  return null;
}

/**
 * Samakan tab program dengan daftar brand dari panel:
 * - ganti nama tab kalau judul program berubah
 * - buat tab kalau belum ada (dan ada brand)
 * - susun ulang kolom brand + baris TARGET; angka realisasi lama ikut pindah berdasarkan nama brand
 * - toko dari Data Toko yang belum ada di tab ditambahkan
 */
async function sinkronTab(judulLama, judulBaru, cfg) {
  const tabs = await daftarTab();
  const namaBaru = pencapaian.namaTab(judulBaru);
  let ada = cariTab(tabs, namaBaru);
  const lama = judulLama ? cariTab(tabs, pencapaian.namaTab(judulLama)) : null;

  if (lama && !ada) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SID(), requestBody: { requests: [
      { updateSheetProperties: { properties: { sheetId: lama[1], title: namaBaru }, fields: "title" } },
    ] } });
    ada = [namaBaru, lama[1]];
  }
  if (!ada && !perluTab(cfg)) return null; // program tanpa target → tidak perlu tab

  if (!ada) {
    const r = await sheets.spreadsheets.batchUpdate({ spreadsheetId: SID(), requestBody: { requests: [
      { addSheet: { properties: { title: namaBaru, gridProperties: { frozenRowCount: 1, frozenColumnCount: 2 } } } },
    ] } });
    ada = [namaBaru, r.data.replies[0].addSheet.properties.sheetId];
  }

  const [isiLama, rt] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${kutipTab(ada[0])}!A1:Z`, valueRenderOption: "FORMULA", dateTimeRenderOption: "FORMATTED_STRING" }),
    sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!D2:E" }),
  ]);
  const tokoDaftar = (rt.data.values || []).filter(r => r && r[0]).map(r => ({ kode: String(r[0]).trim(), nama: r[1] || "" }));
  const baru = pencapaian.susunTab(isiLama.data.values, cfg, tokoDaftar);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SID(), range: `${kutipTab(ada[0])}!A1:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SID(), range: `${kutipTab(ada[0])}!A1`,
    valueInputOption: "USER_ENTERED", requestBody: { values: baru },
  });
  return ada[0];
}

app.get("/api/info", requireAuth, async (req, res) => {
  try {
    const [rows, tabs] = await Promise.all([bacaInfoRows(), daftarTab()]);
    const data = rows.map((row, i) => ({ row, index: i + 1 })).filter(x => x.row && x.row[0]).map(({ row, index }) => {
      const t = cariTab(tabs, pencapaian.namaTab(row[0]));
      return {
        index, judul: String(row[0]), deskripsi: row[1] || "", gambar: row[2] || "",
        mekanisme: row[3] || "", periode: row[4] || "", target: row[6] ?? "",
        tab: t ? t[0] : null, gid: t ? t[1] : null,
        ...pencapaian.untukForm(null),
      };
    });
    // Ambil header + baris TARGET tiap tab program sekaligus
    const punyaTab = data.filter(x => x.tab);
    if (punyaTab.length) {
      const r = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SID(), ranges: punyaTab.map(x => `${kutipTab(x.tab)}!A1:Z`), ...OPSI_ANGKA,
      });
      punyaTab.forEach((x, i) => {
        const tab = pencapaian.parseTab(r.data.valueRanges[i].values);
        Object.assign(x, pencapaian.untukForm(tab));
        x.jumlahTokoTerisi = [...tab.toko.values()].filter(d => d.adaAngka).length;
      });
    }
    res.json({ spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SID()}/edit`, data });
  } catch (e) { kirimError(res, e); }
});

app.post("/api/info", requireAuth, async (req, res) => {
  try {
    const cfg = bersihkanTarget(req.body);
    if (typeof cfg === "string") return res.status(400).json({ error: cfg });
    const salah = cekInfo(req.body, await bacaInfoRows(), null);
    if (salah) return res.status(400).json({ error: salah });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SID(), range: "Info_Program!A:H",
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: [barisInfo(req.body)] },
    });
    const tab = await sinkronTab(null, req.body.judul, cfg);
    segarkanBot();
    res.json({ ok: true, tab });
  } catch (e) { kirimError(res, e); }
});

app.put("/api/info/:index", requireAuth, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!(index >= 1)) return res.status(400).json({ error: "Index tidak valid" });
    const cfg = bersihkanTarget(req.body);
    if (typeof cfg === "string") return res.status(400).json({ error: cfg });
    const rows = await bacaInfoRows();
    const salah = cekInfo(req.body, rows, index);
    if (salah) return res.status(400).json({ error: salah });
    const judulLama = rows[index - 1]?.[0] || null;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `Info_Program!A${index + 1}:H${index + 1}`,
      valueInputOption: "RAW", requestBody: { values: [barisInfo(req.body)] },
    });
    const tab = await sinkronTab(judulLama, req.body.judul, cfg);
    segarkanBot();
    res.json({ ok: true, tab });
  } catch (e) { kirimError(res, e); }
});

// Hapus program: baris di Info_Program dihapus, tab pencapaiannya DIBIARKAN (arsip data)
app.delete("/api/info/:index", requireAuth, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!(index >= 1)) return res.status(400).json({ error: "Index tidak valid" });
    await hapusBaris("Info_Program", index);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

// ── TEMPLATE & UPLOAD DATA HO ──────────────────────────────────

/** Program + tab + daftar toko untuk 1 program (dipakai template & upload) */
async function dataProgram(index) {
  if (!(index >= 1)) throw Object.assign(new Error("Index tidak valid"), { status: 400 });
  const p = (await bacaInfoRows())[index - 1] || [];
  if (!p[0]) throw Object.assign(new Error("Program tidak ditemukan"), { status: 404 });
  const program = { judul: String(p[0]), target: parseAngka(p[6]) };
  const t = cariTab(await daftarTab(), pencapaian.namaTab(program.judul));
  if (!t) throw Object.assign(new Error("Program ini belum punya tab target. Klik Edit, isi brand / tier, lalu Simpan dulu."), { status: 400 });
  const [rf, ru, rt] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${kutipTab(t[0])}!A1:Z`, valueRenderOption: "FORMULA", dateTimeRenderOption: "FORMATTED_STRING" }),
    sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${kutipTab(t[0])}!A1:Z`, ...OPSI_ANGKA }),
    sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!D2:E" }),
  ]);
  const tab = pencapaian.parseTab(ru.data.values);
  const tokoDaftar = (rt.data.values || []).filter(r => r && r[0]).map(r => ({ kode: String(r[0]).trim(), nama: r[1] || "" }));
  return { program, namaTab: t[0], gid: t[1], valuesFormula: rf.data.values || [], tab, cfg: pencapaian.untukForm(tab), tokoDaftar };
}

const namaFileAman = s => String(s).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "program";

app.get("/api/info/:index/template", requireAuth, async (req, res) => {
  try {
    const d = await dataProgram(parseInt(req.params.index));
    const aoa = pencapaian.barisTemplate(d.tab, d.cfg, d.tokoDaftar);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = aoa[0].map((h, i) => ({ wch: i === 1 ? 28 : Math.max(10, String(h).length + 2) }));
    ws["!freeze"] = { xSplit: 2, ySplit: 1 };
    const tierTeks = d.cfg.pakaiTier ? d.cfg.tiers.map(t => `${t.nama} (target total ${t.total ?? "-"})`).join(", ") : "";
    const petunjuk = [
      [`Template upload — ${d.program.judul}`],
      [],
      ["1. Isi angka REALISASI (pack) di kolom tiap brand, satu baris per toko."],
      ["2. Jangan ubah isi kolom KODE_TOKO. Urutan kolom boleh diubah, nama header jangan."],
      ["3. Sel yang dikosongkan tidak mengubah data lama. Kolom yang tidak dikenal diabaikan."],
      ...(d.cfg.pakaiTier ? [[`4. Kolom TIER: isi salah satu dari ${tierTeks}. Boleh ditulis angkanya saja (mis. 1).`]] : []),
      [`${d.cfg.pakaiTier ? 5 : 4}. Brand bertanda (opsional) tidak wajib dipenuhi, tapi tetap dihitung ke total.`],
      [`${d.cfg.pakaiTier ? 6 : 5}. Target diatur dari panel (Info Program → Edit), bukan dari file ini.`],
      [`${d.cfg.pakaiTier ? 7 : 6}. Upload lewat panel: Info Program → tombol "Upload data HO" pada program ini.`],
      [],
      ["Target saat ini:"],
      ["Brand", ...(d.cfg.pakaiTier ? d.cfg.tiers.map(t => t.nama) : ["Target"])],
      ...d.cfg.brands.map(b => [b.brand + (b.opsional ? " (opsional)" : ""), ...b.target.map(v => v ?? "")]),
      ["TOTAL minimal", ...d.cfg.tiers.map(t => t.total ?? "")],
    ];
    const wsP = XLSX.utils.aoa_to_sheet(petunjuk);
    wsP["!cols"] = [{ wch: 30 }, ...d.cfg.tiers.map(() => ({ wch: 12 }))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");
    XLSX.utils.book_append_sheet(wb, wsP, "Petunjuk");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Template_${namaFileAman(d.program.judul)}.xlsx"`);
    res.send(buf);
  } catch (e) { kirimError(res, e); }
});

/**
 * Upload file HO (xlsx / xls / csv, dikirim base64).
 * Tanpa ?simpan=1 → hanya pratinjau (tidak menulis apa pun). Dengan ?simpan=1 → tulis ke tab.
 */
app.post("/api/info/:index/upload", requireAuth, async (req, res) => {
  try {
    const { nama, data } = req.body || {};
    if (!data) return res.status(400).json({ error: "File belum dipilih" });
    let wb;
    try { wb = XLSX.read(Buffer.from(String(data), "base64"), { type: "buffer", cellDates: true }); }
    catch { return res.status(400).json({ error: "File tidak bisa dibaca. Pakai format .xlsx, .xls, atau .csv" }); }
    // Pakai sheet "Data" kalau ada (template), kalau tidak sheet pertama
    const namaSheet = wb.SheetNames.find(n => n.trim().toUpperCase() === "DATA") || wb.SheetNames[0];
    const tglId = v => v instanceof Date ? v.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" }) : v;
    const rowsFile = XLSX.utils.sheet_to_json(wb.Sheets[namaSheet], { defval: "", raw: true })
      .map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, tglId(v)])));
    if (!rowsFile.length) return res.status(400).json({ error: `Sheet "${namaSheet}" kosong` });
    if (rowsFile.length > 5000) return res.status(400).json({ error: "Maksimal 5.000 baris per upload" });

    const d = await dataProgram(parseInt(req.params.index));
    const tokoValid = new Map(d.tokoDaftar.map(t => [t.kode.toUpperCase(), t.nama]));
    const tanggal = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
    let hasil;
    try { hasil = pencapaian.gabungUpload(d.valuesFormula, d.cfg, rowsFile, tokoValid, tanggal); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const r = hasil.ringkasan;
    const ringkasan = { ...r, sheet: namaSheet, barisFile: rowsFile.length, tab: d.namaTab };

    if (req.query.simpan !== "1") return res.json({ simpan: false, ringkasan });
    if (r.diperbarui + r.ditambah === 0) return res.status(400).json({ error: "Tidak ada toko yang cocok untuk disimpan", ringkasan });

    const baru = pencapaian.susunTab(hasil.values, d.cfg, d.tokoDaftar);
    await sheets.spreadsheets.values.clear({ spreadsheetId: SID(), range: `${kutipTab(d.namaTab)}!A1:Z` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `${kutipTab(d.namaTab)}!A1`,
      valueInputOption: "USER_ENTERED", requestBody: { values: baru },
    });
    await catatLog(now(), "-", "", "-", "UPLOAD PROGRAM",
      `${d.program.judul}: ${r.diperbarui} toko diperbarui, ${r.ditambah} ditambah — file ${String(nama || "-").slice(0, 80)} — Via Admin Web`, 0, 0);
    segarkanBot();
    res.json({ simpan: true, ringkasan });
  } catch (e) { kirimError(res, e); }
});

// Rekap pencapaian 1 program untuk semua toko
app.get("/api/info/:index/pencapaian", requireAuth, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!(index >= 1)) return res.status(400).json({ error: "Index tidak valid" });
    const p = (await bacaInfoRows())[index - 1] || [];
    if (!p[0]) return res.status(404).json({ error: "Program tidak ditemukan" });
    const program = { judul: String(p[0]), target: parseAngka(p[6]) };
    const t = cariTab(await daftarTab(), pencapaian.namaTab(program.judul));
    if (!t) return res.json({ judul: program.judul, tab: null, ...pencapaian.untukForm(null), data: [] });
    const [rc, rt] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `${kutipTab(t[0])}!A1:Z`, ...OPSI_ANGKA }),
      sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!D2:E" }),
    ]);
    const tab = pencapaian.parseTab(rc.data.values);
    const namaToko = new Map((rt.data.values || []).map(r => [String(r[0] || "").trim().toUpperCase(), r[1] || ""]));
    const data = pencapaian.rekap(program, tab)
      .map(h => ({ ...h, namaToko: namaToko.get(h.kodeToko) || null }))
      .sort((a, b) => (b.persen ?? -1) - (a.persen ?? -1));
    res.json({ judul: program.judul, tab: t[0], gid: t[1], ...pencapaian.untukForm(tab), data });
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// LOG
// ============================================================

app.get("/api/log", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "LOG_KLAIM!A2:H" });
    const data = (r.data.values || []).reverse().slice(0, 200).map(row => ({
      tanggal:    row[0] || "",
      nama:       row[1] || "",
      pic:        row[2] || "",
      kode:       row[3] || "",
      aksi:       row[4] || "",
      keterangan: row[5] || "",
      poin:       row[6] || "",
      sisa:       row[7] || "",
    }));
    res.json(data);
  } catch (e) { kirimError(res, e); }
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`✅ Admin panel jalan di http://localhost:${PORT}`);
  if (!cfg().panel.passwordHash) console.log("⚠️  Password panel belum dibuat. Jalankan: node scripts/set-password.js");
});
