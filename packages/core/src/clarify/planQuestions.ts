/**
 * Pre-plan clarifying questions (Claude Code–style).
 *
 * Before drafting a plan, ask structured multi-choice questions so the
 * planner doesn't invent platform/stack/scope. Questions are grouped by
 * short `header` tabs (Platform, Features, …) the REPL renders as a
 * horizontal navigator with numbered options + descriptions.
 */

import type { Classification } from '../types.js';
import type { Clarification } from './types.js';

export type PlanClarifyOption = {
  label: string;
  description?: string;
};

export type PlanClarifyQuestion = {
  id: string;
  /** Short tab label (≤12 chars), e.g. "Platform". */
  header: string;
  question: string;
  options: PlanClarifyOption[];
  /** Optional default option label. */
  defaultOption?: string;
};

export type PlanClarifyAnswer = {
  questionId: string;
  header: string;
  answer: string;
};

const GREENFIELD_RE =
  /\b(build|create|make|start|scaffold|from scratch|greenfield|new (app|game|project|site|website|api|service))\b/i;
const GAME_RE = /\b(game|fps|shooter|platformer|rpg|unity|godot|unreal|three\.?js|babylon)\b/i;
const WEBAPP_RE = /\b(web\s*app|website|saas|dashboard|next\.?js|react|vue|svelte)\b/i;
const CLI_RE = /\b(cli|command[- ]line|terminal app)\b/i;

/**
 * Build clarifying questions for plan mode. Combines greenfield/domain
 * templates with any rule-based {@link Clarification}s that already have
 * options. Caps at 4 questions so the loop stays short.
 */
export function buildPlanClarifyQuestions(opts: {
  prompt: string;
  classification?: Classification;
  clarifications?: Clarification[];
  /** True when the repo looks empty / has almost no source files. */
  emptyRepo?: boolean;
}): PlanClarifyQuestion[] {
  const out: PlanClarifyQuestion[] = [];
  const seenHeaders = new Set<string>();

  const push = (q: PlanClarifyQuestion) => {
    if (seenHeaders.has(q.header.toLowerCase())) return;
    if (out.length >= 4) return;
    seenHeaders.add(q.header.toLowerCase());
    out.push(q);
  };

  // "I want to build an FPS" should clarify even inside a full monorepo;
  // generic "build a fix for X" in an existing codebase should not.
  const intentionalNew =
    Boolean(opts.emptyRepo) ||
    GREENFIELD_RE.test(opts.prompt) ||
    /\b(from scratch|greenfield)\b/i.test(opts.prompt);
  const emptyOrExplicit =
    Boolean(opts.emptyRepo) || /\b(from scratch|greenfield|new (app|game|project|site|website))\b/i.test(opts.prompt);

  if (intentionalNew && GAME_RE.test(opts.prompt)) {
    push({
      id: 'platform',
      header: 'Platform',
      question: 'What platform should this run on?',
      defaultOption: 'Browser (Recommended)',
      options: [
        {
          label: 'Browser (Recommended)',
          description: 'Web-first with Three.js / Babylon.js — fastest to iterate and share.',
        },
        {
          label: 'Desktop (Electron)',
          description: 'Wrap a browser build in Electron for a native window.',
        },
        {
          label: 'Godot Engine',
          description: 'Real game engine with GDScript/C# — better for complex gameplay.',
        },
        {
          label: 'Unity',
          description: 'Industry-standard engine — heavier setup, strong asset ecosystem.',
        },
      ],
    });
    push({
      id: 'features',
      header: 'Features',
      question: 'How ambitious should the first playable build be?',
      defaultOption: 'MVP slice',
      options: [
        {
          label: 'MVP slice',
          description: 'Move, look, shoot one enemy type in a single sandbox level.',
        },
        {
          label: 'Vertical slice',
          description: 'One polished level with HUD, 2 weapons, and basic AI.',
        },
        {
          label: 'Full prototype',
          description: 'Menu → combat → win/lose loop with multiple encounters.',
        },
      ],
    });
    push({
      id: 'art',
      header: 'Art style',
      question: 'What art direction should the plan assume?',
      defaultOption: 'Low-poly / stylized',
      options: [
        {
          label: 'Low-poly / stylized',
          description: 'Simple meshes and flat shading — quick to prototype.',
        },
        {
          label: 'Retro / pixel',
          description: '2.5D or billboard sprites with a classic FPS feel.',
        },
        {
          label: 'Realistic PBR',
          description: 'Higher fidelity materials — more asset and lighting work.',
        },
        {
          label: 'Undecided — pick for me',
          description: 'Planner chooses the lowest-friction style for the stack.',
        },
      ],
    });
  } else if (intentionalNew && WEBAPP_RE.test(opts.prompt)) {
    push({
      id: 'platform',
      header: 'Platform',
      question: 'What should we build this as?',
      defaultOption: 'Next.js web app',
      options: [
        {
          label: 'Next.js web app',
          description: 'React + App Router — good default for modern web products.',
        },
        {
          label: 'Vite + React SPA',
          description: 'Lighter client-only app without a server framework.',
        },
        {
          label: 'Full-stack Node API + UI',
          description: 'Separate API and frontend packages in a monorepo.',
        },
      ],
    });
    push({
      id: 'features',
      header: 'Scope',
      question: 'How large should the first plan be?',
      defaultOption: 'MVP',
      options: [
        { label: 'MVP', description: 'Smallest useful slice users can try end-to-end.' },
        { label: 'Core product', description: 'Main flows covered; polish later.' },
        { label: 'Full roadmap', description: 'Phased plan covering near- and mid-term work.' },
      ],
    });
  } else if (intentionalNew && CLI_RE.test(opts.prompt)) {
    push({
      id: 'platform',
      header: 'Runtime',
      question: 'What runtime should the CLI target?',
      defaultOption: 'Node.js (TypeScript)',
      options: [
        { label: 'Node.js (TypeScript)', description: 'Familiar npm ecosystem; easy to ship.' },
        { label: 'Python', description: 'Good for scripting and data tooling.' },
        { label: 'Go', description: 'Single static binary; great for ops tools.' },
      ],
    });
  } else if (emptyOrExplicit) {
    push({
      id: 'platform',
      header: 'Stack',
      question: 'What stack should the plan assume?',
      defaultOption: 'TypeScript / Node',
      options: [
        { label: 'TypeScript / Node', description: 'Default for web services and tooling in this repo.' },
        { label: 'Python', description: 'Scripts, ML, or data-heavy work.' },
        { label: 'Something else — I will specify', description: 'Answer in chat after Submit if needed.' },
      ],
    });
    push({
      id: 'features',
      header: 'Scope',
      question: 'How large should the first plan be?',
      defaultOption: 'MVP',
      options: [
        { label: 'MVP', description: 'Smallest useful slice.' },
        { label: 'Core product', description: 'Main flows covered.' },
        { label: 'Full roadmap', description: 'Phased near- and mid-term plan.' },
      ],
    });
  }

  // Fold detector clarifications that already have options.
  for (const c of opts.clarifications ?? []) {
    if (!c.options || c.options.length === 0) continue;
    push({
      id: c.id,
      header: headerForSignal(c.signal),
      question: c.question,
      defaultOption: c.defaultOption,
      options: c.options.map((label) => ({ label })),
    });
  }

  return out;
}

function headerForSignal(signal: Clarification['signal']): string {
  switch (signal) {
    case 'high_risk_keywords':
      return 'Safety';
    case 'memory_conflict':
      return 'Memory';
    case 'open_scope':
      return 'Scope';
    case 'low_confidence':
      return 'Intent';
    case 'vague_references':
      return 'Target';
    default:
      return 'Clarify';
  }
}

/** Format answers for injection into the planner prompt. */
export function formatClarifyAnswers(answers: PlanClarifyAnswer[]): string {
  if (answers.length === 0) return '';
  return [
    '# User clarifications (treat as hard constraints)',
    ...answers.map((a) => `- **${a.header}**: ${a.answer}`),
  ].join('\n');
}
