import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type RunMode, type SettingsReport } from '../lib/api';
import { Section, Spinner, cls } from '../components/common';
import { useTheme, type ThemePref } from '../lib/theme';

export function SettingsPage(): React.ReactElement {
  const [data, setData] = useState<SettingsReport | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = (): void => {
    void api.settings().then(setData).catch(() => {});
  };
  useEffect(refresh, []);
  if (!data) return <Spinner />;

  const saveKey = async (name: string): Promise<void> => {
    const v = keys[name]?.trim();
    if (!v) return;
    setBusy(name);
    try {
      await api.saveKey(name, v);
      setKeys((k) => ({ ...k, [name]: '' }));
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const removeKey = async (name: string): Promise<void> => {
    setBusy(name);
    try {
      await api.removeKey(name);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  const toggleHost = async (provider: string, enabled: boolean): Promise<void> => {
    setBusy(provider);
    try {
      await api.setHost(provider, enabled);
      refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <Section title="Appearance">
        <Appearance />
      </Section>

      <Section title="Cloud providers">
        <div className="space-y-2">
          {data.providers.map((p) => (
            <div key={p.name} className="card flex items-center gap-3">
              <div className="w-40 shrink-0">
                <div className="font-medium">{p.label}</div>
                <div className="text-xs text-muted">{p.envVar}</div>
              </div>
              {p.configured ? (
                <div className="flex flex-1 items-center gap-2">
                  <span className="chip border-ok text-ok">configured{p.source ? ` · ${p.source}` : ''}</span>
                  {p.source === 'env' ? (
                    <span className="ml-auto text-xs text-muted">set via environment variable</span>
                  ) : (
                    <button
                      className="btn btn-danger ml-auto"
                      disabled={busy === p.name}
                      onClick={() => void removeKey(p.name)}
                      title="Remove this key so you can replace it"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <input
                    className="input flex-1"
                    type="password"
                    placeholder={`set ${p.envVar}`}
                    value={keys[p.name] ?? ''}
                    onChange={(e) => setKeys((k) => ({ ...k, [p.name]: e.target.value }))}
                  />
                  <button className="btn" disabled={busy === p.name} onClick={() => void saveKey(p.name)}>
                    Save
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Local host CLIs">
        <div className="space-y-2">
          {data.hosts.map((h) => (
            <div key={h.provider} className="card flex items-center justify-between">
              <div>
                <div className="font-medium">{h.label}</div>
                <div className="text-xs text-muted">{h.binPath || h.cli || 'not detected'}</div>
              </div>
              <button
                className={cls('btn', h.enabled && 'btn-primary')}
                disabled={busy === h.provider}
                onClick={() => void toggleHost(h.provider, !h.enabled)}
              >
                {h.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Applying changes">
        <AutoApply enabled={data.autoApply} onChange={(v) => api.setAutoApply(v).then(refresh)} />
      </Section>

      <Section title="Run mode">
        <RunModeSetting mode={data.runMode} onChange={(v) => api.setRunMode(v).then(refresh)} />
      </Section>

      <Section title="Preview">
        <PreviewInApp
          enabled={data.previewInApp}
          onChange={(v) =>
            api.setPreviewInApp(v).then(() => {
              // Let the app shell switch preview routing live (no reload).
              window.dispatchEvent(new CustomEvent('cr:preview-in-app', { detail: { previewInApp: v } }));
              return refresh();
            })
          }
        />
      </Section>

      <Section title="Spending limit">
        <SpendingLimit current={data.limits.monthlyUsd} onSave={(v) => api.setLimit(v).then(refresh)} />
      </Section>

      <Section title="Paths">
        <div className="card text-xs text-muted">
          <div>credentials: {data.paths.credentials}</div>
          <div>database: {data.paths.db}</div>
        </div>
      </Section>
    </div>
  );
}

function Appearance(): React.ReactElement {
  const { pref, setPref } = useTheme();
  const opts: Array<{ id: ThemePref; label: string }> = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'System' },
  ];
  return (
    <div className="card flex items-center gap-3">
      <span className="text-sm text-muted">Theme</span>
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {opts.map((o) => (
          <button
            key={o.id}
            onClick={() => setPref(o.id)}
            className={cls(
              'px-3 py-1.5 text-sm transition-colors',
              pref === o.id ? 'bg-accent/20 text-text' : 'text-muted hover:bg-panel2 hover:text-text',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AutoApply({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => Promise<unknown> }): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const toggle = async (next: boolean): Promise<void> => {
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="card flex items-center gap-3">
      <div className="flex-1">
        <div className="font-medium">Auto-accept file changes</div>
        <div className="text-xs text-muted">
          {enabled
            ? 'Changes from each run are written to your files automatically.'
            : 'Runs keep edits as a diff you review and accept before they touch your files.'}
        </div>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        disabled={saving}
        onClick={() => void toggle(!enabled)}
        className={cls(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60',
          enabled ? 'bg-accent' : 'bg-panel2 border border-border',
        )}
        title={enabled ? 'Turn off auto-accept' : 'Turn on auto-accept'}
      >
        <span
          className={cls(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            enabled ? 'left-0.5 translate-x-5' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

function PreviewInApp({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => Promise<unknown> }): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const toggle = async (next: boolean): Promise<void> => {
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="card flex items-center gap-3">
      <div className="flex-1">
        <div className="font-medium">Open previews in the built-in browser</div>
        <div className="text-xs text-muted">
          {enabled
            ? "When the agent opens a page or dev server, it shows in CodeRouter's browser panel. CLI runs route to this window when it's open."
            : 'Previews open in your system default browser instead.'}
        </div>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        disabled={saving}
        onClick={() => void toggle(!enabled)}
        className={cls(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60',
          enabled ? 'bg-accent' : 'bg-panel2 border border-border',
        )}
        title={enabled ? 'Use the system browser instead' : 'Use the built-in browser'}
      >
        <span
          className={cls(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            enabled ? 'left-0.5 translate-x-5' : 'left-0.5',
          )}
        />
      </button>
    </div>
  );
}

const RUN_MODE_OPTIONS: Array<{ id: RunMode; label: string; blurb: string }> = [
  {
    id: 'unsandboxed',
    label: 'Run everything',
    blurb: 'Edits and commands run in-place in your project. Full terminal, dev servers, and browser preview. No command restrictions.',
  },
  {
    id: 'allowlist',
    label: 'Allowlist',
    blurb: 'Runs in-place, but only allowlisted commands (build/test/run/package managers) execute. Dev servers and preview still work.',
  },
  {
    id: 'sandboxed',
    label: 'Sandboxed',
    blurb: 'Each run works inside an isolated temporary copy of your project. Safest, but cannot run a live server you can open.',
  },
];

function RunModeSetting({ mode, onChange }: { mode: RunMode; onChange: (v: RunMode) => Promise<unknown> }): React.ReactElement {
  const [saving, setSaving] = useState<RunMode | null>(null);
  const active = RUN_MODE_OPTIONS.find((o) => o.id === mode) ?? RUN_MODE_OPTIONS[0];
  const select = async (next: RunMode): Promise<void> => {
    if (next === mode) return;
    setSaving(next);
    try {
      await onChange(next);
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="card space-y-3">
      <div className="inline-flex overflow-hidden rounded-md border border-border">
        {RUN_MODE_OPTIONS.map((o) => (
          <button
            key={o.id}
            disabled={saving !== null}
            onClick={() => void select(o.id)}
            className={cls(
              'px-3 py-1.5 text-sm transition-colors disabled:opacity-60',
              mode === o.id ? 'bg-accent/20 text-text' : 'text-muted hover:bg-panel2 hover:text-text',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="text-xs text-muted">{active.blurb}</div>
    </div>
  );
}

function SpendingLimit({
  current,
  onSave,
}: {
  current: number | null;
  onSave: (v: number | null) => Promise<unknown>;
}): React.ReactElement {
  const [val, setVal] = useState(current ? String(current) : '');
  return (
    <div className="card flex items-center gap-2">
      <span className="text-sm text-muted">Monthly cap ($)</span>
      <input className="input max-w-[140px]" type="number" value={val} onChange={(e) => setVal(e.target.value)} placeholder="none" />
      <button className="btn" onClick={() => void onSave(val ? Number(val) : null)}>
        Save
      </button>
    </div>
  );
}
