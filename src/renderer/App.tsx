import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent,
} from "react";
import {
  SearchItem,
  SearchResponse,
  AppInfo,
  FileIndexStatus,
  PluginInfo,
  PermissionRequest,
  PublicSettings,
} from "../shared/ipc";

function buildFlat(res: SearchResponse): SearchItem[] {
  if (!res) return [];
  // 优先级策略：
  // - 普通搜索：命令（计算器/金额/Everything入口）→ 插件 → 文件 → 应用
  // - 应用命中（appsFirst）：应用 → 插件 → 文件 → 命令
  //   应用是用户主要意图，"在 Everything 中搜索"入口和计算结果降级到后面
  const apps = res.apps ?? [];
  const files = res.files ?? [];
  const commands = res.commands ?? [];
  const plugins = res.plugins ?? [];
  const appFirst = res.appsFirst && apps.length > 0;
  if (appFirst) {
    return [...apps, ...plugins, ...files, ...commands];
  }
  return [...commands, ...plugins, ...files, ...apps];
}

interface DetailState {
  pluginId: string;
  pluginName: string;
  src: string;
}

const typeLabels: Record<string, string> = {
  command: "计算结果",
  plugin: "工具",
  app: "应用",
  file: "文件",
  snippet: "片段",
};
function Icon({ name = "search" }: { name?: string }) {
  const paths: Record<string, string> = {
    search: "m21 21-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
    notes: "M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5",
    "calc-paper":
      "M5 3h14v18H5z M8 7h8 M8 11h1 M12 11h1 M16 11h.1 M8 15h1 M12 15h1 M16 15h.1 M8 18h1 M12 18h1",
    amount: "m7 4 5 7 5-7 M6 11h12 M6 15h12 M12 11v10",
    password: "M5 10h14v11H5z M8 10V6a4 4 0 0 1 8 0v4 M12 14v3",
    plugin: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
    file: "M5 3h9l5 5v13H5z M14 3v6h5",
    app: "M3 4h18v14H3z M8 22h8 M12 18v4",
    command: "m5 7 5 5-5 5 M13 17h6",
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.plugin} />
    </svg>
  );
}
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  const at = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (!needle || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export default function App() {
  const [query, setQuery] = useState("");
  const [flat, setFlat] = useState<SearchItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Plugin detail view
  const [detail, setDetail] = useState<DetailState | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Permission card + toast
  const [perm, setPerm] = useState<PermissionRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Plugin management
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [showManage, setShowManage] = useState(false);
  const [fileIndex, setFileIndex] = useState<FileIndexStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [hotkeyDraft, setHotkeyDraft] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const searchVersion = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);
  // Mirror of the `detail` state for the onShow handler, which must not
  // re-subscribe on every detail change (it is registered once at mount).
  const detailRef = useRef<DetailState | null>(null);
  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  const showToast = useCallback((msg: string) => {
    if (!msg) return;
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const openSettings = useCallback(() => {
    window.launcher
      .getSettings()
      .then((value) => {
        setSettings(value);
        setHotkeyDraft(value.hotkey);
        document.documentElement.dataset.theme = value.theme;
        setSettingsOpen(true);
      })
      .catch(() => showToast("设置读取失败"));
  }, [showToast]);

  const updateSettings = useCallback(
    async (patch: Partial<PublicSettings>) => {
      if (!settings) return;
      const next = { ...settings, ...patch };
      await window.launcher.setSettings(patch);
      setSettings(next);
      document.documentElement.dataset.theme = next.theme;
    },
    [settings],
  );

  const saveHotkey = useCallback(async () => {
    const value = hotkeyDraft.trim();
    if (!value) return;
    const result = await window.launcher.setHotkey(value);
    if (!result.ok) {
      showToast(result.error || "快捷键不可用");
      return;
    }
    setSettings((current) =>
      current ? { ...current, hotkey: value } : current,
    );
    showToast("快捷键已更新");
  }, [hotkeyDraft, showToast]);

  const refreshPlugins = useCallback(() => {
    window.launcher
      .listPlugins()
      .then(setPlugins)
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.launcher
      .appInfo()
      .then((i) => {
        setInfo(i);
        if (i.fileIndex) setFileIndex(i.fileIndex);
      })
      .catch(() => {});
    refreshPlugins();
    window.launcher
      .getSettings()
      .then((value) => {
        setSettings(value);
        setHotkeyDraft(value.hotkey);
        document.documentElement.dataset.theme = value.theme;
      })
      .catch(() => {});
  }, [refreshPlugins]);

  // Live file-index progress (background walk while the app runs).
  useEffect(() => {
    return window.launcher.onFileIndexProgress((s) => setFileIndex(s));
  }, []);

  // Hotkey pressed -> main sends 'launcher:show'; reset to a fresh search.
  //
  // EXCEPTION (editor-state retention plan): when a plugin detail view is
  // open, the re-show must RESTORE it, not reset it. The detail state lives
  // in the top frame (this component), the iframe itself is never reloaded,
  // and the window keeps its expanded size — so the user's in-memory form
  // state (password editor etc.) is exactly what the host preserved.
  // Without this guard, setDetail(null) would unmount the iframe mid-edit
  // and the unsaved form would be lost even though the host kept the
  // window hidden-but-alive on blur.
  useEffect(() => {
    const off = window.launcher.onShow(() => {
      const hadDetail = detailRef.current !== null;
      if (hadDetail) {
        // Detail view is alive: keep it mounted, only refocus the window.
        return;
      }
      searchVersion.current++;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      setLoading(false);
      setQuery("");
      setFlat([]);
      setSelected(0);
      setCopied(null);
      setDetail(null);
      setPerm(null);
      setShowManage(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    return off;
  }, []);

  // Main-process events: toasts, permission cards, detail-exit.
  useEffect(() => {
    const offToast = window.launcher.onToast((t) => showToast(t.msg));
    const offPerm = window.launcher.onPermissionRequest((req) => setPerm(req));
    const offExit = window.launcher.onDetailExit(() => {
      setDetail(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    });
    return () => {
      offToast();
      offPerm();
      offExit();
    };
  }, [showToast]);

  useEffect(() => {
    resultsRef.current
      ?.querySelector(`#result-${selected}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, flat]);

  useEffect(
    () => () => {
      searchVersion.current++;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const loadingTimerRef = useRef<number | null>(null);

  const doSearch = useCallback(
    (q: string) => {
      const version = ++searchVersion.current;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (loadingTimerRef.current) window.clearTimeout(loadingTimerRef.current);

      if (!q.trim()) {
        setFlat([]);
        setSelected(0);
        setLoading(false);
        return;
      }

      // Delay loading spinner by 150ms so fast queries (<150ms) do not flicker
      loadingTimerRef.current = window.setTimeout(() => {
        if (version === searchVersion.current) setLoading(true);
      }, 150);

      debounceRef.current = window.setTimeout(async () => {
        try {
          const res = await window.launcher.search(q);
          if (version !== searchVersion.current) return;
          if (loadingTimerRef.current)
            window.clearTimeout(loadingTimerRef.current);
          const newFlat = buildFlat(res);
          setFlat(newFlat);
          setSelected((prev) => (prev < newFlat.length ? prev : 0));
        } catch {
          if (version === searchVersion.current)
            showToast("搜索失败，请重新输入后重试");
        } finally {
          if (loadingTimerRef.current)
            window.clearTimeout(loadingTimerRef.current);
          if (version === searchVersion.current) setLoading(false);
        }
      }, 120);
    },
    [showToast],
  );

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (!composing.current) doSearch(v);
    else {
      searchVersion.current++;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      if (loadingTimerRef.current) window.clearTimeout(loadingTimerRef.current);
      setLoading(false);
    }
  };

  // Close the detail view through the beforeClose negotiation. The host
  // asks the plugin page whether it allows closing; a page with unsaved
  // changes can refuse (it shows its own confirm dialog). If the page
  // allows (or does not answer within the timeout), the host closes and
  // sends EvtDetailExit, which this component listens to via onDetailExit
  // to actually unmount the iframe.
  const requestCloseDetail = useCallback(async () => {
    if (!detail) return;
    await window.launcher.detailClose();
    // If the page refused, detailClose returns { closed: false } and the
    // iframe stays mounted. If it allowed, the host sends EvtDetailExit
    // and onDetailExit unmounts it — no setDetail(null) needed here.
  }, [detail]);

  const launch = useCallback(
    async (item: SearchItem) => {
      if (!item) return;
      searchVersion.current++;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      setLoading(false);
      try {
        if (item.type === "plugin") {
          const r = await window.launcher.selectPlugin(item);
          if (r.openedDetail) {
            setDetail({
              pluginId: r.openedDetail.pluginId,
              pluginName: r.openedDetail.pluginName,
              src: `plugin://${r.openedDetail.pluginId}/${r.openedDetail.detail}`,
            });
          } else if (r.error) {
            showToast(r.error);
          }
          return;
        }
        const r = await window.launcher.launch(item);
        if (item.type === "command" && r.copied) {
          setCopied(r.copied);
          window.setTimeout(() => setCopied(null), 1500);
        }
        if (r.error) showToast(r.error);
      } catch {
        showToast("打开失败，请重试");
      }
    },
    [showToast],
  );

  /**
   * Show a native context menu for a search result (right-click / menu key).
   * Only file, folder, and .lnk-app results get the menu; store apps,
   * commands, plugins, and URLs are rejected by the main process.
   */
  const showContextMenu = useCallback(
    async (item: SearchItem, x?: number, y?: number) => {
      try {
        const res = await window.launcher.showResultContextMenu({
          type: item.type,
          payload: item.payload,
          title: item.title,
          x,
          y,
        });
        if (res.error) {
          showToast(res.error);
        } else if (res.action === "copy") {
          showToast("已复制完整路径");
        }
      } catch {
        showToast("菜单调用失败，请重试");
      }
    },
    [showToast],
  );

  // ------------------------------------------------- Enter handling (IME-safe)
  // Chinese IMEs often consume the physical Enter key as their own "commit"
  // key, so the page never sees key === "Enter" and the launcher appears dead.
  // We therefore: (1) act on keydown, ignoring real IME composition; (2) fall
  // back to keyup, which still arrives on some IMEs when keydown was eaten;
  // (3) expose a clickable button (mouse is never intercepted by an IME).
  const enterAt = useRef(0);
  const runSelected = useCallback(() => {
    const item = flat[selected];
    if (!item) return;
    enterAt.current = Date.now();
    void launch(item);
  }, [flat, selected, launch]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (perm || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      if (e.nativeEvent.isComposing) return; // let the IME commit first
      e.preventDefault();
      runSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      searchVersion.current++;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      void window.launcher.hide();
    } else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      // Shift+F10 or the keyboard Menu key: show the context menu for the
      // currently selected result. The menu appears near the result list;
      // the main process handles positioning relative to the window.
      e.preventDefault();
      const item = flat[selected];
      if (item) void showContextMenu(item);
    }
  };

  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (perm || e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (Date.now() - enterAt.current < 300) return; // keydown already handled it
    runSelected();
  };

  // Esc in the parent frame while a detail view is open (iframe Esc is
  // handled by the plugin-frame preload). Both paths go through the
  // beforeClose negotiation, so unsaved changes are confirmed first.
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !perm) void requestCloseDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, requestCloseDetail, perm]);

  const answerPerm = async (granted: boolean) => {
    if (!perm) return;
    const id = perm.requestId;
    setPerm(null);
    await window.launcher.permissionReply(id, granted);
  };

  const answerPermViaKey = (e: KeyboardEvent) => {
    if (!perm) return;
    if (e.key === "Escape") {
      e.preventDefault();
      void answerPerm(false);
    }
  };
  useEffect(() => {
    if (!perm) return;
    window.addEventListener("keydown", answerPermViaKey);
    return () => window.removeEventListener("keydown", answerPermViaKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perm]);

  const managePlugins = async (
    action: "install" | "rescan" | "uninstall",
    id?: string,
  ) => {
    if (action === "install") {
      const r = await window.launcher.installPluginPick();
      if (r.error) showToast(r.error);
      else if (r.ok)
        showToast(r.pluginId ? `已安装插件 ${r.pluginId}` : "安装完成");
    } else if (action === "rescan") {
      const list = await window.launcher.rescanPlugins();
      setPlugins(list);
      showToast("已重新扫描");
    } else if (action === "uninstall" && id) {
      const r = await window.launcher.uninstallPlugin(id);
      if (r.error) showToast(r.error);
      else {
        const list = await window.launcher.rescanPlugins();
        setPlugins(list);
        showToast(`已卸载 ${id}`);
      }
    }
    refreshPlugins();
  };

  const openPluginKeyword = (p: PluginInfo) => {
    if (p.hasDetail) {
      void launch({
        id: `plugin:${p.id}:home`,
        type: "plugin",
        title: p.name,
        payload: "",
        pluginId: p.id,
        raw: { keyword: p.keywords[0] ?? p.id, value: "" },
      });
      return;
    }
    setQuery(p.keywords[0] ?? p.id);
    doSearch(p.keywords[0] ?? p.id);
    inputRef.current?.focus();
  };

  // ------------------------------------------------------------ detail UI
  if (detail) {
    return (
      <div className="app">
        <div className="detailbar">
          <span className="detailbar-name">
            <Icon name={detail.pluginId} /> {detail.pluginName}
          </span>
          <button
            className="detailbar-maximize"
            onClick={() => void window.launcher.toggleMaximize()}
            title="最大化 / 还原 (⊡)"
          >
            ⊡
          </button>
          <button
            className="detailbar-close"
            onClick={() => void requestCloseDetail()}
            title="关闭 (Esc)"
          >
            返回搜索 · Esc
          </button>
        </div>
        <iframe
          title={detail.pluginName}
          ref={iframeRef}
          className="detail-frame"
          src={detail.src}
          onLoad={() => {
            void window.launcher.detailReady();
          }}
        />
        {toast && <div className="toast">{toast}</div>}
        {perm && (
          <div className="perm-card" onClick={(e) => e.stopPropagation()}>
            <div className="perm-title">插件「{perm.pluginName}」请求访问</div>
            <div className="perm-target">{perm.target}</div>
            <div className="perm-purpose">{perm.purpose}</div>
            <div className="perm-actions">
              <button
                className="perm-btn deny"
                onClick={() => void answerPerm(false)}
              >
                拒绝 (Esc)
              </button>
              <button
                className="perm-btn allow"
                onClick={() => void answerPerm(true)}
              >
                允许访问
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ------------------------------------------------------------ search UI
  const showEmpty = query.trim().length > 0 && flat.length === 0 && !loading;
  const showHint = query.trim().length === 0;

  return (
    <div className="app">
      <div className="searchbar">
        <span className="searchbar-icon">
          <Icon />
        </span>
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
            searchVersion.current++;
            if (debounceRef.current) window.clearTimeout(debounceRef.current);
            if (loadingTimerRef.current)
              window.clearTimeout(loadingTimerRef.current);
            setLoading(false);
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            doSearch((e.target as HTMLInputElement).value);
          }}
          onKeyUp={onKeyUp}
          placeholder="搜索应用、文件或工具…"
          aria-label="搜索应用、文件或工具"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="search-results"
          aria-expanded={flat.length > 0}
          aria-activedescendant={
            flat[selected] ? `result-${selected}` : undefined
          }
          autoFocus
          spellCheck={false}
        />
        {loading && (
          <span className="spinner" role="status" aria-label="正在搜索" />
        )}
        {flat.length > 0 && (
          <button
            type="button"
            className="go-btn"
            title="打开选中项（相当于回车）"
            onMouseDown={(e) => e.preventDefault()}
            onClick={runSelected}
          >
            {flat[selected]?.type === "command" ? "复制结果" : "打开"}{" "}
            <kbd>↵</kbd>
          </button>
        )}
        <button
          className="settings-trigger"
          title="系统设置"
          aria-label="系统设置"
          onClick={openSettings}
        >
          ⚙
        </button>
      </div>

      {settingsOpen && settings && (
        <div
          className="settings-backdrop"
          onMouseDown={() => setSettingsOpen(false)}
        >
          <section
            className="settings-panel"
            role="dialog"
            aria-modal="true"
            aria-label="系统设置"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <span>系统设置</span>
                <small>启动、外观与本地数据</small>
              </div>
              <button onClick={() => setSettingsOpen(false)}>×</button>
            </header>
            <div className="settings-body">
              <div className="settings-section">
                <h2>快捷键</h2>
                <div className="settings-row">
                  <div>
                    <strong>唤起应用</strong>
                    <small>例如 Alt+Space、Ctrl+Shift+Space</small>
                  </div>
                  <div className="hotkey-editor">
                    <input
                      value={hotkeyDraft}
                      onChange={(e) => setHotkeyDraft(e.target.value)}
                    />
                    <button onClick={() => void saveHotkey()}>保存</button>
                  </div>
                </div>
              </div>
              <div className="settings-section">
                <h2>通用</h2>
                <label className="settings-row">
                  <div>
                    <strong>开机自动启动</strong>
                    <small>登录 Windows 后在后台运行</small>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.launchAtLogin}
                    onChange={(e) =>
                      void updateSettings({ launchAtLogin: e.target.checked })
                    }
                  />
                </label>
              </div>
              <div className="settings-section">
                <h2>外观</h2>
                <div className="settings-row">
                  <div>
                    <strong>颜色模式</strong>
                    <small>立即应用到主界面</small>
                  </div>
                  <select
                    value={settings.theme}
                    onChange={(e) =>
                      void updateSettings({
                        theme: e.target.value as PublicSettings["theme"],
                      })
                    }
                  >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </div>
              </div>
              <div className="settings-section">
                <h2>本地数据</h2>
                <div className="settings-row">
                  <div>
                    <strong>应用数据</strong>
                    <small>设置、插件和插件私有数据</small>
                  </div>
                  <button onClick={() => void window.launcher.revealData()}>
                    打开目录
                  </button>
                </div>
                <div className="settings-row">
                  <div>
                    <strong>诊断日志</strong>
                    <small>自动轮转，不保存密码和剪贴板正文</small>
                  </div>
                  <button onClick={() => void window.launcher.revealLogs()}>
                    打开日志
                  </button>
                </div>
              </div>
              <div className="settings-section">
                <h2>文件索引</h2>
                <div className="settings-row">
                  <div>
                    <strong>
                      {info?.everythingAvailable
                        ? "Everything 索引"
                        : "本地索引"}
                    </strong>
                    <small>
                      {fileIndex
                        ? `${fileIndex.count.toLocaleString()} 个文件${fileIndex.capped ? " · 已达上限" : fileIndex.running ? " · 正在建立" : ""}`
                        : "正在读取状态"}
                    </small>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      <div className="results" ref={resultsRef}>
        {copied && (
          <div className="copied-toast" role="status">
            已复制：{copied}
          </div>
        )}

        {showHint && (
          <div className="hint">
            <div className="home-heading">
              <div>
                <span className="eyebrow">UTOOLS LITE</span>
                <h1>随时唤起，即刻开始</h1>
              </div>
              <span className="home-caption">你的桌面工具箱</span>
            </div>
            <div className="quick-examples">
              <span>试试输入</span>
              {["2+2*2", "1234.56"].map((value) => (
                <button
                  key={value}
                  onClick={() => {
                    setQuery(value);
                    doSearch(value);
                    inputRef.current?.focus();
                  }}
                >
                  {value}
                  <span>↗</span>
                </button>
              ))}
            </div>

            {plugins.length > 0 && (
              <div className="plugin-list">
                <div className="plugin-list-head">
                  <span>
                    常用工具{" "}
                    <span className="tool-count">{plugins.length}</span>
                  </span>
                  <button
                    className="plugin-manage-btn"
                    onClick={() => setShowManage((v) => !v)}
                  >
                    {showManage ? "收起" : "管理"}
                  </button>
                </div>
                <div
                  className={showManage ? "tool-grid managing" : "tool-grid"}
                >
                  {plugins.map((p) => (
                    <div
                      key={p.id}
                      className={
                        "plugin-row" + (p.status === "error" ? " error" : "")
                      }
                      onClick={() => openPluginKeyword(p)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (
                          e.target === e.currentTarget &&
                          (e.key === "Enter" || e.key === " ")
                        ) {
                          e.preventDefault();
                          openPluginKeyword(p);
                        }
                      }}
                      title={p.error ?? p.description ?? p.name}
                    >
                      <span className="plugin-icon">
                        <Icon name={p.id} />
                      </span>
                      <span className="plugin-name">
                        {p.name}
                        {p.builtin ? "" : " · 已安装"}
                        {p.status === "error" && (
                          <span className="plugin-err"> ⚠ {p.error}</span>
                        )}
                      </span>
                      <span className="plugin-kws">
                        {p.keywords.slice(0, 2).map((k) => (
                          <span key={k} className="plugin-kw">
                            {k}
                          </span>
                        ))}
                      </span>
                      {showManage && (
                        <span
                          className="plugin-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="plugin-action"
                            onClick={() =>
                              void window.launcher
                                .revealPlugin(p.id)
                                .then((r) => {
                                  if (r.note) showToast(r.note);
                                  else if (r.error) showToast(r.error);
                                })
                            }
                          >
                            目录
                          </button>
                          {!p.builtin && (
                            <button
                              className="plugin-action danger"
                              onClick={() =>
                                void managePlugins("uninstall", p.id)
                              }
                            >
                              卸载
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {showManage && (
                  <div className="plugin-manage-bar">
                    <button onClick={() => void managePlugins("install")}>
                      安装插件（文件夹 / zip）…
                    </button>
                    <button onClick={() => void managePlugins("rescan")}>
                      重新扫描
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showEmpty && (
          <div className="empty">
            <Icon />
            <strong>没有找到相关结果</strong>
            <span>试试更短的关键词，或检查文件名是否正确。</span>
            {info && !info.everythingAvailable
              ? fileIndex?.running
                ? "正在建立文件索引，部分文件稍后可被搜到。"
                : "重新启动可刷新本地文件索引。"
              : ""}
          </div>
        )}

        <div
          id="search-results"
          role="listbox"
          aria-label="搜索结果"
          aria-busy={loading}
        >
          {flat.map((item, i) => (
            <Fragment key={item.id}>
              {(i === 0 || flat[i - 1].type !== item.type) && (
                <div className="result-group" role="presentation">
                  {typeLabels[item.type]}
                </div>
              )}
              <div
                id={`result-${i}`}
                role="option"
                aria-selected={i === selected}
                title={item.subtitle ?? item.title}
                className={"result" + (i === selected ? " selected" : "")}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  // Only left button opens the result; right button is
                  // handled by onContextMenu below. Without this guard a
                  // right-click would both open the file AND show the menu.
                  if (e.button !== 0) return;
                  void launch(item);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // Select this row so the menu acts on what the user
                  // right-clicked, not the previously keyboard-selected row.
                  setSelected(i);
                  void showContextMenu(item, e.clientX, e.clientY);
                }}
              >
                {item.iconUrl ? (
                  <img
                    className="result-icon-img"
                    src={item.iconUrl}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <span className="result-icon">
                    <Icon name={item.pluginId ?? item.type} />
                  </span>
                )}
                <div className="result-text">
                  <div className="result-title">
                    <Highlight
                      text={item.title.replace(/^[🧾💰]\s*/u, "")}
                      query={query}
                    />
                  </div>
                  {item.subtitle && (
                    <div className="result-sub">{item.subtitle}</div>
                  )}
                </div>
                <span className="result-type">
                  {i === selected ? <kbd>↵</kbd> : typeLabels[item.type]}
                </span>
              </div>
            </Fragment>
          ))}
        </div>
      </div>
      <footer className="statusbar">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>Esc</kbd> 隐藏
        </span>
        <span
          className="index-status"
          style={{ cursor: "pointer" }}
          onClick={() => {
            if (info?.everythingAvailable) {
              void window.launcher.launch({
                type: "command",
                payload: query ? `everything:${query}` : "everything:",
              });
            } else if (fileIndex?.capped) {
              void window.launcher.launch({
                type: "app",
                payload: "https://www.voidtools.com/zh-cn/",
              });
            }
          }}
          title={
            info?.everythingAvailable
              ? "已连接本地 Everything，点击直接唤起"
              : fileIndex?.capped
                ? "本地索引已达 600,000 条上限，点击查看 Everything 获取全盘秒搜"
                : "本地文件索引"
          }
        >
          <i className={fileIndex?.running ? "indexing" : ""} />
          {info?.everythingAvailable
            ? "Everything 已联动 (点击唤起)"
            : fileIndex
              ? `${fileIndex.running ? "索引中 · " : fileIndex.capped ? "已达上限(点此极速全搜) · " : "已索引 "}${fileIndex.count.toLocaleString()} 个文件`
              : "准备中"}
        </span>
      </footer>

      {toast && <div className="toast">{toast}</div>}
      {perm && (
        <div className="perm-card">
          <div className="perm-title">插件「{perm.pluginName}」请求访问</div>
          <div className="perm-target">{perm.target}</div>
          <div className="perm-purpose">{perm.purpose}</div>
          <div className="perm-actions">
            <button
              className="perm-btn deny"
              onClick={() => void answerPerm(false)}
            >
              拒绝 (Esc)
            </button>
            <button
              className="perm-btn allow"
              onClick={() => void answerPerm(true)}
            >
              允许访问
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
