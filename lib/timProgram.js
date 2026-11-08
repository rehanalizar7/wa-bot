/**
 * Ringkasan pencapaian program untuk tim (RE / Supervisor / Manajer), dibatasi ke toko di wilayahnya.
 * Program "berjalan" = program yang ada di Info_Program. Peserta = toko yang ada di tab program
 * (dan sudah punya TIER kalau program pakai tier). Toko di luar itu dianggap tidak ikut program.
 */
const P = require("./pencapaian");

const fmt = n => P.fmtAngka(Math.round(n || 0));
const pct = (a, b) => (b > 0 ? Math.floor(a / b * 100) : 0);
const bar = p => { const i = Math.max(0, Math.min(10, Math.floor(p / 10))); return "▓".repeat(i) + "░".repeat(10 - i); };

// "8/11/2026" (d/m/y) → angka yang bisa dibandingkan
function nilaiTgl(v) {
  const m = String(v || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? +m[3] * 10000 + +m[2] * 100 + +m[1] : 0;
}

function ikut(tab, kode) {
  const d = tab?.toko.get(String(kode || "").trim().toUpperCase());
  if (!d) return false;
  return tab.pakaiTier ? !!String(d.tier || "").trim() : true;
}

/** Statistik program untuk sekumpulan toko. null kalau program tidak punya tab/target. */
function statArea(program, tab, tokoArea, grupOf) {
  if (!tab) return null;
  const s = {
    peserta: 0, adaPenjualan: 0, tercapai: 0, tierSalah: [], realisasi: 0, target: 0,
    brand: tab.brands.map(b => ({ brand: b.brand, opsional: b.opsional, total: 0, target: 0, tokoTercapai: 0 })),
    update: "",
    tier: new Map(tab.tiers.map(t => [t.nama || "-", { nama: t.nama || "-", peserta: 0, tercapai: 0 }])),
    grup: new Map(), hampir: [], nol: [],
  };
  for (const t of tokoArea) {
    if (!ikut(tab, t.code)) continue;
    const h = P.hitung(program, t.code, tab);
    if (!h) continue;
    s.peserta++;
    if (h.tierBelumAda) { s.tierSalah.push(t); continue; }

    const g = grupOf ? grupOf(t) : null;
    if (g && !s.grup.has(g)) s.grup.set(g, { nama: g, peserta: 0, tercapai: 0, realisasi: 0, target: 0 });
    const G = g ? s.grup.get(g) : null;
    const tk = h.tier || "-";
    if (!s.tier.has(tk)) s.tier.set(tk, { nama: tk, peserta: 0, tercapai: 0 });
    const T = s.tier.get(tk);

    T.peserta++; if (G) G.peserta++;
    h.brand.forEach((b, i) => { s.brand[i].target += b.target || 0; if (b.tercapai) s.brand[i].tokoTercapai++; });
    if (h.update && nilaiTgl(h.update) > nilaiTgl(s.update)) s.update = String(h.update);
    s.target += h.target || 0; if (G) G.target += h.target || 0;
    if (h.realisasi) {
      s.adaPenjualan++;
      s.realisasi += h.realisasi; if (G) G.realisasi += h.realisasi;
      h.brand.forEach((b, i) => { s.brand[i].total += b.realisasi || 0; });
    } else s.nol.push(t);
    if (h.tercapai) { s.tercapai++; T.tercapai++; if (G) G.tercapai++; }
    else if (h.realisasi) {
      // kemajuan = seberapa dekat ke "tercapai penuh" (total + semua brand wajib), 0–99
      const kemajuan = h.target > 0 ? Math.min(99, Math.floor((h.target - h.kurang) / h.target * 100)) : 0;
      const brandKurang = h.brand.filter(b => !b.opsional && b.kurang > 0).map(b => b.brand);
      s.hampir.push({ toko: t, h, kemajuan, brandKurang });
    }
  }
  s.hampir.sort((a, b) => b.kemajuan - a.kemajuan || a.h.kurang - b.h.kurang);
  for (const [k, v] of s.tier) if (!v.peserta) s.tier.delete(k);
  return s;
}

/** Satu baris ringkas untuk daftar program. */
function barisRingkas(no, program, s) {
  if (!s) return `${no}. *${program.judul}* — _info program_`;
  if (!s.peserta) return `${no}. *${program.judul}* — _belum ada toko peserta di wilayah kamu_`;
  return `${no}. *${program.judul}*\n    ✅ ${s.tercapai}/${s.peserta} toko tercapai · 📈 ${pct(s.realisasi, s.target)}% dari target`;
}

/**
 * Detail program untuk wilayah.
 * @param opt.area      label wilayah, mis. "Territory Code 032"
 * @param opt.judulGrup judul breakdown, mis. "Per RE" / "Per District Code"
 */
function teksDetail(program, s, opt = {}) {
  let t = `🎯 *${program.judul}*\n📍 ${opt.area || "Semua wilayah"}`;
  if (program.periode) t += `\n📅 ${program.periode}`;
  if (!s) return t + `\n\n_Program ini belum punya target/pencapaian. Ketik detail program lewat menu toko._`;
  if (!s.peserta) return t + `\n\nBelum ada toko peserta program ini di wilayah kamu.`;

  const p = pct(s.realisasi, s.target);
  t += `\n\n👥 Peserta: *${s.peserta} toko*` +
    `\n✅ Tercapai: *${s.tercapai} toko* (${pct(s.tercapai, s.peserta)}%)` +
    `\n🛒 Sudah ada penjualan: ${s.adaPenjualan} toko` +
    `\n📈 Realisasi: *${fmt(s.realisasi)} / ${fmt(s.target)} ${P.SATUAN}* (${p}%)\n${bar(p)}`;

  if (s.tier.size > 1 || (s.tier.size === 1 && !s.tier.has("-"))) {
    t += `\n\n*Per tier:*\n` + [...s.tier.values()].map(x => `• ${x.nama}: ${x.tercapai}/${x.peserta} tercapai`).join("\n");
  }
  if (s.brand.length) {
    t += `\n\n*Realisasi per brand:*\n` + s.brand.map(b => `• ${b.brand}${b.opsional ? " _(ops)_" : ""}: ${fmt(b.total)} ${P.SATUAN}`).join("\n");
  }
  if (s.grup.size > 1 || (opt.judulGrup && s.grup.size)) {
    const g = [...s.grup.values()].sort((a, b) => pct(b.realisasi, b.target) - pct(a.realisasi, a.target));
    t += `\n\n*${opt.judulGrup || "Per wilayah"}:*\n` + g.slice(0, 15).map((x, i) =>
      `${i + 1}. ${x.nama}: ✅ ${x.tercapai}/${x.peserta} · ${pct(x.realisasi, x.target)}%`).join("\n");
    if (g.length > 15) t += `\n_...dan ${g.length - 15} lainnya_`;
  }
  if (s.hampir.length) {
    t += `\n\n🔥 *Paling dekat target:*\n` + s.hampir.slice(0, 5).map(({ toko, h, brandKurang }) =>
      `• ${toko.nama} (${toko.code})${h.tier ? ` ${h.tier}` : ""}: kurang *${fmt(h.kurang)} ${P.SATUAN}*` +
      (brandKurang.length && h.realisasi >= h.target ? ` (${brandKurang.join(", ")})` : "")).join("\n");
  }
  if (s.nol.length) {
    t += `\n\n🔴 *Belum ada penjualan (${s.nol.length} toko):*\n` + s.nol.slice(0, 5).map(x => `• ${x.nama} (${x.code})`).join("\n");
    if (s.nol.length > 5) t += `\n_...dan ${s.nol.length - 5} lainnya_`;
  }
  if (s.tierSalah.length) t += `\n\n⚠️ ${s.tierSalah.length} toko tier-nya tidak dikenal — cek di tab program.`;
  return t + `\n\n_Ketik *CEK [kode]* untuk detail toko._`;
}

/** Caption singkat untuk gambar rekap: angka utama + daftar kode toko (bisa disalin untuk CEK). */
function teksSingkat(program, s, opt = {}) {
  let t = `🎯 *${program.judul}* — ${opt.area || "Semua wilayah"}\n` +
    `📈 ${pct(s.realisasi, s.target)}% target · ✅ ${s.tercapai}/${s.peserta} toko tercapai`;
  if (s.hampir.length) {
    t += `\n\n🔥 *Paling dekat tercapai:*\n` + s.hampir.slice(0, 5).map(({ toko, h, brandKurang }) =>
      `• ${toko.nama} (${toko.code}) — kurang ${fmt(h.kurang)}` +
      (brandKurang.length && h.realisasi >= h.target ? ` (${brandKurang.join(", ")})` : "")).join("\n");
  }
  if (s.nol.length) {
    t += `\n\n🔴 *Belum ada penjualan (${s.nol.length}):*\n` + s.nol.slice(0, 5).map(x => `• ${x.nama} (${x.code})`).join("\n");
    if (s.nol.length > 5) t += `\n_...dan ${s.nol.length - 5} lainnya_`;
  }
  return t + `\n\n_Ketik *CEK [kode]* untuk detail toko._`;
}

/** Baris progres program untuk 1 toko (dipakai di CEK). "" kalau toko tidak ikut. */
function barisToko(program, tab, toko) {
  if (!tab || !ikut(tab, toko.code)) return "";
  const h = P.hitung(program, toko.code, tab);
  if (!h) return "";
  const nama = `*${program.judul}*${h.tier ? ` (${h.tier})` : ""}`;
  if (h.tierBelumAda) return `• ${nama}: ⚠️ tier belum valid`;
  if (!h.adaData || h.realisasi == null) return `• ${nama}: target ${fmt(h.target)} ${P.SATUAN} — _belum ada data_`;
  if (h.tercapai) return `• ${nama}: ${fmt(h.realisasi)}/${fmt(h.target)} ${P.SATUAN} ✅ *tercapai*`;
  return `• ${nama}: ${fmt(h.realisasi)}/${fmt(h.target)} ${P.SATUAN} (${h.persen ?? 0}%) — kurang *${fmt(h.kurang)}*`;
}

module.exports = { statArea, barisRingkas, teksDetail, teksSingkat, barisToko };
