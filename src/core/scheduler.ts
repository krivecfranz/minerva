// ponytail: thin ts-fsrs wrapper, defaults only. Add a params argument when tuning matters.
import {
  fsrs,
  createEmptyCard,
  Rating,
  type Card,
} from "ts-fsrs";

export interface MinervaCard {
  id: string;
  question: string;
  answer: string;
  source?: string;
  concept?: string;
  // ponytail: provider Card object kept opaque; swap for Card type once storage layer exists
  fsrs: unknown;
}

// ponytail: enable_short_term=false so "good"/"easy" land on day-scale intervals, not 10-minute learning steps
const S = fsrs({ enable_short_term: false });

const RATINGS = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
} as const;

export function newCard(
  id: string,
  question: string,
  answer: string,
  concept?: string,
): MinervaCard {
  // ponytail: per-card FSRS params still ignored, one global scheduler is enough.
  // The concept is kept though - interleaving in /review needs it.
  return { id, question, answer, ...(concept ? { concept } : {}), fsrs: createEmptyCard() };
}

function asFsrs(card: MinervaCard): Card {
  const c = { ...(card.fsrs as Card) };
  // JSON roundtrip turns Date fields into ISO strings - revive them
  if (typeof c.due === "string") {
    c.due = new Date(c.due);
    c.last_review = typeof c.last_review === "string" ? new Date(c.last_review) : c.last_review;
  }
  return c;
}

export function isDue(card: MinervaCard, now: Date = new Date()): boolean {
  return asFsrs(card).due.getTime() <= now.getTime();
}

export function gradeCard(
  card: MinervaCard,
  rating: keyof typeof RATINGS,
  now: Date = new Date(),
): MinervaCard {
  const { card: next } = S.next(asFsrs(card), now, RATINGS[rating]);
  return { ...card, fsrs: next };
}

export function nextIntervalDays(card: MinervaCard, now: Date = new Date()): number {
  const ms = asFsrs(card).due.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function sortDue(cards: MinervaCard[], now: Date = new Date()): MinervaCard[] {
  // ponytail: plain due time. Math.min(0, ...) clamped every future card to 0,
  // so not-yet-due cards were not ordered at all.
  const t = (c: MinervaCard) => asFsrs(c).due.getTime();
  return [...cards].sort((a, b) => {
    const [da, db] = [isDue(a, now), isDue(b, now)];
    if (da !== db) return da ? -1 : 1;
    return t(a) - t(b);
  });
}

/**
 * Round-robins the queue across concepts so consecutive cards come from
 * different ones - that mixing is what makes a review session interleaved.
 * Cards without a concept form their own group and are treated like any other.
 */
export function interleave(cards: MinervaCard[]): MinervaCard[] {
  const groups = new Map<string, MinervaCard[]>();
  for (const c of cards) {
    const key = c.concept ?? "";
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  if (groups.size < 2) return [...cards];

  const out: MinervaCard[] = [];
  // ponytail: re-sorts per card - O(n^2 log n). Decks are tens of cards, not millions.
  while (out.length < cards.length) {
    const lists = [...groups.values()].filter((l) => l.length).sort((a, b) => b.length - a.length);
    const last = out[out.length - 1]?.concept ?? "";
    // prefer the largest group that differs from the previous card
    const pick = lists.find((l) => (l[0].concept ?? "") !== last) ?? lists[0];
    out.push(pick.shift()!);
  }
  return out;
}
