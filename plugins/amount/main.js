/**
 * amount (金额大写) — 阿拉伯数字 <-> 人民币中文大写
 *
 * 转换核心与详情页共用一份实现：convert.js
 *   · 沙箱侧（本文件）: require("./convert.js")
 *   · 详情页:          <script src="convert.js"> -> window.AmountConvert
 *
 * 用法：
 *   · `金额` / `大写` / `rmb`      -> 打开转换面板（打开即自动读剪贴板）
 *   · `金额 1234.56`               -> 结果行直接显示大写，回车进面板继续转换
 */

const { toCapitalAmount, formatCurrency } = require("./convert.js");

const OPEN_ITEM = {
  text: "💰 打开金额大写转换",
  description: "粘贴金额自动转换 · 双击结果复制",
  icon: "💰",
  data: { action: "open" },
};

main.onInput("金额", (_keyword, cb) => cb([OPEN_ITEM]));
main.onInput("大写", (_keyword, cb) => cb([OPEN_ITEM]));
main.onInput("rmb", (_keyword, cb) => cb([OPEN_ITEM]));

function searchAmount(_keyword, value, cb) {
  const capital = toCapitalAmount(value);
  if (!capital) {
    cb([
      {
        text: "💰 打开金额大写转换",
        description: `「${value}」不是有效金额，回车进面板手输`,
        icon: "💰",
        data: { action: "open", value },
      },
    ]);
    return;
  }
  cb([
    {
      text: `💰 ${capital}`,
      description: `${formatCurrency(value)} · 回车打开转换面板`,
      icon: "💰",
      data: { action: "convert", value },
    },
  ]);
}

main.onInputSearch("金额", searchAmount);
main.onInputSearch("大写", searchAmount);
main.onInputSearch("amount", searchAmount);

main.onExit(() => {
  main.log("amount detail view closed");
});

main.log("amount plugin loaded");
