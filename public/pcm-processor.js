/**
 * PCM Capture AudioWorklet Processor
 *
 * Runs on the audio rendering thread. Captures raw Float32 PCM samples
 * from the microphone input and forwards them to the main thread via
 * the MessagePort. This replaces the deprecated ScriptProcessorNode
 * which can cause native crashes (0xC0000005) in Electron 28 on Windows.
 *
 * The main thread (DictationPanel) handles downsampling (48kHz→16kHz)
 * and conversion to 16-bit PCM before sending to the STT service.
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufferSize = 4096;
    this._buffer = new Float32Array(this._bufferSize);
    this._bytesWritten = 0;
  }

  /**
   * Called by the audio rendering thread for each 128-sample quantum.
   * We accumulate samples into a larger buffer (~4096 samples) before
   * posting to the main thread, to reduce MessagePort overhead.
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true; // Keep processor alive
    }

    const channelData = input[0]; // Mono channel

    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._bytesWritten++] = channelData[i];

      if (this._bytesWritten >= this._bufferSize) {
        // Buffer full — send a copy to the main thread
        this.port.postMessage({
          type: 'audio',
          samples: this._buffer.slice(0),
        });
        this._bytesWritten = 0;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
