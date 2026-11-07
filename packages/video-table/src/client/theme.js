/**
 * 工作台外壳的主题桥。
 *
 * 面板不再自己写死一套深色：所有「外壳」颜色都指向 DSH 的设计变量
 * `--dsw-alias-*`，这样 DSH 切浅色 / 换主题时工作台跟着走。
 *
 * 每个值都写成 `var(--token, 回退值)`，回退值必须保留：
 * 离屏渲染（导出、缩略图、headless 测试）里没有 DSH 的 CSS 变量，
 * 没有回退就会拿到空字符串，颜色变成「继承」，整块面板会花掉。
 *
 * token 名不是猜的：全部取自 DSH 的 ui-theme 包
 * （app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js），
 * 该文件同时给出 `body`（浅色）与 `body[data-ds-dark-theme]`（深色）两套值。
 * 2026-11 实测存在的别名共 119 个，这里只挑外壳用得到的那些。
 *
 * 注意：这里面只有「界面主题」。预览画面的黑底、时间线里按轨道区分的
 * 片段色、波形色、播放头、选中描边属于产品颜色，不走这里 —— 改了会破坏
 * 画面与时间线的一致性。
 */

/** 组装一个带回退的变量引用。回退值只在没有 DSH 样式表时生效。 */
const v = (token, fallback) => `var(--${token}, ${fallback})`;

export const T = {
  // ---- 面 ---------------------------------------------------------------
  /** 整页底色（bg-base：浅 #fff / 深 #151517） */
  bg: v('dsw-alias-bg-base', '#151517'),
  /** 面板 / 弹层底色（bg-layer-2：浅 #fff / 深 #2c2c2e） */
  panel: v('dsw-alias-bg-layer-2', '#2c2c2e'),
  /** 再抬一层的面：对话框、下拉（bg-layer-3：浅 #fff / 深 #353638） */
  panelAlt: v('dsw-alias-bg-layer-3', '#353638'),
  /** 遮罩 / 衬底（bg-mask-1） */
  mask: v('dsw-alias-bg-mask-1', 'rgba(0,0,0,.5)'),

  // ---- 字 ---------------------------------------------------------------
  /** 主文字（label-primary） */
  text: v('dsw-alias-label-primary', '#f9fafb'),
  /** 次文字：说明、单位、轨道名（label-secondary） */
  textDim: v('dsw-alias-label-secondary', '#cfd3d6'),
  /** 三级文字：占位、计数（label-tertiary） */
  textFaint: v('dsw-alias-label-tertiary', '#adb2b8'),

  // ---- 线 ---------------------------------------------------------------
  /** 所有 1px 边框 / 分隔线（border-l2） */
  border: v('dsw-alias-border-l2', 'rgba(255,255,255,.12)'),
  /** 更淡的分隔线：行与行之间（border-l1） */
  borderFaint: v('dsw-alias-border-l1', 'rgba(255,255,255,.06)'),
  /** 需要被看见的边框：悬停、虚线提示（border-l4） */
  borderStrong: v('dsw-alias-border-l4', 'rgba(255,255,255,.2)'),

  // ---- 色 ---------------------------------------------------------------
  /** 强调（state-business-primary：浅 #4176e6 / 深 #7aaaff） */
  accent: v('dsw-alias-state-business-primary', '#7aaaff'),
  /** 强调的底色（state-business-tertiary） */
  accentDim: v('dsw-alias-state-business-tertiary', 'rgba(122,170,255,.2)'),
  /** 危险（state-error-primary） */
  danger: v('dsw-alias-state-error-primary', '#f25a5a'),
  /** 危险的底色（interactive-bg-hover-danger） */
  dangerDim: v('dsw-alias-interactive-bg-hover-danger', 'rgba(242,90,90,.15)'),
  /** 成功（state-success-secondary） */
  ok: v('dsw-alias-state-success-secondary', '#4ed17e'),
  /** 提醒（state-warn-primary） */
  warn: v('dsw-alias-state-warn-primary', '#f59e0b'),
  /** 提醒的底色（state-warn-tertiary） */
  warnDim: v('dsw-alias-state-warn-tertiary', 'rgba(245,158,11,.16)'),

  // ---- 填充 -------------------------------------------------------------
  /** 轻填充：输入框、条带（interactive-bg-hover） */
  fill: v('dsw-alias-interactive-bg-hover', 'rgba(255,255,255,.07)'),
  /** 重一点的填充：选中行、芯片（interactive-bg-active） */
  fillStrong: v('dsw-alias-interactive-bg-active', 'rgba(255,255,255,.11)'),

  // ---- 主按钮 -----------------------------------------------------------
  /** 主按钮底（button-primary-fill：浅 #0f1115 / 深 #f9fafb） */
  primary: v('dsw-alias-button-primary-fill', '#f9fafb'),
  /** 主按钮文字（label-primary-foreground：浅 #fff / 深 #0f1115） */
  onPrimary: v('dsw-alias-label-primary-foreground', '#0f1115'),

  // ---- 形状 / 字号 ------------------------------------------------------
  /** 圆角：面板、对话框（radius-md = 12px） */
  radius: v('dsw-radius-md', '12px'),
  /** 小圆角：按钮、输入框（radius-sm = 8px） */
  radiusSm: v('dsw-radius-sm', '8px'),
  /** 大圆角：面板外框（radius-lg = 16px） */
  radiusLg: v('dsw-radius-lg', '16px'),
  /** 间距没有 alias token（查过 asar：ui-theme 只导出颜色/圆角/字号/阴影），
   *  所以这里给一个数字，调用处当 gap 用。 */
  gap: 8,
  /** 正文族（--dsh-font-family-text 由宿主 boot 脚本写在 body 上） */
  font: v('dsh-font-family-text', "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"),
  /** 阴影（--dsw-shadow-lv2 是整套 box-shadow 值，不是颜色） */
  shadow: v('dsw-shadow-lv2', '0 10px 30px rgba(0,0,0,.45)'),
};

export default T;
