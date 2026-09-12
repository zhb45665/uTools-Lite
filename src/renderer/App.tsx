import {
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

  const doSearch = useCallback((q: string) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setFlat([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await window.launcher.search(q);
        setFlat(buildFlat(res));
        setSelected(0);
      } finally {
        setLoading(false);
      }
    }, 120);
  }, []);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (!composing.current) doSearch(v);
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
    },
    [showToast],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[selected];
      if (item) void launch(item);
    } else if (e.key === "Escape") {
      // Blur the input -> window blur -> main hides the launcher.
      inputRef.current?.blur();
    }
  };

  // Esc in the parent frame while a detail view is open (iframe Esc is
  // handled by the plugin-frame preload).
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, closeDetail]);

  const answerPerm = async (granted: boolean) => {
    if (!perm) return;
    const id = perm.requestId;
    setPerm(null);
    await window.launcher.permissionReply(id, granted);
  };

  const answerPermViaKey = (e: KeyboardEvent) => {
    if (!perm) return;
    if (e.key === "Enter") void answerPerm(true);
    else if (e.key === "Escape") void answerPerm(false);
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
      else showToast(r.pluginId ? `已安装插件 ${r.pluginId}` : "安装完成");
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
    setQuery(p.keywords[0] ?? p.id);
    doSearch(p.keywords[0] ?? p.id);
    inputRef.current?.focus();
  };

  // ------------------------------------------------------------ detail UI
  if (detail) {
    return (
      <div className="app">
        <div className="detailbar">
          <span className="detailbar-name">🧩 {detail.pluginName}</span>
          <button
            className="detailbar-close"
            onClick={closeDetail}
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
        <iframe
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
                允许 (Enter)
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
        <span className="searchbar-icon">🔍</span>
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            doSearch((e.target as HTMLInputElement).value);
          }}
          placeholder="Search files, apps, plugins… (2+2*2 / note / b64)"
          autoFocus
          spellCheck={false}
        />
        {loading && <span className="spinner">▋</span>}
      </div>

      <div className="results">
        {copied && <div className="copied-toast">Copied: {copied}</div>}

        {showHint && (
          <div className="hint">
            <div>
              Type to search files &amp; apps, or compute <b>2+2*2</b>
            </div>
            {info && (
              <div className="meta">
                {info.everythingAvailable
                  ? "Everything: ready"
                  : fileIndex
                    ? `本地文件索引：${fileIndex.count.toLocaleString()} 个文件${
                        fileIndex.complete
                          ? fileIndex.capped
                            ? "（已达索引上限）"
                            : "（已完成）"
                          : "（后台扫描中…）"
                      }`
                    : "本地文件索引：启动中…"}
                {" · "}
                {info.appCount} apps indexed
                {" · "}
                {info.pluginCount} plugins
              </div>
            )}
            <div className="meta">↑↓ navigate · Enter open · Esc close</div>

            {plugins.length > 0 && (
              <div className="plugin-list">
                <div className="plugin-list-head">
                  <span>已安装插件（点击输入其关键词）</span>
                  <button
                    className="plugin-manage-btn"
                    onClick={() => setShowManage((v) => !v)}
                  >
                    {showManage ? "收起" : "管理"}
                  </button>
                </div>
                {plugins.map((p) => (
                  <div
                    key={p.id}
                    className={
                      "plugin-row" + (p.status === "error" ? " error" : "")
                    }
                    onClick={() => openPluginKeyword(p)}
                    title={p.error ?? p.description ?? p.name}
                  >
                    <span className="plugin-icon">{p.icon ?? "🧩"}</span>
                    <span className="plugin-name">
                      {p.name}
                      {p.builtin ? "" : " (user)"}
                      {p.status === "error" && (
                        <span className="plugin-err"> ⚠ {p.error}</span>
                      )}
                    </span>
                    <span className="plugin-kws">
                      {p.keywords.map((k) => (
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
                            void window.launcher.revealPlugin(p.id)
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
            No results
            {info && !info.everythingAvailable
              ? " — install Everything for fast file search"
              : ""}
          </div>
        )}

        {flat.map((item, i) => (
          <div
            key={item.id}
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
              <span className="result-icon">{item.icon ?? "•"}</span>
            )}
            <div className="result-text">
              <div className="result-title">{item.title}</div>
              {item.subtitle && (
                <div className="result-sub">{item.subtitle}</div>
              )}
            </div>
            <span className="result-type">{item.type}</span>
          </div>
        ))}
      </div>

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
              允许 (Enter)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
