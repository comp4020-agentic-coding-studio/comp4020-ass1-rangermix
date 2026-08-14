// Pure geo utilities shared by pin placement, preset snapping, "Surprise
// me", and the race announcer's route-length figure. No DOM, no fetch — a
// linear scan and a haversine formula, both plain arithmetic.

const DEG2RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two lon/lat points, in metres. Used for
 * the preset-snap sanity check ("within 800 m"), the "Surprise me" minimum
 * separation (>= 8 km), and summing hop lengths along a route for the
 * aria-announcement's km figure — none of those are graph edge weights
 * (which are travel TIME), so this is deliberately independent of the
 * routing graph. */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Finds the graph node nearest (lon, lat) by a linear scan over every
 * node, x-scaling longitude by cos(lat) so a degree of longitude and a
 * degree of latitude contribute comparable real-world distance — without
 * that scaling, a naive dLon/dLat comparison over-weights east-west
 * separation away from the equator (Canberra: cos(-35.3°) ≈ 0.815, a ~18%
 * skew that's enough to flip the winner between two close candidates on
 * opposite axes). The reference latitude is the QUERY point's own lat, not
 * a precomputed bbox midpoint (unlike mapRenderer's cosMidLat) — this
 * function has no bbox to draw one from, and Canberra's bbox is narrow
 * enough (~0.6° of latitude) that any in-region reference lat gives the
 * same nearest-node answer. Only relative order matters for an argmin, so
 * this stays in squared-degree space rather than converting to metres. */
export function nearestNode(
  lon: number,
  lat: number,
  lonArr: Float64Array,
  latArr: Float64Array,
): number {
  const cosLat = Math.cos(lat * DEG2RAD);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lonArr.length; i++) {
    const dx = (lonArr[i] - lon) * cosLat;
    const dy = latArr[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
