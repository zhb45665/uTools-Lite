const OPEN_ITEM = {
  text: "◫ 打开 OCR 文字识别",
  description: "粘贴截图或选择图片 · 中文英文离线识别",
  icon: "◫",
  data: { action: "open" },
};

for (const keyword of ["ocr", "文字识别", "图片识别", "截图识别", "识字"]) {
  main.onInput(keyword, (_key, cb) => cb([OPEN_ITEM]));
  main.onInputSearch(keyword, (_key, _value, cb) => cb([OPEN_ITEM]));
}

main.onExit(() => main.log("ocr detail view closed"));
main.log("ocr plugin loaded");
