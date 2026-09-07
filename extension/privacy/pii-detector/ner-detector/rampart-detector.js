// privacy/pii-detector/ner-detector/rampart-detector.js
// Isolated PII NER Detector using nationaldesignstudio/rampart via Transformers.js

if (typeof ModelLoader === "undefined" && typeof require !== "undefined") {
  const loaderModule = require("./model-loader.js");
  global.ModelLoader = loaderModule.ModelLoader || loaderModule;
}

if (typeof RampartAdapter === "undefined" && typeof require !== "undefined") {
  const adapterModule = require("./rampart-adapter.js");
  global.RampartAdapter = adapterModule.RampartAdapter || adapterModule;
}

class RampartDetector {
  /**
   * Performs token-classification on the provided text using Rampart and converts
   * the output into standardized PIIDetection[] objects.
   *
   * @param {string} text - Input text to scan
   * @param {Object} [options={}] - Optional metadata (elementId, bbox)
   * @returns {Promise<Array<Object>>} Standardized PIIDetection[] objects
   */
  static async detect(text, options = {}) {
    if (!text || typeof text !== "string") {
      return [];
    }

    // 1. Ensure model is loaded via ModelLoader
    const Loader = (typeof ModelLoader !== "undefined") ? ModelLoader : (typeof self !== "undefined" ? self.ModelLoader : null);
    if (!Loader) {
      throw new Error("ModelLoader is not available in the current environment.");
    }

    const classifier = await Loader.getPipeline();
    const provider = Loader.getExecutionProvider() || "Unknown";

    // 2. Measure inference time
    const startTime = (typeof performance !== "undefined") ? performance.now() : Date.now();
    const rawResults = await classifier(text);
    const endTime = (typeof performance !== "undefined") ? performance.now() : Date.now();
    const inferenceTimeMs = Math.round((endTime - startTime) * 100) / 100;

    // 3. Convert raw token-classification results to standardized PIIDetection schema
    const Adapter = (typeof RampartAdapter !== "undefined") ? RampartAdapter : (typeof self !== "undefined" ? self.RampartAdapter : null);
    if (!Adapter) {
      throw new Error("RampartAdapter is not available in the current environment.");
    }

    const detections = Adapter.toPIIDetections(rawResults, text, options);

    // 4. Extract diagnostic summary
    const detectedLabels = [...new Set(detections.map(d => d.type))];
    const scoreSummary = detections.map(d => ({
      type: d.type,
      text: d.text,
      confidence: d.confidence,
      start: d.start,
      end: d.end
    }));

    // 5. Diagnostic Logging
    console.log("------------------------------------------");
    console.log("[RampartDetector] Inference Complete");
    console.log(`- Model: ${Loader.MODEL_ID} (${Loader.DTYPE})`);
    console.log(`- Execution Provider: ${provider}`);
    console.log(`- Inference Time: ${inferenceTimeMs} ms`);
    console.log(`- Raw Tokens Count: ${rawResults.length}`);
    console.log(`- Final PII Detections Count: ${detections.length}`);
    console.log(`- Detected PII Types:`, detectedLabels);
    console.log(`- Detected Entities Summary:`, scoreSummary);
    console.log("------------------------------------------");

    return detections;
  }

  /**
   * Helper method to retrieve raw token-classification output without schema conversion.
   *
   * @param {string} text - Input text to scan
   * @returns {Promise<Array<Object>>} Raw token-classification objects
   */
  static async detectRaw(text) {
    if (!text || typeof text !== "string") {
      return [];
    }
    const Loader = (typeof ModelLoader !== "undefined") ? ModelLoader : (typeof self !== "undefined" ? self.ModelLoader : null);
    const classifier = await Loader.getPipeline();
    return classifier(text);
  }
}

if (typeof self !== "undefined") {
  self.RampartDetector = RampartDetector;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { RampartDetector };
}
