// One clock owns RTP audio. Never replay a TCP burst as a burst of UDP packets.
export class VoiceFramePacer {
  constructor(send, { now = () => performance.now(), maxFrames = 3 } = {}) {
    this.send = send;
    this.now = now;
    this.maxFrames = maxFrames;
    this.queue = [];
    this.busy = false;
    this.closed = false;
    this.dropped = 0;
  }
  push(payload) {
    if (this.closed || !payload.length || payload.length > 4096) return;
    this.queue.push({ payload: Buffer.from(payload), at: this.now() });
    while (this.queue.length > this.maxFrames) { this.queue.shift(); this.dropped++; }
  }
  async tick() {
    if (this.closed || this.busy) return;
    const now = this.now();
    while (this.queue.length && now - this.queue[0].at > 60) { this.queue.shift(); this.dropped++; }
    this.busy = true;
    try { await this.send(this.queue.shift()?.payload || Buffer.from([0xf8, 0xff, 0xfe])); }
    finally { this.busy = false; }
  }
  start(onError) {
    this.timer = setInterval(() => { void this.tick().catch(onError); }, 20);
    this.timer.unref?.();
  }
  close() { this.closed = true; clearInterval(this.timer); this.queue.length = 0; }
}
