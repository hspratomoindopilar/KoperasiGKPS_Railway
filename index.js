const express = require('express');
const cors = require('cors');
const pool = require('./db');
require('dotenv').config();
const multer = require('multer');
const path = require('path');
const session = require('express-session'); // 1. Tambah import ini

const app = express();
app.use(cors());
app.use(express.json());

// 1. HANYA BUKA AKSES UNTUK FOTO/ASET (IKLAN TETAP MUNCUL)
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use('/img', express.static(path.join(__dirname, 'public/img')));

app.use(session({
    secret: 'koperasi-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // Aktif 24 jam
    }
}));

// Paksa browser untuk selalu minta data terbaru ke server
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// --- BAGIAN ROUTING & PROTEKSI ---

// A. Akses Publik (Tanpa Login)
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

// B. Middleware Proteksi
const cekSesi = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login.html');
    }
};

// C. Rute Utama (localhost:3000)
app.get('/', (req, res) => {
    if (req.session.userId) {
        // Otomatis lempar sesuai role
        return res.redirect(req.session.role === 'admin' ? '/index.html' : '/anggota.html');
    }
    res.redirect('/login.html');
});

// D. Lindungi Halaman Private (File fisik .html)
app.get('/index.html', cekSesi, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/anggota.html', cekSesi, (req, res) => res.sendFile(path.join(__dirname, 'public', 'anggota.html')));

// E. Jalur Tambahan (Opsional biar URL keren tanpa .html)
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/profil', cekSesi, (req, res) => res.sendFile(path.join(__dirname, 'public', 'anggota.html')));
// Rute untuk ambil data user yang sedang login
app.get('/api/auth/me', (req, res) => {
    if (req.session && req.session.userId) {
        res.json(req.session.user);
    } else {
        res.status(401).json({ error: 'Tidak ada sesi login' });
    }
});

// --- SETUP MULTER START ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, 'logo-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// 1. CEK KONEKSI
pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('Gagal konek database:', err.message);
    else console.log('Koneksi PostgreSQL Berhasil!');
});

// 2. TAMBAH ANGGOTA (REGISTRASI)
app.post('/tambah-anggota', async (req, res) => {
    try {
        // Ambil aturan nominal dari database
        const config = await getGlobalConfig();
        const NOMINAL_WAJIB = config ? config.iuran_wajib : 20000;
        const BIAYA_DAFTAR = config ? (config.biaya_pendaftaran || 100000) : 100000;

        const {
            nama_lengkap, alamat, no_hp, tgl_bergabung, nik,
            jenis_kelamin, pekerjaan, ttl, iuran_sukarela
        } = req.body;

        // Validasi Tanggal
        const date = tgl_bergabung ? new Date(tgl_bergabung) : new Date();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yy = String(date.getFullYear()).substring(2);
        const prefix = mm + yy;

        // Cari anggota dengan ID (primary key) terakhir untuk ambil nomor urutnya
        const lastMember = await pool.query("SELECT no_anggota FROM anggota ORDER BY id_anggota DESC LIMIT 1");

        let nextSequence = 1; // Default kalau database masih kosong

        if (lastMember.rows.length > 0) {
            const lastNo = lastMember.rows[0].no_anggota; // Contoh: "0226076"
            // Ambil 3 digit terakhir (076), ubah jadi angka, lalu tambah 1
            const lastSeq = parseInt(lastNo.substring(lastNo.length - 3));
            nextSequence = lastSeq + 1;
        }

        const urutan = String(nextSequence).padStart(3, '0');
        let no_anggota = prefix + urutan;
        // -----------------------------------------

        // Simpan Data Anggota
        const newMember = await pool.query(
            "INSERT INTO anggota (no_anggota, nama_lengkap, alamat, no_hp, tgl_bergabung, nik, jenis_kelamin, pekerjaan, ttl) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id_anggota",
            [no_anggota, nama_lengkap, alamat, no_hp, date, nik, jenis_kelamin, pekerjaan, ttl]
        );

        const id_baru = newMember.rows[0].id_anggota;
        const bln = date.getMonth() + 1;
        const thn = date.getFullYear();

        // --- SIMPAN TRANSAKSI OTOMATIS ---

        // 1. Simpan Biaya Pendaftaran
        await pool.query(
            "INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, status_verifikasi, bulan_iuran, tahun_iuran, created_at) VALUES ($1, 'pendaftaran', $2, 'Biaya Pendaftaran', true, $3, $4, NOW())",
            [id_baru, BIAYA_DAFTAR, bln, thn]
        );

        // 2. Simpan Iuran Wajib (Otomatis 20rb dari DB)
        await pool.query(
            "INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, status_verifikasi, bulan_iuran, tahun_iuran, created_at) VALUES ($1, 'wajib', $2, 'Setoran awal', true, $3, $4, NOW())",
            [id_baru, NOMINAL_WAJIB, bln, thn]
        );

        // 3. Simpan Iuran Sukarela (Jika ada input)
        const sukarela = parseFloat(iuran_sukarela) || 0;
        if (sukarela > 0) {
            await pool.query(
                "INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, status_verifikasi, bulan_iuran, tahun_iuran, created_at) VALUES ($1, 'sukarela', $2, 'Setoran awal', true, $3, $4, NOW())",
                [id_baru, sukarela, bln, thn]
            );
        }

        res.json({ success: true, message: "Berhasil!", no_anggota });

    } catch (err) {
        console.error("Error Tambah Anggota:", err.message);
        res.status(500).json({ success: false, message: "Gagal: " + err.message });
    }
});
// 3. DAFTAR ANGGOTA (DENGAN TOTAL SALDO)
app.get('/daftar-anggota', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                a.*, 
                -- 1. TOTAL SIMPANAN (Bersih: Pendaftaran dibuang, Penarikan dihitung)
                -- Nama field tetap 'total_simpanan' supaya sinkron dengan showDetail lu
                COALESCE((
                    SELECT SUM(jumlah_bayar) 
                    FROM transaksi 
                    WHERE id_anggota = a.id_anggota 
                    AND jenis_iuran IN ('wajib', 'sukarela', 'tarik_simpanan')
                ), 0) as total_simpanan,
                
                -- 2. KHUSUS WAJIB (Untuk hitung tunggakan di frontend)
                COALESCE((
                    SELECT SUM(jumlah_bayar) 
                    FROM transaksi 
                    WHERE id_anggota = a.id_anggota AND jenis_iuran = 'wajib'
                ), 0) as total_simpanan_wajib_saja,
                
                -- 3. JUMLAH BARIS WAJIB (Untuk label 'X Bulan')
                (SELECT COUNT(*) FROM transaksi WHERE id_anggota = a.id_anggota AND jenis_iuran = 'wajib') as total_lunas_wajib,
                
                -- 4. CEK PINJAMAN AKTIF
                (SELECT id FROM pinjaman WHERE id_anggota = a.id_anggota AND status != 'lunas' LIMIT 1) as id_pinjaman
            FROM anggota a 
            ORDER BY a.id_anggota DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error("Error Daftar Anggota:", err.message);
        res.status(500).json({ message: "Gagal ambil daftar anggota" });
    }
});
// 4. RIWAYAT (DENGAN TGL INPUT)
app.get('/riwayat-iuran/:id_anggota', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM transaksi WHERE id_anggota = $1 ORDER BY created_at DESC", [req.params.id_anggota]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ message: "Gagal" }); }
});

// 5. TAMBAH IURAN BULK (SUDAH KONEK GLOBAL CONFIG)
app.post('/tambah-iuran-bulk', async (req, res) => {
    try {
        // 1. Ambil config terbaru dari Database
        const config = await getGlobalConfig();
        const NOMINAL_WAJIB_DB = config ? config.iuran_wajib : 20000;

        const { id_anggota, jenis_iuran, jumlah_per_bulan, bulan_mulai, tahun_mulai, total_bulan } = req.body;

        let bln = parseInt(bulan_mulai);
        let thn = parseInt(tahun_mulai);
        let jumlahBayarFinal = parseFloat(jumlah_per_bulan);

        // 2. LOGIKA PROTEKSI: Jika iuran WAJIB, paksa pakai angka dari DB
        if (jenis_iuran === 'wajib') {
            jumlahBayarFinal = NOMINAL_WAJIB_DB;
        }

        // 3. Eksekusi Loop Input ke Database
        for (let i = 0; i < total_bulan; i++) {
            if (bln > 12) {
                bln = 1;
                thn++;
            }

            await pool.query(
                `INSERT INTO transaksi (
                    id_anggota, jenis_iuran, jumlah_bayar, keterangan, 
                    status_verifikasi, bulan_iuran, tahun_iuran, created_at
                ) VALUES ($1, $2, $3, $4, true, $5, $6, NOW())`,
                [
                    id_anggota,
                    jenis_iuran,
                    jumlahBayarFinal,
                    `Iuran ${jenis_iuran} (Bulk)`,
                    bln,
                    thn
                ]
            );
            bln++;
        }

        res.json({
            success: true,
            message: `Berhasil input ${total_bulan} bulan iuran ${jenis_iuran} dengan nominal Rp${jumlahBayarFinal.toLocaleString('id-ID')}`
        });

    } catch (err) {
        console.error("Error Bulk Iuran:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. LAPORAN & UPDATE/HAPUS
app.get('/laporan-kas', async (req, res) => {
    try {
        const query = `
            SELECT 
                jenis_iuran, 
                SUM(jumlah_bayar) as total 
            FROM transaksi 
            WHERE jenis_iuran IN ('wajib', 'sukarela', 'pokok', 'pendaftaran', 'admin_pinjaman','angsuran_pokok','pendapatan_bunga','tarik_simpanan')
            GROUP BY jenis_iuran
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: "Gagal ambil laporan kas" });
    }
});

app.post('/update-anggota', async (req, res) => {
    try {
        // Ambil data dari frontend (termasuk potongan tempat dan tgl lahir)
        const {
            no_anggota, nama_lengkap, nik, no_hp, pekerjaan,
            alamat, jenis_kelamin, tgl_bergabung,
            edit_tempat, edit_tgl_lahir
        } = req.body;

        // Kita gabungkan di sini biar formatnya tetap "Jakarta, 1990-05-20" di kolom ttl
        const ttlGabungan = `${edit_tempat}, ${edit_tgl_lahir}`;

        await pool.query(
            `UPDATE anggota SET 
                nama_lengkap=$1, nik=$2, no_hp=$3, pekerjaan=$4, 
                alamat=$5, ttl=$6, jenis_kelamin=$7, tgl_bergabung=$8 
             WHERE no_anggota=$9`,
            [nama_lengkap, nik, no_hp, pekerjaan, alamat, ttlGabungan, jenis_kelamin, tgl_bergabung, no_anggota]
        );

        res.json({ message: "Update data berhasil!" });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: "Gagal update: " + err.message });
    }
});

app.delete('/hapus-anggota/:no_anggota', async (req, res) => {
    try {
        const { no_anggota } = req.params;
        // 1. Cari ID-nya dulu
        const member = await pool.query("SELECT id_anggota FROM anggota WHERE no_anggota = $1", [no_anggota]);

        if (member.rows.length === 0) {
            return res.status(404).json({ message: "Anggota tidak ditemukan" });
        }

        const id_anggota = member.rows[0].id_anggota;

        // 2. Hapus transaksi (iuran) dulu karena ada Foreign Key
        await pool.query("DELETE FROM transaksi WHERE id_anggota = $1", [id_anggota]);

        // 3. Baru hapus anggotanya
        await pool.query("DELETE FROM anggota WHERE no_anggota = $1", [no_anggota]);

        res.json({ message: "Berhasil dihapus dari database" });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: "Gagal menghapus data" });
    }
});
// GANTI BAGIAN INI DI index.js LU
app.get('/api/laporan-transaksi', async (req, res) => {
    try {
        const tahunSekarang = new Date().getFullYear();
        const targetTahun = req.query.tahun || tahunSekarang;

        // 1. Ambil Config terbaru biar laporan tahu aturan nominal sekarang
        const config = await getGlobalConfig();

        // 2. Ambil Data Transaksi
        const result = await pool.query(`
            SELECT t.*, a.nama_lengkap, a.no_anggota, a.tgl_bergabung
            FROM transaksi t 
            LEFT JOIN anggota a ON t.id_anggota = a.id_anggota 
            WHERE t.tahun_iuran = $1
            ORDER BY t.bulan_iuran ASC, t.created_at DESC
        `, [targetTahun]);

        // 3. Kirim Paket Lengkap: Data Transaksi + Aturan Config
        res.json({
            config: config, // Isinya { iuran_wajib: 20000, ... }
            transaksi: result.rows
        });

    } catch (err) {
        console.error("Error di laporan-transaksi:", err.message);
        res.status(500).json({ message: "Gagal memuat data transaksi" });
    }
});
app.post('/api/pinjaman', async (req, res) => {
    const client = await pool.connect();
    try {
        const { id_anggota, nominal_pokok, tenor, bunga_persen } = req.body;
        await client.query('BEGIN');

        // 1. Cek Pinjaman Aktif
        const cek = await client.query("SELECT id FROM pinjaman WHERE id_anggota = $1 AND status != 'lunas'", [id_anggota]);
        if (cek.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: "Anggota masih punya pinjaman aktif!" });
        }

        // 2. Ambil Config Admin (Sesuai tabel pengaturan lu: biaya_admin_pinjaman)
        const config = await getGlobalConfig();
        const nominalAdmin = config ? (parseFloat(config['biaya_admin_pinjaman']) || 0) : 0;

        // 3. Simpan Pinjaman Utama
        const resPinjam = await client.query(
            `INSERT INTO pinjaman (id_anggota, nominal_pokok, tenor, bunga_persen, biaya_admin) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [id_anggota, nominal_pokok, tenor, bunga_persen, nominalAdmin]
        );
        const idPinjaman = resPinjam.rows[0].id;

        // --- GENERATE JADWAL ANGSURAN (MODEL BUNGA MENURUN) ---
        const pokokPerBulan = Math.floor(nominal_pokok / tenor);
        let sisaPinjaman = nominal_pokok; // Kita mulai dari saldo awal

        for (let i = 1; i <= tenor; i++) {
            // Bunga dihitung dari sisa pinjaman (Bukan dari total awal)
            const bungaBulanIni = Math.floor(sisaPinjaman * (bunga_persen / 100));
            const totalTagihan = pokokPerBulan + bungaBulanIni;

            await client.query(
                `INSERT INTO jadwal_angsuran (id_pinjaman, angsuran_ke, pokok_rp, bunga_rp, total_rp, status) 
                VALUES ($1, $2, $3, $4, $5, 'belum_bayar')`,
                [idPinjaman, i, pokokPerBulan, bungaBulanIni, totalTagihan]
            );

            // Update sisa pinjaman buat itungan bulan depan
            sisaPinjaman -= pokokPerBulan;
        }
        // 5. Catat Admin ke Kas (Biar log GAK null/null lagi)
        const now = new Date();
        await client.query(
            `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, bulan_iuran, tahun_iuran) 
             VALUES ($1, 'admin_pinjaman', $2, $3, $4, $5)`,
            [id_anggota, nominalAdmin, `Biaya Admin Pinjaman (ID: ${idPinjaman})`, now.getMonth() + 1, now.getFullYear()]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "🔥 Mantap! Pinjaman & Jadwal Berhasil Dibuat." });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Gagal Simpan:", err.message);
        res.status(500).json({ success: false, message: "Gagal: " + err.message });
    } finally {
        client.release();
    }
});
// API UNTUK MENGAMBIL DAFTAR PINJAMAN
app.get('/api/daftar-pinjaman', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                p.*, 
                a.nama_lengkap, 
                a.no_anggota 
            FROM pinjaman p
            JOIN anggota a ON p.id_anggota = a.id_anggota
            ORDER BY p.tanggal_pinjam DESC
        `);

        res.json(result.rows);
    } catch (err) {
        console.error("Error ambil daftar pinjaman:", err.message);
        res.status(500).json({ message: "Gagal mengambil data pinjaman" });
    }
});

app.post('/api/bayar-angsuran', async (req, res) => {
    const client = await pool.connect(); // Pake client buat transaksi SQL
    try {
        const { id_jadwal } = req.body;

        await client.query('BEGIN'); // Mulai transaksi

        // 1. Ambil data jadwalnya dulu
        const infoJadwal = await client.query(
            `SELECT j.*, p.id_anggota 
             FROM jadwal_angsuran j 
             JOIN pinjaman p ON j.id_pinjaman = p.id 
             WHERE j.id_jadwal = $1`, [id_jadwal]
        );

        if (infoJadwal.rows.length === 0) throw new Error("Jadwal tidak ditemukan");
        const data = infoJadwal.rows[0];

        if (data.status === 'lunas') throw new Error("Angsuran ini sudah lunas!");

        // 2. UPDATE status di jadwal_angsuran
        await client.query(
            "UPDATE jadwal_angsuran SET status = 'lunas', tgl_bayar = NOW() WHERE id_jadwal = $1",
            [id_jadwal]
        );

        const now = new Date();
        const bulan = now.getMonth() + 1;
        const tahun = now.getFullYear();

        // 3. INSERT Transaksi POKOK
        await client.query(
            `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, bulan_iuran, tahun_iuran) 
             VALUES ($1, 'angsuran_pokok', $2, $3, $4, $5)`,
            [data.id_anggota, data.pokok_rp, `Angsuran Pokok ke-${data.angsuran_ke} (No: ${data.no_angsuran})`, bulan, tahun]
        );

        // 4. INSERT Transaksi BUNGA
        await client.query(
            `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, bulan_iuran, tahun_iuran) 
             VALUES ($1, 'pendapatan_bunga', $2, $3, $4, $5)`,
            [data.id_anggota, data.bunga_rp, `Bunga Angsuran ke-${data.angsuran_ke} (No: ${data.no_angsuran})`, bulan, tahun]
        );

        await client.query('COMMIT'); // Eksekusi semua!
        res.json({ success: true, message: "Pembayaran Pokok & Bunga berhasil dicatat!" });

    } catch (err) {
        await client.query('ROLLBACK'); // Batalin semua kalau ada error
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// Endpoint untuk mengambil jadwal angsuran berdasarkan ID Pinjaman
app.get('/api/jadwal-angsuran/:id_pinjaman', async (req, res) => {
    try {
        const { id_pinjaman } = req.params;

        // Query untuk ambil jadwal, diurutkan dari angsuran ke-1
        const result = await pool.query(
            `SELECT * FROM jadwal_angsuran 
             WHERE id_pinjaman = $1 
             ORDER BY angsuran_ke ASC`,
            [id_pinjaman]
        );

        // Kirim datanya ke frontend
        res.json(result.rows);
    } catch (err) {
        console.error("Error Get Jadwal:", err.message);
        res.status(500).json({ success: false, message: "Gagal mengambil jadwal" });
    }
});

async function getGlobalConfig() {
    try {
        const res = await pool.query('SELECT nama_key, nilai_nominal FROM pengaturan');
        const config = {};

        res.rows.forEach(row => {
            const key = row.nama_key;
            const val = row.nilai_nominal;

            // Logika baru: Cek apakah key ini termasuk kategori nominal/angka
            const isNumericKey = [
                'iuran_wajib',
                'biaya_admin_pinjaman',
                'biaya_pendaftaran',
                'saldo_awal'
            ].includes(key);

            if (isNumericKey) {
                // Jika key-nya adalah pengaturan keuangan, ubah ke angka float
                config[key] = parseFloat(val) || 0;
            } else {
                // Jika key-nya adalah nama_koperasi atau logo_url, biarkan jadi teks murni
                config[key] = val;
            }
        });

        return config;
    } catch (err) {
        console.error('Gagal mengambil config:', err);
        return null;
    }
}
// Pakai fungsi getGlobalConfig yang tadi kita bahas
app.get('/api/config', async (req, res) => {
    try {
        const config = await getGlobalConfig();
        if (!config) {
            return res.status(500).json({ message: "Gagal mengambil konfigurasi" });
        }
        res.json(config);
    } catch (err) {
        console.error("Error di route /api/config:", err.message);
        res.status(500).json({ message: "Server Error" });
    }
});

// Route baru untuk handle upload logo + update data teks sekaligus
app.post('/api/config/update-full', upload.single('logo_file'), async (req, res) => {
    try {
        const bodyData = req.body;

        // 1. Jika ada file logo baru yang diupload, masukkan ke database
        if (req.file) {
            const logoPath = `/uploads/${req.file.filename}`;
            await pool.query("UPDATE pengaturan SET nilai_nominal = $1 WHERE nama_key = 'logo_url'", [logoPath]);
        }

        // 2. Update data lainnya (nama, iuran, dll) satu per satu
        for (const [key, value] of Object.entries(bodyData)) {
            // Kita filter agar tidak mencoba update 'logo_file' ke kolom nilai_nominal
            if (key !== 'logo_file') {
                await pool.query(
                    "UPDATE pengaturan SET nilai_nominal = $1 WHERE nama_key = $2",
                    [value, key]
                );
            }
        }

        res.json({ message: "Berhasil update konfigurasi" });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: "Gagal update" });
    }
});

// API RIWAYAT PINJAMAN (Daftar Semua Pinjaman Anggota)
// ==========================================
app.get('/api/riwayat-pinjaman/:id_anggota', async (req, res) => {
    const { id_anggota } = req.params;
    // VALIDASI: Pastikan id yang diminta sama dengan id di session (Kecuali Admin)
    if (!req.session.userId || (req.session.userId != id_anggota && req.session.role !== 'admin')) {
        return res.status(403).json({ error: "Akses ditolak!" });
    }
    try {
        const query = `
            SELECT 
                p.id AS id_pinjaman,
                TO_CHAR(p.tanggal_pinjam, 'DD-MM-YYYY') AS tgl_pinjam_teks,
                p.nominal_pokok,
                p.tenor,
                p.status AS status_pinjaman,
                -- Hitung berapa kali sudah bayar (Lunas)
                (SELECT COUNT(*) FROM jadwal_angsuran WHERE id_pinjaman = p.id AND status = 'lunas') AS angsuran_masuk,
                -- Hitung total pokok yang sudah dibayar
                COALESCE((SELECT SUM(pokok_rp) FROM jadwal_angsuran WHERE id_pinjaman = p.id AND status = 'lunas'), 0) AS total_pokok_terbayar,
                -- Hitung sisa utang pokok
                (p.nominal_pokok - COALESCE((SELECT SUM(pokok_rp) FROM jadwal_angsuran WHERE id_pinjaman = p.id AND status = 'lunas'), 0)) AS sisa_utang
            FROM pinjaman p
            WHERE p.id_anggota = $1
            ORDER BY p.tanggal_pinjam DESC;
        `;

        const result = await pool.query(query, [id_anggota]);

        // Kirim datanya ke frontend
        res.status(200).json(result.rows);

    } catch (err) {
        console.error("Error Riwayat Pinjaman:", err.message);
        res.status(500).json({ error: "Gagal mengambil data riwayat." });
    }
});

app.get('/api/pengeluaran', async (req, res) => {
    try {
        const { bulan, tahun } = req.query;
        let query = "SELECT * FROM pengeluaran WHERE 1=1";
        let params = [];

        // Filter Tahun (Misal: 2026)
        if (tahun && tahun !== 'all') {
            params.push(tahun);
            query += ` AND EXTRACT(YEAR FROM tanggal) = $${params.length}`;
        }

        // Filter Bulan (Misal: 02 untuk Februari)
        if (bulan && bulan !== 'all') {
            params.push(bulan);
            query += ` AND EXTRACT(MONTH FROM tanggal) = $${params.length}`;
        }

        query += " ORDER BY tanggal DESC";

        const result = await pool.query(query, params);
        res.json({ status: 'success', data: result.rows });
    } catch (err) {
        console.error("Error API BKU:", err.message);
        res.status(500).json({ status: 'error', message: 'Gagal mengambil data' });
    }
});

app.post('/api/pengeluaran', async (req, res) => {
    const { kategori, keterangan, nominal, admin_input } = req.body;

    try {
        // Query Insert: tanggal otomatis pakai CURRENT_DATE supaya seragam
        const query = `
            INSERT INTO pengeluaran (tanggal, kategori, keterangan, nominal, admin_input) 
            VALUES (CURRENT_DATE, $1, $2, $3, $4) 
            RETURNING *`;

        const values = [
            kategori.toUpperCase(), // Paksa uppercase biar database rapi
            keterangan,
            nominal,
            admin_input
        ];

        const result = await pool.query(query, values);

        res.status(200).json({
            status: 'success',
            message: 'Data pengeluaran berhasil dicatat',
            data: result.rows[0]
        });
    } catch (err) {
        console.error("Error Simpan BKU:", err.message);
        res.status(500).json({
            status: 'error',
            message: 'Gagal simpan ke database'
        });
    }
});

app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const config = await getGlobalConfig();
        const saldoAwal = parseFloat(config.saldo_awal || 0);

        // 2. Hitung Total Pemasukan Murni (Hanya yang angkanya positif)
        const masukRes = await pool.query("SELECT SUM(jumlah_bayar) as total FROM transaksi WHERE jumlah_bayar > 0");
        const totalMasuk = parseFloat(masukRes.rows[0].total || 0);

        // 2b. Hitung Khusus Tarik Simpanan (Yang angkanya negatif)
        const tarikRes = await pool.query("SELECT SUM(ABS(jumlah_bayar)) as total FROM transaksi WHERE jumlah_bayar < 0");
        const totalTarikSimpanan = parseFloat(tarikRes.rows[0].total || 0);

        // 3. Total Pengeluaran Operasional
        const keluarRes = await pool.query('SELECT SUM(nominal) as total FROM pengeluaran');
        const totalKeluarOps = parseFloat(keluarRes.rows[0].total || 0);

        // 4. Total Pencairan Pinjaman
        const pinjamanRes = await pool.query('SELECT SUM(nominal_pokok) as total FROM pinjaman');
        const totalPinjaman = parseFloat(pinjamanRes.rows[0].total || 0);

        // 5. Total Pengeluaran Kumulatif (Sekarang ditambah Tarik Simpanan)
        const totalPengeluaranKumulatif = totalKeluarOps + totalPinjaman + totalTarikSimpanan;

        // 6. Saldo Kas Akhir (Rumus Sakti yang sudah diupdate)
        const saldoAkhir = (saldoAwal + totalMasuk) - totalPengeluaranKumulatif;

        res.json({
            saldo_awal: saldoAwal,
            total_pemasukan: totalMasuk,
            total_pengeluaran_ops: totalKeluarOps,
            total_pinjaman_cair: totalPinjaman,
            total_tarik_simpanan: totalTarikSimpanan, // Data baru buat card baru
            total_pengeluaran_kumulatif: totalPengeluaranKumulatif,
            saldo_akhir_kas: saldoAkhir
        });

    } catch (err) {
        console.error("Error Dashboard API:", err.message);
        res.status(500).json({ message: "Gagal memuat ringkasan dashboard" });
    }
});

// ENDPOINT UNTUK LAPORAN ARUS KAS PERIODE
app.get('/api/laporan-periode', async (req, res) => {
    const { bulan, tahun } = req.query;
    const startDate = `${tahun}-${bulan}-01`;

    try {
        const config = await getGlobalConfig();
        const saldoAwalConfig = parseFloat(config.saldo_awal || 0);

        // 1. HITUNG SALDO AWAL PERIODE (Data akumulasi sebelum bulan ini)
        // SUM(jumlah_bayar) otomatis menghitung (Masuk - Tarik) karena penarikan nilainya minus
        const saMasuk = await pool.query("SELECT SUM(jumlah_bayar) as total FROM transaksi WHERE (tahun_iuran < $1) OR (tahun_iuran = $1 AND bulan_iuran < $2)", [tahun, bulan]);
        const saKeluarOps = await pool.query("SELECT SUM(nominal) as total FROM pengeluaran WHERE tanggal < $1", [startDate]);
        const saPinjaman = await pool.query("SELECT SUM(nominal_pokok) as total FROM pinjaman WHERE tanggal_pinjam < $1", [startDate]);

        const saldoAwalPeriode = saldoAwalConfig +
            parseFloat(saMasuk.rows[0].total || 0) -
            (parseFloat(saKeluarOps.rows[0].total || 0) + parseFloat(saPinjaman.rows[0].total || 0));

        // 2. AMBIL DETAIL TRANSAKSI (Iuran & Tarik Simpanan)
        const mMasuk = await pool.query(`
            SELECT created_at as tanggal, 
                   CONCAT(UPPER(jenis_iuran), ' - ', (SELECT nama_lengkap FROM anggota WHERE id_anggota = transaksi.id_anggota)) as ket,
                   jumlah_bayar as nominal_asli
            FROM transaksi 
            WHERE bulan_iuran = $1 AND tahun_iuran = $2
        `, [bulan, tahun]);

        // Proses mMasuk: Pisahkan mana yang murni MASUK dan mana yang KELUAR (Penarikan)
        const transaksiDiproses = mMasuk.rows.map(t => {
            const nominal = parseFloat(t.nominal_asli || 0);
            return {
                tanggal: t.tanggal,
                ket: t.ket,
                masuk: nominal > 0 ? nominal : 0,           // Jika positif masuk kolom masuk
                keluar: nominal < 0 ? Math.abs(nominal) : 0 // Jika negatif (tarik), masuk kolom keluar sebagai angka positif
            };
        });

        // 3. AMBIL DETAIL PENGELUARAN (OPERASIONAL)
        const mKeluarOps = await pool.query(`
            SELECT tanggal, 
                   keterangan as ket, 
                   0 as masuk, 
                   nominal as keluar
            FROM pengeluaran 
            WHERE EXTRACT(MONTH FROM tanggal) = $1 AND EXTRACT(YEAR FROM tanggal) = $2
        `, [bulan, tahun]);

        // 4. AMBIL DETAIL PENGELUARAN (PINJAMAN CAIR)
        const mKeluarPinj = await pool.query(`
            SELECT tanggal_pinjam as tanggal, 
                   CONCAT('PENCAIRAN PINJAMAN - ', (SELECT nama_lengkap FROM anggota WHERE id_anggota = pinjaman.id_anggota)) as ket,
                   0 as masuk, nominal_pokok as keluar
            FROM pinjaman 
            WHERE EXTRACT(MONTH FROM tanggal_pinjam) = $1 AND EXTRACT(YEAR FROM tanggal_pinjam) = $2
        `, [bulan, tahun]);

        // GABUNGKAN SEMUA & URUTKAN BERDASARKAN TANGGAL
        const rincian = [...transaksiDiproses, ...mKeluarOps.rows, ...mKeluarPinj.rows]
            .sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));

        // HITUNG TOTAL RINGKASAN
        const totalMasukBulanIni = transaksiDiproses.reduce((sum, item) => sum + item.masuk, 0);
        const totalKeluarBulanIni =
            transaksiDiproses.reduce((sum, item) => sum + item.keluar, 0) + // Termasuk Tarik Simpanan
            mKeluarOps.rows.reduce((sum, item) => sum + parseFloat(item.keluar), 0) +
            mKeluarPinj.rows.reduce((sum, item) => sum + parseFloat(item.keluar), 0);

        res.json({
            status: 'success',
            data: {
                saldo_awal: saldoAwalPeriode,
                pemasukan: totalMasukBulanIni,
                pengeluaran: totalKeluarBulanIni,
                saldo_akhir: saldoAwalPeriode + totalMasukBulanIni - totalKeluarBulanIni,
                list_transaksi: rincian
            }
        });
    } catch (err) {
        console.error("Error Laporan Periode:", err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// API LOGIN KHUSUS ANGGOTA
// --- 1. ENDPOINT LOGIN (Pintu Masuk) ---
app.post('/api/login-anggota', async (req, res) => {
    const { no_anggota, pin_anggota } = req.body;

    try {
        const query = "SELECT id_anggota, nama_lengkap, role, tgl_bergabung FROM anggota WHERE no_anggota = $1 AND pin_anggota = $2";
        const result = await pool.query(query, [no_anggota, pin_anggota]);

        if (result.rows.length > 0) {
            const user = result.rows[0];

            // Simpan ke Session agar dikenal oleh endpoint lain
            req.session.userId = user.id_anggota;
            req.session.role = user.role;
            req.session.nama = user.nama_lengkap;

            req.session.user = {
                id_anggota: user.id_anggota,
                no_anggota: no_anggota, // Ambil dari input login
                nama_lengkap: user.nama_lengkap,
                role: user.role,
                tgl_bergabung: user.tgl_bergabung
            };

            res.json({
                success: true,
                data: req.session.user // Pakai data dari session saja biar sama
            });

        } else {
            res.status(401).json({ success: false, message: "Nomor Anggota atau PIN salah!" });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// --- 2. ENDPOINT CEK SESI (Pengecek saat halaman dibuka) ---
app.get('/api/cek-sesi-anggota', (req, res) => {
    if (req.session.userId) {
        res.json({ id_anggota: req.session.userId, role: req.session.role });
    } else {
        res.status(401).json({ message: "Belum login" });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Gagal logout' });
        }
        res.clearCookie('connect.sid'); // Bersihkan cookie session di browser
        res.json({ success: true, message: 'Berhasil logout' });
    });
});

// --- 3. ENDPOINT DETAIL (Otak Data & Keamanan) ---
app.get('/api/anggota-detail/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Proteksi: Anggota dilarang intip ID orang lain
        if (req.session.role === 'anggota' && req.session.userId != id) {
            return res.status(403).json({ message: "Akses ditolak!" });
        }

        const result = await pool.query(`
            SELECT 
                a.*, 
                COALESCE((SELECT SUM(jumlah_bayar) FROM transaksi WHERE id_anggota = a.id_anggota), 0) as total_simpanan,
                COALESCE((SELECT SUM(jumlah_bayar) FROM transaksi WHERE id_anggota = a.id_anggota AND jenis_iuran = 'wajib'), 0) as total_simpanan_wajib_saja,
                (SELECT COUNT(*) FROM transaksi WHERE id_anggota = a.id_anggota AND jenis_iuran = 'wajib') as total_lunas_wajib,
                (SELECT id FROM pinjaman WHERE id_anggota = a.id_anggota AND status != 'lunas' LIMIT 1) as id_pinjaman
            FROM anggota a 
            WHERE a.id_anggota = $1
        `, [id]);

        if (result.rows.length > 0) {
            res.json({
                ...result.rows[0],
                userRole: req.session.role // Beritahu frontend ini admin atau anggota
            });
        } else {
            res.status(404).json({ message: "Data tidak ditemukan" });
        }
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

function cekLogin(req, res, next) {
    if (req.session.userId) {
        next(); // Lanjut kalau ada session
    } else {
        res.redirect('/login'); // Mentalin ke login kalau nggak ada
    }
}

app.post('/api/update-password', async (req, res) => {
    // Ambil id_anggota dari express-session
    // Pastikan pas login lu sudah set: req.session.id_anggota = user.id_anggota;
    const userId = req.session.userId;
    const { newPassword } = req.body;

    // Proteksi: Jika tidak ada session, tendang
    if (!userId) {
        return res.status(401).json({
            success: false,
            message: 'Sesi login tidak ditemukan. Silakan login kembali.'
        });
    }

    try {
        // Update kolom pin_anggota berdasarkan id_anggota yang sedang login
        const query = 'UPDATE anggota SET pin_anggota = $1 WHERE id_anggota = $2';
        const result = await pool.query(query, [newPassword, userId]);

        if (result.rowCount > 0) {
            res.json({ success: true, message: 'Password/PIN berhasil diperbarui!' });
        } else {
            res.status(404).json({ success: false, message: 'Data anggota tidak ditemukan.' });
        }
        if (result.rowCount > 0) {
            // Opsional: Hapus session biar user login ulang dengan PIN baru
            req.session.destroy();
            res.json({ success: true, message: 'PIN berhasil diubah, silakan login kembali.' });
        }
    } catch (err) {
        console.error('Error update password:', err);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' });
    }
});

// F. Terakhir: Static Folder (Hanya untuk aset seperti CSS/JS/Gambar)
app.use(express.static('public'));

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});

