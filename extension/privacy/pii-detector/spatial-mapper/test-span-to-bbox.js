// privacy/pii-detector/spatial-mapper/test-span-to-bbox.js
// Isolated Test Suite for SpanToBBox Spatial Grounding Layer (Milestone 3A - Chunk 2B)

const { SpanToBBox } = require("./span-to-bbox.js");
const { RampartDetector } = require("../ner-detector/rampart-detector.js");

async function runTestSuite() {
  console.log("==================================================");
  console.log(" MILESTONE 3A - CHUNK 2B: SPAN-TO-BBOX TEST");
  console.log(" Spatial Grounding Layer for PII Detections");
  console.log("==================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST SET 1: OCR Spatial Grounding - Single & Multiple Entities
  // ----------------------------------------------------
  console.log("--- TEST SET 1: OCR Spatial Mapping (My name is John Smith.) ---");
  const text1 = "My name is John Smith.";

  // Mocked OCR word-level output from Tesseract
  const ocrWords1 = [
    { text: "My", bbox: { x: 10, y: 100, width: 25, height: 20 } },
    { text: "name", bbox: { x: 40, y: 100, width: 45, height: 20 } },
    { text: "is", bbox: { x: 90, y: 100, width: 18, height: 20 } },
    { text: "John", bbox: { x: 115, y: 100, width: 42, height: 20 } },
    { text: "Smith.", bbox: { x: 162, y: 100, width: 55, height: 20 } }
  ];

  const spatialCtx1 = {
    ocrWords: ocrWords1,
    sourceText: text1
  };

  // Run real Rampart detector on text1
  const detections1 = await RampartDetector.detect(text1);
  const grounded1 = SpanToBBox.groundDetections(detections1, spatialCtx1);

  console.log("Grounded Detections 1:\n", JSON.stringify(grounded1, null, 2));

  assert(grounded1.length === 2, "Test 1: 2 detections returned");

  const johnDet = grounded1.find(d => d.type === "GIVEN_NAME");
  const smithDet = grounded1.find(d => d.type === "SURNAME");

  assert(Boolean(johnDet && johnDet.bbox), "Test 1: John received a bounding box");
  assert(
    johnDet && johnDet.bbox &&
    johnDet.bbox.x === 115 && johnDet.bbox.y === 100 &&
    johnDet.bbox.width === 42 && johnDet.bbox.height === 20,
    `Test 1: John bbox matches Word 3: {x:115, y:100, width:42, height:20}`
  );

  assert(Boolean(smithDet && smithDet.bbox), "Test 1: Smith received a bounding box");
  assert(
    smithDet && smithDet.bbox &&
    smithDet.bbox.x === 162 && smithDet.bbox.y === 100 &&
    smithDet.bbox.width === 55 && smithDet.bbox.height === 20,
    `Test 1: Smith bbox matches Word 4: {x:162, y:100, width:55, height:20}`
  );

  // Edge case check: multiple entities in one region have distinct non-overlapping bboxes
  assert(
    johnDet.bbox.x !== smithDet.bbox.x,
    "Test 1 (Edge Case): Multiple entities in one region have distinct non-identical bboxes"
  );

  // ----------------------------------------------------
  // TEST SET 2: OCR Spatial Grounding - Multi-Word Union Entity
  // ----------------------------------------------------
  console.log("\n--- TEST SET 2: OCR Multi-Word Union (I live at 123 Main Street.) ---");
  const text2 = "I live at 123 Main Street.";

  const ocrWords2 = [
    { text: "I", bbox: { x: 10, y: 200, width: 8, height: 18 } },
    { text: "live", bbox: { x: 24, y: 200, width: 32, height: 18 } },
    { text: "at", bbox: { x: 62, y: 200, width: 16, height: 18 } },
    { text: "123", bbox: { x: 84, y: 200, width: 28, height: 18 } },
    { text: "Main", bbox: { x: 118, y: 198, width: 42, height: 20 } },
    { text: "Street.", bbox: { x: 166, y: 200, width: 60, height: 18 } }
  ];

  const spatialCtx2 = {
    ocrWords: ocrWords2,
    sourceText: text2
  };

  const detections2 = await RampartDetector.detect(text2);
  const grounded2 = SpanToBBox.groundDetections(detections2, spatialCtx2);

  console.log("Grounded Detections 2:\n", JSON.stringify(grounded2, null, 2));

  assert(grounded2.length === 2, "Test 2: 2 detections returned");

  const bldgDet = grounded2.find(d => d.type === "BUILDING_NUMBER");
  const streetDet = grounded2.find(d => d.type === "STREET_NAME");

  assert(
    bldgDet && bldgDet.bbox &&
    bldgDet.bbox.x === 84 && bldgDet.bbox.y === 200 &&
    bldgDet.bbox.width === 28 && bldgDet.bbox.height === 18,
    "Test 2 (Single Word): Building number bbox matches Word 3: {x:84, y:200, width:28, height:18}"
  );

  // Expected Union for "Main" (x:118, y:198, w:42, h:20) + "Street." (x:166, y:200, w:60, h:18):
  // minX = 118, minY = 198, maxX = 166+60 = 226, maxY = 198+20 = 218 -> width = 108, height = 20
  assert(Boolean(streetDet && streetDet.bbox), "Test 2: Street name received a bounding box");
  assert(
    streetDet && streetDet.bbox &&
    streetDet.bbox.x === 118 && streetDet.bbox.y === 198 &&
    streetDet.bbox.width === 108 && streetDet.bbox.height === 20,
    `Test 2 (Multi-Word Union): Street name bbox is exact union: {x:118, y:198, width:108, height:20}`
  );

  // ----------------------------------------------------
  // TEST SET 3: Edge Cases - Geometry Availability & Malformed Offsets
  // ----------------------------------------------------
  console.log("\n--- TEST SET 3: Edge Cases ---");

  // 3.1 Entity with no available geometry
  const noGeomResult = SpanToBBox.getBBoxForSpan(10, 15, {});
  assert(noGeomResult === null, "Edge Case 3.1: No spatial context returns bbox = null");

  // 3.2 Coarse region-only context (Requirement 4: Do not pretend coarse region is precise entity bbox)
  const regionOnlyResult = SpanToBBox.getBBoxForSpan(10, 15, {
    bbox: { x: 10, y: 10, width: 300, height: 40 }
  });
  assert(regionOnlyResult === null, "Edge Case 3.2: Coarse region-only context returns bbox = null (avoids false precision)");

  // 3.3 Null / undefined / empty spatial context
  assert(SpanToBBox.getBBoxForSpan(10, 15, null) === null, "Edge Case 3.3a: null context returns null");
  assert(SpanToBBox.getBBoxForSpan(10, 15, undefined) === null, "Edge Case 3.3b: undefined context returns null");

  // 3.4 Malformed offsets
  assert(SpanToBBox.getBBoxForSpan(null, null, spatialCtx1) === null, "Edge Case 3.4a: null offsets return null");
  assert(SpanToBBox.getBBoxForSpan(undefined, undefined, spatialCtx1) === null, "Edge Case 3.4b: undefined offsets return null");
  assert(SpanToBBox.getBBoxForSpan(-5, 10, spatialCtx1) === null, "Edge Case 3.4c: negative start offset returns null");
  assert(SpanToBBox.getBBoxForSpan(20, 10, spatialCtx1) === null, "Edge Case 3.4d: start >= end offset returns null");
  assert(SpanToBBox.getBBoxForSpan("10", "15", spatialCtx1) === null, "Edge Case 3.4e: non-number offsets return null");

  // 3.5 Out of range offsets
  assert(SpanToBBox.getBBoxForSpan(500, 520, spatialCtx1) === null, "Edge Case 3.5: offsets out of text range return null");

  // ----------------------------------------------------
  // TEST SET 4: DOM Text Node Mapping (Mocked Range Environment)
  // ----------------------------------------------------
  console.log("\n--- TEST SET 4: DOM Text Node Range Mapping ---");

  // Mock DOM Text Node & Document Range API for Node environment
  const mockText = "Contact organizer@example.com for info.";
  const mockTextNode = {
    nodeValue: mockText,
    textContent: mockText
  };

  global.document = {
    createRange: () => ({
      setStart: (node, start) => {},
      setEnd: (node, end) => {},
      getClientRects: () => [{ left: 75.2, top: 50.4, width: 149.8, height: 16.2 }],
      getBoundingClientRect: () => ({ left: 75.2, top: 50.4, width: 149.8, height: 16.2 })
    })
  };

  const domBBox = SpanToBBox.fromDOMTextNode(mockTextNode, 8, 29);
  assert(Boolean(domBBox), "Test 4: DOM Range mapping produced bounding box");
  assert(
    domBBox && domBBox.x === 75 && domBBox.y === 50 && domBBox.width === 150 && domBBox.height === 16,
    `Test 4: DOM Range bbox rounded properly: {x:75, y:50, width:150, height:16}`
  );

  // DOM Range out of range check
  const domOutOfRange = SpanToBBox.fromDOMTextNode(mockTextNode, 50, 60);
  assert(domOutOfRange === null, "Test 4: DOM offset beyond node length returns null");

  // Clean up global mock
  delete global.document;

  // ----------------------------------------------------
  // TEST SET 5: Preservation of Original Detection Properties
  // ----------------------------------------------------
  console.log("\n--- TEST SET 5: Property Preservation ---");
  const origDet = detections1[0];
  const groundedDet = grounded1[0];

  assert(groundedDet.type === origDet.type, "Property Preservation: type is preserved");
  assert(groundedDet.source === origDet.source, "Property Preservation: source is preserved ('RAMPART')");
  assert(groundedDet.text === origDet.text, "Property Preservation: text is preserved");
  assert(groundedDet.confidence === origDet.confidence, "Property Preservation: confidence is preserved");
  assert(groundedDet.start === origDet.start, "Property Preservation: start offset is preserved");
  assert(groundedDet.end === origDet.end, "Property Preservation: end offset is preserved");

  // ----------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------
  console.log("\n==================================================");
  console.log(` SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite();
