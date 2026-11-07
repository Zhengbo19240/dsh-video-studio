/**
 * 关键帧曲线：三次贝塞尔缓动。
 *
 * 覆盖三件事：
 *   1) 纯函数 bezierEase（端点 / 单调 / 与线性差异 / 对称）；
 *   2) 命令引擎的校验（分量越界 / 长度不对 → INVALID_OP）；
 *   3) 播放器 ease() 的优先级（bezier 优先，缺省回落 kind）。
 *
 *   node scripts/keyframe-curve-test.mjs
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import { bezierEase, isValidBezier } from "../src/domain.mjs";
import { ease, evaluateTransform } from "../src/client/player.js";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('keyframe-curve');

let pass = 0;
let fail = 0;
const t = async (n, f) => {
  try {
    await f();
    pass += 1;
    console.log("  ok   " + n);
  } catch (e) {
    fail += 1;
    console.log("  FAIL " + n + " :: " + (e && e.message));
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const EASE_IN_OUT = [0.42, 0, 0.58, 1];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "vw-bez-"));
const store = new ProjectStore();
const doc = await store.open(root, "s1");
const apply = async (ops) => {
  const p = store.preview(doc.projectId, "s1", undefined, ops);
  return store.applyPreview(p.previewId, "s1");
};
const clipNow = () => store.get(doc.projectId).doc.clips[0];

await apply([
  { type: "clip.insert", clipId: "c1", trackId: "t1", clipType: "text", start: 0, duration: 4, text: "曲线" },
]);

// ------------------------------------------------------------ 纯函数 ------

await t("端点：k=0 严格返回 0", async () => {
  for (const b of [EASE_IN_OUT, [0, 0, 1, 1], [0.9, 0.1, 0.1, 0.9]]) {
    assert(bezierEase(b[0], b[1], b[2], b[3], 0) === 0, "k=0 不是 0: " + JSON.stringify(b));
  }
});

await t("端点：k=1 严格返回 1", async () => {
  for (const b of [EASE_IN_OUT, [0, 0, 1, 1], [0.9, 0.1, 0.1, 0.9]]) {
    assert(bezierEase(b[0], b[1], b[2], b[3], 1) === 1, "k=1 不是 1: " + JSON.stringify(b));
  }
});

await t("单调不降：41 个采样点连成上升曲线", async () => {
  let prev = -1;
  for (let i = 0; i <= 40; i += 1) {
    const k = i / 40;
    const v = bezierEase(EASE_IN_OUT[0], EASE_IN_OUT[1], EASE_IN_OUT[2], EASE_IN_OUT[3], k);
    if (v < prev - 1e-9) throw new Error(`k=${k} 回退了：${prev} → ${v}`);
    prev = v;
  }
});

await t("对称曲线中点正好 0.5", async () => {
  const v = bezierEase(0.42, 0, 0.58, 1, 0.5);
  assert(near(v, 0.5, 1e-3), "中点=" + v);
});

await t("与 linear 不同：前段低于 k、后段高于 k", async () => {
  const a = bezierEase(0.42, 0, 0.58, 1, 0.25);
  const b = bezierEase(0.42, 0, 0.58, 1, 0.75);
  assert(a < 0.25 - 0.02, "k=0.25 应明显低于线性，实际 " + a);
  assert(b > 0.75 + 0.02, "k=0.75 应明显高于线性，实际 " + b);
});

await t("出界 k 被夹住（不做外推）", async () => {
  assert(bezierEase(0.42, 0, 0.58, 1, -3) === 0, "负 k 未夹住");
  assert(bezierEase(0.42, 0, 0.58, 1, 9) === 1, "超 1 的 k 未夹住");
});

await t("isValidBezier：合法通过、越界/长度不对被拒", async () => {
  assert(isValidBezier([0.42, 0, 0.58, 1]), "合法四元组被拒");
  assert(!isValidBezier([0.42, 0, 1.2, 1]), "1.2 越界却通过");
  assert(!isValidBezier([0.42, 0, 0.58]), "三元组却通过");
  assert(!isValidBezier("0.42,0,0.58,1"), "字符串却通过");
});

// ------------------------------------------------------- 命令引擎校验 ------

await t("分量越界被拒（INVALID_OP）", async () => {
  try {
    await apply([
      { type: "clip.set_keyframe", clipId: "c1", property: "scale", t: 0, value: 1, bezier: [0.42, 0, 1.2, 1] },
    ]);
    throw new Error("应当拒绝");
  } catch (e) {
    if (e.code !== "INVALID_OP") throw e;
    assert(/0\.\.1/.test(e.message), "原因里没有范围说明：" + e.message);
  }
});

await t("分量非数字 / 长度不对被拒（INVALID_OP）", async () => {
  for (const bad of [[0.42, "0", 0.58, 1], [0.42, 0, 0.58], [-0.1, 0, 0.58, 1]]) {
    try {
      await apply([{ type: "clip.set_keyframe", clipId: "c1", property: "scale", t: 0, value: 1, bezier: bad }]);
      throw new Error("应当拒绝: " + JSON.stringify(bad));
    } catch (e) {
      if (e.code !== "INVALID_OP") throw e;
    }
  }
});

await t("写入后关键帧带 bezier，回读一致", async () => {
  await apply([
    { type: "clip.set_keyframe", clipId: "c1", property: "scale", t: 0, value: 1 },
    { type: "clip.set_keyframe", clipId: "c1", property: "scale", t: 4, value: 3, ease: "easeIn", bezier: EASE_IN_OUT },
  ]);
  const k = clipNow().keyframes.find((x) => x.property === "scale" && x.t === 4);
  assert(k && Array.isArray(k.bezier), "没有存下 bezier");
  assert(k.bezier.length === 4 && k.bezier[0] === 0.42, "bezier 内容不对: " + JSON.stringify(k.bezier));
});

// ------------------------------------------------ 播放器：优先级与回落 ----

await t("player.ease：bezier 优先于 kind", async () => {
  const v = ease(0.5, "easeIn", [0, 0, 1, 1]); // 该曲线退化成直线
  assert(near(v, 0.5, 1e-6), "bezier 未生效，easeIn 算出 " + v);
  assert(near(ease(0.5, "easeIn"), 0.25, 1e-9), "无 bezier 时 easeIn 基线不对");
});

await t("player.ease：缺省回落到 kind / 线性", async () => {
  const eIn = ease(0.5, "easeIn");
  const eOut = ease(0.5, "easeOut");
  const eBoth = ease(0.5, "easeInOut");
  const linear = ease(0.5, undefined);
  assert(near(eIn, 0.25, 1e-9), "easeIn=" + eIn);
  assert(near(eOut, 0.75, 1e-9), "easeOut=" + eOut);
  assert(near(eBoth, 0.5, 1e-9), "easeInOut=" + eBoth);
  assert(near(linear, 0.5, 1e-9), "linear=" + linear);
});

await t("player.ease：坏 bezier 回落到 kind，不抛", async () => {
  const v = ease(0.5, "easeOut", [0.42, 0, 5, 1]);
  assert(near(v, 0.75, 1e-9), "坏数据没有回落: " + v);
});

await t("evaluateTransform：帧间用 bezier 求值", async () => {
  const c = clipNow();
  const k = bezierEase(EASE_IN_OUT[0], EASE_IN_OUT[1], EASE_IN_OUT[2], EASE_IN_OUT[3], 0.25);
  const v = evaluateTransform(c, 1).scale; // t=1 在 0..4 之间，raw=0.25
  assert(near(v, 1 + 2 * k, 1e-6), `v=${v}，期望 ${1 + 2 * k}`);
  assert(Math.abs(v - 1.5) > 1e-3, "与 easeIn 的结果撞了，说明 bezier 没生效");
});

await t("重新写同一帧可去掉 bezier", async () => {
  await apply([
    { type: "clip.set_keyframe", clipId: "c1", property: "scale", t: 4, value: 3, ease: "linear" },
  ]);
  const k = clipNow().keyframes.find((x) => x.property === "scale" && x.t === 4);
  assert(!("bezier" in k), "bezier 未被移除: " + JSON.stringify(k));
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
