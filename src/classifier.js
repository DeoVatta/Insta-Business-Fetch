/**
 * Instagram Prospector - Profile Classifier
 *
 * Language detection for Indonesian business profiles.
 * No regex-based category — category is determined by AI only.
 */

// Indonesian stopwords / common words (language fingerprint)
const IND_WORDS = new Set([
    'yang', 'dan', 'di', 'dengan', 'untuk', 'ini', 'itu', 'ada', 'saya',
    'kita', 'kamu', 'nya', 'tidak', 'atau', 'dari', 'pada', 'ke', 'oleh',
    'akan', 'sudah', 'juga', 'bisa', 'hanya', 'lebih', 'seperti', 'dalam',
    'telah', 'serta', 'tersedia', 'hubungi', 'wa', 'whatsapp', 'call',
    'kontak', 'info', 'layanan', 'jasa', 'produk', 'harga', 'promo', 'sale',
    'diskon', 'gratis', 'order', 'pesan', 'cek', 'follow', 'ig', 'instagram',
    'profil', 'bio', 'link', 'website', 'com', 'id', 'co', 'official',
    'verified', 'resmi', 'store', 'toko', 'shop', 'klik', 'visit', 'dm',
    'chat', 'message', 'lokasi', 'alamat', 'jam', 'buka', 'tutup', 'hari',
    'menit', 'detik', 'km', 'jl', 'jalan', 'rt', 'rw', 'no', 'nomor',
    'tebal', 'tipis', 'murah', ' mahal', 'bagus', ' ori', 'asli', 'import',
    ' Grosir', 'eceran', 'cod', 'cod.', 'bayar', 'transfer', ' BCA', ' BRI',
    ' mandiri', ' ovo', 'dana', 'gopay', 'linkaja', 'shopeepay',
    ' siap', 'antar', 'kirim', 'terima', 'packing', 'bubble',
    ' ready', 'stok', 'habis', 'new', 'lama', 'update', 'terkini',
    ' baca', 'lihat', 'share', ' komen', 'like', ' follback',
    ' admin', 'owner', ' founder', ' ceo', ' manager',
    ' bisnis', 'usaha', 'dagang', 'jual', 'beli', 'niaga',
    'kota', 'kab', 'kabupaten', 'provinsi', 'negeri', ' PT', ' CV',
    'email', 'gmail', 'yahoo', 'hotmail', 'mail',
    'mau', 'ingin', 'cari', 'butuh', 'butuh', 'butuhkan',
]);

// Indonesian cities (Layer 1: name/location match)
const INDONESIAN_CITIES = [
    'jakarta', 'jkt', 'tangerang', 'tangsel', 'bekasi', 'bogor', 'depok',
    'bandung', 'bdg', 'cirebon', 'karawang', 'purwakarta', 'sukabumi',
    'subang', 'indramayu', 'majalengka', 'sumedang', 'garut', 'cianjur', 'bandung barat',
    'semarang', 'smg', 'solo', 'surakarta', 'yogyakarta', 'jogja', 'jogjakarta', 'yogya',
    'salatiga', 'slg', 'klaten', 'klt', 'wonogiri', 'sragen', 'boyolali', 'magelang',
    'pati', 'kudus', 'rembang', 'blora', 'grobogan', 'karanganyar', 'cepu',
    'ungaran', 'ung', 'pekalongan', 'pkl', 'tegal', 'tgl', 'brebes', 'pemalang',
    'batang', 'kendal', 'demak', 'jepara', 'jombang', 'mojokerto', 'surabaya', 'sby',
    'sidoarjo', 'gresik', 'lamongan', 'tuban', 'bojonegoro', 'nganjuk', 'madiun',
    'ponorogo', 'ngawi', 'magetan', 'caruban', 'trenggalek', 'tulungagung', 'blitar',
    'malang', 'mlg', 'pasuruan', 'probolinggo', 'lumajang', 'jember', 'banyuwangi',
    'situbondo', 'bondowoso', 'kediri',
    'bali', 'denpasar', 'kuta', 'ubud', 'sanur', 'nusa dua', 'nusa penida',
    'lombok', 'mataram', 'sumbawa',
    'medan', 'mdn', 'pekanbaru', 'pkp', 'padang', 'palembang', 'plm',
    'pekanbaru', 'riau', 'jambi', 'bengkulu', 'lampung', 'bandar lampung',
    'banjarmasin', 'bjb', 'kalimantan', 'samarinda', 'balikpapan', 'pontianak',
    'makassar', 'mks', 'parepare', 'palopo', 'manado', 'gorontalo',
    'kendari', 'palu', 'bau-bau',
    'mataram', 'kupang', 'ambon', 'ternate', 'sorong', 'jayapura', 'papua',
    'jawa', 'jatim', 'jateng', 'jabar', 'dki', 'indonesia', 'riau',
    'batam', 'pekanbaru', 'banjarmasin', 'pontianak',
    'cilacap', 'kebumen', 'banyumas', 'purworejo', 'wonosobo', 'kebumen',
    'bantul', 'sleman', 'gunung kidul', 'kulon progo',
    'jember', 'banyuwangi', 'bondowoso', 'situbondo', 'probolinggo',
    'pamekasan', 'sampang', 'sumenep', 'bangkalan',
    'fs', 'foto', 'gallery', 'studio',
];

function wordBoundaryMatch(text, keyword) {
    const escaped = keyword.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

/**
 * Count how many Indonesian language words appear in text.
 * Returns ratio of found words to total words checked.
 */
function countIndWords(text) {
    const words = (text || '').toLowerCase().split(/[\s,.!?;:()#@\/\\]+/)
        .filter(w => w.length > 2);
    if (words.length === 0) return 0;
    let matches = 0;
    for (const w of words) {
        if (IND_WORDS.has(w)) matches++;
    }
    return matches;
}

/**
 * 3-layer Indonesian language detection:
 *
 * Layer 1: Display name / location contains Indonesian city → PASS
 * Layer 2: Bio contains Indonesian language words (≥2 unique) → PASS
 * Layer 3: Caption/description contains Indonesian language words (≥2 unique) → PASS
 *
 * Any layer passes → Indonesian profile.
 */
export function isIndonesian(displayName = '', bio = '', caption = '') {
    const text = ((bio || '') + ' ' + (caption || '')).toLowerCase();

    // Layer 1: Check city in displayName or bio
    for (const city of INDONESIAN_CITIES) {
        if (wordBoundaryMatch((displayName || '') + ' ' + bio, city)) return true;
    }
    // Also check if display name itself looks Indonesian
    for (const city of INDONESIAN_CITIES) {
        if (wordBoundaryMatch(displayName || '', city)) return true;
    }
    // Quick check: "indonesia" in name
    if (/\b(indonesia|indonesian|indo)\b/i.test(displayName)) return true;

    // Layer 2: Bio Indonesian language fingerprint
    const bioIndCount = countIndWords(bio);
    if (bioIndCount >= 2) return true;

    // Layer 3: Caption Indonesian language fingerprint
    const captionIndCount = countIndWords(caption);
    if (captionIndCount >= 2) return true;

    return false;
}

/**
 * Simple Indonesian check using the 3-layer system.
 * Convenience wrapper for places that only have one text field.
 */
export function isIndonesianSimple(text = '') {
    if (!text || text.length < 5) return false;
    // Layer 1: city in text
    for (const city of INDONESIAN_CITIES) {
        if (wordBoundaryMatch(text, city)) return true;
    }
    // Layer 2+3: language fingerprint
    if (countIndWords(text) >= 3) return true;
    return false;
}

export function detectLocation(bio = '', displayName = '', nativeLocation = '') {
    const raw = ((bio || '') + ' ' + (displayName || '')).toLowerCase();
    if (nativeLocation) {
        const nl = nativeLocation.toLowerCase();
        for (const city of INDONESIAN_CITIES) {
            if (nl.includes(city)) return city.charAt(0).toUpperCase() + city.slice(1);
        }
    }
    for (const city of INDONESIAN_CITIES) {
        if (wordBoundaryMatch(raw, city)) return city.charAt(0).toUpperCase() + city.slice(1);
    }
    return '';
}

export function calculateEngagement(likes, comments, followers) {
    if (!followers || followers === 0) return 0;
    return ((likes + comments) / followers * 100).toFixed(2);
}
