import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Blocks,
  ChevronRight,
  ClipboardList,
  FileDiff,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Globe,
  LayoutDashboard,
  type LucideIcon,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  SquarePen,
  SquareTerminal,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { api, execCommand, isMac, type ChatSummary, type ProjectSummary } from './lib/api';
import { LoopEventsProvider, useDaemonConnected, usePlanOpen, usePreviewOpen } from './lib/events';
import { useTheme, type ThemePref } from './lib/theme';
import { cls, timeAgo } from './components/common';
import { Logo } from './components/Logo';
import { Terminal } from './components/Terminal';
import { ChangesPanel } from './components/ChangesPanel';
import { FileTree } from './components/FileTree';
import { Preview } from './components/Preview';
import { LoopsPage } from './pages/Loops';
import { ChatPage, type ChatChanges, type ChatSeed } from './pages/Chat';
import { OverviewArea } from './pages/OverviewArea';
import { PlansPage, type PlanSelection } from './pages/Plans';
import { PluginsPage } from './pages/Plugins';
import { SettingsArea } from './pages/SettingsArea';

export type Nav = 'overview' | 'chat' | 'plans' | 'loops' | 'plugins' | 'settings';

type TopItem = { id: Nav; label: string; icon: LucideIcon };

const TOP_NAV: TopItem[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'chat', label: 'New chat', icon: SquarePen },
  { id: 'plans', label: 'Plans', icon: ClipboardList },
  { id: 'loops', label: 'Loops', icon: RefreshCw },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
];

export function App(): React.ReactElement {
  return (
    <LoopEventsProvider>
      <Shell />
    </LoopEventsProvider>
  );
}

function Shell(): React.ReactElement {
  const [nav, setNav] = useState<Nav>('overview');
  const [prevNav, setPrevNav] = useState<Nav>('overview');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chatsKey, setChatsKey] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addedProjects, setAddedProjects] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('cr.addedProjects') || '[]') as string[];
    } catch {
      return [];
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  // Dockable side panels (files / browser / terminal / changes). Each panel
  // can be opened/closed, docked to the left or right of the main content, and
  // its dock resized. `files` opens on the left by default (IDE-style). The
  // whole layout is persisted so it survives reloads.
  const [panels, setPanels] = useState<Record<PanelId, PanelState>>(() => loadLayout().panels);
  const [activeBySide, setActiveBySide] = useState<Record<Side, PanelId | null>>(() => loadLayout().activeBySide);
  const [leftWidth, setLeftWidth] = useState<number>(() => loadLayout().leftWidth);
  const [rightWidth, setRightWidth] = useState<number>(() => loadLayout().rightWidth);
  // In-app browser preview URL; opens automatically (on the Browser tab) when
  // the agent starts a dev server whose URL we detect.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Whether previews open in the built-in browser (default) or the OS
  // browser. Mirrors the global setting; a false value routes open_preview
  // to the external browser instead of the right-dock Browser tab.
  const [previewInApp, setPreviewInApp] = useState(true);
  const [insertText, setInsertText] = useState<{ text: string; nonce: number } | null>(null);
  const [changes, setChanges] = useState<ChatChanges | null>(null);
  // Plan workspace: which plan to open, and a pending chat seed (prompt +
  // mode) used to launch refine / build chats from a plan.
  const [planSelection, setPlanSelection] = useState<PlanSelection>(null);
  const [chatSeed, setChatSeed] = useState<ChatSeed | null>(null);
  const connected = useDaemonConnected();
  const mac = isMac();

  // Open a fresh chat pre-filled with a prompt + mode (used by the Plan
  // workspace "Refine"/"Start build" actions and CLI -> app handoffs).
  const seedChat = (prompt: string, seedMode: string, cwd?: string): void => {
    if (cwd) setProject(cwd);
    setChatSeed({ prompt, mode: seedMode, nonce: Date.now() });
    setChatId('new');
    setNav('chat');
  };

  // Chat "View plan": jump to the Plan workspace focused on a plan id.
  const viewPlan = (planId: string, cwd?: string): void => {
    if (cwd) setProject(cwd);
    setPlanSelection({ id: planId, nonce: Date.now() });
    setNav('plans');
  };

  // CLI -> app handoff: open a Plan-mode refine chat preloaded with the
  // pushed plan's body (mirrors Claude Code's "refine with Ultraplan").
  usePlanOpen((e) => {
    void api
      .plan(e.cwd, e.planId)
      .then((d) => {
        setPlanSelection({ id: e.planId, nonce: Date.now() });
        seedChat(`Here is a draft plan to refine:\n\n${d.body}`, 'plan', e.cwd);
      })
      .catch(() => {
        // Plan body unavailable; still surface it in the workspace.
        setProject(e.cwd);
        setPlanSelection({ id: e.planId, nonce: Date.now() });
        setNav('plans');
      });
  }, []);

  // CLI -> app handoff: a CLI-run agent called open_preview with the pref on,
  // so show the URL in the built-in browser here.
  usePreviewOpen((e) => {
    showInAppBrowser(e.url);
  }, []);

  // Load the preview-target preference; the setting page updates it live via
  // the custom event below so we don't have to poll.
  useEffect(() => {
    void api.settings().then((s) => setPreviewInApp(s.previewInApp)).catch(() => {});
    const onPref = (e: Event): void => {
      const detail = (e as CustomEvent<{ previewInApp: boolean }>).detail;
      if (detail && typeof detail.previewInApp === 'boolean') setPreviewInApp(detail.previewInApp);
    };
    window.addEventListener('cr:preview-in-app', onPref as EventListener);
    return () => window.removeEventListener('cr:preview-in-app', onPref as EventListener);
  }, []);

  // Persist the whole dock layout (which panels are open, their side, and the
  // dock widths) so it survives reloads.
  useEffect(() => {
    try {
      localStorage.setItem('cr.layout', JSON.stringify({ panels, activeBySide, leftWidth, rightWidth }));
    } catch {
      /* ignore quota errors */
    }
  }, [panels, activeBySide, leftWidth, rightWidth]);

  // --- dockable panel actions ------------------------------------------------
  const openPanel = (id: PanelId): void => {
    const side = panels[id].side;
    setPanels((p) => ({ ...p, [id]: { ...p[id], open: true } }));
    setActiveBySide((a) => ({ ...a, [side]: id }));
  };
  const togglePanel = (id: PanelId): void => {
    const side = panels[id].side;
    const willOpen = !panels[id].open;
    setPanels((p) => ({ ...p, [id]: { ...p[id], open: willOpen } }));
    setActiveBySide((a) => (willOpen ? { ...a, [side]: id } : a[side] === id ? { ...a, [side]: null } : a));
  };
  const closePanel = (id: PanelId): void => {
    const side = panels[id].side;
    setPanels((p) => ({ ...p, [id]: { ...p[id], open: false } }));
    setActiveBySide((a) => (a[side] === id ? { ...a, [side]: null } : a));
  };
  // Swap a panel to the opposite side (left <-> right).
  const movePanel = (id: PanelId): void => {
    const from = panels[id].side;
    const to: Side = from === 'left' ? 'right' : 'left';
    setPanels((p) => ({ ...p, [id]: { ...p[id], side: to } }));
    setActiveBySide((a) => ({ ...a, [to]: id, [from]: a[from] === id ? null : a[from] }));
  };

  // ⌘J toggles the terminal; ⌘K / ⌘P opens search — matching Codex/Claude.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        togglePanel('terminal');
      } else if (meta && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'p')) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels]);

  useEffect(() => {
    void api
      .projects()
      .then((r) => {
        setProjects(r.projects);
        const first = r.projects[0]?.cwd ?? null;
        setProject((p) => p ?? first);
        if (first) setExpanded((e) => (e.size ? e : new Set([first])));
      })
      .catch(() => {});
  }, []);

  // All chats across every project; grouped under their project in the tree.
  useEffect(() => {
    void api
      .chats()
      .then((r) => setChats(r.chats))
      .catch(() => setChats([]));
  }, [chatsKey]);

  const chatsByProject = useMemo(() => {
    const map = new Map<string, ChatSummary[]>();
    for (const c of chats) {
      const list = map.get(c.cwd) ?? [];
      list.push(c);
      map.set(c.cwd, list);
    }
    return map;
  }, [chats]);

  // Daemon-known projects plus any folders the user added manually (which
  // may not have CodeRouter history yet, so they aren't in the DB).
  const allProjects = useMemo(() => {
    const known = new Set(projects.map((p) => p.cwd));
    const extras: ProjectSummary[] = addedProjects
      .filter((cwd) => !known.has(cwd))
      .map((cwd) => ({
        cwd,
        name: cwd.replace(/\/+$/, '').split('/').pop() || cwd,
        lastSeen: 0,
        runs: 0,
        loops: 0,
        chats: 0,
        costUsd: 0,
        lastActivity: 0,
      }));
    return [...extras, ...projects];
  }, [projects, addedProjects]);

  const registerProject = (path: string): void => {
    setAddedProjects((prev) => {
      const next = prev.includes(path) ? prev : [path, ...prev];
      try {
        localStorage.setItem('cr.addedProjects', JSON.stringify(next));
      } catch {
        /* ignore quota errors */
      }
      return next;
    });
    setProject(path);
    setExpanded((e) => new Set(e).add(path));
    newChat();
  };

  // "Use an existing folder": native picker (Electron) or a path prompt.
  const openExistingFolder = async (): Promise<void> => {
    let dir: string | null = null;
    const picker = window.coderouter?.pickFolder;
    if (picker) dir = await picker();
    else {
      const typed = window.prompt('Open an existing project folder (absolute path):');
      dir = typed && typed.trim() ? typed.trim() : null;
    }
    if (dir) registerProject(dir.trim());
  };

  // "Start from scratch": create a new folder via the daemon, then register it.
  const createNewFolder = async (): Promise<void> => {
    const typed = window.prompt('Create a new project folder (absolute path):');
    const path = typed && typed.trim() ? typed.trim() : null;
    if (!path) return;
    try {
      await execCommand({ cwd: '', command: `mkdir -p '${path.replace(/'/g, `'\\''`)}'` }, () => {});
    } catch {
      /* best effort — still register so the user can point at it */
    }
    registerProject(path);
  };

  const newChat = (): void => {
    setChatId('new');
    setNav('chat');
  };
  const openChat = (c: ChatSummary): void => {
    setProject(c.cwd);
    setChatId(c.id);
    setNav('chat');
  };
  // File-explorer actions: reference a file in the prompt (@path) or
  // open it in the user's editor.
  const mentionFile = (relPath: string): void => {
    setNav('chat');
    setInsertText({ text: `@${relPath}`, nonce: Date.now() });
  };
  const openFileInEditor = (relPath: string): void => {
    if (project) void api.openPath(project, relPath);
  };
  const deleteChat = async (c: ChatSummary): Promise<void> => {
    if (!window.confirm(`Delete chat "${c.title || 'Untitled'}"? This can't be undone.`)) return;
    // Optimistically drop it from the tree; if the open chat was deleted,
    // fall back to a fresh new-chat composer.
    setChats((prev) => prev.filter((x) => x.id !== c.id));
    if (nav === 'chat' && chatId === c.id) newChat();
    try {
      await api.deleteChat(c.cwd, c.id);
    } catch {
      // Re-sync from the daemon if the delete failed so the UI is honest.
      setChatsKey((k) => k + 1);
    }
  };
  const toggleProject = (cwd: string): void => {
    setProject(cwd);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  // Show a URL the agent produced (dev server, or an open_preview call).
  // Honors the preview-in-app setting: the built-in browser panel when on,
  // the OS default browser when off.
  const showServerUrl = (url: string): void => {
    if (previewInApp) {
      setPreviewUrl(url);
      openPanel('browser');
    } else {
      void api.openUrl(url);
    }
  };

  // Force the built-in browser regardless of the setting - used for explicit
  // CLI -> app preview handoffs (the CLI already decided to route here).
  const showInAppBrowser = (url: string): void => {
    setPreviewUrl(url);
    openPanel('browser');
  };

  const activeName = allProjects.find((p) => p.cwd === project)?.name;

  // Panels currently open on each side, plus the resolved active tab (falls
  // back to the first open panel when the stored active one isn't here).
  const leftPanels = PANEL_ORDER.filter((id) => panels[id].open && panels[id].side === 'left');
  const rightPanels = PANEL_ORDER.filter((id) => panels[id].open && panels[id].side === 'right');
  const leftActive = leftPanels.includes(activeBySide.left as PanelId) ? activeBySide.left : leftPanels[0] ?? null;
  const rightActive = rightPanels.includes(activeBySide.right as PanelId) ? activeBySide.right : rightPanels[0] ?? null;

  const renderPanel = (id: PanelId): React.ReactElement => {
    switch (id) {
      case 'files':
        return <FileTree project={project} onMention={mentionFile} onOpenFile={openFileInEditor} />;
      case 'browser':
        return <Preview url={previewUrl} isElectron={Boolean(window.coderouter?.isElectron)} />;
      case 'terminal':
        return <Terminal project={project} />;
      case 'changes':
        return <ChangesPanel changes={changes} />;
    }
  };

  return (
    <div className="flex h-full">
      {sidebarOpen && (
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
        <div className="drag">
          <div className={cls('flex items-center justify-end px-2', mac ? 'h-11' : 'h-9 pt-1')}>
            <button
              onClick={() => setSidebarOpen(false)}
              className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel2 hover:text-text"
              title="Collapse sidebar"
            >
              <PanelLeft className="h-[17px] w-[17px]" strokeWidth={2} />
            </button>
          </div>
          <div className="flex items-center gap-2 px-3 pb-3">
            <Logo className="h-12 w-12" />
            <span className="text-lg font-semibold tracking-tight text-accent">CodeRouter</span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="no-drag mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-muted transition-colors hover:bg-panel2 hover:text-text"
          >
            <Search className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
            Search
            <span className="ml-auto text-[11px] text-muted/60">⌘K</span>
          </button>
          {TOP_NAV.map((n) => {
            const Icon = n.icon;
            const active = n.id === 'chat' ? nav === 'chat' && (chatId === 'new' || chatId == null) : nav === n.id;
            return (
              <button
                key={n.id}
                onClick={() => (n.id === 'chat' ? newChat() : setNav(n.id))}
                className={cls(
                  'no-drag mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors',
                  active ? 'bg-accent/20 text-text' : 'text-muted hover:bg-panel2 hover:text-text',
                )}
              >
                <Icon className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
                {n.label}
              </button>
            );
          })}

          <SectionLabel
            action={
              <AddProjectMenu
                onCreate={() => void createNewFolder()}
                onOpen={() => void openExistingFolder()}
              />
            }
          >
            Projects
          </SectionLabel>
          {allProjects.length === 0 && <Empty>No projects yet</Empty>}
          {allProjects.map((p) => {
            const open = expanded.has(p.cwd);
            const pChats = chatsByProject.get(p.cwd) ?? [];
            return (
              <div key={p.cwd}>
                <button
                  onClick={() => toggleProject(p.cwd)}
                  title={p.cwd}
                  className={cls(
                    'no-drag flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-medium transition-colors hover:bg-panel2',
                    project === p.cwd ? 'text-text' : 'text-muted hover:text-text',
                  )}
                >
                  <ChevronRight className={cls('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')} strokeWidth={2.5} />
                  {open ? (
                    <FolderOpen className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
                  ) : (
                    <Folder className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
                  )}
                  <span className="truncate">{p.name}</span>
                  {pChats.length > 0 && <span className="ml-auto pl-1 text-[11px] text-muted/70">{pChats.length}</span>}
                </button>
                {open && (
                  <div className="mb-1 ml-3 border-l border-border pl-2">
                    {pChats.length === 0 && <div className="px-2 py-1 text-xs text-muted/60">No chats yet</div>}
                    {pChats.map((c) => (
                      <div key={c.id} className="group/chat relative">
                        <button
                          onClick={() => openChat(c)}
                          title={c.title}
                          className={cls(
                            'no-drag flex w-full items-center rounded-md py-1 pl-2 pr-7 text-left text-[13px] transition-colors',
                            nav === 'chat' && chatId === c.id ? 'bg-panel2 text-text' : 'text-muted hover:bg-panel2 hover:text-text',
                          )}
                        >
                          <span className="truncate">{c.title || 'Untitled'}</span>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteChat(c);
                          }}
                          title="Delete chat"
                          className="no-drag absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-panel hover:text-bad focus:opacity-100 group-hover/chat:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="px-2 pb-2">
          <SidebarSettings
            active={nav === 'settings'}
            connected={connected}
            onOpenSettings={() => {
              setPrevNav((p) => (nav === 'settings' ? p : nav));
              setNav('settings');
            }}
          />
        </div>
      </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className={cls(
            'drag flex shrink-0 items-center gap-2 border-b border-border pr-4',
            mac ? 'h-11' : 'h-12',
            !sidebarOpen && mac ? 'pl-[80px]' : 'pl-4',
          )}
        >
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel2 hover:text-text"
              title="Open sidebar"
            >
              <PanelLeft className="h-[17px] w-[17px]" strokeWidth={2} />
            </button>
          )}
          <h1 className="text-[15px] font-semibold">{nav === 'chat' ? 'Chat' : TOP_NAV.find((n) => n.id === nav)?.label ?? 'Settings'}</h1>
          <div className="no-drag ml-auto flex items-center gap-1">
            {(nav === 'loops' || nav === 'chat') && activeName && (
              <span className="mr-1 max-w-[180px] truncate text-xs text-muted">{activeName}</span>
            )}
            <PanelToggle icon={FolderTree} active={panels.files.open} onClick={() => togglePanel('files')} title="File explorer" />
            <PanelToggle icon={Globe} active={panels.browser.open} onClick={() => togglePanel('browser')} title="Browser preview" />
            <PanelToggle icon={SquareTerminal} active={panels.terminal.open} onClick={() => togglePanel('terminal')} title="Terminal (⌘J)" />
            <PanelToggle icon={FileDiff} active={panels.changes.open} onClick={() => togglePanel('changes')} title="Changes" />
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          {leftPanels.length > 0 && (
            <>
              <aside style={{ width: leftWidth }} className="min-w-[12rem] max-w-[60vw] shrink-0 bg-panel">
                <Dock
                  side="left"
                  panelIds={leftPanels}
                  active={leftActive}
                  onActivate={(id) => setActiveBySide((a) => ({ ...a, left: id }))}
                  onClose={closePanel}
                  onMove={movePanel}
                  renderPanel={renderPanel}
                />
              </aside>
              <ResizeHandle onResize={(dx) => setLeftWidth((w) => clampWidth(w + dx))} />
            </>
          )}
          <div className={cls('min-h-0 flex-1', nav === 'chat' || nav === 'plans' ? 'overflow-hidden' : 'overflow-y-auto')}>
            {nav === 'chat' ? (
              <ChatPage
                chatId={chatId}
                project={project}
                projects={allProjects}
                insertText={insertText}
                seed={chatSeed}
                onProjectChange={setProject}
                onAddFolder={() => void openExistingFolder()}
                onChanges={setChanges}
                onServerUrl={showServerUrl}
                onViewPlan={(planId) => viewPlan(planId)}
                onSessionCreated={(id) => {
                  setChatId(id);
                  setChatsKey((k) => k + 1);
                  if (project) setExpanded((e) => new Set(e).add(project));
                }}
              />
            ) : (
              // Universal page container: one place controls width + side
              // margins for every section so they stay consistent.
              <div className={cls('mx-auto w-full max-w-6xl px-6 py-6', nav === 'plans' && 'h-full')}>
                {nav === 'overview' && <OverviewArea />}
                {nav === 'plans' && (
                  <PlansPage
                    project={project}
                    selection={planSelection}
                    onStartBuild={(_id, body) =>
                      seedChat(
                        `Execute this plan step by step. Implement it fully.\n\n${body}`,
                        'agent',
                      )
                    }
                    onRefine={(_id, body) => seedChat(`Here is a draft plan to refine:\n\n${body}`, 'plan')}
                  />
                )}
                {nav === 'loops' && <LoopsPage projects={allProjects} project={project} />}
                {nav === 'plugins' && <PluginsPage project={project} />}
                {nav === 'settings' && <SettingsArea onBack={() => setNav(prevNav)} />}
              </div>
            )}
          </div>
          {rightPanels.length > 0 && (
            <>
              <ResizeHandle onResize={(dx) => setRightWidth((w) => clampWidth(w - dx))} />
              <aside style={{ width: rightWidth }} className="min-w-[16rem] max-w-[65vw] shrink-0 bg-panel">
                <Dock
                  side="right"
                  panelIds={rightPanels}
                  active={rightActive}
                  onActivate={(id) => setActiveBySide((a) => ({ ...a, right: id }))}
                  onClose={closePanel}
                  onMove={movePanel}
                  renderPanel={renderPanel}
                />
              </aside>
            </>
          )}
        </div>
      </main>
      {searchOpen && (
        <SearchPalette
          chats={chats}
          projects={allProjects}
          onClose={() => setSearchOpen(false)}
          onOpenChat={(c) => {
            openChat(c);
            setSearchOpen(false);
          }}
          onOpenProject={(cwd) => {
            setProject(cwd);
            setExpanded((e) => new Set(e).add(cwd));
            newChat();
            setSearchOpen(false);
          }}
        />
      )}
    </div>
  );
}

// --- dockable side panels ----------------------------------------------------

type PanelId = 'files' | 'browser' | 'terminal' | 'changes';
type Side = 'left' | 'right';
type PanelState = { open: boolean; side: Side };

const PANEL_ORDER: PanelId[] = ['files', 'browser', 'terminal', 'changes'];

const PANEL_META: Record<PanelId, { label: string; icon: LucideIcon }> = {
  files: { label: 'Files', icon: FolderTree },
  browser: { label: 'Browser', icon: Globe },
  terminal: { label: 'Terminal', icon: SquareTerminal },
  changes: { label: 'Changes', icon: FileDiff },
};

const DEFAULT_PANELS: Record<PanelId, PanelState> = {
  files: { open: true, side: 'left' },
  browser: { open: false, side: 'right' },
  terminal: { open: false, side: 'right' },
  changes: { open: false, side: 'right' },
};

type Layout = {
  panels: Record<PanelId, PanelState>;
  activeBySide: Record<Side, PanelId | null>;
  leftWidth: number;
  rightWidth: number;
};

function clampWidth(w: number): number {
  return Math.min(760, Math.max(200, Math.round(w)));
}

/** Load the persisted dock layout, falling back to sensible IDE defaults. */
function loadLayout(): Layout {
  const fallback: Layout = {
    panels: DEFAULT_PANELS,
    activeBySide: { left: 'files', right: null },
    leftWidth: 260,
    rightWidth: 480,
  };
  try {
    const raw = localStorage.getItem('cr.layout');
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Layout>;
    return {
      panels: { ...DEFAULT_PANELS, ...(p.panels ?? {}) },
      activeBySide: {
        left: p.activeBySide?.left ?? 'files',
        right: p.activeBySide?.right ?? null,
      },
      leftWidth: clampWidth(p.leftWidth ?? 260),
      rightWidth: clampWidth(p.rightWidth ?? 480),
    };
  } catch {
    return fallback;
  }
}

/**
 * A draggable divider that reports incremental horizontal movement so the
 * caller can grow/shrink the adjacent dock. Widens the hit area beyond the
 * visible 1px line for easier grabbing.
 */
function ResizeHandle({ onResize }: { onResize: (dx: number) => void }): React.ReactElement {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    let last = e.clientX;
    const move = (ev: MouseEvent): void => {
      onResize(ev.clientX - last);
      last = ev.clientX;
    };
    const up = (): void => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <div
      onMouseDown={onMouseDown}
      className="group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize"
      title="Drag to resize"
    >
      <div className="mx-auto h-full w-px bg-border transition-colors group-hover:bg-accent/70" />
    </div>
  );
}

/**
 * A dockable panel container. Renders a tab strip for every panel open on its
 * side, plus per-panel controls to move it to the other side or close it.
 * Visited panels stay mounted (hidden) so switching tabs doesn't tear down a
 * live terminal or reload the preview — only closing (or moving) does.
 */
function Dock({
  side,
  panelIds,
  active,
  onActivate,
  onClose,
  onMove,
  renderPanel,
}: {
  side: Side;
  panelIds: PanelId[];
  active: PanelId | null;
  onActivate: (id: PanelId) => void;
  onClose: (id: PanelId) => void;
  onMove: (id: PanelId) => void;
  renderPanel: (id: PanelId) => React.ReactElement;
}): React.ReactElement {
  const [visited, setVisited] = useState<Set<PanelId>>(() => new Set(active ? [active] : []));
  useEffect(() => {
    if (active) setVisited((v) => (v.has(active) ? v : new Set(v).add(active)));
  }, [active]);

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {panelIds.map((id) => {
            const { label, icon: Icon } = PANEL_META[id];
            const isActive = id === active;
            return (
              <button
                key={id}
                onClick={() => onActivate(id)}
                className={cls(
                  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  isActive ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-panel2 hover:text-text',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>
        {active && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => onMove(active)}
              title={side === 'left' ? 'Move panel to the right' : 'Move panel to the left'}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel2 hover:text-text"
            >
              {side === 'left' ? (
                <PanelRight className="h-4 w-4" strokeWidth={2} />
              ) : (
                <PanelLeft className="h-4 w-4" strokeWidth={2} />
              )}
            </button>
            <button
              onClick={() => onClose(active)}
              title="Close panel"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel2 hover:text-text"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {[...visited]
          .filter((id) => panelIds.includes(id))
          .map((id) => (
            <div key={id} className={cls('h-full', id === active ? 'block' : 'hidden')}>
              {renderPanel(id)}
            </div>
          ))}
      </div>
    </div>
  );
}

type SearchHit =
  | { kind: 'chat'; chat: ChatSummary; projectName: string }
  | { kind: 'project'; project: ProjectSummary };

/**
 * Command-palette style search (⌘K) over projects and chats, in the spirit
 * of Codex/Claude. Type to fuzzily filter; ↑/↓ to move, ↵ to open, Esc to
 * dismiss. Chats and projects are ranked most-recent-first.
 */
function SearchPalette({
  chats,
  projects,
  onClose,
  onOpenChat,
  onOpenProject,
}: {
  chats: ChatSummary[];
  projects: ProjectSummary[];
  onClose: () => void;
  onOpenChat: (c: ChatSummary) => void;
  onOpenProject: (cwd: string) => void;
}): React.ReactElement {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const nameByCwd = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.cwd, p.name);
    return m;
  }, [projects]);

  const hits = useMemo<SearchHit[]>(() => {
    const needle = q.trim().toLowerCase();
    const chatHits: ChatSummary[] = [...chats]
      .filter((c) => {
        if (!needle) return true;
        const name = nameByCwd.get(c.cwd) ?? '';
        return (c.title || 'Untitled').toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    const projHits: ProjectSummary[] = projects
      .filter((p) => {
        if (!needle) return true;
        return p.name.toLowerCase().includes(needle) || p.cwd.toLowerCase().includes(needle);
      })
      .slice(0, 5);
    return [
      ...projHits.map((project) => ({ kind: 'project', project }) as SearchHit),
      ...chatHits.map(
        (chat) => ({ kind: 'chat', chat, projectName: nameByCwd.get(chat.cwd) ?? '' }) as SearchHit,
      ),
    ];
  }, [q, chats, projects, nameByCwd]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  const choose = (h: SearchHit): void => {
    if (h.kind === 'chat') onOpenChat(h.chat);
    else onOpenProject(h.project.cwd);
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[active];
      if (h) choose(h);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-panel shadow-2xl shadow-black/50"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search chats and projects…"
            className="w-full bg-transparent py-3 text-sm text-text outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto py-1.5">
          {hits.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">No matches.</div>
          ) : (
            hits.map((h, i) => {
              const selected = i === active;
              const base = cls(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm',
                selected ? 'bg-accent/15 text-text' : 'text-muted hover:bg-panel2 hover:text-text',
              );
              if (h.kind === 'project') {
                return (
                  <button
                    key={`p:${h.project.cwd}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(h)}
                    className={base}
                  >
                    <Folder className="h-4 w-4 shrink-0" strokeWidth={2} />
                    <span className="truncate font-medium text-text">{h.project.name}</span>
                    <span className="ml-auto truncate pl-3 text-[11px] text-muted/70">Project</span>
                  </button>
                );
              }
              return (
                <button
                  key={`c:${h.chat.id}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(h)}
                  className={base}
                >
                  <SquarePen className="h-4 w-4 shrink-0" strokeWidth={2} />
                  <span className="truncate text-text">{h.chat.title || 'Untitled'}</span>
                  {h.projectName && <span className="shrink-0 text-[11px] text-muted/70">· {h.projectName}</span>}
                  <span className="ml-auto shrink-0 pl-3 text-[11px] text-muted/60">{timeAgo(h.chat.updatedAt)}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PanelToggle({
  icon: Icon,
  active,
  onClick,
  title,
}: {
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  title: string;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cls(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-panel2 hover:text-text',
      )}
    >
      <Icon className="h-[17px] w-[17px]" strokeWidth={2} />
    </button>
  );
}

function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between px-2 pb-1 pt-4">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{children}</span>
      {action}
    </div>
  );
}

/** Projects "+" button → popup with "start from scratch" / "open existing". */
function AddProjectMenu({ onCreate, onOpen }: { onCreate: () => void; onOpen: () => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (
        ref.current && !ref.current.contains(e.target as Node) &&
        menuRef.current && !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: r.left });
    setOpen(true);
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        onClick={toggle}
        title="Add a project folder"
        className={cls(
          'no-drag flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-panel2 hover:text-text',
          open ? 'text-text' : 'text-muted',
        )}
      >
        <FolderPlus className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-50 w-60 overflow-hidden rounded-lg border border-border bg-panel py-1 shadow-xl shadow-black/40"
          >
            <AddProjectRow
              icon={Sparkles}
              label="Start from scratch"
              hint="Create a new empty folder"
              onClick={() => {
                setOpen(false);
                onCreate();
              }}
            />
            <AddProjectRow
              icon={FolderOpen}
              label="Use an existing folder"
              hint="Pick a folder on your machine"
              onClick={() => {
                setOpen(false);
                onOpen();
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

function AddProjectRow({
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button onClick={onClick} className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-panel2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
      <span>
        <span className="block text-sm text-text">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}

/** Bottom-left settings entry: opens a popup (Codex-style) rather than
 *  jumping straight into the settings section. */
function SidebarSettings({
  active,
  connected,
  onOpenSettings,
}: {
  active: boolean;
  connected: boolean;
  onOpenSettings: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cls(
          'no-drag flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors',
          active || open ? 'bg-accent/20 text-text' : 'text-muted hover:bg-panel2 hover:text-text',
        )}
      >
        <SettingsIcon className="h-[17px] w-[17px] shrink-0" strokeWidth={2} />
        Settings
        {!connected && <span className="ml-auto h-2 w-2 rounded-full bg-bad" title="daemon offline" />}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-64 overflow-hidden rounded-xl border border-border bg-panel p-1.5 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2.5 px-1.5 py-1.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-panel2">
              <Logo className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-text">CodeRouter</div>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', connected ? 'bg-ok' : 'bg-bad')} />
                {connected ? 'Daemon connected' : 'Daemon offline'}
              </div>
            </div>
          </div>

          <div className="my-1 h-px bg-border" />

          <button
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-text transition-colors hover:bg-panel2"
          >
            <SettingsIcon className="h-4 w-4 text-muted" strokeWidth={2} />
            Open settings
          </button>

          <div className="my-1 h-px bg-border" />

          <div className="px-1.5 pb-0.5 pt-1">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">Appearance</div>
            <ThemeToggle />
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeToggle(): React.ReactElement {
  const { pref, setPref } = useTheme();
  const opts: Array<{ id: ThemePref; label: string; icon: LucideIcon }> = [
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
    { id: 'system', label: 'System', icon: Monitor },
  ];
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-panel2 p-1">
      {opts.map((o) => {
        const Icon = o.icon;
        const sel = pref === o.id;
        return (
          <button
            key={o.id}
            onClick={() => setPref(o.id)}
            className={cls(
              'flex flex-col items-center gap-1 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors',
              sel ? 'bg-panel text-text shadow-sm ring-1 ring-border' : 'text-muted hover:text-text',
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={2} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="px-2 py-1 text-xs text-muted/70">{children}</div>;
}
