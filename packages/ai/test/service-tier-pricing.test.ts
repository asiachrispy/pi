import { describe, expect, it } from "vitest";
import { applyServiceTierPricing, getServiceTierCostMultiplier } from "../src/api/openai-responses-shared.ts";
import type { Api, Model } from "../src/types.ts";

type ServiceTier = "auto" | "default" | "flex" | "priority" | undefined;

function makeModel(id: string): Pick<Model<Api>, "id"> {
	return { id };
}

function makeUsage(): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
} {
	return {
		input: 1000,
		output: 2000,
		cacheRead: 500,
		cacheWrite: 0,
		totalTokens: 3500,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0, total: 18.3 },
	};
}

describe("getServiceTierCostMultiplier", () => {
	const tierTable: Array<[ServiceTier, number]> = [
		[undefined, 1],
		["auto", 1],
		["default", 1],
		["flex", 0.5],
		["priority", 2],
	];
	for (const [tier, expected] of tierTable) {
		it(`returns ${expected} for tier=${JSON.stringify(tier)} (non-gpt-5.5 model)`, () => {
			expect(getServiceTierCostMultiplier(makeModel("gpt-4o"), tier)).toBe(expected);
		});
	}

	it("returns 2.5 for priority tier on gpt-5.5", () => {
		expect(getServiceTierCostMultiplier(makeModel("gpt-5.5"), "priority")).toBe(2.5);
	});

	it("returns 0.5 for flex tier on gpt-5.5 (no special-case)", () => {
		expect(getServiceTierCostMultiplier(makeModel("gpt-5.5"), "flex")).toBe(0.5);
	});
});

describe("applyServiceTierPricing", () => {
	it("is a no-op for the default tier", () => {
		const usage = makeUsage();
		const before = { ...usage.cost };
		applyServiceTierPricing(usage, "default", makeModel("gpt-4o"));
		expect(usage.cost).toEqual(before);
	});

	it("halves every cost field for flex tier", () => {
		const usage = makeUsage();
		applyServiceTierPricing(usage, "flex", makeModel("gpt-4o"));
		expect(usage.cost.input).toBe(1.5);
		expect(usage.cost.output).toBe(7.5);
		expect(usage.cost.cacheRead).toBe(0.15);
		expect(usage.cost.cacheWrite).toBe(0);
		expect(usage.cost.total).toBeCloseTo(9.15, 10);
	});

	it("doubles every cost field for priority tier on a non-gpt-5.5 model", () => {
		const usage = makeUsage();
		applyServiceTierPricing(usage, "priority", makeModel("gpt-4o"));
		expect(usage.cost.input).toBe(6);
		expect(usage.cost.output).toBe(30);
		expect(usage.cost.cacheRead).toBe(0.6);
		expect(usage.cost.cacheWrite).toBe(0);
		expect(usage.cost.total).toBeCloseTo(36.6, 10);
	});

	it("uses 2.5x for priority tier on gpt-5.5", () => {
		const usage = makeUsage();
		applyServiceTierPricing(usage, "priority", makeModel("gpt-5.5"));
		expect(usage.cost.input).toBe(7.5);
		expect(usage.cost.output).toBe(37.5);
		expect(usage.cost.cacheRead).toBe(0.75);
		expect(usage.cost.cacheWrite).toBe(0);
		expect(usage.cost.total).toBeCloseTo(45.75, 10);
	});

	it("recomputes total as the sum of all fields after scaling", () => {
		const usage = makeUsage();
		applyServiceTierPricing(usage, "flex", makeModel("gpt-4o"));
		const summed = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
		expect(usage.cost.total).toBeCloseTo(summed, 10);
	});
});
