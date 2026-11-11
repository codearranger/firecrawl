import { test } from "node:test";
import assert from "node:assert/strict";
import { inSubnet } from "./net.js";
import { liveViewPage } from "./liveview.js";

test("inSubnet matches addresses in the sandbox network", () => {
  assert.equal(inSubnet("10.250.250.7", "10.250.250.0/24"), true);
  assert.equal(inSubnet("::ffff:10.250.250.7", "10.250.250.0/24"), true);
  assert.equal(inSubnet("10.250.251.7", "10.250.250.0/24"), false);
  assert.equal(inSubnet("172.18.0.5", "10.250.250.0/24"), false);
});

test("inSubnet is false without a subnet or address", () => {
  assert.equal(inSubnet("10.250.250.7", ""), false);
  assert.equal(inSubnet(undefined, "10.250.250.0/24"), false);
  assert.equal(inSubnet("not-an-ip", "10.250.250.0/24"), false);
});

test("live view page only enables input in control mode", () => {
  assert.match(liveViewPage(false), /const interactive = false/);
  assert.match(liveViewPage(true), /const interactive = true/);
});
