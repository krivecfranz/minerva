// ponytail: thin ts-fsrs wrapper; defaults only, pass FSRSParameters via opts when tuning matters
import {
  fsrs,
  createEmptyCard,
  Rating,
  type Card,
  type FSRSParameters,
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

type Opts = Partial<FSRSParameters>;

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
  opts?: Opts,
): MinervaCard {
  void opts; // ponytail: per-card params ignored, single global scheduler is enough
  return { id, question, answer, fsrs: createEmptyCard() };
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
  const t = (c: MinervaCard) => Math.min(0, asFsrs(c).due.getTime() - now.getTime());
  return [...cards].sort((a, b) => {
    const [da, db] = [isDue(a, now), isDue(b, now)];
    if (da !== db) return da ? -1 : 1;
    return t(a) - t(b);
  });
}
