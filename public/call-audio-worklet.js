class CallAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(320);
    this.offset = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.sum += sample;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.samples[this.offset++] = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples, [this.samples.buffer]);
        this.samples = new Float32Array(320);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('zalo-call-audio', CallAudioCapture);
