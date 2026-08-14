// Boot script for the /how/ page: wires the theme toggle (same as home.ts)
// and mounts each chapter's interactive toy into its already-present
// data-testid root. Chapter 5 has no mount call yet — its root ships with
// the honest static placeholder baked into how/index.html until Task 11
// adds climb.ts here.

import { initTheme } from "../theme";
import { mountFlood } from "../toys/flood";
import { mountContraction } from "../toys/contraction";
import { mountOrder } from "../toys/order";
import { mountHierarchy } from "../toys/hierarchy";

function boot(): void {
  initTheme();

  const floodRoot = document.querySelector<HTMLElement>('[data-testid="toy-flood"]');
  if (floodRoot) mountFlood(floodRoot);

  const contractionRoot = document.querySelector<HTMLElement>(
    '[data-testid="toy-contraction"]',
  );
  if (contractionRoot) mountContraction(contractionRoot);

  const orderRoot = document.querySelector<HTMLElement>('[data-testid="toy-order"]');
  if (orderRoot) mountOrder(orderRoot);

  // The hierarchy toy fetches the full render.json (the same payload the
  // home page's map uses) and constructs a MapView — real work, not free.
  // Chapter 4 sits below three others, so most visitors haven't scrolled
  // this far on load: defer the fetch + MapView construction until the
  // toy's root actually enters the viewport (IntersectionObserver), same
  // "don't pay for what you haven't scrolled to" reasoning as lazy-loading
  // an image. `io.disconnect()` right after triggering guarantees
  // mountHierarchy runs exactly once (MapView must never be
  // constructed/discarded repeatedly — see hierarchy.ts's own note). Falls
  // back to an eager mount if IntersectionObserver isn't available.
  const hierarchyRoot = document.querySelector<HTMLElement>('[data-testid="toy-hierarchy"]');
  if (hierarchyRoot) {
    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          mountHierarchy(hierarchyRoot);
          io.disconnect();
        }
      });
      io.observe(hierarchyRoot);
    } else {
      mountHierarchy(hierarchyRoot);
    }
  }
}

boot();
