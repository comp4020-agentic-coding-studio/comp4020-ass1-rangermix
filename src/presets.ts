// Named Canberra place-pairs the home page's preset chips race. Exact
// lon/lat coordinates are frozen by the task brief. "Surprise me" is
// deliberately NOT here — it needs live graph node coordinates to pick a
// random pair >= 8 km apart (haversine), so it's generated in home.ts at
// click time instead of being a fixed a/b pair.

export interface Preset {
  id: string;
  label: string;
  a: [number, number];
  b: [number, number];
}

export const PRESETS: Preset[] = [
  {
    id: "hill",
    label: "To the Hill",
    a: [149.133, -35.186], // Gungahlin
    b: [149.1245, -35.308], // Capital Hill
  },
  {
    id: "diagonal",
    label: "Full diagonal",
    a: [149.066, -35.24], // Belconnen
    b: [149.088, -35.415], // Tuggeranong
  },
  {
    id: "anu-airport",
    label: "ANU → Airport",
    a: [149.119, -35.278], // ANU
    b: [149.193, -35.307], // Canberra Airport
  },
];
