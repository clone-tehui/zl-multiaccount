// RTP sequence numbers wrap at 65536. Bound latency and discard late/duplicate media.
export class CallJitterBuffer {
  constructor({ maxFrames = 6, startupFrames = 3 } = {}) {
    this.maxFrames = maxFrames;
    this.startupFrames = startupFrames;
    this.frames = new Map();
    this.next = null;
    this.started = false;
    this.misses = 0;
  }
  push(sequence, payload) {
    if (this.next === null) this.next = sequence;
    const ahead = (sequence - this.next + 65536) % 65536;
    if (ahead >= 32768) return;
    if (ahead >= this.maxFrames) { this.frames.clear(); this.next = sequence; this.started = false; }
    this.frames.set(sequence, payload);
  }
  take() {
    if (!this.started) {
      if (this.frames.size < this.startupFrames) return null;
      this.started = true;
    }
    const frame = this.frames.get(this.next);
    this.frames.delete(this.next);
    this.next = (this.next + 1) % 65536;
    if (frame) this.misses = 0;
    else if (++this.misses >= this.maxFrames) { this.started = false; this.next = null; this.frames.clear(); }
    return frame || new Uint8Array([0xf8, 0xff, 0xfe]);
  }
}
