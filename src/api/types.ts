import { z } from 'zod/v4';

// ─── Leaderboard ───

export const LeaderboardEntrySchema = z.object({
  rank: z.string(),
  proxyWallet: z.string(),
  userName: z.string(),
  xUsername: z.string().optional().default(''),
  verifiedBadge: z.boolean().optional().default(false),
  vol: z.number(),
  pnl: z.number(),
  profileImage: z.string().optional().default(''),
});

export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;

// ─── Trade ───

export const TradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(['BUY', 'SELL']),
  asset: z.string(),
  conditionId: z.string(),
  size: z.number(),
  price: z.number(),
  timestamp: z.number(),
  title: z.string().nullable().optional(),
  slug: z.string().optional(),
  icon: z.string().optional(),
  eventSlug: z.string().optional(),
  outcome: z.string(),
  outcomeIndex: z.number(),
  name: z.string().optional(),
  pseudonym: z.string().optional(),
  transactionHash: z.string(),
});

export type TradeData = z.infer<typeof TradeSchema>;

// ─── Position ───

export const PositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: z.number(),
  avgPrice: z.number(),
  initialValue: z.number().nullable().optional(),
  currentValue: z.number().nullable().optional(),
  cashPnl: z.number().nullable().optional(),
  percentPnl: z.number().nullable().optional(),
  totalBought: z.number().nullable().optional(),
  realizedPnl: z.number().nullable().optional(),
  percentRealizedPnl: z.number().nullable().optional(),
  curPrice: z.number().nullable().optional(),
  redeemable: z.boolean().optional(),
  mergeable: z.boolean().optional(),
  title: z.string().nullable().optional(),
  slug: z.string().optional(),
  icon: z.string().optional(),
  eventSlug: z.string().optional(),
  outcome: z.string(),
  outcomeIndex: z.number(),
  endDate: z.string().nullable().optional(),
  negativeRisk: z.boolean().optional(),
});

export type PositionData = z.infer<typeof PositionSchema>;

// ─── Closed Position ───

export const ClosedPositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  avgPrice: z.number(),
  totalBought: z.number(),
  realizedPnl: z.number(),
  curPrice: z.number(),
  timestamp: z.number(),
  title: z.string().nullable().optional(),
  slug: z.string().optional(),
  outcome: z.string(),
  outcomeIndex: z.number().nullable().optional(),
  endDate: z.string().nullable().optional(),
  eventSlug: z.string().optional(),
});

export type ClosedPositionData = z.infer<typeof ClosedPositionSchema>;

// ─── Activity ───

export const ActivitySchema = z.object({
  proxyWallet: z.string(),
  timestamp: z.number(),
  conditionId: z.string(),
  type: z.string(),
  size: z.number(),
  usdcSize: z.number(),
  transactionHash: z.string(),
  price: z.number().nullable().optional(),
  asset: z.string().nullable().optional(),
  side: z.string().nullable().optional(),
  outcomeIndex: z.number().nullable().optional(),
  title: z.string().nullable().optional(),
  slug: z.string().optional(),
  outcome: z.string().optional(),
  eventSlug: z.string().optional(),
});

export type ActivityData = z.infer<typeof ActivitySchema>;

// ─── Value ───

export const ValueSchema = z.object({
  user: z.string(),
  value: z.number(),
});

export type ValueData = z.infer<typeof ValueSchema>;

// ─── Traded ───

export const TradedSchema = z.object({
  user: z.string(),
  traded: z.number(),
});

export type TradedData = z.infer<typeof TradedSchema>;

// ─── Gamma Market ───

export const GammaMarketSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  conditionId: z.string(),
  question: z.string().optional().default(''),
  slug: z.string().optional().default(''),
  category: z.string().nullable().optional(),
  outcomes: z.string().optional().default('[]'), // JSON string
  outcomePrices: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  closed: z.boolean().optional().default(false),
  active: z.boolean().optional().default(true),
  volume: z.union([z.string(), z.number()]).nullable().optional().transform(v => v != null ? Number(v) : null),
  liquidity: z.union([z.string(), z.number()]).nullable().optional().transform(v => v != null ? Number(v) : null),
  image: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  eventSlug: z.string().nullable().optional(),
  negRisk: z.boolean().optional(),
}).passthrough();

export type GammaMarketData = z.infer<typeof GammaMarketSchema>;

// ─── Profile ───

export const ProfileSchema = z.object({
  createdAt: z.string().optional(),
  proxyWallet: z.string().optional(),
  profileImage: z.string().optional(),
  displayUsernamePublic: z.boolean().optional(),
  bio: z.string().nullable().optional(),
  pseudonym: z.string().optional(),
  name: z.string().optional(),
  xUsername: z.string().nullable().optional(),
  verifiedBadge: z.boolean().optional().default(false),
});

export type ProfileData = z.infer<typeof ProfileSchema>;
