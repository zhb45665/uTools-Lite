const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const root = path.resolve(__dirname, "..");
const modules = path.join(root, "release", "win-unpacked", "resources", "app.asar.unpacked", "node_modules");
const { createWorker } = require(path.join(modules, "tesseract.js"));
const langPath = fs.mkdtempSync(path.join(os.tmpdir(), "utools-ocr-packaged-"));
for (const code of ["chi_sim", "eng"]) {
  fs.copyFileSync(
    path.join(modules, "@tesseract.js-data", code, "4.0.0", `${code}.traineddata.gz`),
    path.join(langPath, `${code}.traineddata.gz`),
  );
}

(async () => {
  let worker;
  try {
    worker = await createWorker("chi_sim+eng", undefined, {
      langPath,
      gzip: true,
    });
    const result = await worker.recognize(path.join(root, "tmp-ocr-test.png"));
    const text = result.data.text.trim();
    console.log(JSON.stringify({ text, confidence: Math.round(result.data.confidence || 0) }));
    if (!/OCR\s*TEST/i.test(text) || !/2026/.test(text)) throw new Error("packaged OCR assertion failed");
    console.log("PASS: packaged OCR worker and models are usable");
  } finally {
    if (worker) await worker.terminate();
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
