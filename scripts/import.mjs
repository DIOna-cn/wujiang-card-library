#!/usr/bin/env node
/**
 * 导入脚本：把 素材\ 目录下的 .shap 工程档与 描述.txt 统一成每个武将一份的 武将.json。
 *
 * 设计原则：
 * 1. 只做「迁移」，不猜设计意图 —— .shap 有结构化数据就用它，没有就从 描述.txt 解析。
 * 2. 所有人工订正集中在 MANUAL 表里，便于复查与修正。
 * 3. 可重复执行：加 --force 才会覆盖已有 武将.json。
 *
 * 用法：
 *   node scripts/import.mjs            # 只生成不存在的 武将.json，已存在的跳过
 *   node scripts/import.mjs --force    # 全部重新生成（会覆盖网页里的编辑！）
 *   node scripts/import.mjs --dry      # 只打印结果，不写文件
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, '..', '素材');
const DATA_DIR = path.join(ROOT, '.data');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const DRY = argv.includes('--dry');

/* ------------------------------------------------------------------ *
 * 人工订正表
 * ------------------------------------------------------------------ */

/** 势力代码 → 中文显示名 */
const KINGDOM_NAME = {
  wei: '魏', shu: '蜀', wu: '吴', qun: '群', jin: '晋',
  shen: '神', yao: '妖', hun: '魂',
};

/** 势力中文 → 代码（解析 描述.txt 用） */
const KINGDOM_CODE = {
  魏: 'wei', 蜀: 'shu', 吴: 'wu', 群: 'qun', 晋: 'jin',
  神: 'shen', 妖: 'yao', 魂: 'hun',
};

/**
 * 势力值归一化成代码。
 * 素材里两种写法都有：.shap 里多数是 wei/qun/jin，但也见过直接写「蜀」「群」；
 * 描述.txt 里则一律是中文。这里两边都认。
 */
function normalizeKingdom(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (KINGDOM_NAME[s]) return s;          // 已是代码
  if (KINGDOM_CODE[s]) return KINGDOM_CODE[s]; // 中文
  return '';
}

/**
 * 原作：一个武将只属于一个原作。
 * 从编号前缀推断，与 .shap 里的 legendId 对应。
 */
const SERIES = {
  ARK: '明日方舟',
  TH: '东方Project',
  GEN: '原神',
  WEI: '三国杀',
  HSR: '崩坏星穹铁道',
};

/**
 * 已知的「原作」名字。
 *
 * 数据里 原作 和 特性标签 分开存：`origin` 存原作（单值），`tags` 只存特性标签。
 * 但历史数据（以及手改过的 武将.json）常把原作混在 tags 里，
 * 所以读写时都要用这个表把它挑出来。
 */
const ORIGINS = ['明日方舟', '东方Project', '原神', '崩坏星穹铁道', '三国杀', '原创'];

/** 把一串标签拆成 { origin, tags }：原作归 origin，其余留在 tags */
function splitOriginFromTags(list, fallbackOrigin = '') {
  const origins = [];
  const tags = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw ?? '').trim();
    if (!t) continue;
    if (ORIGINS.includes(t)) {
      if (!origins.includes(t)) origins.push(t);
    } else if (!tags.includes(t)) {
      tags.push(t);
    }
  }
  // 一个武将不该有多个原作，多出来的一律只取第一个
  return { origin: fallbackOrigin || origins[0] || '', extraOrigins: origins.slice(1), tags };
}

/**
 * 人工订正：键为素材下的文件夹名。
 *   name/title/kingdom: 覆盖 .shap 或 描述.txt 里的值
 *   ignoreShap: 忽略该文件（重复或空白工程档）
 *   cards: 显式声明卡面（多武将牌 / 多形态时用）
 *   skip: 整个文件夹不作为武将（如纯素材目录）
 */
const MANUAL = {
  _待整理: { skip: '空目录' },
  '原画': { skip: '原画归档，不是武将目录' },
  '宝物卡图': { skip: '道具卡图，不是武将目录' },

  // 迁移前这个键写作 '_待实现/锏'。现在武将一律平躺在 素材\ 下，
  // 「做没做完」由 武将.json 的 implemented 表示（见 scripts/migrate-pending.mjs）
  '锏': {
    name: '锏',
    title: '',
    kingdom: 'qun',
    note: '描述.txt 未标注武将名/体力/势力，名称按文件夹名暂定「锏」，待补',
  },

  '结城理': {
    ignoreShap: ['_重复工程_面具①.结城理.shap'],
    cards: [
      { name: '面具①', image: '新UI.面具①.结城理.png', shap: '面具①.结城理.shap', legendId: 'ARK 004', derived: [] },
      { name: '面具②', image: '新UI.面具②.结城理.png', shap: '面具②.结城理.shap', legendId: 'ARK 004.1', derived: [] },
      { name: '面具③', image: '新UI.面具③.结城理.png', shap: '面具③.结城理.shap', legendId: 'ARK 004.2', derived: [] },
    ],
  },

  塔露拉: {
    cards: [
      { name: '觉醒前', image: '新UI.不死的黑蛇.塔露拉.png', shap: '不死的黑蛇.塔露拉.shap', legendId: 'ARK 011.1', derived: [] },
      { name: '觉醒后', image: '新UI.不死的黑蛇.塔露拉_2.png', derived: ['燎原', '安魂'] },
    ],
  },

  普瑞赛斯: {
    name: '普瑞赛斯',
    title: '语言学家',
    kingdom: 'qun',
    hp: 3,
    maxHp: 3,
    shield: 0,
    cards: [
      {
        name: '武将牌①',
        image: '1.png',
        legendId: '',
        derived: ['改写', '觉醒'],
        skills: [
          { name: '改写', desc: '每轮限一次，当你使用卡牌指定目标、或你成为卡牌目标时，你可以重新为这张牌指定任意合法目标（目标数保持原样，且至少要换掉一个目标）。' },
          { name: '觉醒', desc: '当你死亡时，更换武将牌至②，并抽三张牌。' },
        ],
        note: '此牌的技能在卡面上为空白（作者要求），本条目为实际机制说明。',
      },
      {
        name: '武将牌②',
        image: '2.png',
        legendId: '',
        derived: ['替牌·人', '替牌·眼', '替牌·己', '替牌·换'],
        skills: [
          { name: '替牌·人', desc: '锁定技，其他角色抽牌前，读取牌堆顶等同其即将抽取张数的牌，把其中有价值的牌与牌堆中的随机牌替换，重复至多6次。' },
          { name: '替牌·眼', desc: '其他角色的手牌始终对你可见。' },
          { name: '替牌·己', desc: '锁定技，其他角色或你抽牌前，读取牌堆顶等同其即将抽取张数的牌——对别人换走有价值的、对自己换走无价值的，重复至多3次。' },
          { name: '替牌·换', desc: '当你需要使用或打出牌时、或出牌阶段，你可以把一张手牌与牌堆里的一张牌互换。' },
        ],
        note: '此牌的技能在卡面上为空白（作者要求），本条目为实际机制说明。转换链：武将牌① --死亡(觉醒)--> 武将牌②。两张牌体力上限都是3，但换牌不回满体力。',
      },
    ],
  },

  藿藿: { name: '藿藿', title: '令奉贞凶', kingdom: 'wei' },
  圣聆初雪: { name: '初雪', title: '圣女', kingdom: 'wei', note: '素材目录名为「圣聆初雪」，游戏内武将名显示为「初雪」。' },
  蓬莱山辉夜: { name: '辉夜', title: '竹取姬', kingdom: 'wei', note: '素材目录名为「蓬莱山辉夜」，游戏内武将名显示为「辉夜」。' },
  藤原妹红: { name: '妹红', title: '蓬莱人形', kingdom: 'shu' },
  琪露诺: { name: '琪露诺', title: '湖上的冰精', kingdom: 'wei' },
  遥: { name: '遥', title: '夏末游鳞', kingdom: 'qun' },
  黍: { name: '黍', title: '怀黍离', kingdom: 'wei' },
  颉: { name: '颉', title: '辞岁行', kingdom: 'wei' },
  重岳: { name: '重岳', title: '登临意', kingdom: 'wei' },
  夕: { name: '夕', title: '', kingdom: 'qun', note: '描述.txt 中称号为「（留空）」。' },
  年: { name: '年', title: '洪炉示岁', kingdom: 'wei' },
  乌啾: { name: '乌啾', title: '羽隐愈疗', kingdom: 'wei' },

  /* ---- 以下为「描述.txt 与卡面/工程档不一致」的逐条订正，均已按卡面（.shap/卡图）核对 ---- */

  均1: { name: '均', title: '相见欢', kingdom: 'hun', legendId: 'HUN 001' },
  均2: { name: '均', title: '律法', kingdom: 'jin', legendId: 'JIN 001' },
  觉: {
    kingdom: 'jin',
    title: '读心妖怪',
    cards: [{
      name: '',
      image: '立绘.jpg',
      cardImage: '新UI.读心妖怪.觉.png',
      legendId: 'TH 005',
      skills: [{
        name: '读心',
        desc: '其他角色的出牌阶段开始时，你可以弃置1张手牌并查看其手牌，然后你选择一项操作。若于出牌阶段内首次操作符合你选择的一项，终止此结算并令其失去1点体力，若可能，获得当前结算中的牌，触发该效果后，结束当前阶段。',
      }],
      note: '描述.txt 写作「讀心」；卡面技能名为「读心」。\n本目录 .shap 内的 title 仍是旧版卡名「第三只眼」，此处按卡面与文件夹名取「读心妖怪」。',
    }],
  },

  华法琳: {
    kingdom: 'shu',
    cards: [{
      name: '',
      image: '立绘.png',
      cardImage: '新UI.实验狂魔.华法琳.png',
      legendId: 'ARK 009',
      skills: [
        { name: '血浆', desc: '出牌阶段限两次，你可以选择一名其他角色，然后:令你与其恢复1点生命值，然后你与其失去1点体力，其下个回合造成伤害时，其失去1点体力并令此伤害+1。' },
        { name: '实验', desc: '出牌阶段，你可以弃置两张牌并选择一名角色，若其颜色相同，你令其本回合体力恢复量+1，否则其本回合生命上限视为X(X为其体力值且至少为1)。' },
      ],
      note: '语音均为素材中随机。',
    }],
  },

  圣聆初雪: {
    name: '初雪', title: '圣女', kingdom: 'wei',
    cards: [{
      name: '',
      image: '立绘_圣聆初雪_2.png',
      cardImage: '新UI.圣女.初雪.png',
      legendId: '',
      skills: [
        { name: '雪景', desc: '锁定技，其他角色每累计使用或打出X张牌后，其弃置一张牌（X为其与你当前的距离，至少为2）。此计数在其回合结束后重置。' },
        { name: '祈愿', desc: '转换技，①结束阶段，你可以失去【圣山】并获得【霜涛】；②结束阶段，你可以失去【霜涛】并获得【圣山】。' },
        { name: '圣山', desc: '锁定技，每轮开始时，你获得1点护甲；其他角色计算与你的距离时+1；你的手牌上限+2。' },
        { name: '霜涛', desc: '锁定技（衍生技），你使用的【杀】可以指定至多三名角色为目标；其他角色计算与你的距离时-1。', derived: true },
      ],
      note: '开局自带【圣山】；【霜涛】不在武将技能表里，只能由【祈愿】①获得。两者互斥地修改同一个方向的距离。\n素材目录名为「圣聆初雪」，游戏内武将名显示为「初雪」。',
    }],
  },

  乌啾: {
    kingdom: 'wei',
    cards: [{
      name: '',
      image: '立绘.png',
      cardImage: '',
      legendId: '',
      skills: [
        { name: '捉迷藏', desc: '出牌阶段限一次，你可以失去一点体力、弃置一张红色手牌并选择一名与你距离不大于1的已受伤角色，令其回复1点体力。拥有“迷彩-基本”/“迷彩-锦囊”的角色不能成为[杀]/非延时锦囊牌的目标。你失去“迷彩”系标记时，移去你判定区的所有牌。\n每回合限两次，你使任何角色恢复体力时，你选择并令其获得“迷彩-基本”或“迷彩-锦囊”，然后你进行一次判定，♥️：你可以令与其距离不大于2的一名其他未被此效果影响的角色恢复1点体力；♦️：你令一名角色抽3张牌；♣️：你可以弃置一张红色牌并重复此流程；♠️：你恢复1点体力值并抽1张牌，若如此做，你的下个回合开始时，你移去所有由你产生的“迷彩”系标记并抽等量的牌。', fixNote: '描述.txt 中第二段没有技能名，按卡面应为「捉迷藏」的第二段；若实为独立技能请在网页里拆开。' },
        { name: '保身', desc: '每回合限一次，当你成为锦囊牌的目标时，你可以进行一次判定，若结果为红色，你取消此牌并获得之。' },
      ],
    }],
  },

  涤火杰西卡: {
    name: '涤火杰西卡', title: '', kingdom: 'qun', isLord: true,
    cards: [{
      name: '',
      image: '立绘.png',
      cardImage: '',
      legendId: '',
      skills: [
        { name: '盾牌', desc: '持恒技，你的护甲值每次只能失去一点。当你使用【桃】或你的防具牌置入或从你的装备区失去时，你可以获得一点护甲，当你失去护甲时，你选择一项:1、弃置等同于伤害来源的手牌，并使其失去一点体力，2、获得其区域内的一张牌，3、将手牌摸至于等同于伤害来源血量或手牌数。' },
        { name: '手铳', desc: '持恒技，出牌阶段，若你使用的基本牌被响应，你可以弃置响应者区域内的一张牌。当你的武器牌置入你的手牌区时，你视为对一名角色使用一张不计入次数限制的【杀】，当你的武器牌从你的装备区失去时，你摸2张牌。' },
        { name: '步銃', desc: '出牌阶段限一次，你可以弃置一张♠️或♣️牌，视为对一名角色使用一张不计入次数限制无距离限制的【雷杀】，若其打出一张【闪】，你可以摸一张牌并重置该技能。' },
        { name: '舰炮', desc: '出牌阶段限一次，你可以弃置4-X张花色不同的牌，然后摸X/2张牌，视为对一名角色使用一张无距离限制不计入次数限制的【酒】【火杀】。若该角色因此受到伤害，你可以弃置1~2张杀，视为对其周围1~2名角色使用一张无距离限制不计入次数限制的【火杀】。(X为你本局游戏使用该技能的次数)', fixNote: '描述.txt 原文「弃止1~2张杀」，按文意应为「弃置」，已在卡面基础上修正，请核对。' },
        { name: '整备', desc: '持恒技，你无法被视为【兵粮寸断】的目标。当你与你的回合外失去你区域内的牌时，你可以弃置一张牌(此牌不计入本技能)，并摸一张牌。你的区域无法被任意形式废置。' },
        { name: '黑钢', desc: '主公技，其他角色于其出牌阶段可以给你X张武器牌，你可以选择一项:1，其视为使用X张【无中生有】，2、其恢复X点体力值。', fixNote: '描述.txt 原文「其他角色与其出牌阶段」「其恢复X点体」+换行「力值。」，按卡面语气修正。' },
        { name: '家族', desc: '使命技，当你的第六回合开始时，查看你装备区的牌。成功:当你的装备区拥有4张牌时，你的各装备栏上限加1;失败:你获得场上一张装备牌并摸两张牌。' },
      ],
      note: '描述.txt 未写称号，卡面亦未标；素材里没有成品卡图，仅有立绘。',
    }],
  },

  煌: {
    kingdom: 'shu',
    cards: [{
      name: '',
      image: '立绘_2.png',
      cardImage: '新UI.燃烧的心.煌.png',
      legendId: 'ARK 007',
      skills: [
        { name: '链锯', desc: '出牌阶段，你可以指定一个其他武将并抽两张牌，若均为红色牌，将其当做1张无距离限制的火【杀】对其使用并再次对同一目标发动此技能；否则你失去1点体力并令此技能本回合失效。' },
        { name: '除颤', desc: '锁定技，每局游戏各限一次，当你的生命值低于2/1时，你的下回合结束前，你的体力值始终保持在2/1点以上。' },
        { name: '过载', desc: '锁定技，你的体力值低于3/2时，你视为拥有【沸腾】/【爆裂】。' },
        { name: '沸腾', desc: '你的抽牌阶段抽牌数+1，你的黑桃牌始终视为红桃。', derived: true },
        { name: '爆裂', desc: '你的抽牌阶段抽牌数+1，你抽到的前2张黑色牌视为红桃。', derived: true },
      ],
      note: '语音均为素材内随机。',
    }],
  },

  安洁莉娜: {
    kingdom: 'shu',
    cards: [{
      name: '',
      image: '立绘.png',
      cardImage: '',
      legendId: '',
      skills: [{ name: '重力自定义', desc: '出牌阶段限两次，你可以弃置一张手牌并选择一名角色，直到你下个回合的结束阶段，其非因此技能摸/弃牌时，弃/摸1张牌。' }],
      note: '语音为素材中随机。',
    }],
  },

  塔露拉: {
    name: '塔露拉', title: '不死的黑蛇', kingdom: 'qun',
    cards: [
      {
        name: '觉醒前',
        image: '觉醒前立绘.png',
        cardImage: '新UI.不死的黑蛇.塔露拉.png',
        legendId: 'ARK 011.1',
        skills: [
          { name: '燎原', desc: '每回合限一次，你的回合内/外，当前回合角色对其他角色/你造成伤害时，你可以与受伤角色各摸1张牌/获得场上其区域内的1张牌，并令受伤角色恢复1点体力，若如此做，伤害来源抽取一张【杀】且下一张【杀】无距离次数限制。' },
          { name: '安魂', desc: '锁定技，当你使用能造成伤害的牌时，对自己造成1点伤害。你的回合外，每回合限一次，当你进入濒死状态时，你将体力值回复至1。' },
          { name: '黑蛇', desc: '觉醒技，一名角色死亡前，你的生命上限+1并将体力值回复至3，颠倒你技能中的所有“内”和“外”，本局游戏，你于回合中首次体力回复量+1，你的非限定技视为锁定技且限制次数+1。' },
        ],
      },
      {
        name: '觉醒后',
        image: '觉醒后立绘.png',
        cardImage: '新UI.不死的黑蛇.塔露拉_2.png',
        legendId: 'ARK 011.2',
        skills: [
          { name: '燎原', desc: '每回合限两次，你的回合外/内，当前回合角色对其他角色/你造成伤害时，你可以与受伤角色各摸1张牌/获得场上其区域外的1张牌，并令受伤角色恢复1点体力，若如此做，伤害来源抽取一张【杀】且下一张【杀】无距离次数限制。', fixNote: '玩家备注：场上区域外的意思是其他所有人区域中的牌，参考杨彪的移动场上牌代码。' },
          { name: '安魂', desc: '锁定技，当你使用能造成伤害的牌时，对自己造成1点伤害。你的回合内，每回合限两次，当你进入濒死状态时，你将体力值回复至1。' },
        ],
      },
    ],
  },

  '结城理': {
    name: '结城理', title: '月行水上', kingdom: 'qun', hp: 1, maxHp: 1, shield: 0,
    cards: [
      { name: '面具①', image: '立绘_结城理_1.png', cardImage: '新UI.面具①.结城理.png', shap: '面具①.结城理.shap', legendId: 'ARK 004', shapeSkills: true,
        skills: [{ name: '面具', desc: '锁定技，你的手牌上限+3；当你死亡时，更改武将牌。出牌阶段，你可以失去一点体力。' }] },
      { name: '面具②', image: '立绘_结城理_2.png', cardImage: '新UI.面具②.结城理.png', shap: '面具②.结城理.shap', legendId: 'ARK 004.1', shapeSkills: true,
        skills: [{ name: '面具', desc: '锁定技，你的手牌上限+3；你使用【杀】时可至多指定两个目标；当你死亡或回合开始时，更改武将牌。获得此技能时，你抽一张牌，视为使用一张无距离限制且不计入次数限制的【杀】。出牌阶段，你可以失去一点体力。' }] },
      { name: '面具③', image: '立绘_结城理_3.png', cardImage: '新UI.面具③.结城理.png', shap: '面具③.结城理.shap', legendId: 'ARK 004.2', shapeSkills: true,
        skills: [{ name: '面具', desc: '锁定技，你的手牌上限+3；回合开始时，更换武将牌。获得此技能时，你抽一张牌。每回合限一次，你可以回复1点体力；你处于濒死状态时也可以发动此技能。' }] },
    ],
    note: '一个武将、三张武将牌（面具①②③）。三张牌的显示名都叫「结城理」，描述上都只有「面具」一个技能，并且只有面具①能出现在选将界面。\n转换链：面具① --死亡--> 面具② --死亡--> 面具③；面具② / 面具③ --自己回合开始--> 面具①。\n三张牌的体力上限都是1，换牌即回满——「出牌阶段，你可以失去一点体力」实际上就是这套武将唯一的主动开关。',
  },

  陈: {
    kingdom: 'wei',
    cards: [{
      name: '',
      image: '立绘.png',
      cardImage: '新UI.龙门警司.陈.png',
      legendId: 'ARK 012',
      skills: [
        { name: '赤霄：绝影', desc: '你造成或受到伤害时，你可以选择一种你拥有的牌类型并令伤害来源和受伤角色弃置区域内所有该类型牌，否则你下次由牌造成的伤害+1（不可叠加）。' },
        { name: '赤霄：拔刀', desc: '你使用牌指定唯一目标时，你可以令目标对你造成一点伤害并令此牌结算两次。', derived: true },
        { name: '形照', desc: '任何阶段结束时，若你于此阶段内失去过牌，你从牌堆中获得每种你手牌中未持有的牌类型各1张，若你以此法获得至少2张牌，你恢复1点体力。' },
      ],
      fixNote: '描述.txt 把「赤霄」写成一节内含「绝影」「拔刀」两行；卡面为两个独立技能名，此处按卡面拆开。',
    }],
  },

  蓬莱山辉夜: {
    name: '辉夜', title: '竹取姬', kingdom: 'wei',
    cards: [{
      name: '',
      image: '立绘.jpg',
      cardImage: '新UI.竹取姬.辉夜.png',
      legendId: 'TH 001',
      skills: [
        { name: '初月', desc: '觉醒技，回合开始时，若你有至少1件「神宝」，你回复1点体力，选择一张「神宝」升级，获得【待宵】、【永远】。' },
        { name: '难题', desc: '锁定技，「神宝」离开你的区域时，将其移至你的手牌区；其他角色不能使用、打出或弃置「神宝」；其他角色的手牌上限-X（X为其拥有的「神宝」数量）。其他角色的出牌阶段，其可以将一张「神宝」移入你的手牌区，其与你获得1点护甲，你回复1点体力。每局游戏限一次，出牌阶段开始时，你可以选择一张「神宝」移入你的手牌（无论其在何处）。游戏开始时，将五张「神宝」洗入抽牌堆。' },
        { name: '永远', desc: '出牌阶段，你可以弃置3张牌并指定一名角色，其下个回合开始时，记录其区域内的牌；其下个回合结束时，将其区域恢复至记录状态。' },
        { name: '待宵', desc: '觉醒技，至少两件「神宝」：你回复1点体力，选择一张「神宝」升级，获得【朝靄】、【须臾】。', derived: true },
        { name: '须臾', desc: '出牌阶段，你可以弃置4张牌，指定一名角色（每回合每名角色限一次），其出牌阶段、弃牌阶段、结束阶段结束时，分别抽2/2/1张牌。', derived: true },
        { name: '朝靄', desc: '觉醒技，至少三件「神宝」：你回复1点体力，选择一张「神宝」升级，获得【拂晓】。', derived: true },
        { name: '拂晓', desc: '觉醒技，至少四件「神宝」：你回复1点体力，增加1点体力上限，选择一张「神宝」升级，获得【永夜归反 -破晓明星-】。', derived: true },
        { name: '永夜归反 -破晓明星-', desc: '觉醒技，至少五件「神宝」：你回复1点体力，增加1点体力上限，选择一张「神宝」升级，获得【永夜归反 -世间开明-】。', derived: true, fixNote: '描述.txt 写作「永夜归反 -破晓明星- 觉醒技，至少五件…」，按卡面应为「-破晓明星-」属于技能名。' },
        { name: '永夜归反 -世间开明-', desc: '出牌阶段限一次，重置所有「神宝」的效果计数。', derived: true, fixNote: '描述.txt 写作「永夜归反 -世间开明- 出牌阶段限一次…」，按卡面应为「-世间开明-」属于技能名。' },
      ],
      note: '觉醒链（每一步都是「回合开始时，若你有至少N件神宝」）：初月(1件) → 待宵(2件) → 朝靄(3件) → 拂晓(4件) → 永夜归反 -破晓明星-(5件) → 永夜归反 -世间开明-。\n注意：卡面上「拂晓」与「破晓」并存，但两者是同一技能（觉醒技「拂晓」获得【永夜归反 -破晓明星-】）。\n素材目录名为「蓬莱山辉夜」，游戏内武将名显示为「辉夜」。',
    }],
    treasures: [
      { name: '蓬莱的弹枝', desc: '锁定技，你使用【杀】无次数限制；每回合限一次，你使用【杀】时摸一张牌。（升级后：连距离也放开，且每回合限两次。）' },
      { name: '龙颈之玉', desc: '每回合限一次，你使用锦囊牌指定目标后，对其中一个目标造成1点伤害。（升级后：改为任意牌、且对全部目标生效。）' },
      { name: '燕的子安贝', desc: '每回合限一次，你可以令一名角色获得1点护甲。（升级后：改为令至多两名角色回复1点体力。）' },
      { name: '佛御石之钵', desc: '锁定技，你使用的【杀】不可被响应。（升级后：此【杀】造成的伤害+1。）' },
      { name: '火鼠的皮衣', desc: '锁定技，你受到的伤害改为1点；失去装备区里的它后，你回复1点体力。（升级后：连1点也改，并让伤害来源失去1点体力。）' },
    ],
  },

  黍: {
    kingdom: 'wei',
    cards: [{
      name: '',
      image: '立绘.png',
      cardImage: '',
      legendId: '',
      skills: [
        { name: '春种', desc: '出牌阶段限一次，你可以将一张基本牌扣置到在一名角色的武将牌上，称之为"种"，拥有"种"的角色回合开始时需将一张基本牌和此"种"当做"种"放置在相邻最近的两名角色武将牌上无你其他标记的武将牌上，否则此"种"翻面，称之为"禾"，并使你回复一点体力（"种"、"禾"的上限共用为 1）。' },
        { name: '秋收', desc: '持恒技。摸牌阶段，你可以移除场上任意张"禾"并摸等量张牌。你的手牌上限+x（x 为场上"禾"数量），你对有"禾"的武将打出牌无距离限制，拥有"禾"的角色与你计算距离+1。' },
        { name: '枯荣', desc: '锁定技。若你的回复的体力超出上限，你获得超出上限部分相应数量的护甲。回合开始时，若你的武将牌上有"禾"，你回复一点体力。' },
      ],
    }],
  },

  颉: {
    kingdom: 'wei',
    cards: [{
      name: '',
      image: '立绘.jpg',
      cardImage: '',
      legendId: '',
      skills: [
        { name: '正史', desc: '锁定技，游戏开始时，你获得一枚"史"。每有一张装备牌进入弃牌区/一名角色死亡或脱离濒死/一名角色使用限定技，你获得一枚"史"。你可以弃置一枚"史"，从弃牌区中选择一张非装备牌并装备之，若如此做，你翻开牌堆顶的一张牌，若为装备牌，你将其交给一名其他角色，否则将其扣置在你的武将牌上，称之为"损"。' },
        { name: '书刀', desc: '持恒技，游戏开始时，你的武器区视为装备区视为装备着一把不可被移除的"书刀"（装备牌，攻击距离 2，当你使用牌指定一名玩家时，你可选择一项：使此牌对其无效，并选择移除目标的一个装备区/弃置一枚"史"，使此牌不可被响应）。' },
        { name: '明哲', desc: '使命技，成功：若你先拥有 x 张"史"（x 为场上人数），你获得"保身"（若弃牌区有一张与被使用牌花色、牌名均相同的牌，你可以弃置一张"史"，使其无效并进入弃牌区）。失败：若你先拥有五张"损"，你立即失去所有体力。' },
        { name: '诀别', desc: '锁定技。当你进入濒死时，当前角色回合立即结束，你不可成为任意牌指定的目标，且维持濒死状态直至你的下个回合结束，若你以此法死亡，你可将"书刀"置于任何一名玩家的武将牌上，且使其获得所有"史"并获得"制私"（出牌阶段限一次，你可以视为装备着书刀打出一张牌，若如此做，你展示所有手牌）。' },
      ],
      note: '「书刀」参考孙悟空实现，书刀为武器牌，插图位于同目录下（书刀.jpg）。',
    }],
  },
};

/** 描述.txt 里的技能名 → 卡面上的技能名（差异记录） */
const SKILL_ALIAS = {
  '读心妖怪': '读心',
  '读心': '读心',
};

/** 辉夜的神宝（衍生装备牌）：素材中「神器图标」是升级前，宝物卡图是升级后 */
const SHENBAO = [
  { name: '蓬莱的弹枝', upgraded: '蓬莱的玉枝', icon: '蓬莱的弹枝.png', card: '蓬莱的玉枝.♥.A.png' },
  { name: '龙颈之玉', upgraded: '耀眼的龙玉', icon: '龙颈之玉.png', card: '耀眼的龙玉.♠.K.png' },
  { name: '燕的子安贝', upgraded: '无限的生命之泉', icon: '燕的子安贝.png', card: '无限的生命之泉.♦.K.png' },
  { name: '佛御石之钵', upgraded: '佛体的金刚石', icon: '佛御石之钵.png', card: '佛体的金刚石.♣.K.png' },
  { name: '火鼠的皮衣', upgraded: '火蜥蜴之盾', icon: '火鼠的皮衣.png', card: '火蜥蜴之盾.♥.K.png' },
];

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

function normalize(s) {
  return String(s ?? '').replace(/[\u200b-\u200f\ufeff\u2060]/g, '');
}

/** 去掉隐藏字符并保留原始文件名（读写文件必须用原始名） */
function scanFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    const raw = e.name;
    const clean = normalize(raw);
    const abs = path.join(dir, raw);
    let size = 0;
    try { if (e.isFile()) size = fs.statSync(abs).size; } catch { /* ignore */ }
    return { raw, clean, abs, isDir: e.isDirectory(), size };
  });
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac)$/i;

function isCardImage(clean) {
  return /^新UI\./.test(clean) || /-原画\.(png|jpe?g|webp)$/i.test(clean);
}
function isPortraitImage(clean) {
  return /^立绘/.test(clean);
}

/** 从文件名里取「卡名.武将名」中的卡名 */
function cardNameFromFile(clean) {
  const m = clean.match(/^新UI\.(.+?)\.[^.]+\.(png|jpe?g|webp)$/i);
  return m ? m[1] : '';
}

/** 技能名归一化：统一括号、去掉首尾空白 */
function normSkillName(s) {
  return String(s ?? '')
    .replace(/^[【\[]|[】\]]$/g, '')
    .trim();
}

/**
 * 技能描述原文清洗：只规范换行和两端空白。
 *
 * 为什么不做自动加粗：早期版本会把「准备阶段」这类词无条件包成 ，
 * 结果「直到你的下个准备阶段，此技能失效」被误伤成「下个准备阶段」。
 * 关键词高亮改由网页渲染层做，数据层只保存忠实原文；
 * 已经带  的文本（来自 .shap 或人工订正）原样保留。
 */
function boldify(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/* ------------------------------------------------------------------ *
 * 解析 描述.txt
 * ------------------------------------------------------------------ */

const SKILL_NAME_RE = /^[【\[]([^】\]]{1,10})[】\]]\s*(.*)$/;
const INLINE_SKILL_RE = /^([\u4e00-\u9fa5·]{1,6})\s*[:：]\s*(.*)$/;

/** 技能描述里常见的特征词——用来识别「技能名 描述」这种没有分隔符的写法 */
const DESC_HINT_RE = /(技|阶段|你可以|当你|你使用|你受到|限一次|限两次|锁定|觉醒|限定|转换|使命|主公|每回合|每轮|游戏开始|回合开始|回合结束|视为|获得|弃置|摸|体力|伤害|角色)/;

/**
 * 判断一行是不是「武将基本信息头」，例如：
 *   「藿藿 女 三血 魏势力 称号：令奉贞凶」
 *   「陈 四血 女 魏势力 称号 龙门警司」
 *   「涤火杰西卡 女 流泪猫猫头 三血群势力 主公」
 * 只有第 1 行（最多前 2 行）才可能是头，且必须同时出现「体力写法」和「性别/势力/称号」等标志。
 */
function isHeaderLine(l) {
  if (SKILL_NAME_RE.test(l)) return false;
  const hasHp = /(?:^|[\s，,])(?:[一二两三四五六七八九十\d]+)\s*(?:血|上限)/.test(l) || /上限\s*[一二两三四五六七八九十\d]+\s*血/.test(l);
  const hasFlag = /(?:女|男)\s|势力|称号|主公/.test(l);
  return hasHp && hasFlag;
}

function parseDescTxt(text, folderName) {
  const clean = normalize(text).replace(/\r\n?/g, '\n');
  const lines = clean.split('\n');

  const result = { name: '', gender: '', hp: null, maxHp: null, shield: 0, kingdom: '', title: '', skills: [], notes: [], raw: clean };

  // ---- 1. 头部行 ----
  let headerLines = 0;
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (!isHeaderLine(l)) break;
    headerLines = i + 1;

    // 体力：三血 / 3血 / 六上限两血一甲 / 四血
    const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const toNum = (s) => (/^\d+$/.test(s) ? Number(s) : (CN_NUM[s] ?? null));

    let m;
    if ((m = l.match(/([一二两三四五六七八九十\d]+)\s*上限\s*([一二两三四五六七八九十\d]+)\s*血/))) {
      result.maxHp = toNum(m[1]);
      result.hp = toNum(m[2]);
    } else {
      // 「均 三血女 三血 称号」这种重复写法取最后一个
      const all = [...l.matchAll(/(?:^|[\s，,])([一二两三四五六七八九十\d]+)\s*血(?![力上])/g)];
      if (all.length) {
        const v = toNum(all[all.length - 1][1]);
        result.hp = v;
        result.maxHp = v;
      }
    }
    if ((m = l.match(/([一二两三四五六七八九十\d]+)\s*甲/))) result.shield = toNum(m[1]) ?? 0;
    if (/主公/.test(l)) result.isLord = true;
    if (/(?:^|\s)女(?:\s|势力|$)/.test(l)) result.gender = '女';
    if (/(?:^|\s)男(?:\s|势力|$)/.test(l)) result.gender = '男';
    if ((m = l.match(/称号\s*[:：]?\s*([^\s，,]*)/))) {
      const t = m[1].replace(/^（留空）$/, '');
      if (t && !/^(?:\d+血|女|男)$/.test(t)) result.title = t;
    }
    if ((m = l.match(/(魏|蜀|吴|群|晋|神|妖|魂)势力/)) || (m = l.match(/(?:^|\s)(魏|蜀|吴|群|晋|神|妖|魂)(?:\s|血|$)/))) {
      result.kingdom = KINGDOM_CODE[m[1]] ?? '';
    }
    // 武将名：第一段
    if (!result.name) {
      const first = l.split(/[\s，,]+/)[0];
      if (first && !/^\d/.test(first)) result.name = first;
    }
  }

  // 文件夹名兜底
  if (!result.name) result.name = folderName;

  // ---- 2. 技能段落 ----
  const body = lines.slice(headerLines);
  let cur = null;
  const push = (skill) => {
    if (skill && skill.name) result.skills.push(skill);
  };

  for (const rawLine of body) {
    const line = rawLine.trim();
    if (!line) {
      if (cur) cur.desc += '\n';
      continue;
    }
    // 整行是「（xxx）」的说明
    if (/^[（(].*[）)]$/.test(line)) { result.notes.push(line.replace(/^[（(]|[）)]$/g, '')); continue; }

    let m;
    if ((m = line.match(SKILL_NAME_RE))) {
      push(cur);
      cur = { name: normSkillName(m[1]), desc: m[2] ? m[2].trim() : '', derived: false };
      continue;
    }
    if ((m = line.match(INLINE_SKILL_RE)) && m[1].length <= 6 && !/^https?$/.test(m[1])) {
      push(cur);
      cur = { name: normSkillName(m[1]), desc: m[2].trim(), derived: false };
      continue;
    }
    // 「技能名 描述」——没有分隔符，靠「2~6 个字 + 空格 + 描述特征词」认
    if ((m = line.match(/^([\u4e00-\u9fa5·]{2,6})\s+(.*)$/)) && DESC_HINT_RE.test(m[2])) {
      push(cur);
      cur = { name: normSkillName(m[1]), desc: m[2].trim(), derived: false };
      continue;
    }
    // 独立成行的技能名（描述在后续行）；只在「上一条已有描述」时才开新技能，避免误切
    if (/^[\u4e00-\u9fa5·]{2,6}$/.test(line)) {
      if (!cur || cur.desc.trim()) {
        push(cur);
        cur = { name: normSkillName(line), desc: '', derived: false };
      }
      continue;
    }
    if (cur) {
      cur.desc += (cur.desc && !cur.desc.endsWith('\n') ? '\n' : '') + line;
    } else {
      result.notes.push(line);
    }
  }
  push(cur);

  // 清洗
  result.skills = result.skills
    .map((s) => ({ ...s, desc: s.desc.replace(/\n{2,}/g, '\n').replace(/\n+$/, '').trim() }))
    .filter((s) => s.name);
  result.notes = result.notes.filter((n) => !/^语音|素材中随机|语音均为/.test(n));
  return result;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function listFolders() {
  const out = [];
  for (const e of scanFiles(ASSETS)) {
    if (!e.isDir) continue;
    const manual = MANUAL[e.clean];
    if (manual === null || manual?.skip) continue;
    // 下划线开头的目录本身不是武将，只扫描它下面的武将子目录
    if (/^_/.test(e.clean)) {
      for (const sub of scanFiles(e.abs)) {
        if (!sub.isDir) continue;
        const subKey = `${e.clean}/${sub.clean}`;
        const sm = MANUAL[subKey];
        if (sm === null || sm?.skip) continue;
        out.push({ key: subKey, dir: sub.abs });
      }
      continue;
    }
    out.push({ key: e.clean, dir: e.abs });
  }
  return out;
}

function readShap(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j.baseInfo ? j.baseInfo : null;
  } catch (err) {
    console.warn(`  ! .shap 解析失败：${path.basename(file)} — ${err.message}`);
    return null;
  }
}

/** 收集一个武将文件夹里所有可用素材 */
function collectAssets(dir) {
  const files = scanFiles(dir).filter((f) => !f.isDir);
  const images = files.filter((f) => IMAGE_EXT.test(f.clean));
  const soundRecords = files.filter((f) => AUDIO_EXT.test(f.clean));
  const cardImages = images.filter((f) => isCardImage(f.clean));
  const portraits = images.filter((f) => isPortraitImage(f.clean));
  const others = images.filter((f) => !isCardImage(f.clean) && !isPortraitImage(f.clean));
  const shaps = files.filter((f) => /\.shap$/i.test(f.clean));

  // 语音：按去掉序号/空格后的名字分组
  const soundMap = new Map();
  for (const s of soundRecords) {
    const base = s.clean.replace(/\.(mp3|wav|ogg|m4a|flac)$/i, '').replace(/[\s_]*\(?\d*\)?$/, '').replace(/[\s_]*(cn_)?\d+$/i, '').trim();
    if (!soundMap.has(base)) soundMap.set(base, []);
    soundMap.get(base).push(s.raw);
  }

  return {
    all: files,
    cardImages,
    portraits,
    others,
    shaps,
    sounds: [...soundMap.entries()].map(([name, list]) => ({ name, files: list })),
  };
}

function buildCharacter(folder) {
  // 订正表既支持完整 key（有归类目录时写作 _归类/觉），也支持只用目录名（觉）
  const manual = MANUAL[folder.key] ?? MANUAL[folder.key.split('/').pop()] ?? {};
  const assets = collectAssets(folder.dir);

  // ---- 选主 .shap ----
  const ignored = new Set((manual.ignoreShap ?? []).map(normalize));
  const usableShaps = assets.shaps.filter((s) => !ignored.has(s.clean));
  let primary = null;
  for (const s of usableShaps) {
    const bi = readShap(s.abs);
    if (bi && (bi.skills?.length ?? 0) > 0) {
      if (!primary || (bi.skills.length > (primary.bi.skills?.length ?? 0))) primary = { file: s, bi };
    }
  }

  const descFile = assets.all.find((f) => /^描述\.txt$/i.test(f.clean));
  const desc = descFile ? parseDescTxt(fs.readFileSync(descFile.abs, 'utf8'), folder.key) : null;

  // ---- 基本信息 ----
  const bi = primary?.bi ?? {};
  // 势力：人工订正 > .shap > 描述.txt（归一化函数返回 '' 而不是 null，所以不能用 ??）
  const kingdom = manual.kingdom || normalizeKingdom(bi.kingdom) || normalizeKingdom(desc?.kingdom) || '';
  const info = {
    name: manual.name ?? bi.name ?? desc?.name ?? folder.key,
    title: manual.title ?? bi.title ?? desc?.title ?? '',
    kingdom,
    hp: manual.hp ?? bi.hp ?? desc?.hp ?? null,
    maxHp: manual.maxHp ?? bi.maxHp ?? desc?.maxHp ?? null,
    shield: manual.shield ?? bi.shield ?? desc?.shield ?? 0,
    gender: manual.gender ?? desc?.gender ?? '',
    quality: bi.quality ?? 'epic',
    legendId: manual.legendId ?? bi.legendId ?? '',
    quote: (bi.quote ?? '').replace(/\s+$/g, '').trim(),
    copyright: bi.copyright ?? '',
    isLord: manual.isLord ?? desc?.isLord ?? (bi.masterFlag ? true : false),
  };

  // 体力为 null 时给个兜底显示
  if (info.hp == null) info.hp = 3;
  if (info.maxHp == null) info.maxHp = info.hp;

  // ---- 卡面 ----
  let cards = [];
  if (manual.cards) {
    cards = manual.cards.map((c) => {
      const img = c.image ? assets.all.find((f) => f.clean === c.image) : null;
      const cardImg = c.cardImage ? assets.all.find((f) => f.clean === c.cardImage) : null;
      const shapFile = c.shap ? assets.all.find((f) => f.clean === c.shap) : null;
      const cbi = shapFile ? readShap(shapFile.abs) : null;

      let skills;
      if (c.skills) {
        // 人工逐条订正过的技能表（最权威）
        skills = c.skills.map((s) => ({
          name: s.name,
          desc: boldify(s.desc ?? ''),
          derived: !!s.derived,
          ...(s.fixNote ? { fixNote: s.fixNote } : {}),
        }));
      } else if (cbi?.skills) {
        skills = cbi.skills.map((s) => ({ name: s.name, desc: boldify(s.desc), derived: false }));
      } else {
        skills = [];
      }

      const derived = Array.isArray(c.derived) && c.derived.length
        ? c.derived
        : skills.filter((s) => s.derived).map((s) => s.name);

      // 主图：MANUAL 指定的优先；否则按卡面挑立绘
      let imgFile = img;
      if (!imgFile && assets.portraits.length) {
        imgFile = pickPortrait(assets.portraits, c, manual.cards.length) ?? null;
      }

      return {
        name: c.name ?? '',
        image: imgFile?.raw ?? '',
        cardImage: cardImg?.raw ?? '',
        legendId: c.legendId ?? cbi?.legendId ?? info.legendId,
        skills,
        derived,
        note: c.note ?? '',
      };
    });
  } else if (primary) {
    // 直接用 .shap 里的技能表
    const skills = (primary.bi.skills ?? []).map((s) => ({
      name: s.name,
      desc: boldify(s.desc),
      derived: false,
    }));
    cards = [{
      name: '',
      image: '',
      cardImage: assets.cardImages[0]?.raw ?? '',
      legendId: primary.bi.legendId ?? info.legendId,
      skills,
      derived: [],
      note: '',
    }];
  } else if (desc) {
    // 只有 描述.txt：技能表来自解析结果
    cards = [{
      name: '',
      image: '',
      cardImage: '',
      legendId: '',
      skills: desc.skills.map((s) => ({
        name: SKILL_ALIAS[s.name] ?? s.name,
        desc: boldify(s.desc),
        derived: /衍生技|衍生/.test(s.desc.slice(0, 30)),
      })),
      derived: [],
      note: '',
    }];
  } else {
    cards = [{ name: '', image: '', cardImage: '', legendId: '', skills: [], derived: [], note: '' }];
  }

  // 主图：优先无技能卡图（立绘），其次带技能卡图，都没有则留空（网页显示占位符）
  for (const card of cards) {
    if (card.image) continue; // 已在 MANUAL 里指定
    const portrait = pickPortrait(assets.portraits, card, cards.length);
    if (portrait) card.image = portrait.raw;
  }

  // ---- 素材库 ----
  const gallery = assets.all
    .filter((f) => IMAGE_EXT.test(f.clean) || AUDIO_EXT.test(f.clean))
    .map((f) => ({
      file: f.raw,
      kind: AUDIO_EXT.test(f.clean) ? 'audio' : (isCardImage(f.clean) ? 'card' : isPortraitImage(f.clean) ? 'portrait' : 'icon'),
      size: f.size,
    }));

  // ---- 备注：人工订正 + 描述.txt 里的旁注 + 卡面上的备注 ----
  //
  // 做法：先把所有来源的行摊平，再按行合并去重。
  // 之前想按「整段」判重，但描述.txt 的写法太多样（整段、逐行、末尾重抄、全角括号、
  // 结尾多一个句号……），不如摊平成行后逐行比，简单而且不会误删。
  const noteLines = [];
  const normNote = (s) => String(s ?? '')
    .replace(/^[（(【\[]+|[）)】\]]+$/g, '')     // 整行被括号包住的旁注
    .replace(/（/g, '(').replace(/）/g, ')')     // 全角括号统一
    .replace(/[。．.]$/, '')                     // 结尾句号不该影响判重
    .replace(/[\s，。；、,.!?！？:：]/g, '');

  const pushNote = (s) => {
    for (const raw of String(s ?? '').split('\n')) {
      const t = raw.trim();
      if (!t) continue;
      const key = normNote(t);
      if (!key) continue;
      // 完全重复，或某条是另一条的近似子集（描述.txt 常把同一句加几个字重抄）
      const dup = noteLines.some((line) => {
        const k = normNote(line);
        if (k === key) return true;
        const [a, b] = k.length >= key.length ? [k, key] : [key, k];
        return a.includes(b) && Math.abs(a.length - b.length) <= 30;
      });
      if (dup) continue;
      noteLines.push(t);
    }
  };

  pushNote(manual.note);
  for (const n of desc?.notes ?? []) pushNote(n);
  // 卡面上的备注（如「语音均为素材中随机」）也提到顶层，避免只挂在某一张卡上
  for (const c of cards) pushNote(c.note);
  const note = noteLines.join('\n');

  // ---- 原作 与 标签 ----
  // 原作（origin）与特性标签（tags）分开存：
  //   原作 = 这个武将出自哪部作品，一个武将只能有一个
  //   标签 = 玩法特性（过牌 / 输出 / 减益 / 增益…），可以有多个
  // 势力另外用 kingdom 表达，侧栏有独立的势力筛选。
  const origin = manual.origin ?? SERIES[(info.legendId || '').split(/\s+/)[0]] ?? '';
  const { tags } = splitOriginFromTags(manual.tags, origin);

  // ---- 额外内容（辉夜的神宝）----
  let extras = [];
  if (folder.key === '蓬莱山辉夜') {
    const baoDir = path.join(ASSETS, '宝物卡图');
    const baoFiles = fs.existsSync(baoDir) ? scanFiles(baoDir) : [];
    const treasureDesc = new Map((manual.treasures ?? []).map((t) => [t.name, t]));
    extras = [{
      title: '神宝（衍生装备牌）',
      kind: 'treasure',
      note: '十张衍生装备牌。五件宝物各有升级前后两个形态：素材里「神器图标」是升级前形态（灰度泛黄），`宝物卡图\\` 下的成品卡图是升级后形态。',
      items: SHENBAO.map((sb) => {
        const icon = assets.all.find((f) => f.clean === sb.icon);
        const card = baoFiles.find((f) => f.clean === sb.card);
        const cardName = card ? card.clean.replace(/\.[^.]*$/, '') : sb.upgraded;
        const m = cardName.match(/^(.*?)\.(.+?)$/);
        return {
          name: sb.name,
          upgradedName: sb.upgraded,
          image: card ? path.posix.join('..', '宝物卡图', card.raw) : '',
          icon: icon ? icon.raw : '',
          suit: m ? m[2] : '',
          desc: boldify(treasureDesc.get(sb.name)?.desc ?? ''),
        };
      }),
    }];
  }

  return {
    schema: 1,
    id: folder.key,
    dir: folder.key,
    ...info,
    origin,
    tags,
    note,
    cards,
    extras,
    gallery,
    sounds: assets.sounds,
    source: {
      shap: primary ? primary.file.raw : '',
      descTxt: descFile ? descFile.raw : '',
      importedAt: new Date().toISOString(),
      importer: 'scripts/import.mjs',
    },
  };
}

/** 挑选立绘作为无技能卡图 */
function pickPortrait(portraits, card, cardCount) {
  if (!portraits.length) return null;
  // 多卡面：按名字末尾的序号或名称匹配（结城理 / 塔露拉 / 普瑞赛斯）
  if (cardCount > 1) {
    const idx = card.name.match(/[①②③④⑤]/)?.[0];
    if (idx) {
      const n = '①②③④⑤'.indexOf(idx) + 1;
      const hit = portraits.find((p) => new RegExp(`_${n}(\\D|$)`).test(p.clean)) || portraits[n - 1];
      if (hit) return hit;
    }
    if (/觉醒前/.test(card.name)) return portraits.find((p) => /觉醒前/.test(p.clean)) ?? portraits[0];
    if (/觉醒后/.test(card.name)) return portraits.find((p) => /觉醒后/.test(p.clean)) ?? null;
    const n = card.name.match(/[①②③]/)?.[0];
    if (n) {
      const ord = '①②③'.indexOf(n) + 1;
      const hit = portraits.find((p) => new RegExp(`_${ord}(\\D|$)`).test(p.clean));
      if (hit) return hit;
    }
  }
  // 单卡面：优先不带 _2 后缀的
  const plain = portraits.find((p) => !/_\d+\./.test(p.clean));
  return plain ?? portraits[0];
}

function main() {
  if (!fs.existsSync(ASSETS)) {
    console.error(`找不到素材目录：${ASSETS}`);
    process.exit(1);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const folders = listFolders();
  const results = [];
  const warnings = [];

  for (const folder of folders) {
    const char = buildCharacter(folder);
    const cardDir = folder.dir;
    const jsonPath = path.join(cardDir, '武将.json');
    const exists = fs.existsSync(jsonPath);

    // 清掉 undefined 的 null 占位（MANUAL 里写错的键）
    results.push({ folder, char, jsonPath, exists });

    const nSkills = char.cards.reduce((a, c) => a + c.skills.length, 0);
    if (nSkills === 0) warnings.push(`${folder.key}：没有解析到任何技能`);
    if (!char.cards.some((c) => c.image)) warnings.push(`${folder.key}：没有可用的无技能卡图（将显示占位符）`);

    if (DRY) continue;
    if (exists && !FORCE) continue;
    fs.writeFileSync(jsonPath, JSON.stringify(char, null, 2) + '\n', 'utf8');
  }

  // ---- 汇总 ----
  console.log(`\n素材目录：${ASSETS}`);
  console.log(`武将数：${results.length}${DRY ? '（--dry，未写文件）' : ''}\n`);
  console.log('武将'.padEnd(14) + '称号'.padEnd(12) + '势力  体力  卡面  技能  主图');
  console.log('-'.repeat(96));
  for (const { char, exists } of results) {
    const nSkills = char.cards.reduce((a, c) => a + c.skills.length, 0);
    const main = char.cards[0]?.image || (char.cards[0]?.cardImage ? '(带技能图)' : '—');
    console.log(
      String(char.name).padEnd(12) +
      String(char.title || '—').padEnd(10) +
      String(char.kingdom || '—').padEnd(5) +
      `${char.hp}/${char.maxHp}${char.shield ? '+' + char.shield : ''}`.padEnd(7) +
      String(char.cards.length).padEnd(6) +
      String(nSkills).padEnd(6) +
      main + (exists ? '  [已存在]' : '')
    );
  }

  if (warnings.length) {
    console.log('\n注意：');
    for (const w of warnings) console.log('  · ' + w);
  }
  console.log(`\n共 ${results.length} 位武将，${results.reduce((a, r) => a + r.char.cards.length, 0)} 张卡面。`);
}

export { parseDescTxt, MANUAL, SHENBAO, boldify, normalize, normalizeKingdom, splitOriginFromTags, ORIGINS, SERIES };

// 只有「直接执行本文件」时才跑导入流程；
// 被 check-migration.mjs 之类 import 时不能跑，否则会顺手改文件。
const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) main();
