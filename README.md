# Bot WA Poin Toko

Bot WhatsApp untuk program poin loyalitas toko (whatsapp-web.js + Google Sheets),
lengkap dengan panel web. Semua pengaturan dilakukan dari panel, tanpa perlu edit kode.

## Isi folder

| File | Fungsi |
|---|---|
| `index3.js` | Bot WhatsApp |
| `admin-server.js` | Panel web admin |
| `watchdog.js` | Restart otomatis kalau bot macet |
| `lib/store.js` | Penyimpanan pengaturan bersama (bot & panel) |
| `public/` | Halaman panel (hanya folder ini yang bisa dibuka dari browser) |
| `scripts/set-password.js` | Buat / reset password panel |
| `ecosystem.config.js` | Konfigurasi PM2 (nama proses & port) |
| `data/` | **Dibuat otomatis.** Isi pengaturan, daftar tim, password. Jangan di-commit. |
| `credentials.json` | Kunci service account Google. **Jangan di-commit.** |

## Pasang di VPS (area baru)

```bash
# 1. Ambil kode
git clone https://github.com/rehanalizar7/wa-bot.git wa-bot-madura
cd wa-bot-madura
npm install

# 2. Taruh credentials.json (service account Google) di folder ini

# 3. Buat password panel
node scripts/set-password.js

# 4. Cek NAMA & PORT di ecosystem.config.js (jangan sama dengan bot lain di VPS)
pm2 start ecosystem.config.js
pm2 save
```

Lalu arahkan nginx / cloudflared ke port panel (default `3010`), buka panel di browser, login,
dan ikuti **Langkah persiapan** di halaman Beranda:

1. **Pengaturan → Spreadsheet**: share spreadsheet ke email service account, tempel link-nya, klik
   *Buat otomatis* untuk membuat tab yang dibutuhkan.
2. **Koneksi WA**: scan QR dari HP nomor bot, lalu pilih grup notifikasi.
3. **Pengaturan → Super Admin**: isi nomor admin utama.
4. **Tim**: daftarkan RE, Supervisor, Manajer, dan admin.
5. **Hadiah**, **Info Program**, **Menu Bot**, **Pesan Bot**: sesuaikan.

## Lupa password panel

```bash
node scripts/set-password.js
```

## Catatan

- Perubahan dari panel langsung dipakai bot tanpa restart.
- Tampilan panel memakai `public/app.css` (Tailwind yang sudah di-build). Kalau menambah class
  Tailwind baru di `admin.html`, build ulang:
  `npx tailwindcss@3 -i in.css -o public/app.css --content public/admin.html --minify`
  (isi `in.css`: `@tailwind base; @tailwind components; @tailwind utilities;`).
- Perintah admin lewat chat WA (DAFTAR, TAMBAH, RE TAMBAH, dll) tetap bisa dipakai.
