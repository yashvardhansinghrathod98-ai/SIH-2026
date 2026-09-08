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

  const rampartPiiDebugContainer = document.getElementById("rampart-pii-debug-container");
  const rampartPiiCount = document.getElementById("rampart-pii-count");
  const rampartPiiJsonOutput = document.getElementById("rampart-pii-json-output");

  const allRawDebugContainer = document.getElementById("all-raw-debug-container");
  const allRawCount = document.getElementById("all-raw-count");
  const allRawJsonOutput = document.getElementById("all-raw-json-output");

  const fusedDebugContainer = document.getElementById("fused-debug-container");
  const fusedCount = document.getElementById("fused-count");
  const mergedCount = document.getElementById("merged-count");
  const fusedJsonOutput = document.getElementById("fused-json-output");

  const sanitizedDomTextContainer = document.getElementById("sanitized-dom-text-container");
  const sanitizedTextRedactionsCount = document.getElementById("sanitized-text-redactions-count");
  const sanitizedDomTextOutput = document.getElementById("sanitized-dom-text-output");

  const sanitizedScreenshotContainer = document.getElementById("sanitized-screenshot-container");
  const sanitizedScreenshotMaskedCount = document.getElementById("sanitized-screenshot-masked-count");
  const sanitizedCanvasPreview = document.getElementById("sanitized-canvas-preview");
  const sanitizedScreenshotStatus = document.getElementById("sanitized-screenshot-status");

  const privacyGateContainer = document.getElementById("privacy-gate-container");
  const privacyGateBadge = document.getElementById("privacy-gate-badge");
  const privacyGateCard = document.getElementById("privacy-gate-card");
  const privacyGateStatusIndicator = document.getElementById("privacy-gate-status-indicator");
  const privacyGateStatusIcon = document.getElementById("privacy-gate-status-icon");
  const privacyGateStatusTitle = document.getElementById("privacy-gate-status-title");
  const privacyGateStatusDesc = document.getElementById("privacy-gate-status-desc");
  const chkDom = document.getElementById("chk-dom");
  const chkScreenshot = document.getElementById("chk-screenshot");
  const chkTextRedact = document.getElementById("chk-text-redact");
  const chkVisualRedact = document.getElementById("chk-visual-redact");
  const chkSchema = document.getElementById("chk-schema");
  const privacyGateReasons = document.getElementById("privacy-gate-reasons");
  const privacyGateReasonsList = document.getElementById("privacy-gate-reasons-list");
  const privacyGateJsonOutput = document.getElementById("privacy-gate-json-output");

  const textRedactionDiagnostics = document.getElementById("text-redaction-diagnostics");
  const textDiagTitle = document.getElementById("text-diag-title");
  const textDiagBadge = document.getElementById("text-diag-badge");
  const diagMetricRequired = document.getElementById("diag-metric-required");
  const diagMetricMapped = document.getElementById("diag-metric-mapped");
  const diagMetricApplied = document.getElementById("diag-metric-applied");
  const diagMetricCovered = document.getElementById("diag-metric-covered");
  const diagMetricUnresolved = document.getElementById("diag-metric-unresolved");
  const diagMetricVerifFails = document.getElementById("diag-metric-verif-fails");
  const textDiagUnresolvedContainer = document.getElementById("text-diag-unresolved-container");
  const textDiagUnresolvedList = document.getElementById("text-diag-unresolved-list");

  const dbgWidth = document.getElementById("dbg-width");
  const dbgHeight = document.getElementById("dbg-height");
  const dbgHasData = document.getElementById("dbg-hasdata");
  const dbgPercent = document.getElementById("dbg-percent");

  let currentJsonData = null;

  // Observation state: POPUP collects observations, PIPELINE performs detections
  const currentObservations = {
    pageState: null,
    domTextRegions: null,
    ocrResults: null
  };

  /**
   * Executes the central PrivacyPipeline across all available observations
   * and renders the unified results across the presentation containers.
   */
  async function runPrivacyPipelineAndRender() {
    if (typeof PrivacyPipeline === "undefined") {
      console.warn("[Popup] PrivacyPipeline is not loaded.");
      return null;
    }

    showStatus("Running PrivacyPipeline across all observation branches...", "info");

    const metadata = {
      ...(currentObservations.pageState?.metadata || {}),
      canvas: canvasPreview && canvasPreview.width > 0 ? {
        width: canvasPreview.width,
        height: canvasPreview.height
      } : null
    };

    const result = await PrivacyPipeline.execute({
      pageState: currentObservations.pageState,
      domTextRegions: currentObservations.domTextRegions,
      ocrResults: currentObservations.ocrResults,
      screenshotCanvas: canvasPreview && canvasPreview.width > 0 ? canvasPreview : null,
      metadata: metadata
    });

    console.log("=== PRIVACY PIPELINE RESULT ===", result);
    renderPipelineResults(result);
    return result;
  }

  function renderPipelineResults(result) {
    if (!result) return;

    // 1. Structural DOM PII
    renderPIIDebug(result.bySource.DOM || []);

    // 2. DOM Visible Text PII
    renderDOMTextDebug({
      textRegions: currentObservations.domTextRegions || [],
      detections: result.bySource.DOM_TEXT || []
    });

    // 3. OCR PII Detections
    renderOCRPIIDebug(
      (currentObservations.ocrResults || []).length,
      result.bySource.OCR || []
    );

    // 4. Rampart NER PII
    const rampartDetections = result.bySource.RAMPART || [];
    if (rampartPiiCount) rampartPiiCount.textContent = rampartDetections.length;
    if (rampartPiiJsonOutput) rampartPiiJsonOutput.textContent = JSON.stringify(rampartDetections, null, 2);
    if (rampartPiiDebugContainer) rampartPiiDebugContainer.classList.remove("hidden");

    // 5. ALL RAW DETECTIONS (Hidden: privacy pipeline output shows only fused results)
    if (allRawDebugContainer) allRawDebugContainer.classList.add("hidden");

    // 6. CANONICAL FUSED DETECTIONS
    const fusedDetections = result.fusedDetections || [];
    if (fusedCount) fusedCount.textContent = fusedDetections.length;
    if (mergedCount) mergedCount.textContent = result.trace?.mergedGroupCount ?? 0;
    if (fusedJsonOutput) fusedJsonOutput.textContent = JSON.stringify(fusedDetections, null, 2);
    if (fusedDebugContainer) fusedDebugContainer.classList.remove("hidden");

    // 7. SANITIZED DOM TEXT (Section 7)
    renderSanitizedDOMText(
      result.sanitizedDomText,
      result.trace?.textRedactionsCount ?? 0
    );

    // 8. SANITIZED SCREENSHOT (Section 8)
    renderSanitizedScreenshot(result.sanitizedScreenshot);

    // 9. PRIVACY GATE STATUS & OUTBOUND CONTEXT (Section 9)
    renderPrivacyGate(result.privacyGate, result.textRedactionMetadata);

    // Main JSON Output Window: Show ONLY fused results
    currentJsonData = fusedDetections;
    if (outputTitle) {
      outputTitle.textContent = `Privacy Pipeline Output (${fusedDetections.length} Fused Canonical Detections)`;
    }
    if (jsonOutput) {
      jsonOutput.textContent = JSON.stringify(fusedDetections, null, 2);
    }
    if (copyBtn) copyBtn.disabled = false;
  }

  if (inspectBtn) {
    inspectBtn.addEventListener("click", async () => {
      showStatus("Analyzing webpage DOM & page text...", "info");
      inspectBtn.disabled = true;

      // 1. Independent DOM Observation Capture
      try {
        const response = await chrome.runtime.sendMessage({ action: "INSPECT_PAGE" });

        if (response && response.status === "success" && response.pageState) {
          currentObservations.pageState = response.pageState;
          currentObservations.domTextRegions = response.domTextData?.textRegions || [];
          renderPageState(response.pageState);
        } else {
          const errorMsg = response?.message || "Failed to inspect page.";
          showStatus("DOM Error: " + errorMsg, "error");
          inspectBtn.disabled = false;
          return;
        }
      } catch (domErr) {
        console.error("[DOM Inspection Error]", domErr);
        showStatus("DOM Error: " + (domErr?.message || String(domErr)), "error");
        inspectBtn.disabled = false;
        return;
      }

      // 2. Centralized PII detection owned by PrivacyPipeline (independent error boundary)
      try {
        const result = await runPrivacyPipelineAndRender();
        if (result) {
          showStatus(`DOM analysis complete! ${result.fusedDetections.length} fused PII detections found.`, "info");
        }
      } catch (pipelineErr) {
        console.error("[Pipeline Error after DOM]", pipelineErr);
        showStatus("Pipeline Notice: " + (pipelineErr?.message || String(pipelineErr)), "error");
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
          showStatus("Rendering image into Canvas (2x resolution upscaled)...", "info");
          const { width, height, scale, originalWidth, originalHeight } = await CanvasProcessor.loadToCanvas(
            response.dataUrl,
            canvasPreview,
            { scale: 2.0 }
          );

          const stats = CanvasProcessor.inspectCanvas(canvasPreview);
          renderCanvasDebug(stats);

          if (canvasDim) canvasDim.textContent = `${width} × ${height} px (${scale}x upscaled from ${originalWidth}×${originalHeight})`;
          if (canvasContainer) canvasContainer.classList.remove("hidden");
          if (ocrBtn) ocrBtn.disabled = false;
          showStatus(`Canvas ready! ${stats.nonZeroPercent}% non-zero pixels (${scale}x upscaled). Click 'Run Local OCR'.`, "info");
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

      // 1. Independent Visual Observation: Tesseract OCR execution
      let ocrResults = null;
      try {
        ocrResults = await OCREngine.recognize(canvasPreview, (progress) => {
          const pct = Math.round(progress * 100);
          showStatus(`Running OCR: ${pct}% complete...`, "info");
        });

        // Store raw OCR observations
        currentObservations.ocrResults = ocrResults;
        showStatus(`OCR recognition complete (${ocrResults.length} words recognized). Running PrivacyPipeline...`, "info");
      } catch (ocrErr) {
        console.error("[OCR Error Raw]", ocrErr);
        const displayErr = ocrErr?.message || (typeof ocrErr === "object" ? JSON.stringify(ocrErr) : String(ocrErr));
        showStatus("OCR Error: " + displayErr, "error");
        ocrBtn.disabled = false;
        return;
      }

      // 2. Centralized PII detection owned by PrivacyPipeline (independent error boundary)
      try {
        const result = await runPrivacyPipelineAndRender();
        if (result) {
          showStatus(`OCR & Pipeline complete! Words: ${ocrResults.length} | Fused PII: ${result.fusedDetections.length}.`, "info");
        }
      } catch (pipelineErr) {
        console.error("[Pipeline Error after OCR]", pipelineErr);
        const displayErr = pipelineErr?.message || (typeof pipelineErr === "object" ? JSON.stringify(pipelineErr) : String(pipelineErr));
        showStatus("Pipeline Notice: " + displayErr, "error");
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

  function renderSanitizedDOMText(sanitizedText, redactionsCount) {
    if (sanitizedTextRedactionsCount) sanitizedTextRedactionsCount.textContent = redactionsCount;
    if (sanitizedDomTextOutput) {
      sanitizedDomTextOutput.textContent = (sanitizedText && sanitizedText.trim())
        ? sanitizedText
        : "// No visible DOM text available to sanitize.";
    }
    if (sanitizedDomTextContainer) sanitizedDomTextContainer.classList.remove("hidden");
  }

  function renderSanitizedScreenshot(sanitizedScreenshot) {
    if (!sanitizedScreenshotContainer) return;

    if (!sanitizedScreenshot || !sanitizedScreenshot.success || !sanitizedScreenshot.canvas) {
      if (sanitizedScreenshotStatus) {
        if (sanitizedScreenshot?.reason === "no_source_canvas") {
          sanitizedScreenshotStatus.textContent = "No screenshot captured yet. Capture canvas and run OCR to generate sanitized screenshot.";
          sanitizedScreenshotStatus.className = "status-container info";
        } else {
          sanitizedScreenshotStatus.textContent = "Screenshot Sanitization Notice: " + (sanitizedScreenshot?.error || "Visual redaction unavailable.");
          sanitizedScreenshotStatus.className = "status-container error";
        }
        sanitizedScreenshotStatus.classList.remove("hidden");
      }
      if (sanitizedCanvasPreview) {
        sanitizedCanvasPreview.width = 0;
        sanitizedCanvasPreview.height = 0;
      }
      sanitizedScreenshotContainer.classList.remove("hidden");
      return;
    }

    if (sanitizedScreenshotStatus) {
      sanitizedScreenshotStatus.classList.add("hidden");
    }

    if (sanitizedScreenshotMaskedCount) {
      sanitizedScreenshotMaskedCount.textContent = sanitizedScreenshot.maskedCount;
    }

    if (sanitizedCanvasPreview) {
      sanitizedCanvasPreview.width = sanitizedScreenshot.canvas.width;
      sanitizedCanvasPreview.height = sanitizedScreenshot.canvas.height;
      const ctx = sanitizedCanvasPreview.getContext("2d");
      ctx.clearRect(0, 0, sanitizedCanvasPreview.width, sanitizedCanvasPreview.height);
      ctx.drawImage(sanitizedScreenshot.canvas, 0, 0);
    }

    sanitizedScreenshotContainer.classList.remove("hidden");
  }

  function renderPrivacyGate(gateResult, textRedactionMetadata = null) {
    if (!privacyGateContainer) return;
    if (!gateResult) {
      privacyGateContainer.classList.add("hidden");
      return;
    }

    const isAllowed = Boolean(gateResult.allowed);
    const checks = gateResult.checks || {};
    const reasons = Array.isArray(gateResult.reasons) ? gateResult.reasons : [];
    const outboundContext = gateResult.outboundContext || null;

    if (privacyGateBadge) {
      privacyGateBadge.textContent = isAllowed ? "ALLOWED" : "BLOCKED";
      privacyGateBadge.style.color = isAllowed ? "#059669" : "#dc2626";
    }

    if (privacyGateStatusIndicator) {
      privacyGateStatusIndicator.className = `gate-status-indicator ${isAllowed ? "allowed" : "blocked"}`;
    }
    if (privacyGateStatusIcon) {
      privacyGateStatusIcon.textContent = isAllowed ? "🟢" : "🔴";
    }
    if (privacyGateStatusTitle) {
      privacyGateStatusTitle.textContent = isAllowed ? "ALLOWED" : "BLOCKED";
    }
    if (privacyGateStatusDesc) {
      privacyGateStatusDesc.textContent = isAllowed
        ? "All required redactions verified. Safe to send sanitized context."
        : (reasons.length > 0
            ? `Transmission blocked: ${reasons.join(", ")}`
            : "Transmission blocked by Privacy Gate.");
    }

    function updateCheckItem(el, passed, label) {
      if (!el) return;
      el.className = `gate-check-item ${passed ? "passed" : "failed"}`;
      el.innerHTML = `<span class="chk-icon">${passed ? "✅" : "❌"}</span> ${label}`;
    }

    updateCheckItem(chkDom, Boolean(checks.sanitizedDomPresent), "Sanitized DOM");
    updateCheckItem(chkScreenshot, Boolean(checks.sanitizedScreenshotPresent), "Sanitized Screenshot");
    updateCheckItem(chkTextRedact, Boolean(checks.textRedactionComplete), "Text Redaction");
    updateCheckItem(chkVisualRedact, Boolean(checks.visualRedactionComplete), "Visual Redaction");
    updateCheckItem(chkSchema, Boolean(checks.outboundSchemaValid), "Outbound Schema");

    if (privacyGateReasons && privacyGateReasonsList) {
      if (reasons.length > 0) {
        privacyGateReasonsList.innerHTML = reasons.map(r => `<li>${r}</li>`).join("");
        privacyGateReasons.classList.remove("hidden");
      } else {
        privacyGateReasonsList.innerHTML = "";
        privacyGateReasons.classList.add("hidden");
      }
    }

    // Render safe text redaction diagnostics
    const meta = textRedactionMetadata || gateResult.textRedactionMetadata || null;
    renderTextRedactionDiagnostics(meta);

    if (privacyGateJsonOutput) {
      privacyGateJsonOutput.textContent = isAllowed && outboundContext
        ? JSON.stringify(outboundContext, null, 2)
        : "// NULL (Blocked: Outbound transmission prohibited)";
    }

    privacyGateContainer.classList.remove("hidden");
  }

  function renderTextRedactionDiagnostics(metadata) {
    if (!textRedactionDiagnostics) return;
    if (!metadata || !metadata.summary) {
      textRedactionDiagnostics.classList.add("hidden");
      return;
    }

    const summary = metadata.summary;
    const unredacted = Array.isArray(metadata.unredactedDetections) ? metadata.unredactedDetections : [];
    const isComplete = Boolean(metadata.textRedactionComplete);

    if (diagMetricRequired) diagMetricRequired.textContent = summary.required;
    if (diagMetricMapped) diagMetricMapped.textContent = summary.mapped;
    if (diagMetricApplied) diagMetricApplied.textContent = summary.applied;
    if (diagMetricCovered) diagMetricCovered.textContent = summary.covered;
    if (diagMetricUnresolved) diagMetricUnresolved.textContent = summary.unresolved;
    if (diagMetricVerifFails) diagMetricVerifFails.textContent = summary.verificationFailures;

    if (textDiagBadge) {
      textDiagBadge.textContent = isComplete ? "PASS" : "FAIL";
      textDiagBadge.className = `diag-badge ${isComplete ? "pass" : "fail"}`;
    }

    if (unredacted.length > 0) {
      if (textDiagUnresolvedList) {
        textDiagUnresolvedList.innerHTML = unredacted.map(item => {
          const bboxStr = item.bbox
            ? `[x:${Math.round(item.bbox.x)}, y:${Math.round(item.bbox.y)}, w:${Math.round(item.bbox.width)}, h:${Math.round(item.bbox.height)}]`
            : "none";
          const mappingStr = `Required: ${item.textMapping?.required ? "Yes" : "No"} | Mapped: ${item.textMapping?.matched ? "Yes" : "No"} | Span: ${item.textMapping?.spanFound ? "Yes" : "No"}`;
          const redactStr = `Attempted: ${item.redaction?.attempted ? "Yes" : "No"} | Applied: ${item.redaction?.applied ? "Yes" : "No"} | Covered: ${item.redaction?.covered ? "Yes" : "No"}`;
          const srcStr = Array.isArray(item.sources) ? item.sources.join(", ") : (item.source || "UNKNOWN");

          return `
            <div class="diag-unresolved-item">
              <div class="item-header">
                <span>#${item.detectionIndex !== undefined ? item.detectionIndex + 1 : "?"} ${item.type}</span>
                <span>${item.reason || "UNRESOLVED"}</span>
              </div>
              <div class="item-details">
                <div><strong>Source:</strong> ${srcStr} | <strong>Context:</strong> ${item.contextSource || "none"} | <strong>Element:</strong> ${item.elementId || "none"}</div>
                <div><strong>Location (BBox):</strong> ${bboxStr}</div>
                <div><strong>Mapping:</strong> ${mappingStr}</div>
                <div><strong>Redaction:</strong> ${redactStr}</div>
              </div>
            </div>
          `;
        }).join("");
      }
      if (textDiagUnresolvedContainer) textDiagUnresolvedContainer.classList.remove("hidden");
    } else {
      if (textDiagUnresolvedList) textDiagUnresolvedList.innerHTML = "";
      if (textDiagUnresolvedContainer) textDiagUnresolvedContainer.classList.add("hidden");
    }

    textRedactionDiagnostics.classList.remove("hidden");
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
