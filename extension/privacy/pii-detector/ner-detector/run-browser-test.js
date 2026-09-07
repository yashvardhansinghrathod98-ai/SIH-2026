// privacy/pii-detector/ner-detector/run-browser-test.js
// Automated runner that launches real Google Chrome, navigates to test-ner.html, and captures diagnostic output.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const EXTENSION_DIR = path.resolve(__dirname, "../../..");
const PORT = 8765;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".wasm": "application/wasm"
};

// 1. Create lightweight HTTP server
const server = http.createServer((req, res) => {
  let reqPath = req.url.split("?")[0];
  if (reqPath === "/") reqPath = "/privacy/pii-detector/ner-detector/test-ner.html";

  const filePath = path.join(EXTENSION_DIR, reqPath);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    });
    res.end(data);
  });
});

async function main() {
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`[Test Server] Serving extension directory at http://localhost:${PORT}`);

  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const debugPort = 9222;

  console.log("[Chrome Launcher] Spawning headless Chrome with WebGPU enabled...");
  const chromeProc = spawn(chromePath, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    "--enable-features=WebGPU,Vulkan",
    "--use-angle=vulkan",
    "--no-first-run",
    "--no-default-browser-check",
    `http://localhost:${PORT}/privacy/pii-detector/ner-detector/test-ner.html`
  ], { stdio: "ignore" });

  // Cleanup handler
  const cleanup = () => {
    try { chromeProc.kill(); } catch (e) {}
    server.close();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(); });

  // 2. Poll for Chrome DevTools WebSocket endpoint
  console.log("[CDP] Waiting for Chrome remote debugging endpoint...");
  let wsUrl = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await fetch(`http://localhost:${debugPort}/json`);
      const tabs = await resp.json();
      const testTab = tabs.find(t => t.url && t.url.includes("test-ner.html")) || tabs[0];
      if (testTab && testTab.webSocketDebuggerUrl) {
        wsUrl = testTab.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {
      // Chrome starting up
    }
  }

  if (!wsUrl) {
    console.error("❌ Failed to attach to Chrome remote debugging port.");
    cleanup();
    process.exit(1);
  }

  console.log("[CDP] Connected to Chrome tab! Capturing browser console output...\n");
  console.log("==================================================");
  console.log(" REAL CHROME BROWSER ENVIRONMENT OUTPUT ");
  console.log("==================================================\n");

  const ws = new WebSocket(wsUrl);

  let msgId = 1;
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: msgId++, method: "Runtime.enable" }));
    ws.send(JSON.stringify({ id: msgId++, method: "Log.enable" }));
  };

  const timeoutTimer = setTimeout(() => {
    console.warn("⚠️ Browser test reached timeout (60s). Exiting.");
    cleanup();
    process.exit(0);
  }, 60000);

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.method === "Runtime.consoleAPICalled") {
        const text = data.params.args.map(a => a.value || (a.description || JSON.stringify(a))).join(" ");
        console.log(`[Browser Console] ${text}`);

        if (text.includes("=== BROWSER DIAGNOSTIC TEST FINISHED ===")) {
          clearTimeout(timeoutTimer);
          setTimeout(() => {
            console.log("\n==================================================");
            console.log(" BROWSER TEST COMPLETE ");
            console.log("==================================================");
            cleanup();
            process.exit(0);
          }, 1000);
        }
      }
    } catch (e) {}
  };
}

main().catch(err => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
