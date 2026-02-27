const pool = require('./db');
const xlsx = require('xlsx');

async function migrate() {
    try {
        console.log("📂 Membaca file MigrasiDanaAnggota.xlsx...");
        const workbook = xlsx.readFile('MigrasiDanaAnggota.xlsx');
        const sheetName = workbook.SheetNames[0]; // Asumsi Sheet ke-1
        const worksheet = workbook.Sheets[sheetName];
        const records = xlsx.utils.sheet_to_json(worksheet);

        console.log(`🚀 Memproses ${records.length} data...`);

        for (const row of records) {
            // 1. Setup Data Anggota
            let no_agt = String(row.no_anggota).trim();
            if (no_agt.length === 6) no_agt = "0" + no_agt;

            const resAnggota = await pool.query(
                "SELECT id_anggota, tgl_bergabung FROM anggota WHERE no_anggota = $1", 
                [no_agt]
            );

            if (resAnggota.rows.length === 0) {
                console.log(`⚠️ Anggota ${no_agt} tidak ditemukan, skip.`);
                continue;
            }

            const { id_anggota, tgl_bergabung } = resAnggota.rows[0];
            const danaPendaftaran = parseInt(row.pendaftaran) || 0;
            let sisaWajib = parseInt(row.wajib) || 0;
            const danaSukarelaAsli = parseInt(row.sukarela) || 0;

            // 2. INPUT PENDAFTARAN
            if (danaPendaftaran > 0) {
                await pool.query(
                    `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, tgl_bayar, created_at, status_verifikasi, keterangan) 
                     VALUES ($1, 'pendaftaran', $2, NOW(), NOW(), true, 'MIGRASI PENDAFTARAN')`,
                    [id_anggota, danaPendaftaran]
                );
            }

            // 3. LOGIKA WAJIB (Cicil per Bulan)
            let current = new Date(tgl_bergabung);
            let end = new Date(); // Sampai hari ini

            while (current <= end && sisaWajib >= 10000) {
                let bulan = current.getMonth() + 1;
                let tahun = current.getFullYear();
                
                // Aturan Juli 2022
                let nominalWajib = (tahun < 2022 || (tahun === 2022 && bulan < 7)) ? 10000 : 20000;

                if (sisaWajib >= nominalWajib) {
                    await pool.query(
                        `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, bulan_iuran, tahun_iuran, tgl_bayar, created_at, status_verifikasi, keterangan) 
                         VALUES ($1, 'wajib', $2, $3, $4, NOW(), NOW(), true, 'MIGRASI WAJIB')`,
                        [id_anggota, nominalWajib, bulan, tahun]
                    );
                    sisaWajib -= nominalWajib;
                } else {
                    break;
                }
                current.setMonth(current.getMonth() + 1);
            }

            // 4. INPUT SUKARELA (Dana Sukarela Asli + Sisa Wajib)
            let totalSukarela = danaSukarelaAsli + sisaWajib;
            if (totalSukarela > 0) {
                await pool.query(
                    `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, tgl_bayar, created_at, status_verifikasi, keterangan) 
                     VALUES ($1, 'sukarela', $2, NOW(), NOW(), true, 'MIGRASI SUKARELA')`,
                    [id_anggota, totalSukarela]
                );
            }

            console.log(`✅ Sukses Migrasi: ${no_agt}`);
        }
        console.log("✨ MIGRASI SELESAI!");

    } catch (err) {
        console.error("❌ Error Migrasi:", err.message);
    }
}

migrate();