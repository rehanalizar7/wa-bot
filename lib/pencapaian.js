/**
 * Pencapaian program per toko — dipakai bersama oleh bot (index3.js) dan panel (admin-server.js).
 *
 * Sheet Pencapaian_Program (1 baris = 1 brand untuk 1 toko di 1 program):
 *   A KODE_PROGRAM, B KODE_TOKO, C BRAND, D TARGET, E REALISASI, F UPDATE_TERAKHIR, G KETERANGAN
 *
 * - KODE_TOKO "SEMUA" = target standar brand itu untuk semua toko (cukup sekali).
 * - Baris toko cukup isi REALISASI; TARGET diisi hanya kalau toko itu targetnya beda.
 * - BRAND kosong = program tanpa rincian brand (1 target total).
 * Semua satuan = pack.
 */

const SATUAN = "pack";
const KODE_SEMUA = new Set(["SEMUA", "*", "ALL"]);
const HEADER = ["KODE_PROGRAM", "KODE_TOKO", "BRAND", "TARGET", "REALISASI", "UPDATE_TERAKHIR", "KETERANGAN"];
const RANGE = "Pencapaian_Program!A2:G";

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

/** Baris mentah sheet → objek */
function parseBaris(rows) {
  return (rows || []).filter(r => r && r[0] && r[1]).map(r => ({
    program:    kunci(r[0]),
    kodeToko:   kunci(r[1]),
    brand:      String(r[2] ?? "").trim(),
    target:     parseAngka(r[3]),
    realisasi:  parseAngka(r[4]),
    update:     String(r[5] ?? "").trim(),
    keterangan: String(r[6] ?? "").trim(),
  }));
}

/** Kunci penghubung program ↔ sheet pencapaian */
function kodeProgram(program) { return kunci(program.kode || program.judul); }

/**
 * Hitung pencapaian 1 toko di 1 program.
 * Return null kalau program ini tidak punya target sama sekali.
 */
function hitung(program, kodeToko, semuaBaris) {
  const key = kodeProgram(program);
  const toko = kunci(kodeToko);
  const baris = semuaBaris.filter(b => b.program === key);
  const standar = baris.filter(b => KODE_SEMUA.has(b.kodeToko));
  const milikToko = baris.filter(b => b.kodeToko === toko);
  const adaData = milikToko.length > 0;

  // Gabungkan per brand: target toko menimpa target standar
  const urutan = [];
  const peta = new Map();
  for (const b of [...standar, ...milikToko]) {
    const k = kunci(b.brand);
    if (!k) continue;
    if (!peta.has(k)) { peta.set(k, { brand: b.brand, target: null, realisasi: null }); urutan.push(k); }
    const x = peta.get(k);
    if (b.target != null) x.target = b.target;
    if (!KODE_SEMUA.has(b.kodeToko) && b.realisasi != null) x.realisasi = b.realisasi;
  }
  const brand = urutan.map(k => {
    const x = peta.get(k);
    // Toko sudah punya data tapi brand ini belum diisi → anggap 0
    const realisasi = x.realisasi ?? (adaData ? 0 : null);
    const tercapai = x.target != null && realisasi != null && realisasi >= x.target;
    const kurang = x.target != null && realisasi != null ? Math.max(0, x.target - realisasi) : null;
    return { ...x, realisasi, tercapai, kurang, persen: x.target > 0 && realisasi != null ? Math.floor(realisasi / x.target * 100) : null };
  });

  // Baris tanpa brand = target / realisasi total (program tanpa rincian brand)
  const totalStd = standar.find(b => !b.brand);
  const totalToko = milikToko.find(b => !b.brand);
  const sumTarget = brand.reduce((s, b) => s + (b.target || 0), 0);
  const sumReal = brand.reduce((s, b) => s + (b.realisasi || 0), 0);

  // Target total: baris tanpa brand (toko → SEMUA) kalau ada. Kalau ada rincian brand,
  // ambil yang lebih besar antara jumlah target brand dan target program ("75 pack campur").
  const targetProgram = program.target ?? null;
  let targetFinal = totalToko?.target ?? totalStd?.target ?? null;
  if (targetFinal == null) {
    targetFinal = brand.length
      ? (sumTarget > 0 || targetProgram != null ? Math.max(sumTarget, targetProgram ?? 0) : null)
      : targetProgram;
  }
  const realisasi = brand.length
    ? (adaData ? sumReal : null)
    : (totalToko?.realisasi ?? null);

  if (targetFinal == null && !brand.length && !adaData) return null;

  const kurangBrand = brand.reduce((s, b) => s + (b.kurang || 0), 0);
  const kurangTotal = targetFinal != null && realisasi != null ? Math.max(0, targetFinal - realisasi) : null;
  const kurang = realisasi == null ? null : Math.max(kurangBrand, kurangTotal ?? 0);
  const update = milikToko.map(b => b.update).filter(Boolean).pop() || "";
  const keterangan = [...new Set(milikToko.map(b => b.keterangan).filter(Boolean))];

  return {
    kodeToko: toko,
    adaData,
    brand,
    target: targetFinal,
    realisasi,
    persen: targetFinal > 0 && realisasi != null ? Math.floor(realisasi / targetFinal * 100) : null,
    brandTercapai: brand.filter(b => b.tercapai).length,
    kurang,
    tercapai: realisasi != null && kurang === 0 && (targetFinal != null || brand.length > 0),
    update,
    keterangan,
  };
}

/** Semua toko yang punya data di program ini (untuk rekap panel) */
function rekap(program, semuaBaris) {
  const key = kodeProgram(program);
  const tokoList = [...new Set(semuaBaris.filter(b => b.program === key && !KODE_SEMUA.has(b.kodeToko)).map(b => b.kodeToko))];
  return tokoList.map(k => hitung(program, k, semuaBaris));
}

function fmtAngka(n) {
  return Number(n).toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

function progressBar(pct) {
  const isi = Math.max(0, Math.min(10, Math.floor((pct || 0) / 10)));
  return "▓".repeat(isi) + "░".repeat(10 - isi);
}

/** Teks WhatsApp untuk toko. "" kalau program tidak pakai target. */
function teksWa(program, toko, semuaBaris) {
  const h = hitung(program, toko.code, semuaBaris);
  if (!h) return "";
  const S = SATUAN;
  let t = `📊 *Pencapaian ${toko.nama}*`;

  if (!h.adaData) {
    if (h.brand.length) {
      t += "\n🎯 Target:\n" + h.brand.map(b => `• ${b.brand}: ${b.target != null ? fmtAngka(b.target) + " " + S : "-"}`).join("\n");
      if (h.target != null) t += `\n*Total: ${fmtAngka(h.target)} ${S}*`;
    } else if (h.target != null) {
      t += `\n🎯 Target: ${fmtAngka(h.target)} ${S}`;
    }
    return t + `\n📈 Realisasi: _belum ada data_`;
  }

  if (h.brand.length) {
    for (const b of h.brand) {
      const tgt = b.target != null ? ` / ${fmtAngka(b.target)}` : "";
      t += `\n• *${b.brand}*: ${fmtAngka(b.realisasi)}${tgt} ${S}`;
      if (b.tercapai) t += " ✅";
      else if (b.persen != null) t += `\n   ${progressBar(b.persen)} ${b.persen}% · kurang ${fmtAngka(b.kurang)}`;
    }
    t += `\n━━━━━━━━━━`;
    t += `\n*Total: ${fmtAngka(h.realisasi)}${h.target != null ? " / " + fmtAngka(h.target) : ""} ${S}${h.persen != null ? ` (${h.persen}%)` : ""}*`;
    t += `\n${h.brandTercapai ? "✅" : "⬜"} ${h.brandTercapai} dari ${h.brand.length} brand tercapai`;
  } else {
    t += `\n🎯 Target    : ${h.target != null ? fmtAngka(h.target) + " " + S : "-"}`;
    t += `\n📈 Realisasi : *${fmtAngka(h.realisasi ?? 0)} ${S}*`;
    if (h.persen != null) t += `\n${progressBar(h.persen)} *${h.persen}%*`;
  }

  if (h.tercapai) t += `\n🎉 Selamat, target program sudah tercapai!`;
  else if (h.kurang != null && h.kurang > 0) t += `\n💪 Kurang *${fmtAngka(h.kurang)} ${S}* lagi`;
  for (const k of h.keterangan) t += `\n📝 ${k}`;
  if (h.update) t += `\n_Update: ${h.update}_`;
  return t;
}

module.exports = { SATUAN, HEADER, RANGE, KODE_SEMUA, parseAngka, parseBaris, kodeProgram, hitung, rekap, teksWa, fmtAngka };
