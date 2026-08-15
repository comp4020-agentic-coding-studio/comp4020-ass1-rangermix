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
    label: "Gungahlin → Capital Hill",
    a: [149.133, -35.186], // Gungahlin
    b: [149.1245, -35.308], // Capital Hill
  },
  {
    id: "anu-airport",
    label: "ANU → Airport",
    a: [149.119, -35.278], // ANU
    b: [149.193, -35.307], // Canberra Airport
  },
  {
    id: "diagonal",
    label: "Belconnen → Tuggeranong",
    a: [149.066, -35.24], // Belconnen
    b: [149.088, -35.415], // Tuggeranong
  },
  {
    id: "dickson-woden",
    label: "Dickson → Woden",
    a: [149.14, -35.252], // Dickson
    b: [149.085, -35.345], // Woden
  },
  {
    id: "kingston-belconnen",
    label: "Kingston → Belconnen",
    a: [149.147, -35.316], // Kingston
    b: [149.066, -35.24], // Belconnen
  },
];
