// privacy/pii-detector/text-detector.js
// Reusable Text & Regex PII Detector for DOM Text and OCR Text

class TextDetector {
  /**
   * Scans a text string for PII patterns (EMAIL, PHONE, CARD).
   * @param {string} textContent - Text content to inspect
   * @param {Object} [options]
   * @param {string} [options.source="DOM_TEXT"] - PIISource (DOM_TEXT or OCR)
   * @param {string|null} [options.elementId=null] - Optional element ID
   * @param {Object|null} [options.bbox=null] - Optional bounding box
   * @returns {Array<Object>} Array of PIIDetection objects
   */
  static detect(textContent, options = {}) {
    if (!textContent || typeof textContent !== "string") {
      return [];
    }

    const source = options.source || (typeof PIISource !== "undefined" ? PIISource.DOM_TEXT : "DOM_TEXT");
    const elementId = options.elementId || null;
    const bbox = options.bbox || null;
    const detections = [];

    // 1. EMAIL Detection
    const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/gi;
    let match;
    while ((match = emailRegex.exec(textContent)) !== null) {
      detections.push(
        createPIIDetection({
          type: typeof PIIType !== "undefined" ? PIIType.EMAIL : "EMAIL",
          source: source,
          elementId: elementId,
          text: match[0],
          confidence: 0.99,
          reason: "email-regex",
          bbox: bbox,
          start: match.index,
          end: match.index + match[0].length
        })
      );
    }

    // 2. PHONE Detection (Indian Formats)
    // Matches: +91 9876543210, +91-9876543210, 91 9876543210, 9876543210, +919876543210
    const phoneRegex = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;
    while ((match = phoneRegex.exec(textContent)) !== null) {
      const matchedText = match[0].trim();
      const digitsOnly = matchedText.replace(/\D/g, "");

      // Ensure valid 10-digit or 12-digit (with 91 prefix) mobile number length
      if (digitsOnly.length === 10 || (digitsOnly.length === 12 && digitsOnly.startsWith("91"))) {
        const offsetInMatch = match[0].indexOf(matchedText);
        const matchStart = match.index + (offsetInMatch >= 0 ? offsetInMatch : 0);
        const matchEnd = matchStart + matchedText.length;
        detections.push(
          createPIIDetection({
            type: typeof PIIType !== "undefined" ? PIIType.PHONE : "PHONE",
            source: source,
            elementId: elementId,
            text: matchedText,
            confidence: 0.95,
            reason: "indian-phone-regex",
            bbox: bbox,
            start: matchStart,
            end: matchEnd
          })
        );
      }
    }

    // 3. CARD Detection (Luhn Validated)
    // Matches digit sequences with optional spaces/hyphens (13-19 digits)
    const cardCandidateRegex = /\b(?:\d[ -]*?){13,19}\b/g;
    while ((match = cardCandidateRegex.exec(textContent)) !== null) {
      const matchedText = match[0].trim();
      const digitsOnly = matchedText.replace(/\D/g, "");

      if (TextDetector.isValidLuhn(digitsOnly)) {
        const offsetInMatch = match[0].indexOf(matchedText);
        const matchStart = match.index + (offsetInMatch >= 0 ? offsetInMatch : 0);
        const matchEnd = matchStart + matchedText.length;
        detections.push(
          createPIIDetection({
            type: typeof PIIType !== "undefined" ? PIIType.CARD : "CARD",
            source: source,
            elementId: elementId,
            text: matchedText,
            confidence: 0.99,
            reason: "luhn-card-regex",
            bbox: bbox,
            start: matchStart,
            end: matchEnd
          })
        );
      }
    }

    return detections;
  }

  /**
   * Luhn Algorithm Check for Credit/Debit Cards.
   * @param {string} digits - String of digits only
   * @returns {boolean} True if Luhn checksum is valid
   */
  static isValidLuhn(digits) {
    if (!digits || typeof digits !== "string") return false;
    const cleanDigits = digits.replace(/\D/g, "");
    if (cleanDigits.length < 13 || cleanDigits.length > 19) return false;

    let sum = 0;
    let shouldDouble = false;

    for (let i = cleanDigits.length - 1; i >= 0; i--) {
      let digit = parseInt(cleanDigits.charAt(i), 10);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }

    return sum % 10 === 0;
  }
}

if (typeof self !== "undefined") {
  self.TextDetector = TextDetector;
}
