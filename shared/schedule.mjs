// The four daily checkpoints. The Claude Code routines must be scheduled at these
// times; the Worker watchdog and the status page use them to spot a check that never ran.
//
// runDayOffset: the check runs this many days relative to the commute day it is about
// (the night check runs the evening before).

export const CHECKS = [
  { mode: 'night', label: '睡前检查', question: '明天要不要定早闹钟？', time: '21:30', runDayOffset: -1 },
  { mode: 'wake', label: '起床检查', question: '要不要起来准备？', time: '05:37', runDayOffset: 0 },
  { mode: 'leave', label: '出门检查', question: '要不要出门？', time: '06:17', runDayOffset: 0 },
  { mode: 'enroute', label: '船上检查', question: '到 SF 后 Muni 能不能坐？', time: '06:57', runDayOffset: 0 },
];

export const MODES = CHECKS.map((c) => c.mode);

export const checkByMode = (mode) => CHECKS.find((c) => c.mode === mode);

/** Minutes after the scheduled time before a missing check counts as "didn't run". */
export const GRACE_MINUTES = 15;

export const DEFAULT_WORKDAYS = [1, 2, 3, 4, 5];

export const LEVELS = ['green', 'yellow', 'red', 'skip'];

export const LEVEL_LABEL = { green: '🟢 正常', yellow: '🟡 注意', red: '🔴 别去', skip: '⚪ 跳过' };
