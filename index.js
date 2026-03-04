const express = require('express');
const cors = require('cors');
const pool = require('./db');
const { logActivity } = require('./logger');
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
    // Ambil no_anggota dari session (siapa yang lagi login/admin)
    const actorNo = req.session.no_anggota || 'SYSTEM'; 

    try {
        const config = await getGlobalConfig();
        const NOMINAL_WAJIB = config ? config.iuran_wajib : 20000;
        const BIAYA_DAFTAR = config ? (config.biaya_pendaftaran || 100000) : 100000;

        const { nama_lengkap, alamat, no_hp, tgl_bergabung, nik, jenis_kelamin, pekerjaan, ttl, iuran_sukarela } = req.body;

        const date = tgl_bergabung ? new Date(tgl_bergabung) : new Date();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yy = String(date.getFullYear()).substring(2);
        const prefix = mm + yy;

        const lastMember = await pool.query("SELECT no_anggota FROM anggota ORDER BY id_anggota DESC LIMIT 1");
        let nextSequence = 1;
        if (lastMember.rows.length > 0) {
            const lastNo = lastMember.rows[0].no_anggota;
            const lastSeq = parseInt(lastNo.substring(lastNo.length - 3));
            nextSequence = lastSeq + 1;
        }

        const urutan = String(nextSequence).padStart(3, '0');
        let no_anggota = prefix + urutan;

        // 1. SIMPAN DATA ANGGOTA
        const newMember = await pool.query(
            "INSERT INTO anggota (no_anggota, nama_lengkap, alamat, no_hp, tgl_bergabung, nik, jenis_kelamin, pekerjaan, ttl) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id_anggota",
            [no_anggota, nama_lengkap, alamat, no_hp, date, nik, jenis_kelamin, pekerjaan, ttl]
        );

        const id_baru = newMember.rows[0].id_anggota;
        
        // --- LOG: Anggota Baru ---
        await logActivity(actorNo, 'INSERT', 'anggota', id_baru, null, { no_anggota, nama_lengkap });

        const bln = date.getMonth() + 1;
        const thn = date.getFullYear();

        // 2. SIMPAN TRANSAKSI (Suntik log di sini juga)
        const transList = [
            { jenis: 'pendaftaran', jumlah: BIAYA_DAFTAR, ket: 'Biaya Pendaftaran' },
            { jenis: 'wajib', jumlah: NOMINAL_WAJIB, ket: 'Setoran awal' }
        ];

        if (parseFloat(iuran_sukarela) > 0) {
            transList.push({ jenis: 'sukarela', jumlah: parseFloat(iuran_sukarela), ket: 'Setoran awal' });
        }

        for (const item of transList) {
            const resTrans = await pool.query(
                "INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, status_verifikasi, bulan_iuran, tahun_iuran, created_at) VALUES ($1, $2, $3, $4, true, $5, $6, NOW()) RETURNING id_transaksi",
                [id_baru, item.jenis, item.jumlah, item.ket, bln, thn]
            );
            
            // --- LOG: Transaksi Otomatis ---
            await logActivity(actorNo, 'INSERT', 'transaksi', resTrans.rows[0].id_transaksi, null, { jenis: item.jenis, jumlah: item.jumlah });
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
                    AND jenis_iuran IN ('wajib', 'sukarela', 'dividen', 'tarik_simpanan')
                    AND keterangan != 'MIGRASI PENDAFTARAN'
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
    // Ambil siapa yang lagi login
    const actorNo = req.session.no_anggota || 'SYSTEM';

    try {
        const config = await getGlobalConfig();
        const NOMINAL_WAJIB_DB = config ? config.iuran_wajib : 20000;

        const { id_anggota, jenis_iuran, jumlah_per_bulan, bulan_mulai, tahun_mulai, total_bulan } = req.body;

        let bln = parseInt(bulan_mulai);
        let thn = parseInt(tahun_mulai);
        let jumlahBayarFinal = parseFloat(jumlah_per_bulan);

        if (jenis_iuran === 'wajib') {
            jumlahBayarFinal = NOMINAL_WAJIB_DB;
        }

        // Loop Input ke Database
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
                [id_anggota, jenis_iuran, jumlahBayarFinal, `Iuran ${jenis_iuran} (Bulk)`, bln, thn]
            );
            bln++;
        }

        // --- LOG: Simpan Ringkasan Aksi Bulk ---
        await logActivity(
            actorNo, 
            'INSERT', 
            'transaksi_bulk', 
            id_anggota, // Kita pakai ID Anggota sebagai target karena ini bulk
            null, 
            { 
                jenis_iuran, 
                total_bulan, 
                nominal_per_bulan: jumlahBayarFinal,
                periode_mulai: `${bulan_mulai}/${tahun_mulai}`
            }
        );

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
            AND NOT (jenis_iuran = 'pendaftaran' AND keterangan = 'MIGRASI PENDAFTARAN')
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
    const actorNo = req.session.no_anggota || 'SYSTEM';

    try {
        const {
            no_anggota, nama_lengkap, nik, no_hp, pekerjaan,
            alamat, jenis_kelamin, tgl_bergabung,
            edit_tempat, edit_tgl_lahir
        } = req.body;

        const ttlGabungan = `${edit_tempat}, ${edit_tgl_lahir}`;

        // --- 1. AMBIL DATA LAMA (SNAPSHOT) SEBELUM DI-UPDATE ---
        const oldDataQuery = await pool.query("SELECT * FROM anggota WHERE no_anggota = $1", [no_anggota]);
        const oldData = oldDataQuery.rows[0];

        // --- 2. EKSEKUSI UPDATE (LOGIKA ASLI LO) ---
        await pool.query(
            `UPDATE anggota SET 
                nama_lengkap=$1, nik=$2, no_hp=$3, pekerjaan=$4, 
                alamat=$5, ttl=$6, jenis_kelamin=$7, tgl_bergabung=$8 
             WHERE no_anggota=$9`,
            [nama_lengkap, nik, no_hp, pekerjaan, alamat, ttlGabungan, jenis_kelamin, tgl_bergabung, no_anggota]
        );

        // --- 3. SIMPAN KE LOG (COMPARE OLD VS NEW) ---
        await logActivity(
            actorNo, 
            'UPDATE', 
            'anggota', 
            null, // Kita pakai no_anggota di data, jadi target_id bisa kosong
            oldData, // Data sebelum diubah
            { nama_lengkap, nik, no_hp, pekerjaan, alamat, ttl: ttlGabungan, jenis_kelamin, tgl_bergabung } // Data sesudah diubah
        );

        res.json({ message: "Update data berhasil!" });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: "Gagal update: " + err.message });
    }
});

app.delete('/hapus-anggota/:no_anggota', async (req, res) => {
    const actorNo = req.session.no_anggota || 'SYSTEM';
    const client = await pool.connect(); // Kita pakai client supaya bisa pakai Transaction (BEGIN/COMMIT)

    try {
        const { no_anggota } = req.params;

        await client.query('BEGIN'); // Mulai proses "Satu paket"

        // 1. Cek & Ambil data anggota dulu
        const memberData = await client.query("SELECT * FROM anggota WHERE no_anggota = $1", [no_anggota]);
        if (memberData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Anggota tidak ditemukan" });
        }

        const dataLama = memberData.rows[0];
        const id_anggota = dataLama.id_anggota;

        // 2. HAPUS CUCU: Jadwal Angsuran
        // Kita hapus semua jadwal yang terhubung dengan pinjaman milik anggota ini
        await client.query(`
            DELETE FROM jadwal_angsuran 
            WHERE id_pinjaman IN (SELECT id FROM pinjaman WHERE id_anggota = $1)
        `, [id_anggota]);

        // 3. HAPUS ANAK: Pinjaman
        await client.query("DELETE FROM pinjaman WHERE id_anggota = $1", [id_anggota]);

        // 4. HAPUS KERABAT: Transaksi (Iuran, Pokok, Bunga, dll)
        // Ini yang bikin saldo kas lo balik (reset) ke kondisi awal
        await client.query("DELETE FROM transaksi WHERE id_anggota = $1", [id_anggota]);

        // 5. HAPUS BAPAK: Anggota
        await client.query("DELETE FROM anggota WHERE no_anggota = $1", [no_anggota]);

        // 6. LOG AKTIVITAS (Tetap catat siapa yang nge-reset data ini)
        await logActivity(
            actorNo, 
            'HARD_DELETE_RESET', 
            'anggota', 
            id_anggota, 
            dataLama, 
            null
        );

        await client.query('COMMIT'); // Selesaikan semua penghapusan
        res.json({ success: true, message: "Reset Berhasil! Anggota & seluruh riwayat kas terhapus." });

    } catch (err) {
        await client.query('ROLLBACK'); // Jika ada satu yang gagal, batalkan semua biar data nggak berantakan
        console.error("Gagal Reset Data:", err.message);
        res.status(500).json({ message: "Gagal reset: " + err.message });
    } finally {
        client.release(); // Kembalikan koneksi ke pool
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
    const actorNo = req.session.no_anggota || 'SYSTEM'; // Ambil siapa yang input
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

        // 2. Ambil Config Admin
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
        let sisaPinjaman = nominal_pokok;

        for (let i = 1; i <= tenor; i++) {
            const bungaBulanIni = Math.floor(sisaPinjaman * (bunga_persen / 100));
            const totalTagihan = pokokPerBulan + bungaBulanIni;

            await client.query(
                `INSERT INTO jadwal_angsuran (id_pinjaman, angsuran_ke, pokok_rp, bunga_rp, total_rp, status) 
                VALUES ($1, $2, $3, $4, $5, 'belum_bayar')`,
                [idPinjaman, i, pokokPerBulan, bungaBulanIni, totalTagihan]
            );
            sisaPinjaman -= pokokPerBulan;
        }

        // 5. Catat Admin ke Kas
        const now = new Date();
        await client.query(
            `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, bulan_iuran, tahun_iuran) 
             VALUES ($1, 'admin_pinjaman', $2, $3, $4, $5)`,
            [id_anggota, nominalAdmin, `Biaya Admin Pinjaman (ID: ${idPinjaman})`, now.getMonth() + 1, now.getFullYear()]
        );

        // --- LOG: Catat Aktivitas Pinjaman Baru ---
        // Kita taruh di dalam transaksi biar kalau log gagal, semua batal (opsional, tapi lebih aman)
        await logActivity(
            actorNo, 
            'INSERT', 
            'pinjaman', 
            idPinjaman, 
            null, 
            { id_anggota, nominal_pokok, tenor, bunga_persen, biaya_admin: nominalAdmin }
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
    const actorNo = req.session.no_anggota || 'SYSTEM'; // Siapa yang proses bayar
    const client = await pool.connect(); 
    
    try {
        const { id_jadwal } = req.body;

        await client.query('BEGIN'); 

        // 1. Ambil data jadwalnya dulu (Snapshot Data Sebelum Update)
        const infoJadwal = await client.query(
            `SELECT j.*, p.id_anggota 
             FROM jadwal_angsuran j 
             JOIN pinjaman p ON j.id_pinjaman = p.id 
             WHERE j.id_jadwal = $1`, [id_jadwal]
        );

        if (infoJadwal.rows.length === 0) throw new Error("Jadwal tidak ditemukan");
        const dataLama = infoJadwal.rows[0];

        if (dataLama.status === 'lunas') throw new Error("Angsuran ini sudah lunas!");

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
            [dataLama.id_anggota, dataLama.pokok_rp, `Angsuran Pokok ke-${dataLama.angsuran_ke} (No: ${dataLama.no_angsuran})`, bulan, tahun]
        );

        // 4. INSERT Transaksi BUNGA
        await client.query(
            `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, keterangan, bulan_iuran, tahun_iuran) 
             VALUES ($1, 'pendapatan_bunga', $2, $3, $4, $5)`,
            [dataLama.id_anggota, dataLama.bunga_rp, `Bunga Angsuran ke-${dataLama.angsuran_ke} (No: ${dataLama.no_angsuran})`, bulan, tahun]
        );

        // --- LOG: Catat Aktivitas Pembayaran ---
        await logActivity(
            actorNo, 
            'UPDATE', 
            'jadwal_angsuran', 
            id_jadwal, 
            { status: dataLama.status, tgl_bayar: dataLama.tgl_bayar }, // Status lama (belum_bayar)
            { 
                status: 'lunas', 
                id_anggota: dataLama.id_anggota, 
                pokok: dataLama.pokok_rp, 
                bunga: dataLama.bunga_rp,
                angsuran_ke: dataLama.angsuran_ke
            }
        );

        await client.query('COMMIT'); 
        res.json({ success: true, message: "Pembayaran Pokok & Bunga berhasil dicatat!" });

    } catch (err) {
        await client.query('ROLLBACK'); 
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
    const actorNo = req.session.no_anggota || 'SYSTEM';

    try {
        const bodyData = req.body;

        // --- 1. AMBIL SNAPSHOT DATA LAMA SEBELUM UPDATE ---
        const oldConfigResult = await pool.query("SELECT nama_key, nilai_nominal FROM pengaturan");
        const oldConfig = {};
        oldConfigResult.rows.forEach(row => {
            oldConfig[row.nama_key] = row.nilai_nominal;
        });

        // 2. Jika ada file logo baru yang diupload
        if (req.file) {
            const logoPath = `/uploads/${req.file.filename}`;
            await pool.query("UPDATE pengaturan SET nilai_nominal = $1 WHERE nama_key = 'logo_url'", [logoPath]);
        }

        // 3. Update data lainnya (nama, iuran, dll) satu per satu
        for (const [key, value] of Object.entries(bodyData)) {
            if (key !== 'logo_file') {
                await pool.query(
                    "UPDATE pengaturan SET nilai_nominal = $1 WHERE nama_key = $2",
                    [value, key]
                );
            }
        }

        // --- 4. SIMPAN KE LOG (COMPARE CONFIG) ---
        await logActivity(
            actorNo, 
            'UPDATE', 
            'pengaturan', 
            null, 
            oldConfig, // Data semua config sebelum diubah
            { ...bodyData, logo_file: req.file ? req.file.filename : 'no change' } // Data baru
        );

        res.json({ message: "Berhasil update konfigurasi" });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ message: "Gagal update: " + err.message });
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
    const actorNo = req.session.no_anggota || 'SYSTEM'; // Siapa yang lagi login
    const { kategori, keterangan, nominal, admin_input } = req.body;

    try {
        // Query Insert: tetap pakai CURRENT_DATE sesuai kode asli lo
        const query = `
            INSERT INTO pengeluaran (tanggal, kategori, keterangan, nominal, admin_input) 
            VALUES (CURRENT_DATE, $1, $2, $3, $4) 
            RETURNING *`;

        const values = [
            kategori.toUpperCase(), 
            keterangan,
            nominal,
            admin_input
        ];

        const result = await pool.query(query, values);
        const dataBaru = result.rows[0];

        // --- LOG: Catat Pengeluaran Keluar ---
        await logActivity(
            actorNo, 
            'INSERT', 
            'pengeluaran', 
            dataBaru.id, // Ambil ID dari hasil RETURNING
            null, 
            { 
                kategori: dataBaru.kategori, 
                nominal: dataBaru.nominal, 
                keterangan: dataBaru.keterangan,
                admin_input: dataBaru.admin_input 
            }
        );

        res.status(200).json({
            status: 'success',
            message: 'Data pengeluaran berhasil dicatat',
            data: dataBaru
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
    console.log("--- BUKTI SERVER JALAN ---"); // Tambahkan baris ini
    try {
        const config = await getGlobalConfig();
        const saldoAwal = parseFloat(config.saldo_awal || 0);

        const masukRes = await pool.query(`
            SELECT SUM(jumlah_bayar) as total 
            FROM transaksi 
            WHERE jumlah_bayar > 0 
            -- TAMBAHKAN INI AGAR DATA MIGRASI HILANG DARI LAPORAN
            AND jenis_iuran != 'dividen' -- exclude dari perhitungan saldo kas
            AND NOT (jenis_iuran = 'pendaftaran' AND keterangan = 'MIGRASI PENDAFTARAN')
        `);

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

        // --- TAMBAHAN BARU: Hitung Total Dividen/SHU ---
        const dividenRes = await pool.query("SELECT SUM(jumlah_bayar) as total FROM transaksi WHERE jenis_iuran = 'dividen'");
        const totalDividen = parseFloat(dividenRes.rows[0].total || 0);

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
            total_dividen: totalDividen, // card baru untuk shu/dividen
            total_pengeluaran_kumulatif: totalPengeluaranKumulatif,
            saldo_akhir_kas: saldoAkhir
        });

    } catch (err) {
        console.error("Error Dashboard API:", err.message);
        // DEBUGGING
        console.log("--- DEBUG DATA ---");
        console.log("Saldo Awal (Config):", saldoAwal);
        console.log("Total Masuk (Setelah Filter):", totalMasuk);
        console.log("Total Keluar Ops:", totalKeluarOps);
        console.log("Total Pinjaman:", totalPinjaman);
        console.log("Total Tarik Simpanan:", totalTarikSimpanan);
        console.log("Hasil Saldo Akhir:", saldoAkhir);
        console.log("------------------");
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
        // Pakai startDate yang sudah lu definisikan di atas (${tahun}-${bulan}-01)
        // Pastikan filternya ditambahkan agar saldo awal tidak terkontaminasi data migrasi

        const saMasuk = await pool.query(`
            SELECT SUM(jumlah_bayar) as total 
            FROM transaksi 
            WHERE created_at < $1 
            -- TAMBAHKAN INI AGAR DATA MIGRASI HILANG DARI LAPORAN
            AND NOT (jenis_iuran = 'pendaftaran' AND keterangan ILIKE '%MIGRASI PENDAFTARAN%')
        `, [startDate]);

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
            WHERE created_at >= $1 AND created_at < ($1::date + interval '1 month')
            -- TAMBAHKAN INI AGAR DATA MIGRASI HILANG DARI LAPORAN
            AND NOT (jenis_iuran = 'pendaftaran' AND keterangan ILIKE '%MIGRASI PENDAFTARAN%')
        `, [startDate]);

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
        const query = `
                SELECT 
                    id_anggota, nama_lengkap, role, tgl_bergabung,
                    TO_CHAR(tgl_bergabung, 'YYYY-MM-DD') as tgl_gabung_str 
                FROM anggota 
                WHERE no_anggota = $1 AND pin_anggota = $2
            `;
        const result = await pool.query(query, [no_anggota, pin_anggota]);

        if (result.rows.length > 0) {
            const user = result.rows[0];

            // Set Session
            req.session.userId = user.id_anggota;
            req.session.no_anggota = no_anggota; // PENTING: biar endpoint lain tau siapa 'actor'nya
            req.session.role = user.role;
            req.session.nama = user.nama_lengkap;

            req.session.user = {
                id_anggota: user.id_anggota,
                no_anggota: no_anggota,
                nama_lengkap: user.nama_lengkap,
                role: user.role,
                tgl_bergabung: user.tgl_gabung_str
            };

            // --- LOG: LOGIN SUKSES ---
            await logActivity(
                no_anggota, 
                'LOGIN', 
                'auth', 
                user.id_anggota, 
                null, 
                { status: 'success', ip: req.ip }
            );

            res.json({ success: true, data: req.session.user });

        } else {
            // --- LOG: LOGIN GAGAL (Penting buat deteksi hacker) ---
            await logActivity(
                no_anggota || 'UNKNOWN', 
                'LOGIN_FAIL', 
                'auth', 
                null, 
                null, 
                { message: "Salah PIN/No Anggota", ip: req.ip }
            );

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
                -- 1. TOTAL SIMPANAN (Bersih: Pendaftaran dibuang, Penarikan dihitung otomatis karena nilainya negatif)
                COALESCE((
                    SELECT SUM(jumlah_bayar) 
                    FROM transaksi 
                    WHERE id_anggota = a.id_anggota 
                    AND jenis_iuran IN ('wajib', 'sukarela', 'tarik_simpanan')
                    -- TAMBAHKAN INI AGAR DATA MIGRASI HILANG DARI LAPORAN
                    AND NOT (jenis_iuran = 'pendaftaran' AND keterangan ILIKE '%MIGRASI PENDAFTARAN%')
                ), 0) as total_simpanan,
                
                -- 2. TOTAL WAJIB SAJA
                COALESCE((SELECT SUM(jumlah_bayar) FROM transaksi WHERE id_anggota = a.id_anggota AND jenis_iuran = 'wajib'), 0) as total_simpanan_wajib_saja,
                
                -- 3. JUMLAH LUNAS WAJIB
                (SELECT COUNT(*) FROM transaksi WHERE id_anggota = a.id_anggota AND jenis_iuran = 'wajib') as total_lunas_wajib,
                
                -- 4. CEK PINJAMAN AKTIF
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

// ENDPOINT KHUSUS LAPORAN TAHUNAN (RAT)
app.get('/api/laporan-tahunan/:tahun', async (req, res) => {
    const { tahun } = req.params;
    const awalTahun = `${tahun}-01-01`;
    const akhirTahun = `${tahun}-12-31`;

    try {
        const config = await getGlobalConfig();
        const saldoAwalConfig = parseFloat(config.saldo_awal || 0);

        // A. HITUNG SALDO AWAL (Semua transaksi fisik sebelum 1 Januari tahun ini)
        const saMasuk = await pool.query("SELECT SUM(jumlah_bayar) as total FROM transaksi WHERE created_at < $1", [awalTahun]);
        const saKeluarOps = await pool.query("SELECT SUM(nominal) as total FROM pengeluaran WHERE tanggal < $1", [awalTahun]);
        const saPinjaman = await pool.query("SELECT SUM(nominal_pokok) as total FROM pinjaman WHERE tanggal_pinjam < $1", [awalTahun]);

        const saldoAwalTahun = saldoAwalConfig +
            parseFloat(saMasuk.rows[0].total || 0) -
            (parseFloat(saKeluarOps.rows[0].total || 0) + parseFloat(saPinjaman.rows[0].total || 0));

        // B. RINGKASAN PEMASUKAN (Dinamis: Wajib, Pokok, Sukarela, dll)
        const rincianMasuk = await pool.query(`
            SELECT UPPER(jenis_iuran) as kategori, SUM(jumlah_bayar) as total 
            FROM transaksi 
            WHERE created_at BETWEEN $1 AND $2 AND jumlah_bayar > 0
            GROUP BY jenis_iuran
        `, [awalTahun, akhirTahun]);

        // C. RINGKASAN PENGELUARAN (Tarik Simpanan, Ops, Pinjaman Cair)
        const totalTarik = await pool.query("SELECT SUM(ABS(jumlah_bayar)) as total FROM transaksi WHERE created_at BETWEEN $1 AND $2 AND jumlah_bayar < 0", [awalTahun, akhirTahun]);
        const totalOps = await pool.query("SELECT SUM(nominal) as total FROM pengeluaran WHERE tanggal BETWEEN $1 AND $2", [awalTahun, akhirTahun]);
        const totalPinjam = await pool.query("SELECT SUM(nominal_pokok) as total FROM pinjaman WHERE tanggal_pinjam BETWEEN $1 AND $2", [awalTahun, akhirTahun]);

        res.json({
            status: 'success',
            data: {
                tahun: tahun,
                saldo_awal: saldoAwalTahun,
                pemasukan: rincianMasuk.rows,
                total_tarik: parseFloat(totalTarik.rows[0].total || 0),
                total_operasional: parseFloat(totalOps.rows[0].total || 0),
                total_pinjaman_cair: parseFloat(totalPinjam.rows[0].total || 0),
                saldo_akhir: saldoAwalTahun +
                    rincianMasuk.rows.reduce((a, b) => a + parseFloat(b.total), 0) -
                    (parseFloat(totalTarik.rows[0].total || 0) + parseFloat(totalOps.rows[0].total || 0) + parseFloat(totalPinjam.rows[0].total || 0))
            }
        });
    } catch (err) {
        console.error("Error Laporan Tahunan:", err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ENDPOINT laporan laba/rugi
app.get('/api/laporan-labarugi', async (req, res) => {
    const { bulan, tahun } = req.query;

    try {
        // 1. Ambil Pendapatan (Gunakan tgl_bayar)
        const pendapatanRes = await pool.query(`
            SELECT 
                jenis_iuran as nama_akun,
                SUM(jumlah_bayar) as total
            FROM transaksi
            WHERE EXTRACT(MONTH FROM tgl_bayar) = $1 
              AND EXTRACT(YEAR FROM tgl_bayar) = $2
              AND jenis_iuran IN ('pendaftaran', 'admin_pinjaman', 'pendapatan_bunga')
              AND jumlah_bayar > 0
            GROUP BY jenis_iuran
        `, [bulan, tahun]);

        // 2. Ambil Beban Operasional (Gunakan tanggal)
        const bebanOpsRes = await pool.query(`
            SELECT 
                kategori as nama_akun, 
                SUM(nominal) as total
            FROM pengeluaran
            WHERE EXTRACT(MONTH FROM tanggal) = $1 
              AND EXTRACT(YEAR FROM tanggal) = $2
            GROUP BY kategori
        `, [bulan, tahun]);

        // 3. Ambil Beban Dividen (Gunakan tgl_bayar)
        const bebanDividenRes = await pool.query(`
            SELECT SUM(jumlah_bayar) as total
            FROM transaksi
            WHERE EXTRACT(MONTH FROM tgl_bayar) = $1 
              AND EXTRACT(YEAR FROM tgl_bayar) = $2
              AND jenis_iuran = 'dividen'
        `, [bulan, tahun]);

        res.json({
            pendapatan: pendapatanRes.rows,
            beban_ops: bebanOpsRes.rows,
            beban_dividen: parseFloat(bebanDividenRes.rows[0].total || 0)
        });

    } catch (err) {
        console.error("DETEKSI ERROR L/R:", err.message);
        res.status(500).json({ message: "Server Error: " + err.message });
    }
});

//endpoint untuk Activity LOG
app.get('/api/logs', async (req, res) => {
    try {
        // Ambil 50 aktivitas terbaru
        const result = await pool.query(`
            SELECT *, TO_CHAR(created_at, 'DD/MM/YYYY HH24:MI') as tgl_format 
            FROM activity_log 
            ORDER BY created_at DESC 
            LIMIT 50
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

app.post('/api/proses-shu-bulk', async (req, res) => {
    const { total_budget, persen_modal, persen_jasa, tahun } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Ambil data kontribusi tiap anggota
        // Simpanan: Pokok + Wajib + Sukarela
        // Jasa: Pendapatan Bunga yang pernah dibayar anggota tersebut
        const dataRes = await client.query(`
            SELECT 
                a.id_anggota,
                SUM(CASE WHEN t.jenis_iuran IN ('wajib', 'sukarela') THEN t.jumlah_bayar ELSE 0 END) as total_simpanan,
                SUM(CASE WHEN t.jenis_iuran = 'pendapatan_bunga' THEN t.jumlah_bayar ELSE 0 END) as total_bunga
            FROM anggota a
            LEFT JOIN transaksi t ON a.id_anggota = t.id_anggota
            GROUP BY a.id_anggota
        `);

        const anggota = dataRes.rows;
        const grandTotalSimpanan = anggota.reduce((s, row) => s + parseFloat(row.total_simpanan), 0);
        const grandTotalBunga = anggota.reduce((s, row) => s + parseFloat(row.total_bunga), 0);

        const budgetModal = (persen_modal / 100) * total_budget;
        const budgetJasa = (persen_jasa / 100) * total_budget;

        for (let row of anggota) {
            const jatahModal = grandTotalSimpanan > 0 ? (parseFloat(row.total_simpanan) / grandTotalSimpanan) * budgetModal : 0;
            const jatahJasa = grandTotalBunga > 0 ? (parseFloat(row.total_bunga) / grandTotalBunga) * budgetJasa : 0;
            
            // Sesuai skenario: Pembulatan ke bawah
            const totalDiterima = Math.floor(jatahModal + jatahJasa);

            if (totalDiterima > 0) {
                await client.query(`
                    INSERT INTO transaksi (id_anggota, tanggal, jenis_iuran, jumlah_bayar, keterangan)
                    VALUES ($1, CURRENT_DATE, 'dividen', $2, $3)
                `, [row.id_anggota, totalDiterima, `Pembagian SHU ${tahun}`]);
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `Berhasil membagikan SHU ke ${anggota.length} anggota` });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: err.message });
    } finally {
        client.release();
    }
});

// F. Terakhir: Static Folder (Hanya untuk aset seperti CSS/JS/Gambar)
app.use(express.static('public'));

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});

