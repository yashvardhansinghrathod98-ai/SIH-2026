// privacy/ocr-quality/ocr-quality-filter.js
// Production component: Filters raw OCR words by confidence to create a cleaner context for Rampart NER.
// Preserves raw OCR words completely untouched for the Regex branch.

class OCRQualityFilter {
  // Initial engineering threshold: 50% confidence (configurable)
  static MIN_RAMPART_OCR_CONFIDENCE = 0.50;

  /**
   * Filters raw OCR words based on quality metrics (primarily confidence).
   * Does NOT mutate the input array or word objects.
   *
   * @param {Array<Object>} rawWords - Array of { text, confidence, bbox }
   * @param {Object} [options={}]
   * @param {number} [options.minConfidence=0.50] - Minimum confidence threshold (0.0-1.0 or 0-100)
   * @returns {{ acceptedWords: Array<Object>, rejectedWords: Array<Object>, stats: Object }}
   */
  static filter(rawWords, options = {}) {
    if (!Array.isArray(rawWords) || rawWords.length === 0) {
      return {
        acceptedWords: [],
        rejectedWords: [],
        stats: { total: 0, accepted: 0, rejected: 0, threshold: this.MIN_RAMPART_OCR_CONFIDENCE }
      };
    }

    const rawMinConf = (typeof options.minConfidence === "number")
      ? options.minConfidence
      : this.MIN_RAMPART_OCR_CONFIDENCE;

    // Normalize threshold to 0.0 - 1.0 scale
    const threshold = rawMinConf > 1 ? rawMinConf / 100 : rawMinConf;

    const acceptedWords = [];
    const rejectedWords = [];

    for (const word of rawWords) {
      if (!word) continue;

      // Basic sanity check: text must be non-empty string
      if (typeof word.text !== "string" || !word.text.trim()) {
        rejectedWords.push({
          word,
          reason: "empty_text",
          confidence: word.confidence ?? 0
        });
        continue;
      }

      // Basic sanity check: bbox must have valid numeric coordinates
      if (!word.bbox ||
          typeof word.bbox.x !== "number" ||
          typeof word.bbox.y !== "number" ||
          typeof word.bbox.width !== "number" ||
          typeof word.bbox.height !== "number" ||
          word.bbox.width <= 0 ||
          word.bbox.height <= 0) {
        rejectedWords.push({
          word,
          reason: "invalid_bbox",
          confidence: word.confidence ?? 0
        });
        continue;
      }

      // Normalize word confidence to 0.0 - 1.0 scale
      const rawConf = typeof word.confidence === "number" ? word.confidence : 0;
      const normalizedConf = rawConf > 1 ? rawConf / 100 : rawConf;

      if (normalizedConf < threshold) {
        rejectedWords.push({
          word,
          reason: "low_confidence",
          confidence: normalizedConf,
          threshold
        });
        continue;
      }

      // Preserved original word object without mutation
      acceptedWords.push(word);
    }

    return {
      acceptedWords,
      rejectedWords,
      stats: {
        total: rawWords.length,
        accepted: acceptedWords.length,
        rejected: rejectedWords.length,
        threshold
      }
    };
  }
}

if (typeof self !== "undefined") {
  self.OCRQualityFilter = OCRQualityFilter;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { OCRQualityFilter };
}
