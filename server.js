// Flydan Bengkel Motor — server stok (demo lokal, tanpa dependency)
// Jalankan:  node server.js   lalu buka http://localhost:3000  (admin: /admin.html)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const DEFAULT_PASSWORD = "flydan123"; // ganti setelah login pertama (menu Pengaturan)

/* ---------------- daftar jasa servis (harga: [matic, bebek, sport], null = tidak berlaku) ---------------- */
const DEFAULT_SERVICES = [
  ["Servis rutin lengkap", 65000, 60000, 85000], ["Ganti oli mesin (jasa)", 10000, 10000, 15000],
  ["Ganti oli gardan (jasa)", 5000, null, null], ["Ganti filter udara (jasa)", 15000, 15000, 25000],
  ["Tune up", 90000, 80000, 130000], ["Bersih injeksi / karburator", 75000, 65000, 100000],
  ["Servis CVT", 60000, null, null], ["Ganti rantai & gir (jasa)", null, 35000, 50000],
  ["Ganti kampas rem (1 roda)", 25000, 25000, 35000], ["Kuras minyak rem", 35000, 35000, 45000],
  ["Tambal ban tubeless", 20000, 20000, 25000], ["Pasang ban", 0, 0, 10000],
  ["Cek kelistrikan", 40000, 40000, 50000], ["Turun mesin / overhaul", 350000, 300000, 500000],
].map(([nm, m, b, sp], i) => ({ id: "s" + String(i + 1).padStart(2, "0"), nm, harga: [m, b, sp] }));

/* ---------------- penyimpanan ---------------- */
function hashPw(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString("hex") };
}
function seed() {
  let n = 0;
  const id = () => "p" + String(++n).padStart(3, "0");
  const P = (cat, nm, ukuran, harga, stok) => ({ id: id(), cat, nm, ukuran, harga, modal: null, stok, minStok: 2, aktif: true });
  return {
    products: [
      // DATA CONTOH — ubah lewat halaman admin
      P("ban", "Ban luar tubeless matic", "80/90-14", 210000, 6),
      P("ban", "Ban luar tubeless matic", "90/90-14", 245000, 5),
      P("ban", "Ban luar tubeless matic", "100/80-14", 290000, 3),
      P("ban", "Ban luar tubeless matic", "110/70-13", 300000, 2),
      P("ban", "Ban luar bebek", "70/90-17", 175000, 6),
      P("ban", "Ban luar bebek", "80/90-17", 205000, 4),
      P("ban", "Ban luar sport", "100/80-17", 330000, 2),
      P("ban", "Ban luar sport", "120/70-17", 420000, 0),
      P("bandalam", "Ban dalam ring 17", "2.25/2.50-17", 35000, 12),
      P("bandalam", "Ban dalam ring 17", "2.50/2.75-17", 38000, 10),
      P("bandalam", "Ban dalam ring 14", "80/90-14", 40000, 5),
      P("oli", "Oli mesin matic 0.8 L", "10W-30", 52000, 15),
      P("oli", "Oli mesin matic 1 L", "10W-40", 62000, 10),
      P("oli", "Oli mesin bebek & sport 1 L", "20W-50", 55000, 8),
      P("oli", "Oli gardan 120 ml", "SAE 80W-90", 17000, 20),
    ],
    orders: [],
    log: [],
    kas: [],
    bookings: [],
    services: DEFAULT_SERVICES,
    seq: { order: 0, product: n, kas: 0, booking: 0 },
    admin: hashPw(DEFAULT_PASSWORD),
  };
}
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) { const d = seed(); save(d); return d; }
  const d = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  // migrasi: buku kas (pembukuan) untuk data lama
  if (!Array.isArray(d.kas)) {
    d.kas = []; d.seq.kas = 0;
    for (const o of [...d.orders].reverse()) if (o.status === "selesai") {
      d.seq.kas += 1;
      d.kas.unshift({ id: "k" + d.seq.kas, tgl: localDate(new Date(o.t)), t: o.t, jenis: "masuk", kategori: "Penjualan barang",
        ket: `${o.kode} · ${o.nama}`, jumlah: o.total, metode: "tunai", auto: true, ref: o.kode });
    }
    save(d);
  }
  if (!Array.isArray(d.bookings)) { d.bookings = []; d.seq.booking = 0; save(d); }
  if (!Array.isArray(d.services)) { d.services = DEFAULT_SERVICES; save(d); }
  // reset password: hapus bagian "admin" di db.json lalu jalankan ulang server
  if (!d.admin || !d.admin.salt || !d.admin.hash) {
    d.admin = hashPw(DEFAULT_PASSWORD);
    save(d);
    console.log(`  Password admin direset ke: ${DEFAULT_PASSWORD}`);
  }
  return d;
}
function save(d) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DB_FILE); // tulis atomik: file tidak rusak kalau listrik mati di tengah simpan
}
let db = load();

/* ---------------- helper ---------------- */
function localDate(d = new Date()) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const KAT_MASUK = ["Jasa servis", "Penjualan barang", "Pemasukan lain"];
const KAT_KELUAR = ["Pembelian stok", "Gaji / upah", "Listrik & air", "Sewa tempat", "Alat & perlengkapan", "Transport", "Pengeluaran lain"];
const METODE = ["tunai", "transfer", "qris"];
function addKas(e) {
  db.seq.kas = (db.seq.kas || 0) + 1;
  const row = { id: "k" + db.seq.kas, tgl: e.tgl || localDate(), t: now(), jenis: e.jenis, kategori: e.kategori, ket: e.ket || "",
    jumlah: e.jumlah, metode: METODE.includes(e.metode) ? e.metode : "tunai", auto: !!e.auto, ref: e.ref || "" };
  db.kas.unshift(row);
  return row;
}
/* Catat uang masuk sebuah nota: barang dan jasa dipisah kategorinya. */
function kasPenjualan(o, metode) {
  const barang = (o.items || []).reduce((s, i) => s + (i.harga || 0) * i.qty, 0);
  const jasa = (o.jasa || []).reduce((s, j) => s + j.harga, 0);
  const ket = `${o.kode} · ${o.nama}`;
  if (barang > 0) addKas({ jenis: "masuk", kategori: "Penjualan barang", ket, jumlah: barang, metode, auto: true, ref: o.kode });
  if (jasa > 0) addKas({ jenis: "masuk", kategori: "Jasa servis", ket: ket + " · " + o.jasa.map(j => j.nm).join(", "), jumlah: jasa, metode, auto: true, ref: o.kode });
}
const isNotaRef = k => k.auto && /^(WEB|TOKO|SRV)-/.test(k.ref || "");
const JENIS_MOTOR = ["matic", "bebek", "sport"];
function kodeBaru(prefix, n) {
  const d = new Date();
  return prefix + "-" + String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + "-" + String(n).padStart(4, "0");
}

const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 60 * 60 * 1000;
const now = () => new Date().toISOString();
const publicProduct = p => ({ id: p.id, cat: p.cat, nm: p.nm, ukuran: p.ukuran, harga: p.harga, stok: p.stok });
const CATS = ["ban", "bandalam", "oli", "lain"];

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}
const fail = (res, code, msg) => send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1e5) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
function cookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdmin(req) {
  const t = cookie(req, "fly_admin");
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
  return true;
}
const int = v => (Number.isInteger(Number(v)) ? Number(v) : NaN);
const str = (v, max = 120) => String(v ?? "").trim().slice(0, max);

function addLog(p, delta, jenis, ket) {
  db.log.unshift({ t: now(), id: p.id, nm: `${p.nm} ${p.ukuran}`.trim(), delta, sisa: p.stok, jenis, ket: ket || "" });
  if (db.log.length > 2000) db.log.length = 2000;
}

const uang = v => (v === "" || v == null ? null : Math.max(0, Math.round(Number(v)) || 0));
/* Laba satu baris barang; null kalau modal belum diisi. */
const labaItem = i => (i.modal == null || i.harga == null ? null : (i.harga - i.modal) * i.qty);
function labaNota(o) {
  let barang = 0, modal = 0, laba = 0, tanpaModal = 0;
  for (const i of o.items || []) {
    barang += (i.harga || 0) * i.qty;
    if (i.modal == null) { tanpaModal += 1; continue; }
    modal += i.modal * i.qty; laba += (i.harga || 0) * i.qty - i.modal * i.qty;
  }
  const jasa = (o.jasa || []).reduce((s, j) => s + j.harga, 0);
  return { barang, modal, labaBarang: laba, jasa, laba: laba + jasa, tanpaModal };
}

/* Kurangi stok untuk sekumpulan item, semua-atau-tidak-sama-sekali. */
function takeStock(items, jenis, ket) {
  const merged = new Map();
  for (const it of items || []) {
    const q = int(it.qty);
    if (!it.id || !(q > 0) || q > 999) return { error: "Jumlah barang tidak valid." };
    merged.set(it.id, (merged.get(it.id) || 0) + q);
  }
  if (!merged.size) return { error: "Keranjang kosong." };
  const lines = [];
  for (const [id, qty] of merged) {
    const p = db.products.find(x => x.id === id && x.aktif);
    if (!p) return { error: "Ada barang yang sudah tidak dijual. Muat ulang halaman." };
    if (p.stok < qty) return { error: `Stok ${p.nm} ${p.ukuran} tinggal ${p.stok}.`, id, stok: p.stok };
    lines.push({ p, qty });
  }
  for (const { p, qty } of lines) { p.stok -= qty; addLog(p, -qty, jenis, ket); }
  return {
    lines: lines.map(({ p, qty }) => ({ id: p.id, nm: p.nm, ukuran: p.ukuran, harga: p.harga, modal: p.modal ?? null, qty })),
    total: lines.reduce((s, { p, qty }) => s + (p.harga || 0) * qty, 0),
  };
}
function newOrder(sumber, extra, taken, jasa = []) {
  db.seq.order += 1;
  const prefix = sumber === "web" ? "WEB" : taken.lines.length ? "TOKO" : "SRV";
  const kode = kodeBaru(prefix, db.seq.order);
  const total = taken.total + jasa.reduce((s, j) => s + j.harga, 0);
  const o = { kode, t: now(), sumber, status: sumber === "web" ? "baru" : "selesai", ...extra, items: taken.lines, jasa, total };
  db.orders.unshift(o);
  return o;
}

/* ---------------- API ---------------- */
async function api(req, res, url) {
  const m = req.method, p = url.pathname;

  // ---- publik ----
  if (m === "GET" && p === "/api/products")
    return send(res, 200, db.products.filter(x => x.aktif).map(publicProduct));

  if (m === "POST" && p === "/api/bookings") {        // booking servis dari website
    const b = await readBody(req);
    const nama = str(b.nama, 60), motor = str(b.motor, 60);
    if (!nama || !motor) return fail(res, 400, "Nama dan motor wajib diisi.");
    const tgl = /^\d{4}-\d{2}-\d{2}$/.test(b.tgl) ? b.tgl : localDate();
    if (tgl < localDate()) return fail(res, 400, "Tanggal sudah lewat.");
    const layanan = (Array.isArray(b.layanan) ? b.layanan : []).slice(0, 20)
      .map(x => ({ nm: str(x.nm, 80), harga: Math.max(0, int(x.harga) || 0) })).filter(x => x.nm);
    db.seq.booking = (db.seq.booking || 0) + 1;
    const bk = { kode: kodeBaru("BK", db.seq.booking), t: now(), status: "baru", nama, hp: str(b.hp, 20).replace(/[^\d+]/g, ""),
      motor, jenis: JENIS_MOTOR.includes(b.jenis) ? b.jenis : "matic", plat: str(b.plat, 15).toUpperCase(), tgl, jam: str(b.jam, 30),
      keluhan: str(b.keluhan, 400), layanan, estimasi: layanan.reduce((s, x) => s + x.harga, 0), nota: "" };
    db.bookings.unshift(bk);
    if (db.bookings.length > 3000) db.bookings.length = 3000;
    save(db);
    return send(res, 201, { kode: bk.kode });
  }

  if (m === "POST" && p === "/api/orders") {
    const b = await readBody(req);
    const nama = str(b.nama, 60), hp = str(b.hp, 20).replace(/[^\d+]/g, "");
    if (!nama) return fail(res, 400, "Nama wajib diisi.");
    if (hp.replace(/\D/g, "").length < 9) return fail(res, 400, "Nomor WhatsApp tidak valid.");
    const taken = takeStock(b.items, "pesanan web", nama);
    if (taken.error) return send(res, 409, taken);
    const o = newOrder("web", { nama, hp, catatan: str(b.catatan, 300), ambil: b.ambil === "pasang" ? "pasang" : "ambil" }, taken);
    db.log.slice(0, taken.lines.length).forEach(l => (l.ket = o.kode + " · " + nama));
    save(db);
    return send(res, 201, { kode: o.kode, items: o.items, total: o.total });
  }

  // ---- login admin ----
  if (m === "POST" && p === "/api/admin/login") {
    const b = await readBody(req);
    const { hash } = hashPw(b.password || "", db.admin.salt);
    const ok = crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(db.admin.hash, "hex"));
    if (!ok) { await new Promise(r => setTimeout(r, 600)); return fail(res, 401, "Password salah."); }
    const t = crypto.randomBytes(24).toString("hex");
    sessions.set(t, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { "Set-Cookie": `fly_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
  }
  if (m === "POST" && p === "/api/admin/logout") {
    sessions.delete(cookie(req, "fly_admin"));
    return send(res, 200, { ok: true }, { "Set-Cookie": "fly_admin=; Path=/; Max-Age=0" });
  }
  if (!p.startsWith("/api/admin/")) return fail(res, 404, "Tidak ditemukan.");
  if (!isAdmin(req)) return fail(res, 401, "Silakan login.");

  // ---- admin ----
  if (m === "GET" && p === "/api/admin/summary") {
    const today = new Date().toDateString();
    const todays = db.orders.filter(o => o.status !== "batal" && new Date(o.t).toDateString() === today);
    return send(res, 200, {
      products: db.products.filter(x => x.aktif),
      orders: db.orders.slice(0, 200),
      log: db.log.slice(0, 300),
      bookings: db.bookings.slice(0, 300),
      services: db.services,
      stats: {
        bookingBaru: db.bookings.filter(x => x.status === "baru").length,
        bookingHariIni: db.bookings.filter(x => x.status !== "batal" && x.tgl === localDate()).length,
        omzetHariIni: todays.reduce((s, o) => s + o.total, 0),
        transaksiHariIni: todays.length,
        pesananBaru: db.orders.filter(o => o.status === "baru").length,
        stokMenipis: db.products.filter(x => x.aktif && x.stok <= x.minStok).length,
      },
    });
  }

  if (m === "POST" && p === "/api/admin/products") {
    const b = await readBody(req);
    const nm = str(b.nm, 80); if (!nm) return fail(res, 400, "Nama barang wajib diisi.");
    const stok = int(b.stok ?? 0); if (!(stok >= 0)) return fail(res, 400, "Stok awal tidak valid.");
    db.seq.product += 1;
    const prod = {
      id: "p" + String(db.seq.product).padStart(3, "0"), cat: CATS.includes(b.cat) ? b.cat : "lain", nm,
      ukuran: str(b.ukuran, 40), harga: b.harga === "" || b.harga == null ? null : Math.max(0, int(b.harga) || 0),
      modal: uang(b.modal), stok, minStok: Math.max(0, int(b.minStok) || 0), aktif: true,
    };
    db.products.push(prod);
    addLog(prod, stok, "barang baru", "stok awal");
    save(db);
    return send(res, 201, prod);
  }

  let mm;
  if ((mm = p.match(/^\/api\/admin\/products\/([\w-]+)(\/stock)?$/))) {
    const prod = db.products.find(x => x.id === mm[1] && x.aktif);
    if (!prod) return fail(res, 404, "Barang tidak ditemukan.");
    if (m === "POST" && mm[2]) {               // tambah / kurangi stok
      const b = await readBody(req);
      const delta = int(b.delta);
      if (!delta || Math.abs(delta) > 9999) return fail(res, 400, "Jumlah tidak valid.");
      if (prod.stok + delta < 0) return fail(res, 409, `Stok tidak cukup (sisa ${prod.stok}).`);
      const biaya = int(b.biaya);
      const stokLama = prod.stok;
      prod.stok += delta;
      // modal rata-rata: (stok lama × modal lama + biaya beli baru) / stok baru
      if (delta > 0 && biaya > 0) {
        prod.modal = prod.modal == null || stokLama <= 0 ? Math.round(biaya / delta)
          : Math.round((stokLama * prod.modal + biaya) / prod.stok);
      }
      addLog(prod, delta, delta > 0 ? "stok masuk" : "koreksi keluar", [str(b.ket, 120), delta > 0 && biaya > 0 ? `beli Rp${Math.round(biaya / delta).toLocaleString("id-ID")}/pcs` : ""].filter(Boolean).join(" · "));
      if (delta > 0 && biaya > 0) addKas({ jenis: "keluar", kategori: "Pembelian stok", ket: `${prod.nm} ${prod.ukuran} × ${delta}`.trim(),
        jumlah: biaya, metode: b.metode, auto: true, ref: prod.id });
      save(db);
      return send(res, 200, prod);
    }
    if (m === "PUT" && !mm[2]) {               // edit data barang
      const b = await readBody(req);
      if (b.nm != null) { const v = str(b.nm, 80); if (!v) return fail(res, 400, "Nama tidak boleh kosong."); prod.nm = v; }
      if (b.ukuran != null) prod.ukuran = str(b.ukuran, 40);
      if (b.cat != null && CATS.includes(b.cat)) prod.cat = b.cat;
      if (b.harga !== undefined) prod.harga = b.harga === "" || b.harga == null ? null : Math.max(0, int(b.harga) || 0);
      if (b.minStok != null) prod.minStok = Math.max(0, int(b.minStok) || 0);
      if (b.modal !== undefined) prod.modal = uang(b.modal);
      save(db);
      return send(res, 200, prod);
    }
    if (m === "DELETE" && !mm[2]) {
      prod.aktif = false; // disembunyikan, riwayat tetap ada
      addLog(prod, 0, "barang dihapus", "");
      save(db);
      return send(res, 200, { ok: true });
    }
  }

  if (m === "POST" && p === "/api/admin/sales") {  // penjualan langsung di bengkel
    const b = await readBody(req);
    const ket = str(b.catatan, 120) || "penjualan di bengkel";
    const jasa = [];
    for (const j of (Array.isArray(b.jasa) ? b.jasa : []).slice(0, 30)) {
      const nm = str(j.nm, 80), harga = int(j.harga);
      if (!nm) return fail(res, 400, "Nama jasa tidak boleh kosong.");
      if (!(harga >= 0) || harga > 1e9) return fail(res, 400, `Harga jasa "${nm}" tidak valid.`);
      jasa.push({ nm, harga });
    }
    const adaBarang = Array.isArray(b.items) && b.items.length > 0;
    if (!adaBarang && !jasa.length) return fail(res, 400, "Nota masih kosong.");
    const bk = b.booking ? db.bookings.find(x => x.kode === b.booking) : null;
    if (b.booking && !bk) return fail(res, 404, "Booking tidak ditemukan.");
    if (bk && (bk.status === "selesai" || bk.status === "batal")) return fail(res, 409, `Booking ${bk.kode} sudah ${bk.status}.`);
    const taken = adaBarang ? takeStock(b.items, "jual di bengkel", ket) : { lines: [], total: 0 };
    if (taken.error) return send(res, 409, taken);
    const metode = METODE.includes(b.metode) ? b.metode : "tunai";
    const o = newOrder("toko", { nama: str(b.nama, 60) || (bk ? bk.nama : "Pembeli langsung"), hp: bk ? bk.hp : "",
      catatan: str(b.catatan, 300), metode, booking: bk ? bk.kode : "" }, taken, jasa);
    if (bk) { bk.status = "selesai"; bk.nota = o.kode; }
    if (o.total > 0) kasPenjualan(o, metode);
    db.log.slice(0, taken.lines.length).forEach(l => (l.ket = o.kode + (b.catatan ? " · " + str(b.catatan, 80) : "")));
    save(db);
    return send(res, 201, o);
  }

  if ((mm = p.match(/^\/api\/admin\/orders\/([\w-]+)$/)) && m === "POST") {
    const o = db.orders.find(x => x.kode === mm[1]);
    if (!o) return fail(res, 404, "Pesanan tidak ditemukan.");
    const b = await readBody(req);
    if (o.status === "batal") return fail(res, 409, "Pesanan sudah dibatalkan.");
    if (b.status === "selesai") {
      if (o.status === "selesai") return fail(res, 409, "Pesanan sudah selesai.");
      o.status = "selesai"; o.metode = METODE.includes(b.metode) ? b.metode : "tunai";
      if (o.total > 0) kasPenjualan(o, o.metode);   // uang masuk saat barang diambil & dibayar
    }
    else if (b.status === "batal") {           // batal → stok dikembalikan
      for (const it of o.items) {
        const prod = db.products.find(x => x.id === it.id);
        if (prod) { prod.stok += it.qty; addLog(prod, it.qty, "pesanan batal", o.kode); }
      }
      o.status = "batal";
      db.kas = db.kas.filter(k => !(k.auto && k.ref === o.kode)); // batalkan pemasukannya juga
      const bk = o.booking && db.bookings.find(x => x.kode === o.booking);
      if (bk && bk.nota === o.kode) { bk.status = "baru"; bk.nota = ""; } // booking bisa dibuatkan nota ulang
    } else return fail(res, 400, "Status tidak valid.");
    save(db);
    return send(res, 200, o);
  }

  if ((mm = p.match(/^\/api\/admin\/bookings\/([\w-]+)$/)) && m === "POST") {
    const bk = db.bookings.find(x => x.kode === mm[1]);
    if (!bk) return fail(res, 404, "Booking tidak ditemukan.");
    const b = await readBody(req);
    if (bk.status === "selesai") return fail(res, 409, "Booking sudah selesai. Batalkan notanya lewat menu Pesanan kalau salah.");
    if (!["baru", "dikerjakan", "batal"].includes(b.status)) return fail(res, 400, "Status tidak valid.");
    bk.status = b.status;
    save(db);
    return send(res, 200, bk);
  }

  // ---- daftar jasa servis ----
  const parseJasa = b => {
    const nm = str(b.nm, 80);
    if (!nm) return { error: "Nama jasa wajib diisi." };
    const harga = [];
    for (const v of (Array.isArray(b.harga) ? b.harga : []).slice(0, 3).concat([null, null, null]).slice(0, 3)) {
      if (v === null || v === "" || v === undefined) { harga.push(null); continue; }
      const n = int(v);
      if (!(n >= 0) || n > 1e9) return { error: `Harga "${nm}" tidak valid.` };
      harga.push(n);
    }
    if (harga.every(h => h === null)) return { error: "Isi minimal satu harga (matic, bebek, atau sport)." };
    return { nm, harga };
  };
  if (m === "POST" && p === "/api/admin/services") {
    const v = parseJasa(await readBody(req));
    if (v.error) return fail(res, 400, v.error);
    if (db.services.some(x => x.nm.toLowerCase() === v.nm.toLowerCase())) return fail(res, 409, "Jasa dengan nama itu sudah ada.");
    const max = db.services.reduce((a, x) => Math.max(a, parseInt(x.id.slice(1), 10) || 0), 0);
    const sv = { id: "s" + String(max + 1).padStart(2, "0"), ...v };
    db.services.push(sv);
    save(db);
    return send(res, 201, sv);
  }
  if ((mm = p.match(/^\/api\/admin\/services\/(s\d+)$/))) {
    const i = db.services.findIndex(x => x.id === mm[1]);
    if (i < 0) return fail(res, 404, "Jasa tidak ditemukan.");
    if (m === "PUT") {
      const v = parseJasa(await readBody(req));
      if (v.error) return fail(res, 400, v.error);
      if (db.services.some((x, j) => j !== i && x.nm.toLowerCase() === v.nm.toLowerCase())) return fail(res, 409, "Jasa dengan nama itu sudah ada.");
      Object.assign(db.services[i], v);
      save(db);
      return send(res, 200, db.services[i]);
    }
    if (m === "DELETE") { db.services.splice(i, 1); save(db); return send(res, 200, { ok: true }); }
    if (m === "POST") {                       // pindah urutan: {arah: -1 | 1}
      const b = await readBody(req), j = i + (int(b.arah) === -1 ? -1 : 1);
      if (j < 0 || j >= db.services.length) return send(res, 200, { ok: true });
      [db.services[i], db.services[j]] = [db.services[j], db.services[i]];
      save(db);
      return send(res, 200, { ok: true });
    }
  }

  // ---- pembukuan keuangan ----
  if (m === "GET" && p === "/api/admin/kas") {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const dari = re.test(url.searchParams.get("dari")) ? url.searchParams.get("dari") : localDate();
    const sampai = re.test(url.searchParams.get("sampai")) ? url.searchParams.get("sampai") : dari;
    const rows = db.kas.filter(k => k.tgl >= dari && k.tgl <= sampai)
      .sort((a, b) => (b.tgl + b.t).localeCompare(a.tgl + a.t));
    const sum = (arr) => arr.reduce((s, k) => s + k.jumlah, 0);
    const masuk = rows.filter(k => k.jenis === "masuk"), keluar = rows.filter(k => k.jenis === "keluar");
    const group = (arr, key) => Object.entries(arr.reduce((g, k) => ((g[k[key]] = (g[k[key]] || 0) + k.jumlah), g), {}))
      .map(([nama, jumlah]) => ({ nama, jumlah })).sort((a, b) => b.jumlah - a.jumlah);
    const harian = {};
    for (const k of rows) { const h = (harian[k.tgl] ||= { tgl: k.tgl, masuk: 0, keluar: 0 }); h[k.jenis] += k.jumlah; }
    const sebelum = db.kas.filter(k => k.tgl < dari);
    const saldoAwal = sum(sebelum.filter(k => k.jenis === "masuk")) - sum(sebelum.filter(k => k.jenis === "keluar"));
    const saldoTotal = sum(db.kas.filter(k => k.jenis === "masuk")) - sum(db.kas.filter(k => k.jenis === "keluar"));
    // ---- laba rugi: penjualan diakui saat uangnya tercatat di kas ----
    const LR = { omzetBerModal: 0, penjualanBarang: 0, modalBarang: 0, labaBarang: 0, jasa: 0, lain: 0, biayaOps: 0, pembelianStok: 0, tanpaModal: 0, manualBarang: 0 };
    const perBarang = {};
    const notaDihitung = new Set();
    for (const k of masuk) {
      const o = k.auto && db.orders.find(x => x.kode === k.ref);
      if (k.kategori === "Penjualan barang") {
        if (!o) { LR.penjualanBarang += k.jumlah; LR.manualBarang += k.jumlah; continue; }
        if (notaDihitung.has(o.kode)) continue;
        notaDihitung.add(o.kode);
        for (const i of o.items) {
          const omzet = (i.harga || 0) * i.qty;
          LR.penjualanBarang += omzet;
          const key = i.id;
          const g = (perBarang[key] ||= { id: i.id, nm: `${i.nm} ${i.ukuran}`.trim(), qty: 0, omzet: 0, modal: 0, laba: 0, tanpaModal: 0 });
          g.qty += i.qty; g.omzet += omzet;
          if (i.modal == null) { LR.tanpaModal += i.qty; g.tanpaModal += i.qty; continue; }
          LR.modalBarang += i.modal * i.qty; LR.omzetBerModal += omzet; g.modal += i.modal * i.qty; g.laba += omzet - i.modal * i.qty;
        }
      } else if (k.kategori === "Jasa servis") LR.jasa += k.jumlah;
      else LR.lain += k.jumlah;
    }
    for (const k of keluar) { if (k.kategori === "Pembelian stok") LR.pembelianStok += k.jumlah; else LR.biayaOps += k.jumlah; }
    LR.labaBarang = LR.omzetBerModal - LR.modalBarang;
    LR.labaKotor = LR.labaBarang + LR.jasa + LR.lain;
    LR.labaBersih = LR.labaKotor - LR.biayaOps;
    const produkTanpaModal = db.products.filter(x => x.aktif && x.modal == null).length;
    const nilaiStok = db.products.filter(x => x.aktif && x.modal != null).reduce((s, x) => s + x.stok * x.modal, 0);
    return send(res, 200, {
      dari, sampai, rows,
      labaRugi: { ...LR, produkTanpaModal, nilaiStok },
      perBarang: Object.values(perBarang).sort((a, b) => b.laba - a.laba || b.omzet - a.omzet),
      ringkas: { masuk: sum(masuk), keluar: sum(keluar), laba: sum(masuk) - sum(keluar), saldoAwal, saldoAkhir: saldoAwal + sum(masuk) - sum(keluar), saldoTotal },
      perKategoriMasuk: group(masuk, "kategori"), perKategoriKeluar: group(keluar, "kategori"), perMetode: group(masuk, "metode"),
      harian: Object.values(harian).sort((a, b) => a.tgl.localeCompare(b.tgl)),
      kategori: { masuk: KAT_MASUK, keluar: KAT_KELUAR },
    });
  }
  if (m === "POST" && p === "/api/admin/kas") {
    const b = await readBody(req);
    const jenis = b.jenis === "keluar" ? "keluar" : b.jenis === "masuk" ? "masuk" : null;
    if (!jenis) return fail(res, 400, "Pilih pemasukan atau pengeluaran.");
    const jumlah = int(b.jumlah);
    if (!(jumlah > 0) || jumlah > 1e10) return fail(res, 400, "Jumlah uang tidak valid.");
    const tgl = /^\d{4}-\d{2}-\d{2}$/.test(b.tgl) ? b.tgl : localDate();
    if (tgl > localDate()) return fail(res, 400, "Tanggal tidak boleh di masa depan.");
    const daftar = jenis === "masuk" ? KAT_MASUK : KAT_KELUAR;
    const kategori = daftar.includes(b.kategori) ? b.kategori : daftar[daftar.length - 1];
    const row = addKas({ jenis, kategori, ket: str(b.ket, 160), jumlah, metode: b.metode, tgl });
    save(db);
    return send(res, 201, row);
  }
  if ((mm = p.match(/^\/api\/admin\/kas\/(k\d+)$/)) && m === "DELETE") {
    const k = db.kas.find(x => x.id === mm[1]);
    if (!k) return fail(res, 404, "Catatan tidak ditemukan.");
    if (isNotaRef(k)) return fail(res, 409, "Catatan ini dari nota/pesanan. Batalkan lewat menu Pesanan.");
    db.kas = db.kas.filter(x => x !== k);
    save(db);
    return send(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/admin/password") {
    const b = await readBody(req);
    if (String(b.password || "").length < 4) return fail(res, 400, "Password minimal 4 karakter.");
    db.admin = hashPw(b.password);
    save(db);
    return send(res, 200, { ok: true });
  }

  return fail(res, 404, "Tidak ditemukan.");
}

/* ---------------- file statis ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json" };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel === "/admin") rel = "/admin.html";
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "Metode tidak didukung.");
    serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    fail(res, 400, e.message === "bad json" ? "Data tidak valid." : "Terjadi kesalahan di server.");
  }
}).listen(PORT, () => {
  console.log(`\n  Flydan Bengkel Motor berjalan`);
  console.log(`  Website pelanggan : http://localhost:${PORT}`);
  console.log(`  Halaman admin     : http://localhost:${PORT}/admin.html`);
  console.log(`  Data stok         : ${DB_FILE}\n`);
});
