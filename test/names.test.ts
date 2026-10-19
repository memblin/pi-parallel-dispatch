import { test } from "node:test";
import assert from "node:assert/strict";
import {
	checkName,
	uniqueName,
	nextColor,
	tmuxColor,
	LEAD_NAME,
} from "../src/names.js";

test("checkName accepts valid names", () => {
	assert.equal(checkName("researcher").ok, true);
	assert.equal(checkName("fix-auth-2").ok, true);
	assert.equal(checkName("A").ok, true);
});

test("checkName rejects reserved and invalid names", () => {
	assert.equal(checkName("lead").ok, false);
	assert.equal(checkName("user").ok, false);
	assert.equal(checkName("").ok, false);
	assert.equal(checkName("has space").ok, false);
	assert.equal(checkName("bad/name").ok, false);
	assert.equal(checkName("-starts-with-hyphen").ok, false);
	assert.equal(checkName("ok".repeat(40)).ok, false); // > 64
});

test("uniqueName appends suffixes on collision", () => {
	assert.equal(uniqueName("bob", []), "bob");
	assert.equal(uniqueName("bob", ["bob"]), "bob-2");
	assert.equal(uniqueName("bob", ["bob", "bob-2"]), "bob-3");
	// case-insensitive collision, original casing preserved
	assert.equal(uniqueName("Bob", ["bob"]), "Bob-2");
	// skips over existing suffixed names
	assert.equal(uniqueName("bob", ["bob", "bob-2", "bob-3"]), "bob-4");
});

test("nextColor picks in order and skips taken", () => {
	assert.equal(nextColor([]), "blue");
	assert.equal(nextColor(["blue"]), "green");
	assert.equal(nextColor(["blue", "green", "yellow", "cyan", "magenta", "orange", "red", "pink"]), "blue");
});

test("tmuxColor maps aliases and falls back", () => {
	assert.equal(tmuxColor("purple"), "magenta");
	assert.equal(tmuxColor("orange"), "colour208");
	assert.equal(tmuxColor("bogus"), "blue");
});

test("LEAD_NAME is lead", () => {
	assert.equal(LEAD_NAME, "lead");
});
