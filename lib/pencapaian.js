/**
 * Pencapaian program per toko — dipakai bersama oleh bot (index3.js) dan panel (admin-server.js).
 *
 * Tiap program punya TAB SENDIRI di spreadsheet, nama tab = judul program:
 *
 *   KODE_TOKO     | NAMA_TOKO         | TIER   | Samsu 12 | Mild 16 | Refil Kertas (opsional) | TOTAL   | UPDATE_TERAKHIR | KETERANGAN
 *   TARGET Tier 1 | (target tier)     |        | 300      | 200     | 50                      | 600     |                 |
 *   TARGET Tier 2 | (target tier)     |        | 200      | 150     | 30                      | 400     |                 |
 *   SUB0006839    | Rehan Barokah MDR | Tier 1 | 280      | 200     | 10                      | =SUM(…) | 8/11/2026       |
 *
 * - Kolom TIER hanya ada kalau program pakai tier/klusterisasi. Tanpa tier: 1 baris "TARGET".
 * - Kolom brand = selain kolom tetap. Akhiran "(opsional)" = brand tidak wajib dipenuhi,
 *   tapi realisasinya tetap ikut dihitung ke total.
 * - TOTAL di baris TARGET = target total minimal tier itu. TOTAL di baris toko = jumlah brand
 *   (rumus), atau realisasi total kalau program tidak dirinci per brand.
 * - Target total yang berlaku = max(jumlah target brand wajib, TOTAL tier).
 * Semua satuan = pack.
 */

const SATUAN = "pack";
const KOL_TETAP = ["KODE_TOKO", "NAMA_TOKO", "TIER", "TOTAL", "UPDATE_TERAKHIR", "KETERANGAN"];
const RE_OPSIONAL = /\s*\(\s*opsional\s*\)\s*$/i;

/** "1.250" / "12,5" / "2jt" / "500rb" / 120 → number; null kalau kosong / bukan angka */
function parseAngka(val) {
  if (typeof val === "number") return val;
  let s = String(val ?? "").toLowerCase().replace(/rp|\s/g, "");
  if (!s) return null;
  let kali = 1;
  if (s.endsWith("jt")) { kali = 1_000_000; s = s.slice(0, -2); }
  else if (s.endsWith("rb") || s.endsWith("k")) { kali = 1_000; s = s.replace(/(rb|k)$/, ""); }
  s = s.replace(/\./g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s) * kali;
}

const kunci = s => String(s ?? "").trim().toUpperCase();
/** "Tier 1" / "TIER1" / "1" → "1"; "Gold" → "GOLD" */
const kunciTier = s => kunci(s).replace(/^TIER\s*/, "").trim();

/** Nama tab dari judul program (karakter yang dilarang Google Sheets dibuang, maks 100) */
function namaTab(judul) {
  return String(judul ?? "").replace(/[\[\]*?\/\\:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

/** "A", "B", ..., "Z", "AA" dari index kolom 0-based */
function hurufKolom(i) {
  let s = ""; i += 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/** Isi tab program (array of rows, baris 1 = header) → struktur */
function parseTab(values) {
  const rows = values || [];
  const header = (rows[0] || []).map(h => String(h ?? "").trim());
  const idx = Object.fromEntries(KOL_TETAP.map(k => [k, header.findIndex(h => kunci(h) === k)]));
  if (idx.KODE_TOKO < 0) idx.KODE_TOKO = 0;
  const brands = header
    .map((h, i) => ({ header: h, i }))
    .filter(x => x.header && !KOL_TETAP.includes(kunci(x.header)))
    .map(x => {
      const brand = x.header.replace(RE_OPSIONAL, "").trim();
      return { brand, key: kunci(brand), opsional: RE_OPSIONAL.test(x.header), i: x.i };
    });
  const ambil = (r, k) => (idx[k] >= 0 ? r[idx[k]] : undefined);

  const tiers = [];
  const toko = new Map();
  for (const r of rows.slice(1)) {
    const kode = kunci(r[idx.KODE_TOKO]);
    if (!kode) continue;
    const m = kode.match(/^(TARGET|SEMUA)\b\s*(.*)$/);
    if (m) {
      const nama = String(r[idx.KODE_TOKO]).trim().replace(/^(target|semua)\s*/i, "").trim();
      const targets = {};
      for (const b of brands) targets[b.key] = parseAngka(r[b.i]);
      tiers.push({ nama, key: kunciTier(nama), total: parseAngka(ambil(r, "TOTAL")), targets });
      continue;
    }
    const realisasi = {};
    let adaAngka = false;
    for (const b of brands) {
      const v = parseAngka(r[b.i]);
      if (v != null) { realisasi[b.key] = v; adaAngka = true; }
    }
    const total = parseAngka(ambil(r, "TOTAL"));
    if (!brands.length && total != null) adaAngka = true;
    toko.set(kode, {
      nama: String(ambil(r, "NAMA_TOKO") ?? "").trim(),
      tier: String(ambil(r, "TIER") ?? "").trim(),
      realisasi, total, adaAngka,
      update: String(ambil(r, "UPDATE_TERAKHIR") ?? "").trim(),
      keterangan: String(ambil(r, "KETERANGAN") ?? "").trim(),
    });
  }
  return {
    pakaiTier: idx.TIER >= 0,
    brands: brands.map(({ brand, key, opsional }) => ({ brand, key, opsional })),
    tiers,
    toko,
  };
}

/** Untuk form panel: tiers [{nama,total}] + brands [{brand, opsional, target:[per tier]}] */
function untukForm(tab) {
  if (!tab) return { pakaiTier: false, tiers: [], brands: [] };
  const tiers = tab.tiers.length ? tab.tiers : [{ nama: "", key: "", total: null, targets: {} }];
  return {
    pakaiTier: tab.pakaiTier,
    tiers: tiers.map(t => ({ nama: t.nama, total: t.total })),
    brands: tab.brands.map(b => ({ brand: b.brand, opsional: b.opsional, target: tiers.map(t => t.targets[b.key] ?? null) })),
  };
}

/**
 * Hitung pencapaian 1 toko. tab = hasil parseTab (boleh null kalau tab belum ada).
 * Return null kalau program ini tidak punya target sama sekali.
 */
function hitung(program, kodeToko, tab) {
  const data = tab?.toko.get(kunci(kodeToko));
  const adaData = !!data?.adaAngka;
  const brands = tab?.brands || [];

  // Pilih baris target sesuai tier toko
  let tier = null;
  if (tab?.pakaiTier) {
    tier = tab.tiers.find(t => t.key && t.key === kunciTier(data?.tier)) || null;
    if (!tier) {
      return { kodeToko: kunci(kodeToko), tierBelumAda: true, tierToko: data?.tier || "", adaData,
        brand: [], target: null, realisasi: null, persen: null, brandWajib: 0, brandTercapai: 0,
        kurang: null, tercapai: false, update: data?.update || "", keterangan: data?.keterangan ? [data.keterangan] : [] };
    }
  } else if (tab) {
    tier = tab.tiers[0] || null;
  }

  const brand = brands.map(b => {
    const target = tier?.targets[b.key] ?? null;
    const realisasi = adaData ? (data.realisasi[b.key] ?? 0) : null;
    const tercapai = target != null && realisasi != null && realisasi >= target;
    const kurang = !b.opsional && target != null && realisasi != null ? Math.max(0, target - realisasi) : null;
    return { brand: b.brand, opsional: b.opsional, target, realisasi, tercapai, kurang,
      persen: target > 0 && realisasi != null ? Math.floor(realisasi / target * 100) : null };
  });
  const wajib = brand.filter(b => !b.opsional);

  const sumWajib = wajib.reduce((s, b) => s + (b.target || 0), 0);
  const totalTier = tier?.total ?? (tab ? null : program.target ?? null);
  const target = sumWajib > 0 || totalTier != null ? Math.max(sumWajib, totalTier ?? 0) : null;
  if (target == null && !brand.length) return null;

  const realisasi = !adaData ? null
    : brand.length ? brand.reduce((s, b) => s + (b.realisasi || 0), 0)
    : (data.total ?? 0);
  const kurangBrand = wajib.reduce((s, b) => s + (b.kurang || 0), 0);
  const kurangTotal = target != null && realisasi != null ? Math.max(0, target - realisasi) : 0;
  const kurang = realisasi == null ? null : Math.max(kurangBrand, kurangTotal);

  return {
    kodeToko: kunci(kodeToko),
    tier: tier?.nama || "",
    tierBelumAda: false,
    adaData, brand, target, realisasi,
    persen: target > 0 && realisasi != null ? Math.floor(realisasi / target * 100) : null,
    brandWajib: wajib.length,
    brandTercapai: wajib.filter(b => b.tercapai).length,
    kurang,
    tercapai: realisasi != null && kurang === 0 && target != null,
    update: data?.update || "",
    keterangan: data?.keterangan ? [data.keterangan] : [],
  };
}

/** Semua toko di tab (untuk rekap panel): yang sudah ada angka, atau sudah diberi tier */
function rekap(program, tab) {
  if (!tab) return [];
  return [...tab.toko.entries()]
    .filter(([, d]) => d.adaAngka || d.tier)
    .map(([kode]) => hitung(program, kode, tab));
}

function fmtAngka(n) {
  return Number(n).toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

function progressBar(pct) {
  const isi = Math.max(0, Math.min(10, Math.floor((pct || 0) / 10)));
  return "▓".repeat(isi) + "░".repeat(10 - isi);
}

/** Teks WhatsApp untuk toko. "" kalau program tidak pakai target. */
function teksWa(program, toko, tab) {
  const h = hitung(program, toko.code, tab);
  if (!h) return "";
  const S = SATUAN;
  let t = `📊 *Pencapaian ${toko.nama}*` + (h.tier ? ` — *${h.tier}*` : "");

  if (h.tierBelumAda) {
    return t + `\n⚠️ Tier toko kamu di program ini belum ditentukan${h.tierToko ? ` ("${h.tierToko}" tidak dikenal)` : ""}. Hubungi sales kamu ya. 🙏`;
  }

  const labelBrand = b => `${b.brand}${b.opsional ? " _(opsional)_" : ""}`;

  if (!h.adaData) {
    if (h.brand.length) {
      t += "\n🎯 Target:\n" + h.brand.map(b => `• ${labelBrand(b)}: ${b.target != null ? fmtAngka(b.target) + " " + S : "-"}`).join("\n");
    }
    if (h.target != null) t += h.brand.length ? `\n*Total minimal: ${fmtAngka(h.target)} ${S}*` : `\n🎯 Target: ${fmtAngka(h.target)} ${S}`;
    return t + `\n📈 Realisasi: _belum ada data_`;
  }

  for (const b of h.brand) {
    const tgt = b.target != null ? ` / ${fmtAngka(b.target)}` : "";
    t += `\n• *${b.brand}*${b.opsional ? " _(opsional)_" : ""}: ${fmtAngka(b.realisasi)}${tgt} ${S}`;
    if (b.tercapai) t += " ✅";
    else if (!b.opsional && b.persen != null) t += `\n   ${progressBar(b.persen)} ${b.persen}% · kurang ${fmtAngka(b.kurang)}`;
  }
  if (h.brand.length) t += `\n━━━━━━━━━━`;
  t += `\n*Total: ${fmtAngka(h.realisasi)}${h.target != null ? " / " + fmtAngka(h.target) : ""} ${S}${h.persen != null ? ` (${h.persen}%)` : ""}*`;
  if (!h.brand.length && h.persen != null) t += `\n${progressBar(h.persen)}`;
  if (h.brandWajib > 1) t += `\n${h.brandTercapai ? "✅" : "⬜"} ${h.brandTercapai} dari ${h.brandWajib} brand wajib tercapai`;

  if (h.tercapai) t += `\n🎉 Selamat, target program sudah tercapai!`;
  else if (h.kurang > 0) t += `\n💪 Kurang *${fmtAngka(h.kurang)} ${S}* lagi`;
  for (const k of h.keterangan) t += `\n📝 ${k}`;
  if (h.update) t += `\n_Update: ${h.update}_`;
  return t;
}

/**
 * Susun ulang isi tab dari pengaturan panel. Angka lama dipindah berdasarkan NAMA brand
 * (bukan posisi kolom), jadi tambah / hapus / ubah urutan brand tidak menggeser data.
 *   cfg = { pakaiTier, tiers: [{nama, total}], brands: [{brand, opsional, target: [per tier]}] }
 *   tokoDaftar = [{kode, nama}] dari Data Toko → toko yang belum ada di tab ditambahkan.
 */
function susunTab(valuesLama, cfg, tokoDaftar) {
  const rows = valuesLama || [];
  const headerLama = (rows[0] || []).map(h => kunci(String(h ?? "").replace(RE_OPSIONAL, "")));
  const kolLama = k => headerLama.indexOf(kunci(k));
  const { pakaiTier, tiers, brands } = cfg;

  const header = ["KODE_TOKO", "NAMA_TOKO", ...(pakaiTier ? ["TIER"] : []),
    ...brands.map(b => b.brand + (b.opsional ? " (opsional)" : "")), "TOTAL", "UPDATE_TERAKHIR", "KETERANGAN"];
  const iBrand0 = pakaiTier ? 3 : 2;
  const kosongTier = pakaiTier ? [""] : [];
  const out = [header];
  tiers.forEach((t, ti) => {
    out.push([
      pakaiTier ? `TARGET ${t.nama}` : "TARGET", pakaiTier ? "(target tier)" : "(semua toko)", ...kosongTier,
      ...brands.map(b => b.target?.[ti] ?? ""), t.total ?? "", "", "",
    ]);
  });

  const barisToko = (kode, nama, tier, nilaiBrand, total, update, ket) => {
    const n = out.length + 1; // nomor baris di sheet
    const rumus = brands.length
      ? `=SUM(${hurufKolom(iBrand0)}${n}:${hurufKolom(iBrand0 + brands.length - 1)}${n})`
      : (String(total).startsWith("=") ? "" : total); // rumus SUM lama tidak berlaku lagi tanpa brand
    out.push([kode, nama, ...(pakaiTier ? [tier] : []), ...nilaiBrand, rumus, update, ket]);
  };

  const sudah = new Set();
  const iKode = Math.max(0, kolLama("KODE_TOKO"));
  for (const r of rows.slice(1)) {
    const kode = kunci(r[iKode]);
    if (!kode || /^(TARGET|SEMUA)\b/.test(kode) || sudah.has(kode)) continue;
    sudah.add(kode);
    const ambil = k => { const i = kolLama(k); return i >= 0 ? (r[i] ?? "") : ""; };
    barisToko(String(r[iKode]).trim(), ambil("NAMA_TOKO"), ambil("TIER"),
      brands.map(b => ambil(b.brand)), ambil("TOTAL"), ambil("UPDATE_TERAKHIR"), ambil("KETERANGAN"));
  }
  for (const t of tokoDaftar || []) {
    const kode = kunci(t.kode);
    if (!kode || sudah.has(kode)) continue;
    sudah.add(kode);
    barisToko(t.kode, t.nama, "", brands.map(() => ""), "", "", "");
  }
  return out;
}

/**
 * Gabungkan data upload (file HO) ke isi tab lama.
 *   valuesLama = isi tab (FORMULA), cfg = untukForm(parseTab(...)),
 *   rowsFile   = array of objects dari file (header → nilai), tokoValid = Map(kodeUpper → nama) dari Data Toko.
 * Kolom dicocokkan berdasarkan NAMA header (huruf besar/kecil & "(opsional)" diabaikan).
 * Sel kosong di file = tidak mengubah data lama.
 * Return { values (siap ditulis via susunTab), ringkasan }.
 */
function gabungUpload(valuesLama, cfg, rowsFile, tokoValid, tanggal) {
  const norm = h => kunci(String(h ?? "").replace(RE_OPSIONAL, "")).replace(/\s+/g, " ");
  const brandKey = new Map(cfg.brands.map(b => [norm(b.brand), b.brand]));
  const tierValid = new Map(cfg.tiers.filter(t => t.nama).map(t => [kunciTier(t.nama), t.nama]));

  // Peta kolom file → kolom tab
  const headerFile = rowsFile.length ? Object.keys(rowsFile[0]) : [];
  const peta = {};           // header file → nama kolom di tab
  const diabaikan = [];
  for (const h of headerFile) {
    const k = norm(h);
    if (k === "KODE_TOKO" || k === "KODE TOKO" || k === "KODE") peta[h] = "KODE_TOKO";
    else if (k === "NAMA_TOKO" || k === "NAMA TOKO") peta[h] = null; // nama ikut Data Toko
    else if (k === "TIER" && cfg.pakaiTier) peta[h] = "TIER";
    else if (k === "UPDATE_TERAKHIR" || k === "UPDATE TERAKHIR" || k === "TANGGAL") peta[h] = "UPDATE_TERAKHIR";
    else if (k === "KETERANGAN" || k === "KET") peta[h] = "KETERANGAN";
    else if (k === "TOTAL") peta[h] = cfg.brands.length ? null : "TOTAL"; // TOTAL dihitung otomatis kalau ada brand
    else if (brandKey.has(k)) peta[h] = brandKey.get(k);
    else { peta[h] = null; if (String(h).trim() && !/^__EMPTY/.test(h)) diabaikan.push(String(h)); }
  }
  const kolKode = headerFile.find(h => peta[h] === "KODE_TOKO");
  if (!kolKode) throw new Error("Kolom KODE_TOKO tidak ditemukan di file. Pakai template dari tombol Download Template.");

  // Header tab lama → posisi kolom
  const rows = (valuesLama || []).map(r => [...r]);
  if (!rows.length) rows.push([]);
  const header = rows[0].map(h => norm(h));
  const posisi = nama => {
    const k = norm(nama);
    let i = header.indexOf(k);
    if (i < 0) { i = header.length; header.push(k); rows[0][i] = nama; }
    return i;
  };
  const iKode = posisi("KODE_TOKO");
  const barisTab = new Map();
  rows.forEach((r, i) => { if (i > 0) { const k = kunci(r[iKode]); if (k && !/^(TARGET|SEMUA)\b/.test(k)) barisTab.set(k, i); } });

  const ring = { diperbarui: 0, ditambah: 0, tidakDikenal: [], tierTidakDikenal: [], angkaSalah: [], dobel: [], kolomDipakai: [], kolomDiabaikan: diabaikan, barisKosong: 0 };
  ring.kolomDipakai = [...new Set(Object.values(peta).filter(v => v && v !== "KODE_TOKO"))];
  const sudah = new Set();

  rowsFile.forEach((rf, n) => {
    const nomorBaris = n + 2; // baris di file (header = 1)
    const kode = kunci(rf[kolKode]);
    if (!kode) { ring.barisKosong++; return; }
    if (/^(TARGET|SEMUA)\b/.test(kode)) return; // baris target di template: abaikan (target diatur dari panel)
    if (sudah.has(kode)) { ring.dobel.push(kode); return; }
    sudah.add(kode);
    let i = barisTab.get(kode);
    if (i === undefined) {
      if (!tokoValid.has(kode)) { ring.tidakDikenal.push(kode); return; }
      i = rows.length;
      rows.push([]);
      rows[i][iKode] = String(rf[kolKode]).trim();
      rows[i][posisi("NAMA_TOKO")] = tokoValid.get(kode) || "";
      barisTab.set(kode, i);
      ring.ditambah++;
    } else ring.diperbarui++;

    let berubahAngka = false;
    for (const h of headerFile) {
      const tujuan = peta[h];
      if (!tujuan || tujuan === "KODE_TOKO") continue;
      const v = rf[h];
      if (v === undefined || v === null || String(v).trim() === "") continue;
      if (tujuan === "TIER") {
        const t = tierValid.get(kunciTier(v));
        if (!t) ring.tierTidakDikenal.push(`${kode} (${v})`);
        rows[i][posisi("TIER")] = t || String(v).trim();
      } else if (tujuan === "UPDATE_TERAKHIR" || tujuan === "KETERANGAN") {
        rows[i][posisi(tujuan)] = typeof v === "number" || v instanceof Date ? v : String(v).trim();
      } else {
        const a = parseAngka(v);
        if (a === null) { ring.angkaSalah.push(`${kode} · ${h}: "${v}" (baris ${nomorBaris})`); continue; }
        rows[i][posisi(tujuan)] = a;
        berubahAngka = true;
      }
    }
    // Tanggal update otomatis kalau file tidak punya kolom UPDATE_TERAKHIR
    if (berubahAngka && !ring.kolomDipakai.includes("UPDATE_TERAKHIR") && tanggal) rows[i][posisi("UPDATE_TERAKHIR")] = tanggal;
  });
  return { values: rows, ringkasan: ring };
}

/** Baris template untuk didownload: header + baris target (info) + semua toko */
function barisTemplate(tab, cfg, tokoDaftar) {
  const header = ["KODE_TOKO", "NAMA_TOKO", ...(cfg.pakaiTier ? ["TIER"] : []),
    ...cfg.brands.map(b => b.brand + (b.opsional ? " (opsional)" : "")), ...(cfg.brands.length ? [] : ["TOTAL"]), "KETERANGAN"];
  const out = [header];
  const sudah = new Set();
  const isi = (kode, nama, d) => out.push([kode, nama, ...(cfg.pakaiTier ? [d?.tier || ""] : []),
    ...cfg.brands.map(b => d?.realisasi[kunci(b.brand)] ?? ""), ...(cfg.brands.length ? [] : [d?.total ?? ""]), d?.keterangan || ""]);
  for (const t of tokoDaftar) {
    const k = kunci(t.kode);
    if (!k || sudah.has(k)) continue;
    sudah.add(k);
    isi(t.kode, t.nama, tab?.toko.get(k));
  }
  for (const [k, d] of tab?.toko || []) if (!sudah.has(k)) { sudah.add(k); isi(k, d.nama, d); }
  return out;
}

module.exports = {
  SATUAN, KOL_TETAP, parseAngka, namaTab, parseTab, untukForm, hitung, rekap, teksWa, fmtAngka, susunTab, kunciTier,
  gabungUpload, barisTemplate,
};
