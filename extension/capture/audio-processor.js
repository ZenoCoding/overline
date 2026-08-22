class LiveAudioProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // Post float32 samples to main thread
      this.port.postMessage(input[0]);
    }
    return true;
  }
}

registerProcessor("live-audio-processor", LiveAudioProcessor);
