import type { Database } from './db.js';

/**
 * Forward-only schema migrations. Each migration runs once per database;
 * we track applied version with `pragma user_version`. Adding a new
 * migration is the only supported way to evolve the schema.
 */

export type Migration = {
  version: number;
  description: string;
  apply: (db: Database) => void;
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema (runs, classifications, learned_examples, project_facts, overrides, failure_patterns, handoff_history, sessions, ratings)',
    apply(db) {
      db.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          mode TEXT NOT NULL,
          task_type TEXT,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          cost_usd REAL NOT NULL DEFAULT 0,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          routes_json TEXT NOT NULL DEFAULT '[]',
          rationale TEXT NOT NULL DEFAULT '',
          diff TEXT,
          files_changed_json TEXT NOT NULL DEFAULT '[]',
          validators_json TEXT NOT NULL DEFAULT '[]',
          effectiveness REAL,
          rating INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_runs_session ON runs(session_id);
        CREATE INDEX idx_runs_status ON runs(status);
        CREATE INDEX idx_runs_created ON runs(created_at);

        CREATE TABLE classifications (
          hash TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          task_type TEXT NOT NULL,
          shape_json TEXT NOT NULL,
          confidence REAL NOT NULL,
          source TEXT NOT NULL,
          rationale TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE learned_examples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt TEXT NOT NULL,
          task_type TEXT NOT NULL,
          shape_json TEXT NOT NULL,
          source_run_id TEXT,
          embed_signature TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(embed_signature)
        );

        CREATE TABLE project_facts (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          source TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_pattern TEXT NOT NULL,
          route TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE failure_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern TEXT NOT NULL,
          context TEXT NOT NULL,
          fail_count INTEGER NOT NULL DEFAULT 1,
          last_seen INTEGER NOT NULL
        );

        CREATE TABLE handoff_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_run_id TEXT NOT NULL,
          from_route TEXT NOT NULL,
          to_route TEXT NOT NULL,
          reason TEXT NOT NULL,
          outcome TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          worktree_path TEXT,
          classification_json TEXT,
          cost_accumulated REAL NOT NULL DEFAULT 0,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          last_diff TEXT,
          handoff_history_json TEXT NOT NULL DEFAULT '[]',
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    description: 'loops + loop_iterations + chat_sessions + chat_messages (CodeRouter Studio)',
    apply(db) {
      db.exec(`
        CREATE TABLE loops (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          goal TEXT NOT NULL,
          cwd TEXT NOT NULL,
          status TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          iterations_done INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          files_changed_json TEXT NOT NULL DEFAULT '[]',
          last_diff TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_loops_status ON loops(status);
        CREATE INDEX idx_loops_updated ON loops(updated_at);

        CREATE TABLE loop_iterations (
          id TEXT PRIMARY KEY,
          loop_id TEXT NOT NULL,
          idx INTEGER NOT NULL,
          run_id TEXT,
          phase TEXT NOT NULL,
          status TEXT NOT NULL,
          verifier_json TEXT NOT NULL DEFAULT '[]',
          diff TEXT,
          summary TEXT NOT NULL DEFAULT '',
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_loop_iterations_loop ON loop_iterations(loop_id);

        CREATE TABLE chat_sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'New chat',
          mode TEXT NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_chat_sessions_updated ON chat_sessions(updated_at);

        CREATE TABLE chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          run_id TEXT,
          route TEXT,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_chat_messages_session ON chat_messages(session_id);
      `);
    },
  },
  {
    version: 3,
    description: 'routing audit trail (routing_requests, routing_decisions, model_invocations, execution_outcomes)',
    apply(db) {
      db.exec(`
        CREATE TABLE routing_requests (
          id TEXT PRIMARY KEY,
          subtask_id TEXT NOT NULL,
          parent_task_id TEXT,
          repo_id TEXT,
          task_kind TEXT NOT NULL,
          language TEXT,
          risk_tier TEXT NOT NULL,
          prompt_tokens_est INTEGER NOT NULL DEFAULT 0,
          features_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_routing_requests_created ON routing_requests(created_at);
        CREATE INDEX idx_routing_requests_kind ON routing_requests(task_kind);

        CREATE TABLE routing_decisions (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          strategy TEXT NOT NULL,
          primary_model TEXT,
          verifier_model TEXT,
          fallback_models_json TEXT NOT NULL DEFAULT '[]',
          reason_codes_json TEXT NOT NULL DEFAULT '[]',
          rejected_json TEXT NOT NULL DEFAULT '[]',
          scores_json TEXT NOT NULL DEFAULT '[]',
          estimated_cost_usd REAL,
          estimated_latency_ms INTEGER,
          logged_propensity REAL NOT NULL DEFAULT 1,
          exploration_probability REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_routing_decisions_request ON routing_decisions(request_id);

        CREATE TABLE model_invocations (
          id TEXT PRIMARY KEY,
          decision_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          via TEXT,
          provider TEXT,
          role TEXT NOT NULL DEFAULT 'primary',
          status TEXT NOT NULL,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          ttft_ms INTEGER,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          schema_valid INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_model_invocations_decision ON model_invocations(decision_id);

        CREATE TABLE execution_outcomes (
          id TEXT PRIMARY KEY,
          decision_id TEXT NOT NULL,
          test_pass INTEGER,
          verifier_pass INTEGER,
          patch_applied INTEGER,
          accepted INTEGER,
          rolled_back INTEGER,
          notes TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_execution_outcomes_decision ON execution_outcomes(decision_id);
      `);
    },
  },
];

export function migrate(db: Database): { from: number; to: number } {
  const from = db.userVersion();
  let to = from;
  db.transaction(() => {
    for (const m of MIGRATIONS) {
      if (m.version > to) {
        m.apply(db);
        db.setUserVersion(m.version);
        to = m.version;
      }
    }
  });
  return { from, to };
}
