const pool = require('./db');
const xlsx = require('xlsx');

async function migrate() {
    try {
        console.log("📂 Membaca file MigrasiDanaAnggota.xlsx...");
        const workbook = xlsx.readFile('MigrasiDanaAnggota.xlsx');
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const records = xlsx.utils.sheet_to_json(worksheet);

        console.log(`🚀 Total data di Excel: ${records.length} baris.`);

        for (const row of records) {
            // Log awal untuk cek isi baris
            let no_agt = String(row.no_anggota).trim();
            if (no_agt.length === 6) no_agt = "0" + no_agt;
            
            console.log(`\n🔍 Proses Anggota: ${no_agt}`);

            const resAnggota = await pool.query(
                "SELECT id_anggota, tgl_bergabung FROM anggota WHERE no_anggota = $1",
                [no_agt]
            );

            if (resAnggota.rows.length === 0) {
                console.log(`   ❌ ERROR: Anggota ${no_agt} tidak ditemukan di database.`);
                continue;
            }

            const { id_anggota, tgl_bergabung } = resAnggota.rows[0];
            const danaPendaftaran = parseInt(row.pendaftaran) || 0;
            let sisaWajib = parseInt(row.wajib) || 0;
            const danaSukarelaAsli = parseInt(row.sukarela) || 0;

            console.log(`   ✅ Ditemukan ID: ${id_anggota}, Tgl Bergabung: ${tgl_bergabung}`);
            console.log(`   💰 Dana: Wajib=${sisaWajib}, Pendaftaran=${danaPendaftaran}, Sukarela=${danaSukarelaAsli}`);

            // 2. INPUT PENDAFTARAN
            if (danaPendaftaran > 0) {
                await pool.query(
                    `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, tgl_bayar, created_at, status_verifikasi, keterangan) 
                     VALUES ($1, 'pendaftaran', $2, $3, $3, true, 'MIGRASI PENDAFTARAN')`,
                    [id_anggota, danaPendaftaran, tgl_bergabung]
                );
                console.log(`   -> OK: Insert Pendaftaran ${danaPendaftaran}`);
            }

            // 3. LOGIKA WAJIB
            let current = new Date(tgl_bergabung);
            let end = new Date();
            
            while (current <= end && sisaWajib >= 10000) {
                let bulan = current.getMonth() + 1;
                let tahun = current.getFullYear();
                let transactionDate = new Date(tahun, current.getMonth(), 15);
                let nominalWajib = (tahun < 2022 || (tahun === 2022 && bulan < 7)) ? 10000 : 20000;

                if (sisaWajib >= nominalWajib) {
                    await pool.query(
                        `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, bulan_iuran, tahun_iuran, tgl_bayar, created_at, status_verifikasi, keterangan) 
                         VALUES ($1, 'wajib', $2, $3, $4, $5, $5, true, 'MIGRASI WAJIB')`,
                        [id_anggota, nominalWajib, bulan, tahun, transactionDate]
                    );
                    sisaWajib -= nominalWajib;
                } else {
                    break;
                }
                current.setMonth(current.getMonth() + 1);
            }
            console.log(`   -> OK: Sisa Wajib setelah loop: ${sisaWajib}`);

            // 4. INPUT SUKARELA
            let totalSukarela = danaSukarelaAsli + sisaWajib;
            if (totalSukarela > 0) {
                await pool.query(
                    `INSERT INTO transaksi (id_anggota, jenis_iuran, jumlah_bayar, tgl_bayar, created_at, status_verifikasi, keterangan) 
                    VALUES ($1, 'sukarela', $2, $3, $3, true, 'SALDO AWAL MIGRASI')`,
                    [id_anggota, totalSukarela, tgl_bergabung]
                );
                console.log(`   -> OK: Insert Sukarela/Saldo Awal ${totalSukarela}`);
            }
        }
        console.log("\n✨ MIGRASI SELESAI!");

    } catch (err) {
        console.error("❌ ERROR FATAL:", err);
    }
}

migrate();