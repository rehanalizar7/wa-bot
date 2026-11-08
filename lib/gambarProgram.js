/**
 * Gambar rekap program untuk tim (RE / Supervisor / Manajer).
 * htmlRekap() menyusun HTML dari hasil timProgram.statArea(); render jadi PNG lewat puppeteer.
 */
const P = require("./pencapaian");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = n => P.fmtAngka(Math.round(n || 0));
const pct = (a, b) => (b > 0 ? Math.floor(a / b * 100) : 0);
const warna = p => (p >= 100 ? "#16a34a" : p >= 70 ? "#2563eb" : p >= 40 ? "#f59e0b" : "#dc2626");

function bar(p, tinggi = 14) {
  const w = Math.max(0, Math.min(100, p));
  return `<div class="bar" style="height:${tinggi}px"><div style="width:${w}%;background:${warna(p)}"></div></div>`;
}

/**
 * @param program  { judul, periode }
 * @param s        hasil statArea (wajib ada & peserta > 0)
 * @param opt      { area, peran, judulGrup }
 */
function htmlRekap(program, s, opt = {}) {
  const pTotal = pct(s.realisasi, s.target);
  const pTercapai = pct(s.tercapai, s.peserta);

  const kpi = [
    ["Peserta", fmt(s.peserta), "toko"],
    ["Tercapai", fmt(s.tercapai), `toko · ${pTercapai}%`],
    ["Ada penjualan", fmt(s.adaPenjualan), `toko · ${pct(s.adaPenjualan, s.peserta)}%`],
    ["Belum jualan", fmt(s.nol.length), "toko"],
  ].map(([l, v, sub]) => `<div class="kpi"><div class="kl">${l}</div><div class="kv">${v}</div><div class="ks">${sub}</div></div>`).join("");

  const tier = [...s.tier.values()].filter(t => t.nama !== "-");
  const blokTier = tier.length ? `
    <div class="card"><div class="h">Tercapai per tier</div>
      ${tier.map(t => { const p = pct(t.tercapai, t.peserta); return `
        <div class="row"><div class="lbl">${esc(t.nama)}</div>${bar(p)}<div class="val">${fmt(t.tercapai)}/${fmt(t.peserta)}</div></div>`; }).join("")}
    </div>` : "";

  const blokBrand = s.brand.length ? `
    <div class="card"><div class="h">Per brand <span class="muted">· toko yang sudah capai target brand · total pack</span></div>
      ${s.brand.map(b => { const p = pct(b.tokoTercapai, s.peserta - s.tierSalah.length); return `
        <div class="row"><div class="lbl">${esc(b.brand)}${b.opsional ? ' <span class="ops">opsional</span>' : ""}</div>${bar(p)}<div class="val"><b>${p}%</b> · ${fmt(b.total)}</div></div>`; }).join("")}
    </div>` : "";

  const grup = [...s.grup.values()].sort((a, b) => pct(b.realisasi, b.target) - pct(a.realisasi, a.target));
  const blokGrup = grup.length > 1 ? `
    <div class="card"><div class="h">${esc(opt.judulGrup || "Per wilayah")} <span class="muted">· % realisasi · tercapai</span></div>
      ${grup.slice(0, 10).map((g, i) => { const p = pct(g.realisasi, g.target); return `
        <div class="row"><div class="lbl"><span class="no">${i + 1}</span>${esc(g.nama)}</div>${bar(p)}<div class="val"><b>${p}%</b> · ${fmt(g.tercapai)}/${fmt(g.peserta)}</div></div>`; }).join("")}
      ${grup.length > 10 ? `<div class="muted small">+${grup.length - 10} lainnya</div>` : ""}
    </div>` : "";

  const dekat = s.hampir.slice(0, 5);
  const blokDekat = dekat.length ? `
    <div class="card"><div class="h">Paling dekat tercapai <span class="muted">· total &amp; semua brand wajib</span></div>
      ${dekat.map(({ toko, h, kemajuan, brandKurang }) => `
        <div class="toko">
          <div class="tn"><b>${esc(toko.nama || toko.code)}</b> <span class="muted">${esc(toko.code)}${h.tier ? " · " + esc(h.tier) : ""}</span></div>
          <div class="trow">${bar(kemajuan, 10)}<div class="val">kurang <b>${fmt(h.kurang)} pack</b></div></div>
          ${brandKurang.length && h.realisasi >= h.target ? `<div class="kb">Total sudah lewat target — tinggal ${esc(brandKurang.join(", "))}</div>` : ""}
        </div>`).join("")}
    </div>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:540px;font-family:"Liberation Sans","DejaVu Sans",Arial,sans-serif;background:#eef2f7;color:#0f172a;font-size:14px}
  .top{background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;padding:22px 22px 70px}
  .tag{font-size:11px;letter-spacing:.12em;opacity:.8;font-weight:700}
  .judul{font-size:24px;font-weight:800;margin-top:4px;line-height:1.15}
  .sub{font-size:13px;opacity:.9;margin-top:6px}
  .wrap{padding:0 16px 16px;margin-top:-56px}
  .card{background:#fff;border-radius:14px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
  .big{display:flex;align-items:flex-end;justify-content:space-between}
  .bigv{font-size:44px;font-weight:800;line-height:1;color:${warna(pTotal)}}
  .bigl{font-size:12px;color:#64748b;font-weight:700;letter-spacing:.06em}
  .bign{text-align:right;font-size:13px;color:#334155}
  .bign b{font-size:18px;color:#0f172a}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
  .kpi{background:#fff;border-radius:12px;padding:10px 8px;text-align:center;box-shadow:0 1px 3px rgba(15,23,42,.08)}
  .kl{font-size:10.5px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
  .kv{font-size:22px;font-weight:800;margin-top:2px}
  .ks{font-size:10.5px;color:#64748b}
  .h{font-size:13px;font-weight:800;margin-bottom:10px;color:#1e293b}
  .muted{color:#94a3b8;font-weight:400}
  .small{font-size:11px;margin-top:4px}
  .row{display:grid;grid-template-columns:160px 1fr 110px;align-items:center;gap:10px;margin:7px 0}
  .lbl{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .val{font-size:12px;text-align:right;color:#334155;white-space:nowrap}
  .bar{background:#e2e8f0;border-radius:99px;overflow:hidden}
  .bar>div{height:100%;border-radius:99px}
  .ops{font-size:9.5px;background:#f1f5f9;color:#64748b;border-radius:4px;padding:1px 4px}
  .no{display:inline-block;width:18px;color:#94a3b8;font-weight:700}
  .toko{padding:7px 0;border-top:1px solid #f1f5f9}.toko:first-of-type{border-top:0}
  .tn{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .trow{display:grid;grid-template-columns:1fr 150px;gap:10px;align-items:center;margin-top:5px}
  .kb{font-size:11px;color:#b45309;margin-top:3px}
  .foot{text-align:center;font-size:11px;color:#64748b;padding:4px 0 2px}
  </style></head><body>
  <div class="top">
    <div class="tag">REKAP PROGRAM${opt.peran ? " · " + esc(opt.peran).toUpperCase() : ""}</div>
    <div class="judul">${esc(program.judul)}</div>
    <div class="sub">${esc(opt.area || "Semua wilayah")}${s.update ? " · data " + esc(s.update) : ""}${program.periode ? " · " + esc(program.periode) : ""}</div>
  </div>
  <div class="wrap">
    <div class="card">
      <div class="big">
        <div><div class="bigl">REALISASI vs TARGET</div><div class="bigv">${pTotal}%</div></div>
        <div class="bign"><b>${fmt(s.realisasi)}</b> / ${fmt(s.target)} pack<br><span class="muted">kurang ${fmt(Math.max(0, s.target - s.realisasi))} pack</span></div>
      </div>
      <div style="margin-top:12px">${bar(pTotal, 18)}</div>
    </div>
    <div class="kpis">${kpi}</div>
    ${blokTier}${blokBrand}${blokGrup}${blokDekat}
    <div class="foot">Ketik CEK [kode toko] untuk detail · PROGRAM untuk daftar program</div>
  </div></body></html>`;
}

/** Render HTML → PNG (Buffer). browser = instance puppeteer yang sudah jalan. */
async function renderPng(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 540, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "load" });
    return await page.screenshot({ type: "png", fullPage: true });
  } finally { await page.close().catch(() => {}); }
}

module.exports = { htmlRekap, renderPng };
