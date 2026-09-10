// privacy/pii-detector/pii-types.js
// Standardized PII Detection Schema and Constants

const PIIType = Object.freeze({
  PASSWORD: "PASSWORD",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  CARD: "CARD",
  QR_CODE: "QR_code",
  SIGNATURE: "signature"
});

const PIISource = Object.freeze({
  DOM: "DOM",
  DOM_TEXT: "DOM_TEXT",
  OCR: "OCR",
  QR_YOLO: "QR_YOLO",
  COMBINED_YOLO: "COMBINED_YOLO"
});

/**
 * Creates a standardized PIIDetection object.
 * @param {Object} params
 * @param {string} params.type - PIIType (PASSWORD, EMAIL, PHONE, CARD)
 * @param {string} params.source - PIISource (DOM, DOM_TEXT, OCR)
 * @param {string|null} [params.elementId=null] - Internal element ID (e.g. "e17")
 * @param {string|null} [params.text=null] - Detected text string (NEVER populated for passwords/input values)
 * @param {number} params.confidence - Fixed confidence rating (0.0 - 1.0)
 * @param {string} params.reason - Explanation of detection rule/regex used
 * @param {Object|null} [params.bbox=null] - Bounding box object { x, y, width, height }
 * @returns {Object} PIIDetection object
 */
function createPIIDetection({
  type,
  source,
  elementId = null,
  text = null,
  confidence,
  reason,
  bbox = null
}) {
  // SECURITY REQUIREMENT: Never allow sensitive input values in text field for PASSWORD or DOM inputs
  let sanitizedText = text;
  if (type === PIIType.PASSWORD || source === PIISource.DOM) {
    sanitizedText = null; // Always null for structural DOM/password detections
  }

  return {
    type,
    source,
    elementId,
    text: sanitizedText,
    confidence,
    reason,
    bbox
  };
}

if (typeof self !== "undefined") {
  self.PIIType = PIIType;
  self.PIISource = PIISource;
  self.createPIIDetection = createPIIDetection;
}
