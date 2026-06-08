import { describe, expect, it } from "vitest";
import {
	buildNoMatchingPackageMessage,
	createPackageSourceParser,
	findSuggestedConfiguredSource,
	parseNpmSpec,
	parseSource,
} from "../src/core/package-source-parser.ts";

const TMP_DIR = "/tmp";

describe("parseNpmSpec", () => {
	const table: Array<[string, { name: string; version?: string }]> = [
		["foo", { name: "foo" }],
		["foo@1.2.3", { name: "foo", version: "1.2.3" }],
		["@scope/pkg", { name: "@scope/pkg" }],
		["@scope/pkg@2.0.0-rc.1", { name: "@scope/pkg", version: "2.0.0-rc.1" }],
		["weird name with spaces", { name: "weird name with spaces" }],
		["a@b@c", { name: "a", version: "b@c" }],
	];
	for (const [input, expected] of table) {
		it(`parses ${JSON.stringify(input)}`, () => {
			expect(parseNpmSpec(input)).toEqual(expected);
		});
	}
});

describe("parseSource", () => {
	it("parses npm: prefix with pinned version", () => {
		expect(parseSource("npm:foo@1.2.3")).toEqual({
			type: "npm",
			spec: "foo@1.2.3",
			name: "foo",
			pinned: true,
		});
	});

	it("parses npm: prefix with no version", () => {
		expect(parseSource("npm:foo")).toEqual({
			type: "npm",
			spec: "foo",
			name: "foo",
			pinned: false,
		});
	});

	it("trims whitespace around the npm spec", () => {
		expect(parseSource("npm:  foo  ")).toEqual({
			type: "npm",
			spec: "foo",
			name: "foo",
			pinned: false,
		});
	});

	it("classifies absolute paths as local", () => {
		expect(parseSource("/abs/path")).toEqual({ type: "local", path: "/abs/path" });
	});

	it("classifies relative paths as local", () => {
		expect(parseSource("./relative/path")).toEqual({ type: "local", path: "./relative/path" });
	});

	it("parses https git URLs as git", () => {
		const result = parseSource("https://github.com/foo/bar.git");
		expect(result.type).toBe("git");
		if (result.type === "git") {
			expect(result.host).toBe("github.com");
			expect(result.path).toBe("foo/bar");
		}
	});

	it("falls back to local for git+ssh shorthand that parseGitUrl does not recognize", () => {
		// parseGitUrl only handles fully-qualified URLs (https/ssh/git). Bare
		// user@host:path shorthand falls through to the local path fallback.
		expect(parseSource("git@github.com:foo/bar.git")).toEqual({
			type: "local",
			path: "git@github.com:foo/bar.git",
		});
	});

	it("parses ssh:// git URLs as git", () => {
		const result = parseSource("ssh://git@github.com/foo/bar.git");
		expect(result.type).toBe("git");
		if (result.type === "git") {
			expect(result.host).toBe("github.com");
			expect(result.path).toBe("foo/bar");
		}
	});

	it("falls back to local for unrecognized strings", () => {
		expect(parseSource("not-a-known-source")).toEqual({ type: "local", path: "not-a-known-source" });
	});
});

describe("findSuggestedConfiguredSource", () => {
	const npmPackages = ["npm:foo", "npm:bar@1.0.0"];
	const gitPackages = ["https://github.com/x/y.git"];

	it("returns undefined when nothing matches", () => {
		expect(findSuggestedConfiguredSource("npm:baz", npmPackages)).toBeUndefined();
	});

	it("matches an npm name without version", () => {
		expect(findSuggestedConfiguredSource("foo", npmPackages)).toBe("npm:foo");
	});

	it("matches an npm spec", () => {
		expect(findSuggestedConfiguredSource("bar@1.0.0", npmPackages)).toBe("npm:bar@1.0.0");
	});

	it("trims whitespace around the input", () => {
		expect(findSuggestedConfiguredSource("  foo  ", npmPackages)).toBe("npm:foo");
	});

	it("matches git shorthand host/path", () => {
		expect(findSuggestedConfiguredSource("github.com/x/y", gitPackages)).toBe("https://github.com/x/y.git");
	});
});

describe("buildNoMatchingPackageMessage", () => {
	it("falls back to a plain message when no suggestion is found", () => {
		expect(buildNoMatchingPackageMessage("npm:missing", ["npm:other"])).toBe(
			"No matching package found for npm:missing",
		);
	});

	it("includes a suggestion when one is found", () => {
		expect(buildNoMatchingPackageMessage("foo", ["npm:foo"])).toBe(
			"No matching package found for foo. Did you mean npm:foo?",
		);
	});
});

describe("createPackageSourceParser", () => {
	const parser = createPackageSourceParser(TMP_DIR);

	describe("getSourceMatchKeyForInput", () => {
		it("keys npm sources by name", () => {
			expect(parser.getSourceMatchKeyForInput("npm:foo@1.0.0")).toBe("npm:foo");
		});

		it("keys git sources by host/path", () => {
			expect(parser.getSourceMatchKeyForInput("https://github.com/x/y.git")).toBe("git:github.com/x/y");
		});

		it("keys local sources by absolute path", () => {
			expect(parser.getSourceMatchKeyForInput("./relative")).toBe(`local:${TMP_DIR}/relative`);
		});
	});

	describe("getSourceMatchKeyForSettings", () => {
		it("keys npm sources by name", () => {
			expect(parser.getSourceMatchKeyForSettings("npm:foo", TMP_DIR)).toBe("npm:foo");
		});

		it("keys local sources by the scope base dir", () => {
			expect(parser.getSourceMatchKeyForSettings("./foo", "/scope/base")).toBe("local:/scope/base/foo");
		});
	});

	describe("packageSourcesMatch", () => {
		it("matches equivalent npm sources regardless of version", () => {
			expect(parser.packageSourcesMatch("npm:foo@1.0.0", "npm:foo", TMP_DIR)).toBe(true);
		});

		it("does not match different npm sources", () => {
			expect(parser.packageSourcesMatch("npm:foo@1.0.0", "npm:bar", TMP_DIR)).toBe(false);
		});

		it("matches a relative local source against its absolute configured form", () => {
			expect(parser.packageSourcesMatch(`${TMP_DIR}/foo`, "./foo", TMP_DIR)).toBe(true);
		});

		it("does not match local sources that point to different files", () => {
			expect(parser.packageSourcesMatch(`${TMP_DIR}/foo`, "./bar", TMP_DIR)).toBe(false);
		});
	});

	describe("normalizePackageSourceForSettings", () => {
		it("passes npm sources through unchanged", () => {
			expect(parser.normalizePackageSourceForSettings("npm:foo@1.0.0", "/scope")).toBe("npm:foo@1.0.0");
		});

		it("passes git sources through unchanged", () => {
			expect(parser.normalizePackageSourceForSettings("https://github.com/x/y.git", "/scope")).toBe(
				"https://github.com/x/y.git",
			);
		});

		it("resolves a local path against cwd and emits a relative path", () => {
			// cwd is /tmp; scope base is /tmp/agent; the input resolves to /tmp/foo
			expect(parser.normalizePackageSourceForSettings("./foo", `${TMP_DIR}/agent`)).toBe("../foo");
		});

		it("returns '.' for a local path that equals the base dir", () => {
			expect(parser.normalizePackageSourceForSettings(".", TMP_DIR)).toBe(".");
		});
	});
});
