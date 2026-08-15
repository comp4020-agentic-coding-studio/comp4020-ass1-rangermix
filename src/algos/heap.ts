// indexed binary min-heap over node ids. Presence is generation-stamped
// (see `reset`) rather than tracked with a `-1` sentinel, so a caller that
// keeps one heap instance alive across many searches (dijkstraCsr, chQuery's
// climb()) can start each new search in O(1) instead of re-filling an
// n-sized "absent" array every time. That per-query allocate-and-fill is
// exactly what made repeated CH queries pay GC costs wildly out of
// proportion to the sliver of the graph CH actually touches — see
// dijkstra.ts's and chQuery.ts's own comments on the scratch pools this
// heap gets reused from.
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private pos: Int32Array; // node id -> heap slot; valid only if slotGen[id] === gen
  private slotGen: Int32Array;
  private gen = 1; // 0 is reserved as "never present" so a zero-inited slotGen array starts virgin
  private count = 0;

  constructor(n: number) {
    this.ids = new Int32Array(n);
    this.keys = new Float64Array(n);
    this.pos = new Int32Array(n);
    this.slotGen = new Int32Array(n);
  }

  get size(): number { return this.count; }

  /** O(n) full reset: every entry is dropped immediately, independent of
   * generation. Kept for any one-shot caller that builds a heap and never
   * reuses it (e.g. chBuild.ts's ordering heap) — reuse across queries
   * should call `reset()` instead. */
  clear(): void { this.slotGen.fill(0); this.count = 0; }

  /** O(1) reset for reuse across queries: bumps the generation so every
   * previously-present id reads as absent without touching the n-sized
   * backing arrays. This is what makes a long-lived heap cheap to restart. */
  reset(): void { this.gen++; this.count = 0; }

  private present(id: number): boolean { return this.slotGen[id] === this.gen; }

  update(id: number, key: number): void {
    let i = this.present(id) ? this.pos[id] : -1;
    if (i === -1) {
      i = this.count++;
      this.ids[i] = id;
      this.pos[id] = i;
      this.slotGen[id] = this.gen;
    } else if (key >= this.keys[this.ids[i]]) return;
    this.keys[id] = key;
    this.siftUp(i);
  }

  pop(): number {
    if (this.count === 0) return -1;
    const top = this.ids[0];
    this.slotGen[top] = 0; // 0 never matches a live (>=1) generation: marks absent
    this.count--;
    if (this.count > 0) {
      this.ids[0] = this.ids[this.count];
      this.pos[this.ids[0]] = 0;
      this.slotGen[this.ids[0]] = this.gen; // restore presence for the moved id
      this.siftDown(0);
    }
    return top;
  }

  key(id: number): number { return this.keys[id]; }

  private siftUp(i: number): void {
    const id = this.ids[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[this.ids[p]] <= this.keys[id]) break;
      this.ids[i] = this.ids[p]; this.pos[this.ids[i]] = i; i = p;
    }
    this.ids[i] = id; this.pos[id] = i;
  }

  private siftDown(i: number): void {
    const id = this.ids[i];
    for (;;) {
      let c = i * 2 + 1;
      if (c >= this.count) break;
      if (c + 1 < this.count && this.keys[this.ids[c + 1]] < this.keys[this.ids[c]]) c++;
      if (this.keys[this.ids[c]] >= this.keys[id]) break;
      this.ids[i] = this.ids[c]; this.pos[this.ids[i]] = i; i = c;
    }
    this.ids[i] = id; this.pos[id] = i;
  }
}
