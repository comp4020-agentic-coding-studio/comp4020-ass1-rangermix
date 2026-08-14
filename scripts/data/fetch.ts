// Fetches the Canberra OSM extract from Overpass and caches it locally as
// raw JSON. Network I/O glue only — parsing/building lives in build.ts, and
// this file has no unit tests (see spec/data.test.ts for the data-contract
// tests, which run once the cached extract has been fetched and built).

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Same bbox and highway filter as the design spec: every drivable way class
// SPEEDS (osm.ts) knows how to weight, inside Canberra's metro area.
const QUERY = `[out:json][timeout:180];
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]["area"!="yes"](-35.60,148.95,-35.10,149.28);
(._;>;);
out body;`;

const PRIMARY = "https://overpass-api.de/api/interpreter";
const FALLBACK = "https://overpass.kumi.systems/api/interpreter";
const TIMEOUT_MS = 180_000;
const CACHE_DIR = resolve("scripts/data/cache");
const CACHE_FILE = resolve(CACHE_DIR, "canberra.json");

// Overpass's usage policy asks automated clients to self-identify, and in
// practice overpass-api.de 406s requests with no User-Agent/Accept at all
// (Node's fetch sends neither by default, unlike curl or a browser) — so
// these aren't optional niceties, the primary endpoint won't serve without
// them.
const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "highway-to-hill-data-pipeline/1.0 (COMP4020 student project; " +
    "+https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-rangermix)",
  Accept: "*/*",
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function post(url: string): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: "data=" + encodeURIComponent(QUERY),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`);
  return res.text();
}

async function main(): Promise<void> {
  let text: string;
  try {
    console.log(`Fetching Canberra extract from ${PRIMARY} ...`);
    text = await post(PRIMARY);
  } catch (err) {
    console.warn(`Primary Overpass endpoint failed: ${errMsg(err)}`);
    console.log(`Retrying against fallback ${FALLBACK} ...`);
    text = await post(FALLBACK);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, text, "utf8");
  const bytes = statSync(CACHE_FILE).size;
  console.log(`Saved ${bytes.toLocaleString()} bytes to ${CACHE_FILE}`);
}

main().catch((err: unknown) => {
  console.error("fetch failed:", errMsg(err));
  process.exitCode = 1;
});
