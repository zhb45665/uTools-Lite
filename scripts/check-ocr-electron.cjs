const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const data = fs.mkdtempSync(path.join(os.tmpdir(), "utools-ocr-test-"));
app.setPath("userData", data);
app.setPath("sessionData", data);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 900, height: 300, show: true });
    const html = `<!doctype html><style>body{margin:0;background:#fff;color:#000;font:700 48px Arial,"Microsoft YaHei";padding:40px}</style><body>OCR TEST 2026<br>文字识别测试</body>`;
    const htmlPath = path.join(data, "ocr-test.html");
    fs.writeFileSync(htmlPath, html, "utf8");
    await win.loadFile(htmlPath);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const png = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, "..", "tmp-ocr-test.png"), png.toPNG());
    const dataUrl = png.toDataURL();
    const { recognizeImage } = require("../dist/main/ocr-service");
    const result = await recognizeImage(dataUrl);
    console.log(JSON.stringify(result));
    if (!/OCR\s*TEST/i.test(result.text) || !/2026/.test(result.text)) {
      throw new Error(`OCR English/numeric assertion failed: ${result.text}`);
    }
    console.log("PASS: offline OCR engine recognized generated test image");
    win.destroy();
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
