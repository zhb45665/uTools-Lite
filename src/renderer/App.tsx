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
} from "../shared/ipc";

function buildFlat(res: SearchResponse): SearchItem[] {
  if (!res) return [];
  return [
    ...(res.commands ?? []),
    ...(res.plugins ?? []),
    ...(res.apps ?? []),
    ...(res.files ?? []),
  ];
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

  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const searchVersion = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    if (!msg) return;
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

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
  }, [refreshPlugins]);

  // Live file-index progress (background walk while the app runs).
  useEffect(() => {
    return window.launcher.onFileIndexProgress((s) => setFileIndex(s));
  }, []);

  // Hotkey pressed -> main sends 'launcher:show'; reset to a fresh search.
  useEffect(() => {
    const off = window.launcher.onShow(() => {
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

  const doSearch = useCallback(
    (q: string) => {
      const version = ++searchVersion.current;
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      setFlat([]);
      setSelected(0);
      if (!q.trim()) {
        setFlat([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      debounceRef.current = window.setTimeout(async () => {
        try {
          const res = await window.launcher.search(q);
          if (version !== searchVersion.current) return;
          setFlat(buildFlat(res));
          setSelected(0);
        } catch {
          if (version === searchVersion.current)
            showToast("搜索失败，请重新输入后重试");
        } finally {
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
      setFlat([]);
      setLoading(false);
    }
  };

  const closeDetail = useCallback(() => {
    if (!detail) return;
    setDetail(null);
    window.launcher.detailClose();
    requestAnimationFrame(() => inputRef.current?.focus());
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
    }
  };

  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (perm || e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (Date.now() - enterAt.current < 300) return; // keydown already handled it
    runSelected();
  };

  // Esc in the parent frame while a detail view is open (iframe Esc is
  // handled by the plugin-frame preload).
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !perm) closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, closeDetail, perm]);

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
            className="detailbar-close"
            onClick={closeDetail}
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
            setFlat([]);
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
      </div>

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
                  void launch(item);
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
          title={
            info?.everythingAvailable
              ? "使用 Everything 搜索文件"
              : "本地文件索引"
          }
        >
          <i className={fileIndex?.running ? "indexing" : ""} />
          {info?.everythingAvailable
            ? "搜索已就绪"
            : fileIndex
              ? `${fileIndex.running ? "索引中 · " : fileIndex.capped ? "已达上限 · " : "已索引 "}${fileIndex.count.toLocaleString()} 个文件`
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
