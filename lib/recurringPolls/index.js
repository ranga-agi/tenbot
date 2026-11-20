/**
 * Recurring Polls module: manages creation, listing, cancellation, pausing,
 * modification, and automatic posting of recurring tennis match polls.
 */

const facade = require('./facade');
const dates = require('./dates');
const parsers = require('./parsers');
const schedules = require('./schedules');
const instances = require('./instances');
const scheduler = require('./scheduler');

const recurringPollsApi = {
  DAY_NAMES: dates.DAY_NAMES,
  DAY_LOOKUP: dates.DAY_LOOKUP,
  parseSinglePostConfig: dates.parseSinglePostConfig,
  parseDaysOfWeek: dates.parseDaysOfWeek,
  formatDaysResult: dates.formatDaysResult,
  extractDaysFromText: dates.extractDaysFromText,
  parsePostTimes: dates.parsePostTimes,
  getPostTimeForSchedule: dates.getPostTimeForSchedule,
  extractCommonFlags: parsers.extractCommonFlags,
  parseRecurringPollText: parsers.parseRecurringPollText,
  scheduleRecurringPoll: schedules.scheduleRecurringPoll,
  modifyRecurringPoll: schedules.modifyRecurringPoll,
  listRecurringPolls: schedules.listRecurringPolls,
  getRecurringPollStatus: schedules.getRecurringPollStatus,
  cancelRecurringPoll: schedules.cancelRecurringPoll,
  clearAllRecurringPolls: schedules.clearAllRecurringPolls,
  cancelAllRecurringPolls: schedules.clearAllRecurringPolls,
  pauseRecurringPoll: schedules.pauseRecurringPoll,
  resumeRecurringPoll: schedules.resumeRecurringPoll,
  getNextInstanceDate: dates.getNextInstanceDate,
  skipRecurringPollInstance: instances.skipRecurringPollInstance,
  unskipRecurringPollInstance: instances.unskipRecurringPollInstance,
  extractOverrideSlotsArgs: parsers.extractOverrideSlotsArgs,
  overrideRecurringPollInstanceSlots: instances.overrideRecurringPollInstanceSlots,
  isPollCreatedForMatchDate: scheduler.isPollCreatedForMatchDate,
  detectManualPlayerBookings: scheduler.detectManualPlayerBookings,
  checkAndExecuteAdvanceBookings: scheduler.checkAndExecuteAdvanceBookings,
  checkAndPostRecurringPolls: scheduler.checkAndPostRecurringPolls,
  formatRecurringScheduleCard: schedules.formatRecurringScheduleCard,
  parseDateToDateKey: dates.parseDateToDateKey,
  extractPauseArgs: parsers.extractPauseArgs,
  extractSkipArgs: parsers.extractSkipArgs,
  getUpcomingInstanceDates: dates.getUpcomingInstanceDates,
  simulateRecurringPoll: scheduler.simulateRecurringPoll,
  pruneExpiredAdvanceBookings: scheduler.pruneExpiredAdvanceBookings,
  normalizeCourtList: dates.normalizeCourtList,
  normalizePollTitle: dates.normalizePollTitle,
  isCourtSkipped: dates.isCourtSkipped,
  overrideRecurringPollInstanceCourtSkip: instances.overrideRecurringPollInstanceCourtSkip
};

facade.bindTarget(recurringPollsApi);

module.exports = recurringPollsApi;
