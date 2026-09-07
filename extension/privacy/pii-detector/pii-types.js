// privacy/pii-detector/pii-types.js
// Standardized PII Detection Schema and Constants

const PIIType = Object.freeze({
  // Structural / Form Input & Deterministic Regex Types
  PASSWORD: "PASSWORD",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  CARD: "CARD",

  // NER / Identity & Location Types (from Rampart / Token-Classification)
  GIVEN_NAME: "GIVEN_NAME",
  SURNAME: "SURNAME",
  NAME: "NAME",
  BUILDING_NUMBER: "BUILDING_NUMBER",
  STREET_NAME: "STREET_NAME",
  SECONDARY_ADDRESS: "SECONDARY_ADDRESS",
  CITY: "CITY",
  STATE: "STATE",
  ZIP_CODE: "ZIP_CODE",
  URL: "URL",
  TAX_ID: "TAX_ID",
  BANK_ACCOUNT: "BANK_ACCOUNT",
  ROUTING_NUMBER: "ROUTING_NUMBER",
  GOVERNMENT_ID: "GOVERNMENT_ID",
  PASSPORT: "PASSPORT",
  DRIVERS_LICENSE: "DRIVERS_LICENSE"
});

const PIISource = Object.freeze({
  DOM: "DOM",
  DOM_TEXT: "DOM_TEXT",
  OCR: "OCR",
  RAMPART: "RAMPART"
});

/**
 * Creates a standardized PIIDetection object.
 * @param {Object} params
 * @param {string} params.type - PIIType (PASSWORD, EMAIL, PHONE, CARD, etc.)
 * @param {string} params.source - PIISource (DOM, DOM_TEXT, OCR, RAMPART)
 * @param {string|null} [params.elementId=null] - Internal element ID (e.g. "e17")
 * @param {string|null} [params.text=null] - Detected text string (NEVER populated for passwords/input values)
 * @param {number} params.confidence - Fixed confidence rating (0.0 - 1.0)
 * @param {string} params.reason - Explanation of detection rule/regex used
 * @param {Object|null} [params.bbox=null] - Bounding box object { x, y, width, height }
 * @param {number|null} [params.start=null] - Start character offset in source text
 * @param {number|null} [params.end=null] - End character offset in source text
 * @returns {Object} PIIDetection object
 */
function createPIIDetection({
  type,
  source,
  elementId = null,
  text = null,
  confidence,
  reason,
  bbox = null,
  start = null,
  end = null
}) {
  // SECURITY REQUIREMENT: Never allow sensitive input values in text field for PASSWORD or DOM inputs
  let sanitizedText = text;
  if (type === PIIType.PASSWORD || source === PIISource.DOM) {
    sanitizedText = null; // Always null for structural DOM/password detections
  }

  const detection = {
    type,
    source,
    elementId,
    text: sanitizedText,
    confidence,
    reason,
    bbox
  };

  // Add character offsets if reliably provided (Requirement 7)
  if (typeof start === "number" && typeof end === "number") {
    detection.start = start;
    detection.end = end;
  }

  return detection;
}

if (typeof self !== "undefined") {
  self.PIIType = PIIType;
  self.PIISource = PIISource;
  self.createPIIDetection = createPIIDetection;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PIIType, PIISource, createPIIDetection };
}
