// src/ui/icons.js のアイコン名バリデーションの単体テスト。
// node --test（依存追加なし）。DOM 非依存の純粋部分のみを対象にする。
// createIcon() は正常系で document.createElement を使うため、node 上では
// 未知名（DOM に触れる前に throw する経路）だけを検証する。

import assert from "node:assert/strict";
import { test } from "node:test";

import { ICON_NAMES, createIcon, isIconName } from "../src/ui/icons.js";

test("ICON_NAMES は統合した 3 アイコンを含む", () => {
  assert.deepEqual([...ICON_NAMES].sort(), ["list", "loop", "record"]);
});

test("ICON_NAMES は凍結されている", () => {
  assert.ok(Object.isFrozen(ICON_NAMES));
});

test("isIconName は既知のアイコン名を true にする", () => {
  for (const name of ["record", "loop", "list"]) {
    assert.equal(isIconName(name), true);
  }
});

test("isIconName は未知のアイコン名を false にする", () => {
  // comment は Phase 2 で追加予定。現時点では未知扱い。
  assert.equal(isIconName("comment"), false);
  assert.equal(isIconName("bogus"), false);
  assert.equal(isIconName(""), false);
  assert.equal(isIconName("toString"), false); // プロトタイプ経由で誤検知しない
});

test("createIcon は未知のアイコン名で Error を投げる", () => {
  assert.throws(() => createIcon("bogus"), /Unknown icon name: bogus/);
});
