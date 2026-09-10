document.addEventListener("DOMContentLoaded", () => {
  const inspectBtn = document.getElementById("inspect-btn");
  const captureBtn = document.getElementById("capture-btn");
  const ocrBtn = document.getElementById("ocr-btn");
  const syntheticOcrBtn = document.getElementById("synthetic-ocr-btn");
  const copyBtn = document.getElementById("copy-btn");
  const statusContainer = document.getElementById("status-container");
  const statusMessage = document.getElementById("status-message");
  const metaContainer = document.getElementById("meta-container");
  const metaObsId = document.getElementById("meta-obs-id");
  const metaTitle = document.getElementById("meta-title");
  const metaElements = document.getElementById("meta-elements");
  const metaUrl = document.getElementById("meta-url");
  const jsonOutput = document.getElementById("json-output");
  const outputTitle = document.getElementById("output-title");

  const canvasContainer = document.getElementById("canvas-container");
  const canvasPreview = document.getElementById("canvas-preview");
  const canvasDim = document.getElementById("canvas-dim");

  const piiDebugContainer = document.getElementById("pii-debug-container");
  const piiCount = document.getElementById("pii-count");
  const piiJsonOutput = document.getElementById("pii-json-output");

  const domTextDebugContainer = document.getElementById("dom-text-debug-container");
  const domTextRegionCount = document.getElementById("dom-text-region-count");
  const domTextPiiCount = document.getElementById("dom-text-pii-count");
  const domTextJsonOutput = document.getElementById("dom-text-json-output");

  const ocrPiiDebugContainer = document.getElementById("ocr-pii-debug-container");
  const ocrResultsCount = document.getElementById("ocr-results-count");
  const ocrPiiCount = document.getElementById("ocr-pii-count");
  const ocrPiiJsonOutput = document.getElementById("ocr-pii-json-output");

  const dbgWidth = document.getElementById("dbg-width");
  const dbgHeight = document.getElementById("dbg-height");
  const dbgHasData = document.getElementById("dbg-hasdata");
  const dbgPercent = document.getElementById("dbg-percent");

  let currentJsonData = null;

  if (inspectBtn) {
    inspectBtn.addEventListener("click", async () => {
      showStatus("Analyzing webpage DOM & page text...", "info");
      inspectBtn.disabled = true;

      try {
        const response = await chrome.runtime.sendMessage({ action: "INSPECT_PAGE" });

        if (response && response.status === "success" && response.pageState) {
          currentJsonData = response.pageState;
          renderPageState(currentJsonData);

          // 1. STRUCTURAL DOM PII (From Form Inputs)
          if (typeof DOMDetector !== "undefined") {
            const structuralDetections = DOMDetector.detect(response.pageState);
            console.log("=== STRUCTURAL DOM PII ===", structuralDetections);
            renderPIIDebug(structuralDetections);
          }

          // 2. PAGE TEXT PII & DOM TEXT REGIONS (From Whole-Page Text Extraction)
          if (response.domTextData) {
            console.log("=== DOM TEXT REGIONS ===", response.domTextData.textRegions);
            console.log("=== PAGE TEXT PII DETECTIONS ===", response.domTextData.detections);
            renderDOMTextDebug(response.domTextData);
            showStatus(`DOM analysis complete! ${response.domTextData.textRegions.length} text regions, ${response.domTextData.detections.length} page text PII.`, "info");
          } else {
            showStatus("DOM analysis complete!", "info");
          }

          if (copyBtn) copyBtn.disabled = false;
        } else {
          const errorMsg = response?.message || "Failed to inspect page.";
          showStatus(errorMsg, "error");
        }
      } catch (err) {
        console.error("[Popup Error]", err);
        showStatus("Error: " + (err?.message || String(err)), "error");
      } finally {
        inspectBtn.disabled = false;
      }
    });
  }

  if (captureBtn) {
    captureBtn.addEventListener("click", async () => {
      showStatus("Capturing tab screenshot...", "info");
      captureBtn.disabled = true;

      try {
        const response = await chrome.runtime.sendMessage({
          action: "CAPTURE_SCREENSHOT",
          options: { format: "png", quality: 90 }
        });

        if (response && response.status === "success" && response.dataUrl) {
          showStatus("Rendering image into Canvas...", "info");
          const { width, height } = await CanvasProcessor.loadToCanvas(response.dataUrl, canvasPreview);

          const stats = CanvasProcessor.inspectCanvas(canvasPreview);
          renderCanvasDebug(stats);

          if (canvasDim) canvasDim.textContent = `${width} × ${height} px`;
          if (canvasContainer) canvasContainer.classList.remove("hidden");
          if (ocrBtn) ocrBtn.disabled = false;
          const qrBtn = document.getElementById("qr-detect-btn");
          if (qrBtn) qrBtn.disabled = false;
          const yoloBtn = document.getElementById("yolo-face-btn");
          if (yoloBtn) yoloBtn.disabled = false;
          showStatus(`Canvas ready! ${stats.nonZeroPercent}% non-zero pixels. Select a vision test.`, "info");
        } else {
          const errorMsg = response?.message || "Failed to capture screenshot.";
          showStatus(errorMsg, "error");
        }
      } catch (err) {
        console.error("[Canvas Load Error]", err);
        showStatus("Error: " + (err?.message || String(err)), "error");
      } finally {
        captureBtn.disabled = false;
      }
    });
  }

  const qrDetectBtn = document.getElementById("qr-detect-btn");
  const yoloFaceBtn = document.getElementById("yolo-face-btn");
  const qrDebugContainer = document.getElementById("qr-debug-container");
  const qrCount = document.getElementById("qr-count");
  const qrJsonOutput = document.getElementById("qr-json-output");

  const faceDebugContainer = document.getElementById("face-debug-container");
  const faceCount = document.getElementById("face-count");
  const faceJsonOutput = document.getElementById("face-json-output");

  if (qrDetectBtn) {
    qrDetectBtn.addEventListener("click", async () => {
      if (!canvasPreview || canvasPreview.width === 0) {
        showStatus("Please capture canvas first.", "error");
        return;
      }

      const stats = CanvasProcessor.inspectCanvas(canvasPreview);
      if (!stats.hasData) {
        showStatus("Warning: Canvas is empty.", "error");
        return;
      }

      showStatus("Running Dedicated YOLO QR Code Detector (ONNX WebGPU/WASM)...", "info");
      qrDetectBtn.disabled = true;

      try {
        const QR_CONFIDENCE_THRESHOLD = 0.50;
        const result = await QRDetectorModule.detectQRCodes(canvasPreview, QR_CONFIDENCE_THRESHOLD, 0.45);
        const { detections, metrics } = result;

        console.log("=== DEDICATED YOLO QR CODE DETECTIONS ===", result);

        if (qrCount) qrCount.textContent = detections.length;
        if (qrJsonOutput) qrJsonOutput.textContent = JSON.stringify(detections, null, 2);
        if (qrDebugContainer) qrDebugContainer.classList.remove("hidden");

        if (detections.length === 0) {
          showStatus(`QR Code detection complete in ${metrics.totalTimeMs}ms (${metrics.executionProvider}). No QR codes detected.`, "info");
        } else {
          // Draw visual bounding box & confidence overlay
          CanvasProcessor.drawDebugOverlays(canvasPreview, detections, "QR CODE");

          showStatus(`QR Code detection complete in ${metrics.totalTimeMs}ms! (${metrics.executionProvider}, Final: ${detections.length} QR code(s) detected)`, "info");
        }

        // Standardized output format for Privacy Gate Integration
        currentJsonData = {
          qrDetector: "Dedicated YOLO QR-Code Detector (YOLOv8n-QR)",
          confidenceThreshold: QR_CONFIDENCE_THRESHOLD,
          modelMeta: QRDetectorModule.getModelMetadata(),
          metrics: metrics,
          detections: detections
        };
        if (outputTitle) outputTitle.textContent = `QR Code Detection Results (${detections.length} QR codes detected)`;
        if (jsonOutput) jsonOutput.textContent = JSON.stringify(currentJsonData, null, 2);
        if (copyBtn) copyBtn.disabled = false;
      } catch (err) {
        console.error("[QR Detection Error]", err);
        showStatus("QR Detection Error: " + (err?.message || String(err)), "error");
      } finally {
        qrDetectBtn.disabled = false;
      }
    });
  }

  if (yoloFaceBtn) {
    yoloFaceBtn.addEventListener("click", async () => {
      if (!canvasPreview || canvasPreview.width === 0) {
        showStatus("Please capture canvas first.", "error");
        return;
      }

      const stats = CanvasProcessor.inspectCanvas(canvasPreview);
      if (!stats.hasData) {
        showStatus("Warning: Canvas is empty.", "error");
        return;
      }

      showStatus("Running Pretrained YOLO Face Detector (ONNX WebGPU/WASM)...", "info");
      yoloFaceBtn.disabled = true;

      try {
        // Run experimental YOLO face detection pipeline
        const result = await YOLOFaceDetectorModule.detectFaces(canvasPreview, 0.45, 0.45);
        const { detections, metrics } = result;

        console.log("=== EXPERIMENTAL YOLO FACE DETECTIONS ===", result);

        // Render debug JSON
        if (faceCount) faceCount.textContent = detections.length;
        if (faceJsonOutput) faceJsonOutput.textContent = JSON.stringify(detections, null, 2);
        if (faceDebugContainer) faceDebugContainer.classList.remove("hidden");

        if (detections.length === 0) {
          showStatus(`YOLO Face detection complete in ${metrics.totalTimeMs}ms (${metrics.executionProvider}). No human faces detected.`, "info");
        } else {
          // Draw non-destructive outline debug boxes ONLY (No black redaction masks, No "[REDACTED]")
          CanvasProcessor.drawDebugOverlays(canvasPreview, detections, "YOLO FACE");

          showStatus(`YOLO Face detection complete in ${metrics.totalTimeMs}ms! (${metrics.executionProvider}, Preprocess: ${metrics.preprocessTimeMs}ms, Inference: ${metrics.inferenceTimeMs}ms, Postprocess: ${metrics.postprocessTimeMs}ms, Final: ${metrics.finalDetectionsCount})`, "info");
        }

        currentJsonData = {
          faceDetector: "Pretrained YOLO Nano Face Detector (YOLOv8n-Face)",
          modelMeta: YOLOFaceDetectorModule.getModelMetadata(),
          diagnosticFlow: {
            step1_modelVerified: "YES (Ultralytics YOLOv8n-face trained on WIDER FACE, 1 class: face)",
            step2_sessionInitialized: `YES (Execution provider: ${metrics.executionProvider})`,
            step3_inputPreprocessing: {
              originalCanvasResolution: metrics.canvasResolution,
              yoloInputResolution: "640 x 640 px",
              colorspace: "RGB",
              normalization: "[0.0, 1.0]",
              tensorLayout: "Float32 [1, 3, 640, 640] NCHW"
            },
            step5_rawOutputTensor: {
              shape: result.rawStats ? result.rawStats.dims : [1, 5, 8400],
              numAnchors: result.rawStats ? result.rawStats.numAnchors : 8400,
              maxRawConfidence: metrics.maxRawConfidence,
              minRawConfidence: metrics.minRawConfidence,
              topPredictions: result.rawStats ? result.rawStats.top10 : []
            },
            step6_stageCountsBreakdown: {
              rawPredictionsTotal: metrics.rawPredictionsTotal,
              candidatesAbove001LowDiagnosticThresh: metrics.candidatesAbove001,
              candidatesAboveConfThresh: metrics.candidatesAboveConfThresh,
              candidatesBeforeNMS: result.candidatesBeforeNMS ? result.candidatesBeforeNMS.length : metrics.candidatesAboveConfThresh,
              candidatesAfterNMS_Final: metrics.finalDetectionsCount
            }
          },
          metrics: metrics,
          faces: detections
        };
        if (outputTitle) outputTitle.textContent = `YOLO Face Detection Results (${detections.length} faces detected)`;
        if (jsonOutput) jsonOutput.textContent = JSON.stringify(currentJsonData, null, 2);
        if (copyBtn) copyBtn.disabled = false;
      } catch (err) {
        console.error("[YOLO Face Detection Error]", err);
        showStatus("YOLO Face Detection Error: " + (err?.message || String(err)), "error");
      } finally {
        yoloFaceBtn.disabled = false;
      }
    });
  }



  if (ocrBtn) {
    ocrBtn.addEventListener("click", async () => {
      if (!canvasPreview || canvasPreview.width === 0) {
        showStatus("Please capture canvas first.", "error");
        return;
      }

      const stats = CanvasProcessor.inspectCanvas(canvasPreview);
      console.log("[OCR Debug] Inspecting screenshot canvas before Tesseract:", stats);

      if (!stats.hasData) {
        showStatus("Warning: Canvas is completely empty/blank (0% pixels).", "error");
        return;
      }

      showStatus(`Initializing Tesseract.js OCR engine (${stats.width}x${stats.height} px, ${stats.nonZeroPercent}% content)...`, "info");
      ocrBtn.disabled = true;

      try {
        const ocrResults = await OCREngine.recognize(canvasPreview, (progress) => {
          const pct = Math.round(progress * 100);
          showStatus(`Running OCR: ${pct}% complete...`, "info");
        });

        // Pass each OCR text region through existing TextDetector
        const ocrPiiDetections = [];
        for (const region of ocrResults) {
          if (typeof TextDetector !== "undefined") {
            const detections = TextDetector.detect(region.text, {
              source: typeof PIISource !== "undefined" ? PIISource.OCR : "OCR",
              elementId: null,
              bbox: region.bbox
            });
            ocrPiiDetections.push(...detections);
          }
        }

        // Temporary DEBUG output
        console.log(`OCR RESULTS: ${ocrResults.length}`);
        console.log(`OCR PII DETECTIONS: ${ocrPiiDetections.length}`);
        console.log("=== OCR PII DETECTIONS ===", ocrPiiDetections);

        renderOCRPIIDebug(ocrResults.length, ocrPiiDetections);

        currentJsonData = {
          debugSummary: `OCR RESULTS: ${ocrResults.length} | OCR PII DETECTIONS: ${ocrPiiDetections.length}`,
          ocrResultsCount: ocrResults.length,
          ocrPiiDetectionsCount: ocrPiiDetections.length,
          ocrPiiDetections: ocrPiiDetections,
          ocrResults: ocrResults
        };
        if (outputTitle) outputTitle.textContent = `OCR Results & PII (OCR RESULTS: ${ocrResults.length}, OCR PII DETECTIONS: ${ocrPiiDetections.length})`;
        if (jsonOutput) jsonOutput.textContent = JSON.stringify(currentJsonData, null, 2);
        if (copyBtn) copyBtn.disabled = false;
        showStatus(`OCR complete! OCR RESULTS: ${ocrResults.length}, OCR PII DETECTIONS: ${ocrPiiDetections.length}.`, "info");
      } catch (err) {
        console.error("[OCR Error Raw]", err);
        const displayErr = err?.message || (typeof err === "object" ? JSON.stringify(err) : String(err));
        showStatus("OCR Error: " + displayErr, "error");
      } finally {
        ocrBtn.disabled = false;
      }
    });
  }

  if (syntheticOcrBtn) {
    syntheticOcrBtn.addEventListener("click", async () => {
      showStatus("Starting 3-Input Serialization Experiment...", "info");
      syntheticOcrBtn.disabled = true;

      try {
        const testCanvas = CanvasProcessor.createSyntheticTestCanvas(800, 400);

        if (canvasPreview) {
          const ctx = canvasPreview.getContext("2d");
          canvasPreview.width = testCanvas.width;
          canvasPreview.height = testCanvas.height;
          ctx.drawImage(testCanvas, 0, 0);

          const stats = CanvasProcessor.inspectCanvas(canvasPreview);
          renderCanvasDebug(stats);
        }

        if (canvasDim) canvasDim.textContent = `800 × 400 px (Synthetic Experiment)`;
        if (canvasContainer) canvasContainer.classList.remove("hidden");

        const experimentResults = {};

        showStatus("[Experiment 1/3] Testing Input A: HTMLCanvasElement...", "info");
        console.log("[Experiment 1/3] Testing Input A: HTMLCanvasElement...");
        const resA = await OCREngine.recognize(testCanvas);
        experimentResults.Input_A_HTMLCanvasElement = {
          inputType: "HTMLCanvasElement",
          resultsCount: resA.length,
          results: resA
        };

        showStatus("[Experiment 2/3] Testing Input B: canvas.toDataURL('image/png')...", "info");
        console.log("[Experiment 2/3] Testing Input B: canvas.toDataURL('image/png')...");
        const dataUrl = testCanvas.toDataURL("image/png");
        const resB = await OCREngine.recognize(dataUrl);
        experimentResults.Input_B_DataURL_String = {
          inputType: "string (data:image/png;base64,...)",
          dataUrlLength: dataUrl.length,
          resultsCount: resB.length,
          results: resB
        };

        showStatus("[Experiment 3/3] Testing Input C: PNG Uint8Array...", "info");
        console.log("[Experiment 3/3] Testing Input C: PNG Uint8Array...");
        const blob = await new Promise(resolve => testCanvas.toBlob(resolve, "image/png"));
        const arrayBuf = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuf);
        const resC = await OCREngine.recognize(uint8Array);
        experimentResults.Input_C_Uint8Array = {
          inputType: "Uint8Array",
          byteLength: uint8Array.byteLength,
          resultsCount: resC.length,
          results: resC
        };

        currentJsonData = experimentResults;
        if (outputTitle) outputTitle.textContent = "Serialization Hypothesis Experiment Results";
        if (jsonOutput) jsonOutput.textContent = JSON.stringify(experimentResults, null, 2);
        if (copyBtn) copyBtn.disabled = false;
        showStatus("Experiment complete! Check JSON window & Console.", "info");

        console.log("=== SERIALIZATION EXPERIMENT COMPARISON ===", experimentResults);
      } catch (err) {
        console.error("[Experiment Error]", err);
        showStatus("Experiment Error: " + (err?.message || String(err)), "error");
      } finally {
        syntheticOcrBtn.disabled = false;
      }
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      if (!currentJsonData) return;
      navigator.clipboard.writeText(JSON.stringify(currentJsonData, null, 2))
        .then(() => showStatus("Copied JSON to clipboard!", "info"))
        .catch((err) => showStatus("Copy failed: " + (err?.message || String(err)), "error"));
    });
  }

  function renderPIIDebug(piiDetections) {
    if (piiCount) piiCount.textContent = piiDetections.length;
    if (piiJsonOutput) piiJsonOutput.textContent = JSON.stringify(piiDetections, null, 2);
    if (piiDebugContainer) piiDebugContainer.classList.remove("hidden");
  }

  function renderDOMTextDebug(domTextData) {
    if (domTextRegionCount) domTextRegionCount.textContent = domTextData.textRegions.length;
    if (domTextPiiCount) domTextPiiCount.textContent = domTextData.detections.length;
    if (domTextJsonOutput) domTextJsonOutput.textContent = JSON.stringify(domTextData, null, 2);
    if (domTextDebugContainer) domTextDebugContainer.classList.remove("hidden");
  }

  function renderOCRPIIDebug(resultsCount, piiDetections) {
    if (ocrResultsCount) ocrResultsCount.textContent = resultsCount;
    if (ocrPiiCount) ocrPiiCount.textContent = piiDetections.length;
    if (ocrPiiJsonOutput) ocrPiiJsonOutput.textContent = JSON.stringify(piiDetections, null, 2);
    if (ocrPiiDebugContainer) ocrPiiDebugContainer.classList.remove("hidden");
  }

  function renderCanvasDebug(stats) {
    if (dbgWidth) dbgWidth.textContent = `${stats.width}px`;
    if (dbgHeight) dbgHeight.textContent = `${stats.height}px`;
    if (dbgHasData) {
      dbgHasData.textContent = stats.hasData ? "YES (True)" : "NO (Empty)";
      dbgHasData.style.color = stats.hasData ? "#16a34a" : "#dc2626";
    }
    if (dbgPercent) dbgPercent.textContent = `${stats.nonZeroPercent}% (${stats.nonZeroPixels.toLocaleString()} px)`;
  }

  function renderPageState(pageState) {
    if (metaObsId) metaObsId.textContent = pageState.metadata.observationId;
    if (metaTitle) metaTitle.textContent = pageState.metadata.title;
    if (metaElements) metaElements.textContent = pageState.metadata.elementCount;
    if (metaUrl) metaUrl.textContent = pageState.metadata.url;
    if (metaContainer) metaContainer.classList.remove("hidden");

    if (outputTitle) outputTitle.textContent = "PageState JSON";
    if (jsonOutput) jsonOutput.textContent = JSON.stringify(pageState, null, 2);
  }

  function showStatus(msg, type) {
    if (statusMessage) statusMessage.textContent = msg;
    if (statusContainer) {
      statusContainer.className = `status-container ${type}`;
      statusContainer.classList.remove("hidden");
    }
  }
});
