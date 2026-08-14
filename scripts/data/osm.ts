// Parses Overpass-API JSON into the pipeline's raw units: drivable ways with
// their oneway/maxspeed semantics resolved, plus the haversine distance used
// to weight every hop. Pure functions, no I/O — build.ts drives the stages
// that turn this into a routing graph.

export interface OverpassNode {
  type: "node"; id: number; lat: number; lon: number;
}

export interface OverpassWay {
  type: "way"; id: number; nodes: number[]; tags?: Record<string, string>;
}

export type OverpassElement = OverpassNode | OverpassWay;

export interface OverpassJson { elements: OverpassElement[] }

export interface OsmWay {
  id: number; refs: number[]; highway: string;
  oneway: "yes" | "-1" | "no"; maxspeed?: number;
}

export interface ParsedOsm {
  nodes: Map<number, [number, number]>; // id -> [lon, lat]
  ways: OsmWay[];
}

// km/h, from the design spec's speed table (SPEEDS[highway]; maxspeed on the
// way overrides this when present).
export const SPEEDS: Record<string, number> = {
  motorway: 100, motorway_link: 60,
  trunk: 90, trunk_link: 60,
  primary: 70, primary_link: 50,
  secondary: 60, secondary_link: 50,
  tertiary: 50, tertiary_link: 40,
  unclassified: 50,
  residential: 40,
  living_street: 10,
};

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two lon/lat points, in meters. */
export function haversineM(
  lon1: number, lat1: number, lon2: number, lat2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// motorway/motorway_link and roundabouts are one-way by convention unless
// tagged otherwise; every other highway type defaults to two-way.
function inferOneway(
  highway: string, tags: Record<string, string>,
): "yes" | "-1" | "no" {
  const tag = tags.oneway;
  if (tag === "yes" || tag === "-1" || tag === "no") return tag;
  if (highway === "motorway" || highway === "motorway_link") return "yes";
  if (tags.junction === "roundabout") return "yes";
  return "no";
}

// Only a plain integer (optionally " km/h"-suffixed) counts; "signals", mph
// tags, and other non-numeric maxspeed values are left undefined so the
// caller falls back to SPEEDS[highway].
function parseMaxspeed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(?:km\/h)?$/.exec(raw.trim());
  return m ? Number(m[1]) : undefined;
}

/** Parses raw Overpass JSON into node coordinates and drivable ways only. */
export function parseOsm(json: OverpassJson): ParsedOsm {
  const nodes = new Map<number, [number, number]>();
  for (const el of json.elements)
    if (el.type === "node") nodes.set(el.id, [el.lon, el.lat]);

  const ways: OsmWay[] = [];
  for (const el of json.elements) {
    if (el.type !== "way") continue;
    const tags = el.tags ?? {};
    const highway = tags.highway;
    if (!highway || !(highway in SPEEDS)) continue; // not drivable (e.g. footway)
    ways.push({
      id: el.id,
      refs: el.nodes,
      highway,
      oneway: inferOneway(highway, tags),
      maxspeed: parseMaxspeed(tags.maxspeed),
    });
  }
  return { nodes, ways };
}
