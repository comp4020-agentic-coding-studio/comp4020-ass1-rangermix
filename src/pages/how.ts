// Boot script for the /how/ page: wires the theme toggle (same as home.ts)
// and mounts each chapter's interactive toy into its already-present
// data-testid root. Chapters 3-5 have no mount call yet — their root ships
// with the honest static placeholder baked into how/index.html until
// Tasks 10/11 add order.ts, hierarchy.ts, and climb.ts here.

import { initTheme } from "../theme";
import { mountFlood } from "../toys/flood";
import { mountContraction } from "../toys/contraction";

function boot(): void {
  initTheme();

  const floodRoot = document.querySelector<HTMLElement>('[data-testid="toy-flood"]');
  if (floodRoot) mountFlood(floodRoot);

  const contractionRoot = document.querySelector<HTMLElement>(
    '[data-testid="toy-contraction"]',
  );
  if (contractionRoot) mountContraction(contractionRoot);
}

boot();
