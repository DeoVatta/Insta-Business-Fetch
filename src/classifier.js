/**
 * Instagram Prospector - Profile Classifier
 */

export const COMPETITOR_KEYWORDS = [
    'mua', 'makeup artist', 'make-up', 'rias pengantin', 'rias',
    'hairstylist', 'hairdo', 'bridalmakeup', 'muahid',
    'rias by', 'by mua', '@mua', 'makeuppro', 'makeupartist',
];

export const VENDOR_KEYWORDS = [
    'fotografer', 'photographer', 'fotografi', 'fotography', 'foto',
    'videografer', 'videografi', 'videography', 'video',
    'wedding photo', 'wedding video', 'prewedding photo',
    'venue', 'gedung', 'ballroom', 'hotel',
    'dekorasi', 'dekor', 'decorator', 'decoration',
    'gaun', 'kebaya', 'wedding gown', 'dress',
    'catering', 'katering', 'jajanan', 'wedding cake', 'cake',
    'tumpeng', 'nasi box',
    'mc', 'moderator', 'seserahan', 'bouquet',
    'undangan', 'invitation', 'invite', 'print',
    'salon', 'nails', 'lash', 'beauty',
    'organizer', 'planner', 'koor', 'entertainment',
    'sound system', 'musik', 'band', 'djuara',
    'soundsystem', 'lighting', 'cars', 'car',
    'souvenir', 'gift', 'bantal', 'bantalcouple',
    'khotmil', 'penceramah', 'ustadz', 'pengajian',
];

export const VENDOR_HASHTAGS = [
    '#fotografer', '#fotografi', '#photographer', '#videografer',
    '#catering', '#katering', '#dekorasi', '#venue', '#gedung',
    '#gaun', '#kebaya', '#weddingdress', '#mc', '#undangan',
    '#weddingplanner', '#weddingorganizer', '#weddingvendor',
    '#weddingvenue', '#weddingcatering', '#weddingdecoration',
    '#bouquet', '#weddingcake', '#souvenir', '#weddingmusic',
    '#salon', '#weddingnails',
];

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
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export function classifyAccount(bio, displayName = '') {
    const text = ((bio || '') + ' ' + (displayName || '')).toLowerCase();
    for (const kw of COMPETITOR_KEYWORDS) {
        if (wordBoundaryMatch(text, kw)) return 'competitor';
    }
    for (const kw of VENDOR_KEYWORDS) {
        if (wordBoundaryMatch(text, kw)) return 'vendor';
    }
    return 'client';
}

export function classifyFromHashtags(hashtags) {
    const tagText = hashtags.map(h => '#' + h.toLowerCase()).join(' ');
    for (const tag of VENDOR_HASHTAGS) {
        if (tagText.includes(tag.toLowerCase())) return 'vendor';
    }
    return 'client';
}

export function detectCategory(bio, displayName, accountType) {
    const text = ((bio || '') + ' ' + (displayName || '')).toLowerCase();
    if (accountType === 'competitor') {
        if (wordBoundaryMatch(text, 'hairstylist') || wordBoundaryMatch(text, 'hairdo')) return 'HAIRSTYLIST';
        if (wordBoundaryMatch(text, 'bridalmakeup')) return 'BRIDAL';
        if (wordBoundaryMatch(text, 'makeup') || wordBoundaryMatch(text, 'mua')) return 'MUA';
        if (wordBoundaryMatch(text, 'rias')) return 'RIAS';
        return 'MUA';
    }
    if (accountType === 'vendor') {
        if (/photographer|foto|fotografer|fotografi|fotography/i.test(text)) return 'PHOTOGRAPHER';
        if (/videografer|videografi|videography|video|cameraman/i.test(text)) return 'VIDEOGRAPHER';
        if (/catering|katering|cake|tumpeng/i.test(text)) return 'CATERING';
        if (/dekorasi|dekor|decorator/i.test(text)) return 'DECORATOR';
        if (/venue|gedung|ballroom|hotel/i.test(text)) return 'VENUE';
        if (/gaun|kebaya|gown|dress/i.test(text)) return 'GAUN/KEBAYA';
        if (/undangan|invitation/i.test(text)) return 'UNDANGAN';
        if (/organizer|planner/i.test(text)) return 'ORGANIZER';
        if (/mc|moderator/i.test(text)) return 'MC';
        if (/salon|nails|lash|beauty/i.test(text)) return 'SALON/BEAUTY';
        if (/bouquet|gift|souvenir/i.test(text)) return 'SOUVENIR';
        if (/sound|music|musik|band|djuara/i.test(text)) return 'MUSIC';
        if (/khotmil|penceramah|ustadz|pengajian/i.test(text)) return 'RELIGIOUS';
        return 'VENDOR';
    }
    return 'Client';
}

export function calculateEngagement(likes, comments, followers) {
    if (!followers || followers === 0) return 0;
    return ((likes + comments) / followers * 100).toFixed(2);
}
