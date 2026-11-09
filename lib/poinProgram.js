/**
 * Poin toko dari transaksi program (default: Veev OM 2026). 1 pack = 1 poin.
 *
 * Data program yang di-upload bersifat KUMULATIF (total s.d. tanggal update), jadi poin tidak
 * ditambah mentah-mentah. Data Toko kolom J (POIN_PROGRAM_TERCATAT) menyimpan total pack yang
 * sudah pernah dijadikan poin. Tiap sinkron: selisih = total sekarang − tercatat → ditambahkan
 * ke saldo POIN (kolom H). Upload ulang data yang sama = selisih 0 = aman.
 * Saldo H tetap dipakai untuk klaim / tambah / kurangi manual seperti biasa.
 */
const P = require("./pencapaian");

const KOLOM_TERCATAT = "POIN_PROGRAM_TERCATAT"; // header kolom J Data Toko
const angka = v => { const n = P.parseAngka(v); return n == null || !isFinite(n) ? 0 : n; };

/** Total pack 1 toko di tab program (jumlah semua brand, atau TOTAL kalau tanpa brand). */
function totalPack(tab, kode) {
  const d = tab.toko.get(String(kode || "").trim().toUpperCase());
  if (!d || !d.adaAngka) return 0;
  const n = tab.brands.length
    ? tab.brands.reduce((s, b) => s + (d.realisasi[b.key] || 0), 0)
    : (d.total || 0);
  return Math.max(0, Math.floor(n));
}

/**
 * @param rowsToko  Data Toko!A2:J (array of array)
 * @param tab       hasil P.parseTab tab program sumber
 * @returns { ubah:[{baris, kode, nama, pic, wa, pack, tercatat, delta, poinLama, poinBaru}], ringkasan }
 */
function hitungSinkron(rowsToko, tab, rasio = 1) {
  const ubah = [];
  let tokoBeli = 0, totalPackSemua = 0;
  rowsToko.forEach((r, i) => {
    const kode = String((r || [])[3] || "").trim();
    if (!kode) return;
    const pack = totalPack(tab, kode);
    if (pack > 0) { tokoBeli++; totalPackSemua += pack; }
    const tercatat = Math.floor(angka(r[9]));
    const delta = (pack - tercatat) * rasio;
    if (!delta) return;
    const poinLama = Math.floor(angka(r[7]));
    ubah.push({
      baris: i + 2, kode, nama: r[4] || "", pic: r[5] || "", wa: String(r[6] || "").trim(),
      pack, tercatat, delta, poinLama, poinBaru: Math.max(0, poinLama + delta),
    });
  });
  const naik = ubah.filter(u => u.delta > 0), turun = ubah.filter(u => u.delta < 0);
  return {
    ubah,
    ringkasan: {
      tokoBeli, totalPack: totalPackSemua,
      tokoNaik: naik.length, poinMasuk: naik.reduce((s, u) => s + u.delta, 0),
      tokoTurun: turun.length, poinKeluar: turun.reduce((s, u) => s - u.delta, 0),
      contoh: ubah.slice(0, 15).map(u => `${u.kode} ${u.nama}: ${u.tercatat} → ${u.pack} pack (${u.delta > 0 ? "+" : ""}${u.delta} poin) · saldo ${u.poinLama} → ${u.poinBaru}`),
    },
  };
}

/** Pesan WA ke toko saat poin bertambah. */
function pesanPoinMasuk(u, judul) {
  return `🎉 *Poin kamu bertambah!*\n\n` +
    `Toko : *${u.nama || u.kode}*\n` +
    `➕ ${P.fmtAngka(u.delta)} poin dari pembelian *${judul}*\n` +
    `💰 Total poin: *${P.fmtAngka(u.poinBaru)} poin*\n\n` +
    `_1 pack = 1 poin._ Ketik *1* cek poin, *2* info hadiah.`;
}

module.exports = { KOLOM_TERCATAT, totalPack, hitungSinkron, pesanPoinMasuk };
