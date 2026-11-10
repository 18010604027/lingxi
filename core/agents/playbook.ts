/**
 * The playbook the roles behind the front read before they work, kept as files in the pet's workspace (so Git keeps
 * every change and a person can read and edit them):
 * - `control/rules/`: the control center's design rules, one per file.
 * - `control/standards/`: how code agents build daily-layer pieces, one standard per file.
 * - `daily/catalog/`: what the daily layer can already do, one capability per file, so a fitting one is reused
 *   instead of built again.
 * Each file starts with a small header (`title`, `when`, `status`, `updated`). A task is given only the index, one
 * line per active entry, and the role opens the file it needs: two hops at most, and the index is rebuilt from the
 * files every time, so it cannot drift.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Worker } from './bus.ts';

export const PLAYBOOK = { rules: 'control/rules', standards: 'control/standards', catalog: 'daily/catalog' } as const;
type Shelf = keyof typeof PLAYBOOK;
/** An index longer than this is cut, and says so: past it the shelf needs merging, not a longer prompt. */
const INDEX_CAP = 100;

export interface Entry { file: string; title: string; when: string; status: string; updated: string }

const FORMAT = [
  'One entry per file, named for what it holds (kebab-case .md). Start with this header, then the body:',
  '',
  '---',
  'title: short name',
  'when: one line, the situation this applies to',
  'status: active        # or retired: kept for the record, left out of the index',
  'updated: YYYY-MM-DD',
  'supersedes: other-file.md   # optional',
  '---',
  '',
  'An entry must stand on its own: what it says, when it applies, when it does not. To change your mind, retire the old',
  'entry and write a new one that supersedes it, rather than rewriting history away.',
].join('\n');

const README: Record<Shelf, string> = {
  rules: `# Control center rules\n\nHow the control center decides. It adds and retires rules here as it learns; the person may edit any of them.\n\n${FORMAT}\n`,
  standards: `# Standards for code agents\n\nHow daily-layer pieces are built. Code agents read the ones that apply before they start.\n\n${FORMAT}\n`,
  catalog: `# Daily layer catalog\n\nWhat the daily layer can already do. Before building anything new, look here: reuse or extend a capability that fits.\nAn entry is added when a capability goes live, and says how to use it.\n\n${FORMAT}\n`,
};

/** Entries the playbook starts with; a file already there is never overwritten. */
const SEED: Array<{ shelf: Shelf; file: string; text: string }> = [
  {
    shelf: 'catalog', file: 'wakeups.md', text: `---
title: The wake table
when: anything that should happen on its own — at set times, repeatedly, or now and then: nudges, routines, check-ins, and the pet's own rhythm of looking up
status: active
updated: 2026-10-26
---

Everything that wakes the pet on its own is one table, run by one engine. Use the wake_* tools; never write a new timer,
schedule or script for this.

- rhythm (one entry, id \`rhythm\`): the pet looks up on its own at a random interval inside its waking hours. It first checks
  whether anyone is at the screen (not locked, input in the last 10 minutes); if so it glances at the screen in front
  of the person and wakes the front, which decides whether to speak. Settings: the window (from/to), the interval
  (jitter_min/jitter_max), skip_chance (looks let pass) and daily_speaking (about how often a day it may speak on its
  own). Tune it with wake_update; pause it with active=false; it cannot be deleted.
- simple reminder: said from its own lines with no model call. Give 8–12 varied lines in the pet's voice; when they wear
  out the table asks you for fresh ones.
- smart reminder: the front is woken with your guide and decides then what to say.
- Either reminder is said by the front in context when the person interacted with the pet in the last few minutes.
- A time missed while the computer slept is skipped, not said late.
`,
  },
  {
    shelf: 'catalog', file: 'where-she-walks.md', text: `---
title: Where the pet may walk, and how it is settled
when: the pet seems to be in the way of the person's work, they move it away, or a workarea case comes to you
status: active
updated: 2026-10-28
---

The pet keeps out of what the person looks at or uses on its own, learnt for each window's stretch of the bottom in each
of its layouts (modes); nothing learnt in one window reaches another. The evidence: what the window shows there (content
counts, near-blank space is free), where the person's hand picked it up (not here; most when it was walking) or put it
down (there is fine), where the pointer works, where it stood long untouched. How it gets past a stretch it may not
stand on it chooses itself each time.

When that is not enough (the person keeps moving it away, or what it keeps out of leaves it a sliver), the matter comes
to you as a case, [case <id>] at the top of the task: the facts, pictures with what is marked on them, and how this
window and mode were decided before. Answer it with case_decide in the shape the case asks for; the answer holds for
that window and mode until another case on it, and the rules only note trouble after that. There is no tool to mark
stretches or set per-program policies any more (retired 10-28): a case is the way.
`,
  },
  {
    shelf: 'rules', file: 'reminder-kind.md', text: `---
title: Simple or smart reminder
when: setting up or changing a reminder
status: active
updated: 2026-10-26
---

Default to simple when the nudge is the same whatever is going on (drink water, stand up). Choose smart when what to say
depends on the person's state, the day or earlier talk (a check-in on a plan, an encouragement before an event). Never
leave a simple reminder with one or two lines: repeating itself makes the pet feel like a machine. Say why in the
reminder's why.
`,
  },
  {
    shelf: 'rules', file: 'rhythm-tuning.md', text: `---
title: Tuning the pet's own rhythm
when: the person reacts to the pet speaking on its own, or asks it to talk more or less
status: active
updated: 2026-10-26
---

The rhythm's settings follow the person, not a fixed plan. Signs to read: they answer or play along when it speaks on its
own (it is welcome); they ignore it several times running, or say it is too much, or ask for quiet (it is too often);
they ask why it has gone quiet (too seldom). Change one thing at a time, by a step (daily_speaking by 2, the interval by
10 minutes, skip_chance by 0.1), say why with the change, and leave it a few days before the next step. A request for
quiet today is not a reason to change the settings for good; pause the rhythm for the day instead, if at all.
`,
  },
  {
    shelf: 'standards', file: 'daily-layer-piece.md', text: `---
title: A daily-layer piece
when: writing or changing any script or small model for the daily layer
status: active
updated: 2026-10-26
---

- Check the catalog first; extend a capability that fits rather than adding a parallel one.
- One piece per folder under control/drafts/<name>/: the code, its tests, and a README saying what it is for, what it
  reads and writes, how it was checked, and what it does not handle.
- Deterministic and cheap: no model calls on the hot path, no network unless the task is about the network.
- Fail closed and quiet: on bad input, do nothing and report it; never retry an outward action on its own.
- Nothing in drafts goes live by itself; promotion is a separate, tested step.
`,
  },
];

/** Seeded entries later replaced, with what replaced them. */
const RETIRED: Array<{ shelf: Shelf; file: string; superseded: string }> = [
  { shelf: 'catalog', file: 'reminders.md', superseded: 'wakeups.md' },
  { shelf: 'catalog', file: 'placement.md', superseded: 'where-he-works.md' },
  { shelf: 'catalog', file: 'roaming.md', superseded: 'where-he-works.md' },
  { shelf: 'catalog', file: 'where-he-works.md', superseded: 'where-she-walks.md' },
  { shelf: 'rules', file: 'where-he-works-is-learnt.md', superseded: 'where-she-walks.md' },
];

function header(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*?)\s*(#.*)?$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

export class Playbook {
  private readonly root: string;

  constructor(workspace: string) {
    this.root = workspace;
  }

  /** Creates the shelves, their READMEs and the starting entries that are missing. */
  seed(): void {
    for (const shelf of Object.keys(PLAYBOOK) as Shelf[]) {
      const dir = join(this.root, PLAYBOOK[shelf]);
      mkdirSync(dir, { recursive: true });
      const readme = join(dir, 'README.md');
      if (!existsSync(readme)) writeFileSync(readme, README[shelf]);
    }
    for (const e of SEED) {
      const file = join(this.root, PLAYBOOK[e.shelf], e.file);
      if (!existsSync(file)) writeFileSync(file, e.text);
    }
    // entries the table replaced: retired in place, kept for the record
    for (const { shelf, file, superseded } of RETIRED) {
      const path = join(this.root, PLAYBOOK[shelf], file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      if (/^status:\s*active/m.test(text)) writeFileSync(path, text.replace(/^status:\s*active.*$/m, 'status: retired').replace(/^(---\r?\n)/, `$1supersededBy: ${superseded}\n`));
    }
  }

  /** The active entries of a shelf, by file name. */
  entries(shelf: Shelf): Entry[] {
    const dir = join(this.root, PLAYBOOK[shelf]);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'INDEX.md')
      .sort()
      .map((file) => {
        const h = header(readFileSync(join(dir, file), 'utf8'));
        return { file, title: h.title ?? file, when: h.when ?? '', status: h.status ?? 'active', updated: h.updated ?? '' };
      })
      .filter((e) => e.status !== 'retired');
  }

  /** The index of a shelf, one line per active entry, cut at the cap with a note. */
  index(shelf: Shelf): string {
    const all = this.entries(shelf);
    const lines = all.slice(0, INDEX_CAP).map((e) => `- ${PLAYBOOK[shelf]}/${e.file} — ${e.title}${e.when ? `: ${e.when}` : ''}`);
    if (all.length > INDEX_CAP) lines.push(`(${all.length - INDEX_CAP} more not listed: this shelf needs merging)`);
    return lines.join('\n');
  }

  /** What a role is shown with each task: the indexes it works from and how to use them. */
  brief(role: Worker): string {
    const shelf = (s: Shelf, title: string) => {
      const idx = this.index(s);
      return idx ? `${title}\n${idx}` : '';
    };
    const parts = role === 'control'
      ? [
        'Before building anything new, check the catalog and reuse a capability that fits. Open a rule when it applies.',
        `You may add or retire rules under ${PLAYBOOK.rules}/ as you learn (format in its README); keep one rule per file.`,
        shelf('catalog', 'Catalog (what the daily layer already does):'),
        shelf('rules', 'Your rules:'),
        shelf('standards', 'Standards code agents follow:'),
      ]
      : [
        'Read the standards that apply before you start, and check the catalog: extend what exists rather than add a parallel piece.',
        shelf('standards', 'Standards:'),
        shelf('catalog', 'Catalog:'),
      ];
    return parts.filter(Boolean).join('\n\n');
  }
}
