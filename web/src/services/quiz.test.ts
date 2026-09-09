import { describe, it, expect, beforeEach } from 'vitest';
import { buildWineEntries } from '@/shared/constants';
import { normalizeLabel } from '@/shared/services/entryUtils';
import type { WineEntry } from '@/shared/types';
import {
  quizQuestion,
  QUIZ_TIERS,
  DEFAULT_LENGTH,
  DEFAULT_PASS,
  newSession,
  chooseAnswer,
  advance,
  retrySession,
  isComplete,
  isPassed,
  isAnswered,
  highestUnlocked,
  isTierUnlocked,
  recordTierPass,
  type QuizTier,
  parseSession,
} from './quiz';

const all = buildWineEntries() as WineEntry[];
const byId = new Map(all.map(e => [e.id, e]));
const label = normalizeLabel;
const someQ = (seed: number, tier: QuizTier = 'ENTHUSIAST') => quizQuestion(all, 0, seed, tier)!;

// Mirrors ToolsTests.swift / TastingQuizTests.
describe('quiz question generation', () => {
  it('produces a question for every slot across a spread of seeds (negatives included)', () => {
    for (let seed = -45; seed < 255; seed += 10) {
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        expect(quizQuestion(all, n, seed, 'ENTHUSIAST'), `seed ${seed} q${n}`).not.toBeNull();
      }
    }
  });

  it('every question is well formed: 4 distinct real options, answer among them', () => {
    for (let seed = 0; seed < 200; seed += 10) {
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        const q = quizQuestion(all, n, seed, 'ENTHUSIAST');
        if (!q) continue;
        const tag = `seed ${seed} q${n}`;
        expect(q.optionIDs.length, tag).toBe(4);
        expect(new Set(q.optionIDs).size, `${tag} repeats an option`).toBe(4);
        expect(q.optionIDs, `${tag} omits its answer`).toContain(q.answerID);
        expect(q.prompt.length).toBeGreaterThan(0);
        for (const id of q.optionIDs) expect(byId.get(id), `${tag} missing ${id}`).toBeTruthy();
      }
    }
  });

  it('a session mixes all three kinds — at least three of each', () => {
    for (let seed = -20; seed < 120; seed += 7) {
      const counts: Record<string, number> = {};
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        const q = quizQuestion(all, n, seed, 'ENTHUSIAST');
        if (q) counts[q.kind] = (counts[q.kind] ?? 0) + 1;
      }
      for (const k of ['grapes', 'region', 'style']) {
        expect(counts[k] ?? 0, `seed ${seed}: ${k}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('no distractor is also a right answer', () => {
    for (let seed = 0; seed < 200; seed += 5) {
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        const q = quizQuestion(all, n, seed, 'ENTHUSIAST');
        if (!q) continue;
        const answer = byId.get(q.answerID) as any;
        const tag = `seed ${seed} q${n}`;
        if (q.kind === 'grapes') {
          for (const id of q.optionIDs) {
            if (id === q.answerID) continue;
            const o = byId.get(id) as any;
            const differs =
              o.grapeType !== answer.grapeType ||
              label(o.grapeBodyClass ?? '') !== label(answer.grapeBodyClass ?? '') ||
              label(o.grapeCountryOfOrigin ?? o.details?.origin ?? '') !== label(answer.grapeCountryOfOrigin ?? answer.details?.origin ?? '');
            expect(differs, `${tag}: ${o.name} matches every fact of ${answer.name}`).toBe(true);
          }
        } else {
          // Recover the grape/country from the prompt wording.
          const grapePrefixes = ['Which of these regions is known for ', 'Which of these styles features '];
          const originPrefix = 'Which of these styles originates in ';
          const gp = grapePrefixes.find(p => q.prompt.startsWith(p));
          if (gp) {
            const key = label(q.prompt.slice(gp.length, -1));
            for (const id of q.optionIDs) {
              if (id === q.answerID) continue;
              const o = byId.get(id) as any;
              const carries = (o.details?.notableGrapes ?? []).some((g: string) => label(g) === key);
              expect(carries, `${tag}: ${o.name} also names it`).toBe(false);
            }
          } else if (q.prompt.startsWith(originPrefix)) {
            const key = label(q.prompt.slice(originPrefix.length, -1));
            for (const id of q.optionIDs) {
              if (id === q.answerID) continue;
              const o = byId.get(id) as any;
              expect(label(o.details?.origin ?? '') !== key, `${tag}: ${o.name} also originates there`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('is deterministic — same slot, same question', () => {
    for (let seed = 0; seed < 100; seed += 7) {
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        expect(quizQuestion(all, n, seed, 'ENTHUSIAST')).toEqual(quizQuestion(all, n, seed, 'ENTHUSIAST'));
      }
    }
  });

  it('consecutive questions differ', () => {
    let repeats = 0;
    for (let seed = 0; seed < 100; seed += 11) {
      for (let n = 0; n < DEFAULT_LENGTH - 1; n++) {
        const a = quizQuestion(all, n, seed, 'ENTHUSIAST');
        const b = quizQuestion(all, n + 1, seed, 'ENTHUSIAST');
        if (JSON.stringify(a) === JSON.stringify(b)) repeats++;
      }
    }
    expect(repeats).toBe(0);
  });
});

describe('quiz tiers', () => {
  it('every tier fills every slot of every session', () => {
    for (const tier of QUIZ_TIERS) {
      for (let seed = -20; seed < 160; seed += 12) {
        for (let n = 0; n < DEFAULT_LENGTH; n++) {
          expect(quizQuestion(all, n, seed, tier), `${tier} seed ${seed} q${n}`).not.toBeNull();
        }
      }
    }
  });

  it('grape answers respect the tier rarity band', () => {
    const bands: [QuizTier, Set<string>][] = [
      ['NOVICE', new Set(['NOBLE', 'COMMON'])],
      ['SOMMELIER', new Set(['UNCOMMON', 'RARE', 'GODFORSAKEN'])],
    ];
    for (let seed = 0; seed < 200; seed += 7) {
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        for (const [tier, allowed] of bands) {
          const q = quizQuestion(all, n, seed, tier);
          if (!q || q.kind !== 'grapes') continue;
          const a = byId.get(q.answerID) as any;
          expect(allowed.has(a.rarity), `${tier}: ${a.name} is ${a.rarity}`).toBe(true);
        }
      }
    }
  });

  it('novice region answers name at least two resolvable grapes', () => {
    const grapeKeys = new Set(all.filter(e => e.category === 'GRAPES').map(e => label(e.name)));
    for (let seed = 0; seed < 200; seed += 7) {
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        const q = quizQuestion(all, n, seed, 'NOVICE');
        if (!q || q.kind !== 'region') continue;
        const a = byId.get(q.answerID) as any;
        const resolvable = (a.details?.notableGrapes ?? []).filter((g: string) => grapeKeys.has(label(g)));
        expect(resolvable.length, `novice region ${a.name}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('quiz session', () => {
  it('a fresh session starts clean', () => {
    const s = newSession(3);
    expect(s.index).toBe(0);
    expect(s.correct).toBe(0);
    expect(s.chosenID).toBeNull();
    expect(isAnswered(s)).toBe(false);
    expect(isComplete(s)).toBe(false);
    expect(isPassed(s)).toBe(false);
  });

  it('keeps a mark per answered question, oldest first, and nothing else (v10#3)', () => {
    const s0 = newSession(11);
    expect(s0.marks).toEqual([]);
    const q = quizQuestion(all, 0, s0.seed, s0.tier)!;
    const right = chooseAnswer(s0, q.answerID, q);
    expect(right.marks).toEqual([true]);
    const s1 = advance(right);
    const q1 = quizQuestion(all, 1, s1.seed, s1.tier)!;
    const wrongId = q1.optionIDs.find(id => id !== q1.answerID)!;
    const wrong = chooseAnswer(s1, wrongId, q1);
    expect(wrong.marks).toEqual([true, false]);
    expect(wrong.correct).toBe(1);
    // A pre-v0.6.29 paper decodes with an empty grid rather than being lost.
    expect(parseSession(JSON.stringify({ ...s0, marks: undefined }))?.marks).toEqual([]);
    expect(parseSession(JSON.stringify({ ...wrong }))?.marks).toEqual([true, false]);
  });

  it('choosing scores rights not wrongs, first tap is final', () => {
    let s = newSession(5);
    const q = someQ(5);
    const wrong = q.optionIDs.find(i => i !== q.answerID)!;
    s = chooseAnswer(s, wrong, q);
    expect(s.correct).toBe(0);
    expect(s.chosenID).toBe(wrong);
    s = chooseAnswer(s, q.answerID, q); // ignored
    expect(s.correct).toBe(0);
    expect(s.chosenID).toBe(wrong);
  });

  it('advance requires an answer, clears it, completes at ten, then is inert', () => {
    let s = newSession(9);
    s = advance(s); // no-op unanswered
    expect(s.index).toBe(0);
    for (let n = 0; n < DEFAULT_LENGTH; n++) {
      expect(s.index).toBe(n);
      const q = quizQuestion(all, s.index, s.seed, s.tier)!;
      s = chooseAnswer(s, q.answerID, q);
      expect(isAnswered(s)).toBe(true);
      s = advance(s);
      expect(isAnswered(s)).toBe(false);
    }
    expect(isComplete(s)).toBe(true);
    expect(s.correct).toBe(DEFAULT_LENGTH);
    expect(isPassed(s)).toBe(true);
    const done = s;
    s = advance(s);
    expect(s).toEqual(done);
  });

  it('the pass mark sits at eight of ten', () => {
    for (const target of [DEFAULT_PASS - 1, DEFAULT_PASS]) {
      let s = newSession(12);
      for (let n = 0; n < DEFAULT_LENGTH; n++) {
        const q = quizQuestion(all, s.index, s.seed, s.tier)!;
        const id = n < target ? q.answerID : q.optionIDs.find(i => i !== q.answerID)!;
        s = chooseAnswer(s, id, q);
        s = advance(s);
      }
      expect(s.correct).toBe(target);
      expect(isPassed(s)).toBe(target === DEFAULT_PASS);
    }
  });

  it('a custom-length session grades on its own shape (daily 5/4)', () => {
    for (const target of [3, 4]) {
      let s = newSession(17, 'ENTHUSIAST', 5, 4);
      for (let n = 0; n < 5; n++) {
        expect(isComplete(s)).toBe(false);
        const q = quizQuestion(all, s.index, s.seed, s.tier)!;
        const id = n < target ? q.answerID : q.optionIDs.find(i => i !== q.answerID)!;
        s = chooseAnswer(s, id, q);
        s = advance(s);
      }
      expect(isComplete(s)).toBe(true);
      expect(isPassed(s)).toBe(target >= 4);
    }
  });

  it('retry starts a different paper from scratch, keeping shape and tier', () => {
    const s = newSession(9, 'NOVICE', 5, 4);
    const next = retrySession(s);
    expect(next.seed).not.toBe(s.seed);
    expect(next.index).toBe(0);
    expect(next.correct).toBe(0);
    expect(next.chosenID).toBeNull();
    expect(next.length).toBe(5);
    expect(next.passMark).toBe(4);
    expect(next.tier).toBe('NOVICE');
  });
});

describe('quiz progress ladder', () => {
  beforeEach(() => localStorage.clear());

  it('a fresh ladder opens at novice only', () => {
    expect(highestUnlocked()).toBe('NOVICE');
    expect(isTierUnlocked('NOVICE')).toBe(true);
    expect(isTierUnlocked('ENTHUSIAST')).toBe(false);
    expect(isTierUnlocked('SOMMELIER')).toBe(false);
  });

  it('passes climb the ladder one rung at a time; repeats and the top open nothing', () => {
    expect(recordTierPass('NOVICE')).toBe('ENTHUSIAST');
    expect(isTierUnlocked('ENTHUSIAST')).toBe(true);
    expect(isTierUnlocked('SOMMELIER')).toBe(false);
    expect(recordTierPass('NOVICE')).toBeNull();
    expect(recordTierPass('ENTHUSIAST')).toBe('SOMMELIER');
    expect(isTierUnlocked('SOMMELIER')).toBe(true);
    expect(recordTierPass('SOMMELIER')).toBeNull();
  });

  it('unlocks survive a reload (localStorage)', () => {
    recordTierPass('NOVICE');
    expect(highestUnlocked()).toBe('ENTHUSIAST');
  });
});

// Determinism guard: pins the generated paper for fixed seeds so a refactor
// can't silently drift the daily challenge away from what shipped.
//
// Re-pinned 0.7.4. These are a *refactor* guard, not a data guard: the picker
// draws from the whole catalog, so growing it legitimately deals a different
// paper. Both seeds now deal several of the 0.7.4 entries (G148, G156, G161,
// G166, R117-R122), which is the tell that the change is the catalog rather
// than the algorithm. Regenerate deliberately, never by pasting a failure.
//
// Re-pinned again when `shared/` synced forward to iOS 0.8.8 (catalog 438 ->
// 446: grapes 171 -> 177, styles 31 -> 33, regions to 124). Same reasoning,
// and the same kind of tell: seed -13 now opens on S033 and seed 777 deals
// R124 in its options -- a style and a region that did not exist when the
// previous pins were taken, so the picker cannot have drawn them under the
// old catalog. Derived by running `quizQuestion` over the current catalog,
// not by copying the assertion diff.
//
// Re-pinned for the 0.2.2 catalogue batch, and this time the tell is exact
// enough to name the lines. Regenerated from the dataset, then each half of
// the move isolated by reverting one data file at a time:
//
//   * **Five of the six region questions moved.** `regionQuestion` picks its
//     subject from
//     `grapeNamesFrom(regions, ...)`, which is a *sorted* list of every grape
//     some region names. The batch added "Manto Negro" to R120 Mallorca's
//     `notableGrapes` -- one line in `regions.ts`, and the only line it
//     changed -- which inserts a name into that sorted list and shifts
//     `names[mod(seed + step, names.length)]` for every seed. Reverting that
//     single line restores those five old answers exactly, and moves nothing
//     else.
//
//     The sixth is seed 777's index 7, R107 with options R124/R017/R107/R034,
//     which is byte-identical across the change. A shifted subject can still
//     land on the same answer and the same distractor walk; nothing about the
//     mechanism promises every slot moves, and an earlier draft of this note
//     said "all five" on a miscount. Six exist. Five moved.
//   * **One grape option set moved**, seed 777 index 3. Its answer G080 Fer
//     Servadou is a medium-bodied French red, and Cabernet Pfeffer's origin
//     was corrected USA -> France, so G154 crossed from `others` into
//     `matching` and shifted the distractor walk by one.
//   * **No style question moved at all**, either seed. The three kinds share
//     `assemble`, so an algorithm change moves all three; only the kinds whose
//     *inputs* changed did.
//
// That is what says this is the catalogue and not the picker. The authored
// `characteristics` do not enter here -- the bank draws on body, origin and
// notable-grape links -- so the bars themselves moved nothing.
// Re-pinned for the iOS 0.9.44-0.9.53 catch-up (2026-09-09), catalogue 446 ->
// 530: grapes 177 -> 221, regions 124 -> 157, styles 33 -> 40. Same reasoning
// as every re-pin above, and the tell is again decisive rather than
// circumstantial: seed 777 now deals **S035 Vin Jaune** and draws G185, G194,
// G211, R135 and R152 among its options; seed -13 opens on a style paper that
// deals **S037 Retsina** and R140. Every one of those ids is past the ceiling
// of the catalogue the old pins were taken under -- S034 was the last style,
// G222 did not go past G177 in the drawable set, R124 was the last region --
// so the picker could not have dealt them before, whatever the algorithm did.
// Regenerated by running `quizQuestion` over the current catalogue, never by
// pasting the assertion diff.
//
describe('quiz determinism golden', () => {
  const GOLDEN: Record<string, ({ k: string; a: string; o: string[] } | null)[]> = {
    '777': [
      { k: 'grapes', a: 'G115', o: ['G151', 'G115', 'G168', 'G185'] },
      { k: 'region', a: 'R065', o: ['R065', 'R118', 'R135', 'R152'] },
      { k: 'style', a: 'S035', o: ['S010', 'S028', 'S006', 'S035'] },
      { k: 'grapes', a: 'G110', o: ['G088', 'G106', 'G110', 'G124'] },
      { k: 'region', a: 'R106', o: ['R006', 'R106', 'R023', 'R040'] },
      { k: 'style', a: 'S004', o: ['S004', 'S009', 'S026', 'S003'] },
      { k: 'grapes', a: 'G138', o: ['G177', 'G194', 'G211', 'G138'] },
      { k: 'region', a: 'R088', o: ['R103', 'R120', 'R088', 'R137'] },
      { k: 'style', a: 'S026', o: ['S025', 'S026', 'S003', 'S021'] },
      { k: 'grapes', a: 'G032', o: ['G032', 'G126', 'G144', 'G161'] },
    ],
    '-13': [
      { k: 'style', a: 'S030', o: ['S027', 'S005', 'S025', 'S030'] },
      { k: 'grapes', a: 'G175', o: ['G096', 'G113', 'G175', 'G130'] },
      { k: 'region', a: 'R140', o: ['R070', 'R140', 'R087', 'R104'] },
      { k: 'style', a: 'S037', o: ['S037', 'S034', 'S011', 'S028'] },
      { k: 'grapes', a: 'G109', o: ['G052', 'G072', 'G089', 'G109'] },
      { k: 'region', a: 'R040', o: ['R018', 'R036', 'R040', 'R056'] },
      { k: 'style', a: 'S022', o: ['S035', 'S022', 'S013', 'S032'] },
      { k: 'grapes', a: 'G038', o: ['G038', 'G090', 'G107', 'G124'] },
      { k: 'region', a: 'R115', o: ['R004', 'R021', 'R038', 'R115'] },
      { k: 'style', a: 'S015', o: ['S009', 'S028', 'S015', 'S005'] },
    ],
  };

  for (const [seed, expected] of Object.entries(GOLDEN)) {
    it(`seed ${seed} reproduces its paper`, () => {
      for (let n = 0; n < expected.length; n++) {
        const q = quizQuestion(all, n, Number(seed), 'ENTHUSIAST');
        const g = expected[n]!;
        expect({ k: q!.kind, a: q!.answerID, o: q!.optionIDs }).toEqual(g);
      }
    });
  }
});
