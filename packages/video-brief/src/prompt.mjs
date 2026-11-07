/**
 * 系统提示段：四段式工作流（问询 → 写脚本 → 定风格 → 开工），≤400 非空白字符。
 *
 * 宿主的 systemPrompt.section 只吃静态 text（没有按会话取状态的参数），
 * 所以这里不假装知道"当前阶段"，而是把**顺序与硬约束**写成规则，让模型先 video_stage_get 再对号入座。
 * 具体阶段、缺失项、下一步全部由工具返回，提示段只负责"别跳步"。
 */

/** 提示段名（同 name 重复注册会互相覆盖）。 */
export const SECTION_NAME = 'dsh-video-brief:protocol';

/** 排序权重。 */
export const SECTION_ORDER = 650;

/** 提示正文（≤720 非空白字符）。 */
export function buildPromptText() {
  return [
    '【视频阶段机】先 video_stage_get 看阶段，按序不跳步：',
    '1. idle/clarify：只补 brief：video_brief_start 拿缺失，一轮 ≤3 条，video_brief_confirm 写回；满 10 进 script。',
    '2. script：video_script_draft 写分镜脚本，逐条给用户看；用户明确说「可以/确认/没问题」再 video_script_confirm；没这句不许渲染样片、不许开工。',
    '3. style：脚本确认后渲 4 张关键帧 + 8 秒样片，video_style_confirm 记 tone/palette/font/density/pace。',
    '4. locked：可改时间线（video_edit_apply 等），首次写操作自动进 build；build 全放行。',
    '5. 交付物＝工作台里的工程本身（时间线+脚本+素材），由用户在面板导出；不要把 MP4 当最终产出，也不要用外部 ffmpeg 自己拼片。MP4 只在风格确认时渲一段预览给用户看。',
    '6. 工序串行：画面（含转场、定镜头时长）→ 音效（贴切点）→ 配乐（避让音效与口播）→ 统稿；上一步没锁定不许开下一步。',
    '7. 并发只按模块切：模块=叙事单元（40 秒~3 分钟，边界能在语法上停），一人一块，不许按时长均分；颜色字号间距只认 style.json，不许自造。',
    '8. 收尾一人统稿，只做三件：接缝检测、转场缝合、全局微调；统稿期间其他人不许写同一工程。',
    'enforce 真拒：脚本→style、风格→时间线；缺什么补什么，不要绕。',
  ].join('\n');
}
