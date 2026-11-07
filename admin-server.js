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

const cfg = () => store.getConfig();
const { normWa, toList } = store;

const PORT = parseInt(process.env.PORT || "3000");
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || "3002");
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const HEARTBEAT_FILE = path.join(__dirname, "watchdog_heartbeat");

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

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
  "Info_Program": ["JUDUL", "DESKRIPSI", "GAMBAR"],
};

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
    res.json({ ok: kurang.length === 0, judul: r.data.properties.title, tab: ada, kurang, email, url: `https://docs.google.com/spreadsheets/d/${id}/edit` });
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
    segarkanBot();
    res.json({ ok: true, dibuat: kurang });
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

app.put("/api/toko/:wa", requireAuth, async (req, res) => {
  try {
    const { dsub, tsub, kode, nama, pic, poin } = req.body;
    const waToWrite = normWa(req.body.newWa) || req.params.wa;
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!G2:G" });
    const rows = r.data.values || [];
    const idx = rows.findIndex(row => String(row[0] || "").trim() === req.params.wa);
    if (idx === -1) return res.status(404).json({ error: "Toko tidak ditemukan" });
    if (waToWrite !== req.params.wa) {
      const waConflict = rows.findIndex(row => String(row[0] || "").trim() === waToWrite);
      if (waConflict !== -1 && waConflict !== idx)
        return res.status(409).json({ error: `Nomor WA ${waToWrite} sudah dipakai toko lain` });
    }
    const sheetRow = idx + 2;
    const oldRow = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: `Data Toko!B${sheetRow}:H${sheetRow}` });
    const old = (oldRow.data.values || [[]])[0] || [];
    const oldWa = old[5] || req.params.wa;
    const oldPoin = old[6] || 0;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `Data Toko!B${sheetRow}:H${sheetRow}`,
      valueInputOption: "RAW", requestBody: { values: [[dsub || "", tsub || "", kode, nama, pic, waToWrite, poin]] },
    });

    const perubahan = [];
    if (waToWrite !== oldWa) perubahan.push(`WA: ${oldWa} → ${waToWrite}`);
    if (String(poin) !== String(oldPoin)) perubahan.push(`Poin: ${oldPoin} → ${poin}`);
    if (nama !== old[3]) perubahan.push(`Nama: ${old[3]} → ${nama}`);
    if ((dsub || "") !== (old[0] || "")) perubahan.push(`DSUB: ${old[0] || "-"} → ${dsub || "-"}`);
    if ((tsub || "") !== (old[1] || "")) perubahan.push(`TSUB: ${old[1] || "-"} → ${tsub || "-"}`);
    const ket = (perubahan.length ? perubahan.join(", ") : "Edit data") + " — Via Admin Web";
    await catatLog(now(), nama, pic || "", kode, "EDIT TOKO", ket, 0, poin || oldPoin);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.delete("/api/toko/:wa", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const rows = r.data.values || [];
    const idx = rows.findIndex(row => String(row[6] || "").trim() === req.params.wa);
    if (idx === -1) return res.status(404).json({ error: "Toko tidak ditemukan" });
    const delRow = rows[idx] || [];
    await hapusBaris("Data Toko", idx + 1);
    await catatLog(now(), delRow[4] || "-", delRow[5] || "", delRow[3] || "-", "HAPUS TOKO", `WA: ${req.params.wa} — Via Admin Web`, 0, 0);
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

// ============================================================
// POIN
// ============================================================

app.post("/api/poin", requireAuth, async (req, res) => {
  try {
    const { wa, aksi } = req.body;
    const jumlah = parseInt(req.body.jumlah);
    if (!jumlah || jumlah <= 0) return res.status(400).json({ error: "Jumlah poin tidak valid" });
    if (!["tambah", "kurangi"].includes(aksi)) return res.status(400).json({ error: "Aksi tidak valid" });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Data Toko!A2:H" });
    const rows = r.data.values || [];
    const idx = rows.findIndex(row => String(row[6] || "").trim() === wa);
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
// INFO PROGRAM  (sheet Info_Program: A JUDUL, B DESKRIPSI, C GAMBAR)
// ============================================================

app.get("/api/info", requireAuth, async (req, res) => {
  try {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SID(), range: "Info_Program!A2:C" });
    const data = (r.data.values || []).map((row, i) => ({ row, index: i + 1 })).filter(x => x.row && x.row[0]).map(({ row, index }) => ({
      index, judul: row[0] || "", deskripsi: row[1] || "", gambar: row[2] || "",
    }));
    res.json(data);
  } catch (e) { kirimError(res, e); }
});

app.post("/api/info", requireAuth, async (req, res) => {
  try {
    const { judul, deskripsi, gambar } = req.body;
    if (!judul || !deskripsi) return res.status(400).json({ error: "Judul dan isi wajib diisi" });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SID(), range: "Info_Program!A:C",
      valueInputOption: "RAW", insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[judul, deskripsi, gambar || ""]] },
    });
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.put("/api/info/:index", requireAuth, async (req, res) => {
  try {
    const { judul, deskripsi, gambar } = req.body;
    const sheetRow = parseInt(req.params.index) + 1;
    if (!(sheetRow >= 2)) return res.status(400).json({ error: "Index tidak valid" });
    if (!judul || !deskripsi) return res.status(400).json({ error: "Judul dan isi wajib diisi" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SID(), range: `Info_Program!A${sheetRow}:C${sheetRow}`,
      valueInputOption: "RAW", requestBody: { values: [[judul, deskripsi, gambar || ""]] },
    });
    segarkanBot();
    res.json({ ok: true });
  } catch (e) { kirimError(res, e); }
});

app.delete("/api/info/:index", requireAuth, async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    if (!(index >= 1)) return res.status(400).json({ error: "Index tidak valid" });
    await hapusBaris("Info_Program", index);
    segarkanBot();
    res.json({ ok: true });
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
