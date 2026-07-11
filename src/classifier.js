/**
 * Instagram Prospector - Profile Classifier
 *
 * Pure rule-based classifiers for Indonesian wedding/business profiles.
 */

export const INDONESIAN_CITIES = [
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
];

export const INDONESIAN_WORDS = [
    'menikah', 'pernikahan', 'resepsi', 'undangan nikah', 'akad',
    'suami', 'istri', 'mempelai', 'pengantin',
    '+62', 'wa.me', 'whatsapp', 'whats app', 'line:', 'telegram:',
    'allah', 'jannah', 'khotbah', 'pengajian', 'khotmil', 'dakwah',
];

function wordBoundaryMatch(text, keyword) {
    const escaped = keyword.replace(/[.*+?^${}|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

export function isIndonesian(bio = '', hashtags = [], nativeLocation = '') {
    const text = ((bio || '') + ' ' + hashtags.join(' ') + ' ' + (nativeLocation || '')).toLowerCase();
    for (const city of INDONESIAN_CITIES) {
        if (wordBoundaryMatch(text, city)) return true;
    }
    for (const word of INDONESIAN_WORDS) {
        if (text.includes(word)) return true;
    }
    if (/\+62|62\d{8,}/.test(text)) return true;
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

export function detectCategory(bio = '', displayName = '', extraText = '') {
    const text = ((bio || '') + ' ' + (displayName || '') + ' ' + (extraText || '')).toLowerCase();

    if (/hairstylist|hairdo/i.test(text)) return 'Hairstylist';
    if (/bridalmakeup/i.test(text)) return 'Bridal Makeup';
    if (/makeup|mua|make-up|rias/i.test(text)) return 'MUA';
    if (/photographer|foto|fotografer|fotografi|fotography/i.test(text)) return 'Fotografer';
    if (/videografer|videografi|videography|video|cameraman/i.test(text)) return 'Videografer';
    if (/catering|katering|cake|tumpeng/i.test(text)) return 'Catering';
    if (/dekorasi|dekor|decorator/i.test(text)) return 'Dekorasi';
    if (/venue|gedung|ballroom|hotel/i.test(text)) return 'Venue';
    if (/gaun|kebaya|gown|dress/i.test(text)) return 'Gaun/Kebaya';
    if (/undangan|invitation/i.test(text)) return 'Undangan';
    if (/organizer|planner/i.test(text)) return 'Wedding Planner';
    if (/mc|moderator/i.test(text)) return 'MC';
    if (/salon|nails|lash|beauty/i.test(text)) return 'Salon/Beauty';
    if (/bouquet|gift|souvenir/i.test(text)) return 'Souvenir';
    if (/sound|music|musik|band|djuara/i.test(text)) return 'Music';
    if (/khotmil|penceramah|ustadz|pengajian/i.test(text)) return 'Religious Services';
    return 'Other';
}

export function calculateEngagement(likes, comments, followers) {
    if (!followers || followers === 0) return 0;
    return ((likes + comments) / followers * 100).toFixed(2);
}
