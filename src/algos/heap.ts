// indexed binary min-heap over node ids
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private pos: Int32Array; // node id -> heap slot, -1 = absent
  private count = 0;

  constructor(n: number) {
    this.ids = new Int32Array(n);
    this.keys = new Float64Array(n);
    this.pos = new Int32Array(n).fill(-1);
  }

  get size(): number { return this.count; }

  clear(): void { this.pos.fill(-1); this.count = 0; }

  update(id: number, key: number): void {
    let i = this.pos[id];
    if (i === -1) { i = this.count++; this.ids[i] = id; this.pos[id] = i; }
    else if (key >= this.keys[this.ids[i]]) return;
    this.keys[id] = key;
    this.siftUp(i);
  }

  pop(): number {
    if (this.count === 0) return -1;
    const top = this.ids[0];
    this.pos[top] = -1;
    this.count--;
    if (this.count > 0) {
      this.ids[0] = this.ids[this.count];
      this.pos[this.ids[0]] = 0;
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
