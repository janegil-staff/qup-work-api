// /qup-work-api/src/utils/geo.js
// Norwegian postcode → place and map position, using Kartverket's open address API
// (Geonorge, free, CC BY 4.0, no key). Answers are cached in memory; postcodes don't move.
//
//   await lookupPostcode('5003')
//   → { postalCode: '5003', city: 'Bergen', municipality: 'Bergen',
//       location: { type: 'Point', coordinates: [5.32, 60.39] } }      (null if unknown)
// Throws if Kartverket can't be reached, so callers can carry on without a position.
const BASE = process.env.GEONORGE_URL ?? 'https://ws.geonorge.no/adresser/v1';
const cache = new Map();

// "MO I RANA" → "Mo i Rana", "ÅLESUND" → "Ålesund"
const SMALL = new Set(['i', 'på', 'og']);
function titleCase(text) {
  if (!text) return undefined;
  return String(text)
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}

const round = (n) => Math.round(n * 10000) / 10000; // ~10 m, plenty for "where in Norway"

export async function lookupPostcode(code) {
  const postalCode = String(code ?? '').trim();
  if (!/^\d{4}$/.test(postalCode)) return null;
  if (cache.has(postalCode)) return cache.get(postalCode);

  const res = await fetch(`${BASE}/sok?postnummer=${postalCode}&treffPerSide=1`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Geonorge answered ${res.status}`);
  const data = await res.json();
  const hit = data?.adresser?.[0];
  const point = hit?.representasjonspunkt;

  const place = hit
    ? {
        postalCode,
        city: titleCase(hit.poststed),
        municipality: titleCase(hit.kommunenavn),
        location:
          Number.isFinite(point?.lon) && Number.isFinite(point?.lat)
            ? { type: 'Point', coordinates: [round(point.lon), round(point.lat)] }
            : undefined,
      }
    : null;
  cache.set(postalCode, place); // unknown postcodes are cached too
  return place;
}

// Like lookupPostcode, but never throws (for "nice to have" places like new jobs)
export async function tryLookupPostcode(code) {
  try {
    return await lookupPostcode(code);
  } catch (err) {
    console.warn('postcode lookup failed:', err.message);
    return null;
  }
}
