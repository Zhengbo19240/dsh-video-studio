/**
 * 文字样式：白名单校验 + 渲染参数归一化。
 *
 * 覆盖：字体白名单、字号 / 行高边界、颜色格式、描边与阴影结构、
 *       clip.set_property（面板实际走的那条命令）与 normalizeTextStyle。
 *
 *   node scripts/text-style-test.mjs
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectStore } from "../src/store.mjs";
import {
  TEXT_FONT_FAMILIES,
  normalizeTextStyle,
  normalizeStroke,
  normalizeShadow,
} from "../src/domain.mjs";

import { useTempBindings } from './_bindings-guard.mjs';
const cleanupBindings = useTempBindings('text-style');

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

const root = await fs.mkdtemp(path.join(os.tmpdir(), "vw-txtstyle-"));
const store = new ProjectStore();
const doc = await store.open(root, "s1");
const apply = async (ops) => {
  const p = store.preview(doc.projectId, "s1", undefined, ops);
  return store.applyPreview(p.previewId, "s1");
};
const clipNow = (id = "t1") => store.get(doc.projectId).doc.clips.find((c) => c.id === id);
const styleNow = () => clipNow().style || {};

/** 断言某条命令被拒，并且原因里有中文说明。 */
async function rejects(ops, code, reasonPattern) {
  try {
    await apply(ops);
    throw new Error("应当被拒绝");
  } catch (e) {
    if (e.code !== code) throw e;
    if (reasonPattern && !reasonPattern.test(e.message)) {
      throw new Error("原因不像中文说明：" + e.message);
    }
  }
}

await apply([{ type: "clip.insert", clipId: "t1", trackId: "t1", clipType: "text", start: 0, duration: 4, text: "样式" }]);
await apply([{ type: "clip.insert", clipId: "m1", trackId: "c1", clipType: "code", layerId: "ly1", start: 0, duration: 1 }]);

await t("白名单字体全部通过", async () => {
  for (const family of TEXT_FONT_FAMILIES) {
    await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontFamily: family } }]);
    assert(styleNow().fontFamily === family, "没有落盘: " + family);
  }
});

await t("白名单外字体被拒，原因是中文", async () => {
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontFamily: "Comic Sans MS" } }],
    "INVALID_ARG",
    /fontFamily/,
  );
});

await t("字号 12 / 200 通过，11 / 201 被拒", async () => {
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontSize: 12 } }]);
  assert(styleNow().fontSize === 12, "12 未写入");
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontSize: 200 } }]);
  assert(styleNow().fontSize === 200, "200 未写入");
  for (const bad of [11, 201, 0, "48", NaN]) {
    await rejects(
      [{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontSize: bad } }],
      "INVALID_ARG",
      /fontSize/,
    );
  }
});

await t("行高 1 / 3 通过，0.9 / 3.1 被拒", async () => {
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { lineHeight: 1 } }]);
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { lineHeight: 3 } }]);
  for (const bad of [0.9, 3.1, "1.5"]) {
    await rejects(
      [{ type: "clip.set_property", clipId: "t1", property: "style", value: { lineHeight: bad } }],
      "INVALID_ARG",
      /lineHeight/,
    );
  }
});

await t("非法颜色被拒（red / #fff / #12345）", async () => {
  for (const bad of ["red", "#fff", "#12345", "#gggggg"]) {
    await rejects(
      [{ type: "clip.set_property", clipId: "t1", property: "style", value: { color: bad } }],
      "INVALID_ARG",
      /颜色/,
    );
  }
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { color: "#12ab34" } }]);
  assert(styleNow().color === "#12ab34", "合法颜色未写入");
});

await t("描边结构：{color,width} 通过、null 清除、坏结构被拒", async () => {
  await apply([
    { type: "clip.set_property", clipId: "t1", property: "style", value: { stroke: { color: "#000000", width: 3 } } },
  ]);
  const s = styleNow().stroke;
  assert(s && s.color === "#000000" && s.width === 3, "描边未写入: " + JSON.stringify(s));
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { stroke: "#000000" } }],
    "INVALID_ARG",
    /stroke/,
  );
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { stroke: { color: "black", width: 2 } } }],
    "INVALID_ARG",
    /描边颜色/,
  );
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { stroke: { color: "#000000", width: 99 } } }],
    "INVALID_ARG",
    /描边宽度/,
  );
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { stroke: null } }]);
  assert(styleNow().stroke == null, "null 没有清掉描边: " + JSON.stringify(styleNow().stroke));
});

await t("阴影结构：{color,blur,x,y} 通过、越界被拒、null 清除", async () => {
  await apply([
    {
      type: "clip.set_property",
      clipId: "t1",
      property: "style",
      value: { shadow: { color: "#000000", blur: 12, x: 2, y: 3 } },
    },
  ]);
  const sh = styleNow().shadow;
  assert(sh && sh.blur === 12 && sh.x === 2 && sh.y === 3, "阴影未写入: " + JSON.stringify(sh));
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { shadow: { blur: 80 } } }],
    "INVALID_ARG",
    /阴影模糊/,
  );
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { shadow: { x: 99 } } }],
    "INVALID_ARG",
    /阴影偏移/,
  );
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { shadow: { spread: 4 } } }],
    "INVALID_ARG",
    /阴影/,
  );
  await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { shadow: null } }]);
  assert(styleNow().shadow == null, "null 没有清掉阴影");
});

await t("粗细与对齐只接受白名单值", async () => {
  for (const w of [400, 600, 700, 900]) {
    await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontWeight: w } }]);
    assert(styleNow().fontWeight === w, "fontWeight 未写入: " + w);
  }
  for (const bad of [300, 500, "700"]) {
    await rejects(
      [{ type: "clip.set_property", clipId: "t1", property: "style", value: { fontWeight: bad } }],
      "INVALID_ARG",
      /fontWeight/,
    );
  }
  for (const a of ["left", "center", "right"]) {
    await apply([{ type: "clip.set_property", clipId: "t1", property: "style", value: { align: a } }]);
  }
  await rejects(
    [{ type: "clip.set_property", clipId: "t1", property: "style", value: { align: "justify" } }],
    "INVALID_ARG",
    /align/,
  );
});

await t("渲染参数归一化：越界值被夹到合法范围", async () => {
  const n = normalizeTextStyle({
    fontFamily: "Comic Sans",
    fontSize: 400,
    fontWeight: 500,
    color: "red",
    align: "justify",
    lineHeight: 9,
    y: 2,
  });
  assert(n.fontFamily === "system-ui", "字体未回落: " + n.fontFamily);
  assert(n.fontSize === 200, "字号未夹住: " + n.fontSize);
  assert(n.fontWeight === 400, "粗细未回落: " + n.fontWeight);
  assert(n.color === "#ffffff", "颜色未回落: " + n.color);
  assert(n.align === "center", "对齐未回落: " + n.align);
  assert(n.lineHeight === 3, "行高未夹住: " + n.lineHeight);
  assert(n.y === 1, "y 未夹住: " + n.y);
});

await t("归一化兼容旧字段（bold / stroke 字符串）", async () => {
  const n = normalizeTextStyle({ bold: true, stroke: "#112233" });
  assert(n.fontWeight === 700, "bold 未映射到 700: " + n.fontWeight);
  assert(n.stroke && n.stroke.color === "#112233" && n.stroke.width === 2, "旧描边未兼容: " + JSON.stringify(n.stroke));
  assert(normalizeStroke("rgba(0,0,0,.7)") === null, "非法旧描边应折成 null");
  assert(normalizeShadow({ blur: 120, x: -80 }) !== null, "阴影对象不该被整体丢弃");
});

await t("非文字片段设样式被拒（INVALID_OP）", async () => {
  await rejects(
    [{ type: "clip.set_property", clipId: "m1", property: "style", value: { fontSize: 20 } }],
    "INVALID_OP",
  );
});

await t("clip.insert 的 style 也过白名单（骨架标记放行）", async () => {
  await rejects(
    [
      {
        type: "clip.insert",
        clipId: "bad1",
        trackId: "t1",
        clipType: "text",
        start: 4,
        duration: 1,
        text: "坏样式",
        style: { fontFamily: "Comic Sans" },
      },
    ],
    "INVALID_ARG",
    /fontFamily/,
  );
  await apply([
    {
      type: "clip.insert",
      clipId: "sk1",
      trackId: "t1",
      clipType: "text",
      start: 4,
      duration: 1,
      text: "第 1 镜",
      style: { skeleton: true, skeletonOf: "a1", shotIndex: 1 },
    },
  ]);
  const st = clipNow("sk1").style;
  assert(st.skeleton === true && st.shotIndex === 1, "骨架标记被吞: " + JSON.stringify(st));
});

await fs.rm(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
