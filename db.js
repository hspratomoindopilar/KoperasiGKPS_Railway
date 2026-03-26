const { Pool } = require('pg');

// Langsung tembak URL-nya di sini
const connectionString = "postgres://postgres.gvoxxegearhnntrrnxre:758186hsp86@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres";

const pool = new Pool({
  connectionString: connectionString,
  max: 10, // <--- TAMBAHKAN INI: Membatasi antrean maksimal 10 koneksi
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: false
});

// Tes koneksi
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Gagal konek:', err.message);
  } else {
    console.log('✅ AKHIRNYA BERHASIL! Database Supabase Terhubung.');
  }
});

module.exports = pool;