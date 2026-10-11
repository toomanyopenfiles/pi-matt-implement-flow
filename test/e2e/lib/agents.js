'use strict';
// ============================================================================
// 三个 agent 的运行时全名与角色判定（票 35 的单一来源）。
//
// 场景定义、轨迹采集与判定器都从这里取名字，不各写一份——名字写错会让「派了谁」
// 的判定静默失效。角色判定只认注册时的全名（含包前缀）。
// ============================================================================

const CODER = 'pi-matt-implement-flow.coder';
const REVIEWER = 'pi-matt-implement-flow.reviewer';
const FINAL = 'pi-matt-implement-flow.final-reviewer';

const isCoder = (agent) => agent === CODER || /\.coder$/.test(agent || '');
const isReviewer = (agent) => agent === REVIEWER || /\.reviewer$/.test(agent || '');
const isFinal = (agent) => agent === FINAL || /\.final-reviewer$/.test(agent || '');

module.exports = { CODER, REVIEWER, FINAL, isCoder, isReviewer, isFinal };
