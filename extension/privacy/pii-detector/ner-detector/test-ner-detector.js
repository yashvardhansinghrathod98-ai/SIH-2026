// privacy/pii-detector/ner-detector/test-ner-detector.js
// Isolated Test Suite for Rampart PII NER Detector & Adapter (Milestone 3A - Chunk 2)

const { ModelLoader } = require("./model-loader.js");
const { RampartAdapter } = require("./rampart-adapter.js");
const { RampartDetector } = require("./rampart-detector.js");

async function runTestSuite() {
  console.log("==================================================");
  console.log(" MILESTONE 3A - CHUNK 2: RAMPART ADAPTER TEST");
  console.log(" Schema: PIIDetection Conversion & Offset Test");
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
    // INITIALIZATION
    // ----------------------------------------------------
    console.log("--- Initializing Rampart Pipeline ---");
    const tInitStart = Date.now();
    await ModelLoader.getPipeline();
    const initDuration = Date.now() - tInitStart;
    const provider = ModelLoader.getExecutionProvider();
    console.log(`Model ready in ${initDuration} ms. Provider: ${provider}\n`);

    // ----------------------------------------------------
    // TEST CASE A: "My name is John Smith."
    // ----------------------------------------------------
    console.log("==================================================");
    console.log("TEST A: Name Entities");
    console.log("==================================================");
    const textA = "My name is John Smith.";
    console.log(`Input: "${textA}"`);

    const detectionsA = await RampartDetector.detect(textA);
    console.log("PIIDetection[] Output:\n", JSON.stringify(detectionsA, null, 2));

    assert(detectionsA.length === 2, "Test A: Exactly 2 PII detections returned");

    const givenName = detectionsA.find(d => d.type === "GIVEN_NAME");
    const surname = detectionsA.find(d => d.type === "SURNAME");

    assert(Boolean(givenName), "Test A: Found GIVEN_NAME entity");
    assert(givenName && givenName.text === "John", `Test A: GIVEN_NAME text is "John" (got "${givenName?.text}")`);
    assert(givenName && givenName.source === "RAMPART", "Test A: Source is 'RAMPART'");
    assert(givenName && typeof givenName.confidence === "number" && givenName.confidence > 0.8, `Test A: Confidence is valid (${givenName?.confidence})`);
    assert(givenName && givenName.start === 11 && givenName.end === 15, `Test A: Exact character offsets for "John" [11..15] (got [${givenName?.start}..${givenName?.end}])`);

    assert(Boolean(surname), "Test A: Found SURNAME entity");
    assert(surname && surname.text === "Smith", `Test A: SURNAME text is "Smith" (got "${surname?.text}")`);
    assert(surname && surname.source === "RAMPART", "Test A: Source is 'RAMPART'");
    assert(surname && surname.start === 16 && surname.end === 21, `Test A: Exact character offsets for "Smith" [16..21] (got [${surname?.start}..${surname?.end}])`);

    // ----------------------------------------------------
    // TEST CASE B: "My email is john.smith@example.com."
    // ----------------------------------------------------
    console.log("\n==================================================");
    console.log("TEST B: Subword & Punctuation Reconstruction (Email)");
    console.log("==================================================");
    const textB = "My email is john.smith@example.com.";
    console.log(`Input: "${textB}"`);

    const detectionsB = await RampartDetector.detect(textB);
    console.log("PIIDetection[] Output:\n", JSON.stringify(detectionsB, null, 2));

    assert(detectionsB.length === 1, "Test B: Exactly 1 PII detection returned");
    const emailDet = detectionsB[0];

    assert(emailDet && emailDet.type === "EMAIL", `Test B: Type is EMAIL (got "${emailDet?.type}")`);
    assert(emailDet && emailDet.text === "john.smith@example.com", `Test B: Reconstructed email is "john.smith@example.com" (got "${emailDet?.text}")`);
    assert(emailDet && emailDet.source === "RAMPART", "Test B: Source is 'RAMPART'");
    assert(emailDet && emailDet.start === 12 && emailDet.end === 34, `Test B: Exact character offsets [12..34] (got [${emailDet?.start}..${emailDet?.end}])`);

    // ----------------------------------------------------
    // TEST CASE C: "I live at 123 Main Street."
    // ----------------------------------------------------
    console.log("\n==================================================");
    console.log("TEST C: Address & BIO Grouping (Building & Street)");
    console.log("==================================================");
    const textC = "I live at 123 Main Street.";
    console.log(`Input: "${textC}"`);

    const detectionsC = await RampartDetector.detect(textC);
    console.log("PIIDetection[] Output:\n", JSON.stringify(detectionsC, null, 2));

    assert(detectionsC.length === 2, "Test C: Exactly 2 PII detections returned");

    const bldgDet = detectionsC.find(d => d.type === "BUILDING_NUMBER");
    const streetDet = detectionsC.find(d => d.type === "STREET_NAME");

    assert(Boolean(bldgDet), "Test C: Found BUILDING_NUMBER entity");
    assert(bldgDet && bldgDet.text === "123", `Test C: Building number is "123" (got "${bldgDet?.text}")`);
    assert(bldgDet && bldgDet.start === 10 && bldgDet.end === 13, `Test C: Building number offsets [10..13] (got [${bldgDet?.start}..${bldgDet?.end}])`);

    assert(Boolean(streetDet), "Test C: Found STREET_NAME entity");
    assert(streetDet && streetDet.text === "Main Street", `Test C: Grouped BIO entity B-STREET_NAME + I-STREET_NAME is "Main Street" (got "${streetDet?.text}")`);
    assert(streetDet && streetDet.start === 14 && streetDet.end === 25, `Test C: Street name offsets [14..25] (got [${streetDet?.start}..${streetDet?.end}])`);

    // ----------------------------------------------------
    // TEST CASE D: "My phone number is 9876543210."
    // ----------------------------------------------------
    console.log("\n==================================================");
    console.log("TEST D: Subword '##' Reconstruction (Phone)");
    console.log("==================================================");
    const textD = "My phone number is 9876543210.";
    console.log(`Input: "${textD}"`);

    const detectionsD = await RampartDetector.detect(textD);
    console.log("PIIDetection[] Output:\n", JSON.stringify(detectionsD, null, 2));

    assert(detectionsD.length === 1, "Test D: Exactly 1 PII detection returned");
    const phoneDet = detectionsD[0];

    assert(phoneDet && phoneDet.type === "PHONE", `Test D: Type is PHONE (got "${phoneDet?.type}")`);
    assert(phoneDet && phoneDet.text === "9876543210", `Test D: Reconstructed subword phone is "9876543210" (got "${phoneDet?.text}")`);
    assert(phoneDet && phoneDet.source === "RAMPART", "Test D: Source is 'RAMPART'");
    assert(phoneDet && phoneDet.start === 19 && phoneDet.end === 29, `Test D: Phone number offsets [19..29] (got [${phoneDet?.start}..${phoneDet?.end}])`);

    // ----------------------------------------------------
    // TEST CASE E: Normal Text (No PII)
    // ----------------------------------------------------
    console.log("\n==================================================");
    console.log("TEST E: Normal Text (Zero False Positives)");
    console.log("==================================================");
    const textE = "The quick brown fox jumps over the lazy dog. Today is a sunny day with clear skies.";
    console.log(`Input: "${textE}"`);

    const detectionsE = await RampartDetector.detect(textE);
    console.log("PIIDetection[] Output:\n", JSON.stringify(detectionsE, null, 2));

    assert(Array.isArray(detectionsE), "Test E: Returns array for normal text");
    assert(detectionsE.length === 0, `Test E: Zero detections returned (got ${detectionsE.length})`);

    // ----------------------------------------------------
    // TEST SUMMARY
    // ----------------------------------------------------
    console.log("\n==================================================");
    console.log(` SUMMARY: ${passed} Passed, ${failed} Failed`);
    console.log("==================================================");

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error("❌ Test suite encountered fatal error:", err);
    process.exit(1);
  }
}

runTestSuite();
