export const DEFAULT_PRICING = {
	default:   { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75  },
	models: {
		// 注意 wildcard 紧贴 4，没有 -：这样 normalize 过的 'claude-opus-4'（无日期后缀）
		// 和原始 'claude-opus-4-20260101' 都能匹配。usage-parser.normalizeModel 会剥日期，
		// 用 '-*' 时空后缀不匹配 → opus / haiku 静默回落到 default 价（sonnet 巧合相同
		// 所以早期没暴露），opus 实际价 5x default → 被低估。
		'claude-opus-4*':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
		'claude-sonnet-4*': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75  },
		'claude-haiku-4*':  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25  },
	},
	cnyRate: 7.2,
}

function globToRegex(glob) {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
	return new RegExp(`^${escaped}$`)
}

function resolveRate(model, pricing) {
	if (model && pricing.models) {
		for (const [pattern, rate] of Object.entries(pricing.models)) {
			if (globToRegex(pattern).test(model)) return rate
		}
	}
	return pricing.default
}

export function estimateCost(tokens, model, pricing = DEFAULT_PRICING) {
	const rate = resolveRate(model, pricing)
	const usd =
		(Number(tokens.input)         || 0) * rate.input      / 1_000_000 +
		(Number(tokens.output)        || 0) * rate.output     / 1_000_000 +
		(Number(tokens.cacheRead)     || 0) * rate.cacheRead  / 1_000_000 +
		(Number(tokens.cacheCreation) || 0) * rate.cacheWrite / 1_000_000
	const cnyRate = pricing.cnyRate ?? DEFAULT_PRICING.cnyRate
	return { usd, cny: usd * cnyRate }
}
