// privacy/test-privacy-pipeline.js
// Isolated Test Suite for PrivacyPipeline Orchestration Layer (Milestone 3A - All Raw Detections)

const { PrivacyPipeline } = require("./privacy-pipeline.js");
const { PIISource, PIIType } = require("./pii-detector/pii-types.js");

async function runPipelineTestSuite() {
  console.log("==================================================");
  console.log(" PRIVACY PIPELINE ORCHESTRATION TEST SUITE");
  console.log(" Logical Architecture: DOM + OCR + Rampart -> All Raw Detections");
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

  try {
    // ----------------------------------------------------
    // FIXTURE DATA: Simulating all 4 detection branches
    // ----------------------------------------------------

    // Branch 1 Input: DOM Form Elements
    const mockPageState = {
      elements: [
        { id: "e1", tag: "input", type: "password", name: "user_pass", bbox: { x: 10, y: 10, width: 200, height: 30 } },
        { id: "e2", tag: "input", type: "email", name: "user_email", bbox: { x: 10, y: 50, width: 200, height: 30 } },
        { id: "e3", tag: "input", type: "tel", name: "user_phone", bbox: { x: 10, y: 90, width: 200, height: 30 } },
        { id: "e4", tag: "input", type: "text", name: "search_query", bbox: { x: 10, y: 130, width: 200, height: 30 } }
      ]
    };

    // Branch 2 Input: Visible DOM Text Regions
    const mockDOMTextRegions = [
      {
        elementId: "t1",
        text: "Support contact: support@example.com for help.",
        bbox: { x: 20, y: 200, width: 300, height: 20 }
      },
      {
        elementId: "t2",
        text: "Emergency helpline: 9876543210 available 24/7.",
        bbox: { x: 20, y: 230, width: 300, height: 20 }
      },
      {
        elementId: "t3",
        text: "Test Card: 4111 1111 1111 1111 (Visa).",
        bbox: { x: 20, y: 260, width: 300, height: 20 }
      }
    ];

    // Branch 3 Input: OCR Word-Level Results
    const mockOCRResults = [
      { text: "Event", bbox: { x: 20, y: 300, width: 40, height: 16 } },
      { text: "organizer@example.com", bbox: { x: 75, y: 300, width: 150, height: 16 } },
      { text: "Phone:", bbox: { x: 20, y: 330, width: 45, height: 16 } },
      { text: "9876543210", bbox: { x: 70, y: 330, width: 80, height: 16 } }
    ];

    // Branch 4 Input: Contextual Text Items for Rampart + Spatial Mapper
    const mockContextualTexts = [
      {
        text: "I live at 123 Main Street.",
        ocrWords: [
          { text: "I", bbox: { x: 10, y: 400, width: 8, height: 18 } },
          { text: "live", bbox: { x: 24, y: 400, width: 32, height: 18 } },
          { text: "at", bbox: { x: 62, y: 400, width: 16, height: 18 } },
          { text: "123", bbox: { x: 84, y: 400, width: 28, height: 18 } },
          { text: "Main", bbox: { x: 118, y: 398, width: 42, height: 20 } },
          { text: "Street.", bbox: { x: 166, y: 400, width: 60, height: 18 } }
        ]
      },
      {
        text: "My name is John Smith."
        // Notice: No spatial geometry provided, bbox should remain null
      }
    ];

    // ----------------------------------------------------
    // EXECUTE FULL PIPELINE
    // ----------------------------------------------------
    const result = await PrivacyPipeline.execute({
      pageState: mockPageState,
      domTextRegions: mockDOMTextRegions,
      ocrResults: mockOCRResults,
      contextualTexts: mockContextualTexts
    });

    const { allRawDetections, bySource, trace } = result;

    console.log("\n==================================================");
    console.log(" VERIFYING PIPELINE TRACING & SPECIFICATIONS");
    console.log("==================================================");

    // 1. Trace Verification: Branch 1 (DOM Structural)
    assert(bySource.DOM.length === 3, `Branch 1 (DOM Structural) produced 3 detections (got ${bySource.DOM.length})`);
    assert(bySource.DOM.some(d => d.type === "PASSWORD" && d.source === "DOM"), "Branch 1 contains PASSWORD detection");
    assert(bySource.DOM.some(d => d.type === "EMAIL" && d.source === "DOM"), "Branch 1 contains EMAIL detection");
    assert(bySource.DOM.some(d => d.type === "PHONE" && d.source === "DOM"), "Branch 1 contains PHONE detection");
    assert(bySource.DOM.every(d => d.text === null), "Security Check: DOM Structural detections never expose text values");

    // 2. Trace Verification: Branch 2 (DOM Visible Text + Regex)
    assert(bySource.DOM_TEXT.length === 3, `Branch 2 (DOM Text + Regex) produced 3 detections (got ${bySource.DOM_TEXT.length})`);
    assert(bySource.DOM_TEXT.some(d => d.type === "EMAIL" && d.text === "support@example.com"), "Branch 2 contains email from DOM text");
    assert(bySource.DOM_TEXT.some(d => d.type === "PHONE" && d.text === "9876543210"), "Branch 2 contains phone from DOM text");
    assert(bySource.DOM_TEXT.some(d => d.type === "CARD" && d.text === "4111 1111 1111 1111"), "Branch 2 contains card from DOM text");
    assert(bySource.DOM_TEXT.every(d => d.source === "DOM_TEXT"), "Branch 2 all have source 'DOM_TEXT'");

    // 3. Trace Verification: Branch 3 (Screenshot -> OCR -> Regex)
    assert(bySource.OCR.length === 2, `Branch 3 (OCR + Regex) produced 2 detections (got ${bySource.OCR.length})`);
    assert(bySource.OCR.some(d => d.type === "EMAIL" && d.text === "organizer@example.com"), "Branch 3 contains email from OCR");
    assert(bySource.OCR.some(d => d.type === "PHONE" && d.text === "9876543210"), "Branch 3 contains phone from OCR");
    assert(bySource.OCR.every(d => d.source === "OCR"), "Branch 3 all have source 'OCR'");

    // 4. Trace Verification: Branch 4 (Contextual Text -> Rampart -> Spatial Mapper)
    assert(bySource.RAMPART.length === 4, `Branch 4 (Rampart + Spatial) produced 4 detections (got ${bySource.RAMPART.length})`);
    assert(bySource.RAMPART.every(d => d.source === "RAMPART"), "Branch 4 all have source 'RAMPART'");

    const bldg = bySource.RAMPART.find(d => d.type === "BUILDING_NUMBER");
    const street = bySource.RAMPART.find(d => d.type === "STREET_NAME");
    const john = bySource.RAMPART.find(d => d.type === "GIVEN_NAME");
    const smith = bySource.RAMPART.find(d => d.type === "SURNAME");

    assert(Boolean(bldg && bldg.text === "123" && bldg.bbox), "Branch 4: Building number grounded with bbox");
    assert(Boolean(street && street.text === "Main Street" && street.bbox), "Branch 4: Street name grounded with union bbox");
    assert(street.bbox.x === 118 && street.bbox.width === 108, "Branch 4: Multi-word union bbox geometry is exact");

    // Check cases where bbox remains null (Requirement 4)
    assert(Boolean(john && john.text === "John" && john.bbox === null), "Branch 4: John has bbox = null (no spatial geometry provided)");
    assert(Boolean(smith && smith.text === "Smith" && smith.bbox === null), "Branch 4: Smith has bbox = null (no spatial geometry provided)");

    // 5. ALL RAW DETECTIONS Aggregation Verification
    const expectedTotal = bySource.DOM.length + bySource.DOM_TEXT.length + bySource.OCR.length + bySource.RAMPART.length;
    assert(allRawDetections.length === expectedTotal, `ALL RAW DETECTIONS contains all ${expectedTotal} detections without omission`);

    // Verify duplicate retention (NO deduplication or merging)
    const phoneDetections = allRawDetections.filter(d => d.type === "PHONE");
    assert(phoneDetections.length >= 3, `Duplicate Retention: Multiple PHONE detections preserved across DOM, DOM_TEXT, OCR (found ${phoneDetections.length})`);

    const emailDetections = allRawDetections.filter(d => d.type === "EMAIL");
    assert(emailDetections.length >= 3, `Duplicate Retention: Multiple EMAIL detections preserved across DOM, DOM_TEXT, OCR (found ${emailDetections.length})`);

    // Verify absence of post-processing
    assert(allRawDetections.every(d => d.fusedConfidence === undefined), "Constraint Check: NO fused confidence calculated");
    assert(allRawDetections.every(d => d.redacted === undefined), "Constraint Check: NO redaction performed");

    // Print summary trace
    console.log("\n==================================================");
    console.log(" TRACE CONFIRMATION:");
    console.log(` DOM → structural PII:                 ${trace.domStructuralCount} detections`);
    console.log(` DOM → visible text → Regex:           ${trace.domTextRegexCount} detections`);
    console.log(` Screenshot → OCR → Regex:             ${trace.ocrRegexCount} detections`);
    console.log(` Contextual text → Rampart → Spatial:  ${trace.rampartSpatialCount} detections`);
    console.log(` ------------------------------------------------`);
    console.log(` ALL RAW DETECTIONS TOTAL:             ${trace.totalRawDetections} detections`);
    console.log("==================================================");

    console.log(`\nTEST SUMMARY: ${passed} Passed, ${failed} Failed\n`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Fatal pipeline test error:", err);
    process.exit(1);
  }
}

runPipelineTestSuite();
