/**
 * Upload massal Data Toko dari file HO.
 * Kolom sheet "Data Toko": A ID, B DSUB, C TSUB, D KODE_TOKO, E NAMA_TOKO, F PIC_TOKO, G WA, H POIN, I KONTRIBUTOR
 * Kunci pencocokan: KODE_TOKO. Sel kosong tidak menimpa data lama. POIN tidak pernah diubah lewat upload.
 */
const { normWa } = require("./store");

// field → index kolom di baris sheet (A=0)
const FIELD = { DSUB: 1, TSUB: 2, KODE_TOKO: 3, NAMA_TOKO: 4, PIC_TOKO: 5, WA: 6 };
const LABEL = { DSUB: "DSUB", TSUB: "TSUB", NAMA_TOKO: "Nama", PIC_TOKO: "PIC", WA: "WA" };
const KOLOM_TEMPLATE = ["KODE_TOKO", "NAMA_TOKO", "PIC_TOKO", "WA", "DSUB", "TSUB"];

const ALIAS = {
  KODE_TOKO: "KODE_TOKO", KODE: "KODE_TOKO", KD_TOKO: "KODE_TOKO",
  NAMA_TOKO: "NAMA_TOKO", NAMA: "NAMA_TOKO", TOKO: "NAMA_TOKO",
  PIC_TOKO: "PIC_TOKO", PIC: "PIC_TOKO", PEMILIK: "PIC_TOKO",
  WA: "WA", NO_WA: "WA", NOMOR_WA: "WA", NO_WHATSAPP: "WA", WHATSAPP: "WA", NO_HP: "WA", HP: "WA",
  DSUB: "DSUB", TSUB: "TSUB",
};
const DIABAIKAN_SENGAJA = new Set(["ID", "POIN", "KONTRIBUTOR", "NO"]);

const normHeader = h => String(h || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const teks = v => (v === null || v === undefined) ? "" : String(v).trim();

/** Isi sheet Data untuk template: header + semua toko yang ada. */
function barisTemplate(rowsSheet) {
  const aoa = [KOLOM_TEMPLATE];
  for (const r of rowsSheet) {
    if (!r || !teks(r[3])) continue;
    aoa.push(KOLOM_TEMPLATE.map(k => teks(r[FIELD[k]])));
  }
  return aoa;
}

/**
 * @param rowsSheet  baris Data Toko!A2:I (array of array)
 * @param rowsFile   hasil sheet_to_json (array of object, key = header file)
 * @returns { update:[{baris, nilai:[B..G]}], baru:[[A..H]], ringkasan }
 */
function gabung(rowsSheet, rowsFile) {
  const headerFile = [...new Set(rowsFile.flatMap(r => Object.keys(r || {})))];
  const peta = {};               // header file → field
  const kolomDipakai = [], kolomDiabaikan = [];
  let adaPoin = false;
  for (const h of headerFile) {
    const n = normHeader(h);
    const f = ALIAS[n];
    if (f && !Object.values(peta).includes(f)) { peta[h] = f; kolomDipakai.push(f); }
    else {
      if (n === "POIN") adaPoin = true;
      if (!n.startsWith("EMPTY")) kolomDiabaikan.push(String(h) + (DIABAIKAN_SENGAJA.has(n) ? " (sengaja tidak diubah)" : ""));
    }
  }
  if (!Object.values(peta).includes("KODE_TOKO"))
    throw new Error("Kolom KODE_TOKO tidak ditemukan di file. Pakai template dari tombol Download Template.");

  // Salinan kerja data sheet
  const data = rowsSheet.map(r => Array.from({ length: 8 }, (_, i) => teks((r || [])[i])));
  const idxKode = new Map();
  data.forEach((r, i) => { const k = r[3].toUpperCase(); if (k && !idxKode.has(k)) idxKode.set(k, i); });
  const pemilikWa = new Map();   // wa → kode
  data.forEach(r => { const w = normWa(r[6]); if (w && r[3]) pemilikWa.set(w, r[3].toUpperCase()); });

  const ringkasan = {
    diperbarui: 0, ditambah: 0, tidakBerubah: 0,
    waSalah: [], waBentrok: [], dataKurang: [], dobel: [], tanpaKode: 0,
    contoh: [], kolomDipakai, kolomDiabaikan, adaPoin,
  };
  const diubah = new Set(), baruIdx = new Set(), sudah = new Set();

  rowsFile.forEach((rf, n) => {
    const nomorBaris = n + 2; // baris 1 = header di file
    const v = {};
    for (const [h, f] of Object.entries(peta)) v[f] = teks(rf[h]);
    const kode = v.KODE_TOKO;
    if (!kode) { if (Object.values(v).some(Boolean)) ringkasan.tanpaKode++; return; }
    const K = kode.toUpperCase();
    if (sudah.has(K)) { ringkasan.dobel.push(kode); return; }
    sudah.add(K);

    // Validasi WA
    let wa = "";
    if (v.WA) {
      wa = normWa(v.WA.replace(/\.0+$/, ""));
      if (!/^\d{10,15}$/.test(wa)) { ringkasan.waSalah.push(`${kode} (baris ${nomorBaris}: "${v.WA}")`); wa = ""; }
      else if (pemilikWa.has(wa) && pemilikWa.get(wa) !== K) {
        ringkasan.waBentrok.push(`${kode} → ${wa} sudah dipakai ${pemilikWa.get(wa)}`); wa = "";
      }
    }

    let i = idxKode.get(K);
    if (i === undefined) {
      // Toko baru: cukup KODE_TOKO. Data yang kosong (mis. WA) bisa dilengkapi admin nanti.
      const kurang = [!v.NAMA_TOKO && "nama", !v.PIC_TOKO && "PIC", !wa && "WA"].filter(Boolean);
      if (kurang.length) ringkasan.dataKurang.push(`${kode} (belum ada ${kurang.join(", ")})`);
      const r = ["", v.DSUB || "", v.TSUB || "", kode, v.NAMA_TOKO || "", v.PIC_TOKO || "", wa, "0"];
      data.push(r); i = data.length - 1;
      idxKode.set(K, i); if (wa) pemilikWa.set(wa, K); baruIdx.add(i);
      ringkasan.ditambah++;
      if (ringkasan.contoh.length < 15) ringkasan.contoh.push(`➕ ${kode} ${v.NAMA_TOKO || "(tanpa nama)"} (WA ${wa || "belum ada"})`);
      return;
    }

    const r = data[i];
    const ubah = [];
    for (const f of ["NAMA_TOKO", "PIC_TOKO", "DSUB", "TSUB", "WA"]) {
      const baru = f === "WA" ? wa : v[f];
      if (!baru) continue;
      const lama = r[FIELD[f]];
      if (f === "WA" ? normWa(lama) === baru : lama === baru) continue;
      ubah.push(`${LABEL[f]}: ${lama || "-"} → ${baru}`);
      if (f === "WA") { pemilikWa.delete(normWa(lama)); pemilikWa.set(baru, K); }
      r[FIELD[f]] = baru;
    }
    if (ubah.length) {
      diubah.add(i); ringkasan.diperbarui++;
      if (ringkasan.contoh.length < 15) ringkasan.contoh.push(`✏️ ${r[3]}: ${ubah.join(", ")}`);
    } else ringkasan.tidakBerubah++;
  });

  const update = [...diubah].map(i => ({ baris: i + 2, nilai: data[i].slice(1, 7) }));
  const stamp = Date.now();
  const baru = [...baruIdx].map((i, n) => { const r = data[i]; r[0] = String(stamp + n); return r.map((x, k) => k === 7 ? 0 : x); });
  return { update, baru, ringkasan };
}

module.exports = { KOLOM_TEMPLATE, barisTemplate, gabung };
