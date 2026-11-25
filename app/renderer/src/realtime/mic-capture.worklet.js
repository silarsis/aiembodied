// Mic capture worklet (runs in AudioWorkletGlobalScope, so no imports). Replaces the deprecated
// ScriptProcessorNode: gathers the 128-sample render quanta of the first input channel into fixed
// frames of `processorOptions.frameSize` samples (default 2048) and posts each full frame, in order,
// to the main thread, transferring its buffer. Outputs are left untouched (silence).
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options && options.processorOptions && options.processorOptions.frameSize;
    this.frameSize = Number.isInteger(requested) && requested > 0 ? requested : 2048;
    this.frame = new Float32Array(this.frameSize);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      return true;
    }
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.frameSize - this.filled);
      this.frame.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.frameSize) {
        const full = this.frame;
        this.frame = new Float32Array(this.frameSize);
        this.filled = 0;
        this.port.postMessage(full, [full.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('aiembodied-mic-capture', MicCaptureProcessor);
