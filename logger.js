// logger.js
const pool = require('./db'); // Sesuaikan path ini dengan lokasi file db.js lo

/**
 * Fungsi untuk mencatat aktivitas secara modular
 */
async function logActivity(actorNo, action, table, targetId, oldData, newData) {
    console.log(`DEBUG: Mencoba simpan log untuk ${table} (Action: ${action})`); // TAMBAH INI
    try {
        const query = `
            INSERT INTO activity_log (actor_no_anggota, action, table_name, target_id, old_data, new_data)
            VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        // Catatan: Library 'pg' otomatis nanganin object JS ke format JSONB
        await pool.query(query, [actorNo, action, table, targetId, oldData, newData]);
        
        console.log(`✅ [Audit Log] ${action} pada tabel ${table} oleh ${actorNo}`);
    } catch (err) {
        // Penting: Kita log error-nya ke console, tapi aplikasi tetap jalan (tidak crash)
        console.error("❌ Gagal simpan log:", err.message);
    }
}

module.exports = { logActivity };