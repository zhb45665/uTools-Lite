import path from "node:path";
import { BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import { getNoteWindow } from "./note-window";

type Captured = { dataUrl: string; name: string; width: number; height: number };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function captureScreenRegion(): Promise<Captured | { canceled: true }> {
  const owner = getNoteWindow();
  if (!owner || owner.isDestroyed()) throw new Error("OCR 窗口不可用");
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  owner.hide();
  await wait(180);
  try {
    const result = await selectRegion(display.bounds);
    if (!result) return { canceled: true };
    // The selector is transparent over the live desktop. Capture only after it
    // has closed so neither the selector nor its dimming layer enters the image.
    await wait(120);
    const pixelWidth = Math.max(1, Math.round(display.size.width * display.scaleFactor));
    const pixelHeight = Math.max(1, Math.round(display.size.height * display.scaleFactor));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: pixelWidth, height: pixelHeight },
      fetchWindowIcons: false,
    });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("无法获取屏幕画面");
    const image = source.thumbnail;
    const size = image.getSize();
    const sx = size.width / result.viewportWidth;
    const sy = size.height / result.viewportHeight;
    const rect = {
      x: Math.max(0, Math.round(result.x * sx)),
      y: Math.max(0, Math.round(result.y * sy)),
      width: Math.min(size.width, Math.max(1, Math.round(result.width * sx))),
      height: Math.min(size.height, Math.max(1, Math.round(result.height * sy))),
    };
    if (rect.x + rect.width > size.width) rect.width = size.width - rect.x;
    if (rect.y + rect.height > size.height) rect.height = size.height - rect.y;
    const cropped = image.crop(rect);
    return {
      dataUrl: cropped.toDataURL(),
      name: `屏幕截图 ${new Date().toLocaleTimeString()}`,
      width: rect.width,
      height: rect.height,
    };
  } finally {
    if (!owner.isDestroyed()) { owner.show(); owner.focus(); }
  }
}

function selectRegion(bounds: Electron.Rectangle): Promise<{
  x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number;
} | null> {
  return new Promise((resolve) => {
    const overlay = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, fullscreenable: false, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { preload: path.join(__dirname, "../preload/screenshot.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    let settled = false;
    const loadTimeout = setTimeout(() => finish(null), 8000);
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(loadTimeout);
      ipcMain.removeListener("ocr-screen-selection", onSelection);
      ipcMain.removeListener("ocr-screen-cancel", onCancel);
      if (!overlay.isDestroyed()) overlay.destroy();
      resolve(value);
    };
    const onSelection = (event: Electron.IpcMainEvent, value: any) => {
      if (event.sender !== overlay.webContents) return;
      const nums = [value?.x, value?.y, value?.width, value?.height, value?.viewportWidth, value?.viewportHeight];
      if (!nums.every((n) => Number.isFinite(n)) || value.width < 6 || value.height < 6) return finish(null);
      finish(value);
    };
    const onCancel = (event: Electron.IpcMainEvent) => { if (event.sender === overlay.webContents) finish(null); };
    ipcMain.on("ocr-screen-selection", onSelection);
    ipcMain.on("ocr-screen-cancel", onCancel);
    overlay.on("closed", () => finish(null));
    const html = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:transparent}body{font-family:"Segoe UI Variable","Microsoft YaHei UI",sans-serif}.veil{position:fixed;inset:0;background:#0005;pointer-events:none}.box{position:fixed;display:none;border:2px solid #4b8cff;background:transparent;box-shadow:0 0 0 9999px #0008;cursor:move}.size{position:absolute;left:-2px;top:-29px;height:24px;padding:3px 8px;border-radius:5px 5px 0 0;background:#1769d2;color:#fff;font-size:12px;line-height:18px;white-space:nowrap;pointer-events:none}.handle{position:absolute;width:10px;height:10px;border:1px solid #1769d2;background:#fff;border-radius:50%}.nw{left:-6px;top:-6px;cursor:nwse-resize}.n{left:50%;top:-6px;transform:translateX(-50%);cursor:ns-resize}.ne{right:-6px;top:-6px;cursor:nesw-resize}.e{right:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize}.se{right:-6px;bottom:-6px;cursor:nwse-resize}.s{left:50%;bottom:-6px;transform:translateX(-50%);cursor:ns-resize}.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.w{left:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize}.toolbar{position:fixed;display:none;gap:7px;padding:6px;border-radius:9px;background:#20242bea;box-shadow:0 7px 24px #0007}.toolbar button{height:30px;border:0;border-radius:6px;padding:0 13px;background:#3a404a;color:#fff;font:13px "Microsoft YaHei UI";cursor:pointer}.toolbar .done{background:#2878e1}.tip{position:fixed;left:50%;top:22px;transform:translateX(-50%);padding:8px 14px;border-radius:9px;background:#111d;color:#fff;font-size:13px;pointer-events:none}
</style><div class="veil"></div><div class="box"><span class="size"></span><i class="handle nw" data-dir="nw"></i><i class="handle n" data-dir="n"></i><i class="handle ne" data-dir="ne"></i><i class="handle e" data-dir="e"></i><i class="handle se" data-dir="se"></i><i class="handle s" data-dir="s"></i><i class="handle sw" data-dir="sw"></i><i class="handle w" data-dir="w"></i></div><div class="toolbar"><button class="cancel">取消</button><button class="done">完成</button></div><div class="tip">拖动选择区域，选好后可移动或调整大小</div><script>
const b=document.querySelector('.box'),v=document.querySelector('.veil'),bar=document.querySelector('.toolbar'),size=document.querySelector('.size'),tip=document.querySelector('.tip');
let rect=null,mode='',dir='',sx=0,sy=0,start=null;
const clamp=(n,a,z)=>Math.max(a,Math.min(z,n));
const normalized=(x1,y1,x2,y2)=>({x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)});
function render(){if(!rect)return;b.style.display='block';Object.assign(b.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});size.textContent=Math.round(rect.width)+' × '+Math.round(rect.height);const below=rect.y+rect.height+10;bar.style.display='flex';bar.style.left=clamp(rect.x+rect.width-bar.offsetWidth,8,innerWidth-bar.offsetWidth-8)+'px';bar.style.top=(below+bar.offsetHeight<innerHeight?below:Math.max(8,rect.y-bar.offsetHeight-10))+'px'}
function begin(e){if(e.button!==0||e.target.closest('.toolbar'))return;sx=e.clientX;sy=e.clientY;start=rect&&{...rect};const h=e.target.closest('.handle');if(h){mode='resize';dir=h.dataset.dir;return}if(rect&&e.target.closest('.box')){mode='move';return}mode='draw';rect={x:sx,y:sy,width:0,height:0};v.style.display='none';bar.style.display='none';tip.style.display='none';render()}
function move(e){if(!mode)return;if(mode==='draw'){rect=normalized(sx,sy,e.clientX,e.clientY)}else if(mode==='move'){rect={...start,x:clamp(start.x+e.clientX-sx,0,innerWidth-start.width),y:clamp(start.y+e.clientY-sy,0,innerHeight-start.height)}}else{let l=start.x,t=start.y,r=start.x+start.width,d=start.y+start.height;if(dir.includes('w'))l=clamp(e.clientX,0,r-6);if(dir.includes('e'))r=clamp(e.clientX,l+6,innerWidth);if(dir.includes('n'))t=clamp(e.clientY,0,d-6);if(dir.includes('s'))d=clamp(e.clientY,t+6,innerHeight);rect={x:l,y:t,width:r-l,height:d-t}}render()}
function end(){if(!mode)return;mode='';if(rect.width<6||rect.height<6){rect=null;b.style.display='none';bar.style.display='none';v.style.display='block';tip.style.display='block';return}render()}
function done(){if(!rect||rect.width<6||rect.height<6)return;screenCapture.finish({...rect,viewportWidth:innerWidth,viewportHeight:innerHeight})}
addEventListener('mousedown',begin);addEventListener('mousemove',move);addEventListener('mouseup',end);b.addEventListener('dblclick',e=>{if(!e.target.closest('.handle'))done()});document.querySelector('.done').onclick=done;document.querySelector('.cancel').onclick=()=>screenCapture.cancel();addEventListener('keydown',e=>{if(e.key==='Escape')screenCapture.cancel();if(e.key==='Enter')done()});addEventListener('contextmenu',e=>{e.preventDefault();screenCapture.cancel()});
</script>`;
    overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    overlay.webContents.once("did-finish-load", () => {
      if (overlay.isDestroyed()) return;
      clearTimeout(loadTimeout);
      overlay.show();
      overlay.focus();
    });
    overlay.webContents.once("did-fail-load", () => finish(null));
  });
}
