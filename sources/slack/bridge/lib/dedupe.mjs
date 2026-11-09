// Bounded memory of recently seen keys, oldest forgotten first.
export class Recent {
  constructor(limit = 5000) {
    this.limit = limit;
    this.keys = new Set();
  }

  has(key) {
    return this.keys.has(key);
  }

  // True the first time a key is seen, false while it is remembered.
  remember(key) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.limit) this.keys.delete(this.keys.values().next().value);
    return true;
  }
}
