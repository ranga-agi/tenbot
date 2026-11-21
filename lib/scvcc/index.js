/**
 * Silver Creek Valley Country Club (SCVCC) Court Booking & Availability Engine
 *
 * Integrates with SCVCC's Clubessential portal to:
 * 1. Query real-time court status & availability (Tennis Courts 1-6 & Pickleball Courts).
 * 2. Book courts on-demand with custom date, time, court selection, players, and party size.
 * 3. List active upcoming member reservations.
 * 4. Cancel & modify court reservations.
 */

const facade = require('./facade');
const { getScvccHost, getScvccUrls } = require('./config');
const { authenticate, authFetch } = require('./auth');
const {
  resolveDateToMDY,
  formatDisplayDate,
  normalizeGridTime,
  formatCourtLabel,
  getDirectCourtBookingAccounts,
  isIgnoredCourt,
  isDirectBookingUser,
  formatPlayerNameFirstLast,
  isPlaceholderPlayer,
  getPlayerShortName,
  matchScvccPlayerToGroupMember,
  detectPrebookedCourt,
  detectClubClosed,
  buildBookingSummaryMessage
} = require('./utils');
const {
  parseCourtsCommand,
  parseBookCourtCommand,
  parseModifyCourtCommand,
  parseBookingsCommand
} = require('./parsers');
const {
  parseCourtGridHtml,
  calculateAvailabilityDuration,
  checkCourtAvailability,
  getCourtBookings,
  getMyReservations
} = require('./sheet');
const {
  searchPlayerOnScvcc,
  cancelCourtReservation,
  modifyCourtBooking,
  bookCourt
} = require('./booking');
const {
  getCourtWebcamConfig,
  getCourtWebcamSnapshot,
  getCourtWebcamClip,
  resolveIpcamliveStreamUrl,
  resolveCourtHlsUrl
} = require('./webcam');

const scvccApi = {
  searchPlayerOnScvcc,
  cancelCourtReservation,
  modifyCourtBooking,
  parseModifyCourtCommand,
  formatCourtLabel,
  getScvccHost,
  getScvccUrls,
  authenticate,
  authFetch,
  parseCourtGridHtml,
  checkCourtAvailability,
  calculateAvailabilityDuration,
  bookCourt,
  getMyReservations,
  parseCourtsCommand,
  parseBookCourtCommand,
  getCourtBookings,
  parseBookingsCommand,
  resolveDateToMDY,
  formatDisplayDate,
  detectPrebookedCourt,
  detectClubClosed,
  isIgnoredCourt,
  isDirectBookingUser,
  getDirectCourtBookingAccounts,
  matchScvccPlayerToGroupMember,
  isPlaceholderPlayer,
  formatPlayerNameFirstLast,
  getPlayerShortName,
  normalizeGridTime,
  buildBookingSummaryMessage,
  getCourtWebcamConfig,
  getCourtWebcamSnapshot,
  getCourtWebcamClip,
  resolveIpcamliveStreamUrl,
  resolveCourtHlsUrl
};

facade.bindTarget(scvccApi);

module.exports = scvccApi;
