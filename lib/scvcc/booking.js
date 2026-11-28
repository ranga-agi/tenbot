/**
 * SCVCC Court Booking, Modification & Cancellation Operations
 * Handles Clubessential MakebookingTime RadAjax dialogs, player search,
 * administrative overrides, and reservation mutations.
 */

const namesStore = require('../names');
const groupsConfig = require('../groupsConfig');
const { getScvccUrls, COURT_RESOURCE_IDS } = require('./config');
const { authFetch } = require('./auth');
const { checkCourtAvailability } = require('./sheet');
const facade = require('./facade');
const {
  resolveDateToMDY,
  formatDisplayDate,
  normalizeGridTime,
  formatCourtLabel,
  isIgnoredCourt,
  formatPlayerNameFirstLast,
  isMemberMatch,
  detectClubClosed
} = require('./utils');

const GUEST_TBA_PLAYER = {
  name: 'Guest TBA',
  id: '-1_Guest',
  type: 'genericGuest'
};

/**
 * Extracts ASP.NET hidden fields from dialog HTML.
 */
function extractFormFields(html) {
  const fields = {};
  const inputMatches = html.match(/<input[^>]+>/gi) || [];
  for (const inp of inputMatches) {
    if (/type=["']?(?:submit|button)["']?/i.test(inp)) continue;
    const nameMatch = inp.match(/name=["']([^"']+)["']/i);
    const valMatch = inp.match(/value=["']([^"']*)["']/i);
    if (nameMatch) {
      fields[nameMatch[1]] = valMatch ? valMatch[1] : '';
    }
  }
  return fields;
}

function readDialogField(fields, html, fieldName) {
  if (fields && fields[fieldName] !== undefined && fields[fieldName] !== '') {
    return fields[fieldName];
  }
  const escaped = fieldName.replace(/\$/g, '\\$');
  return html.match(new RegExp(`name=["']${escaped}["'][^>]*value=["']([^"']+)["']`, 'i'))?.[1]
    || html.match(new RegExp(`value=["']([^"']+)["'][^>]*name=["']${escaped}["']`, 'i'))?.[1];
}

function parseScvccDurationMinutes(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  const hrMinMatch = s.match(/(\d+)\s*(?:hr|hrs|hour|hours)\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?/i);
  if (hrMinMatch) {
    return parseInt(hrMinMatch[1], 10) * 60 + (hrMinMatch[2] ? parseInt(hrMinMatch[2], 10) : 0);
  }
  const numMatch = s.match(/(\d+)/);
  return numMatch ? parseInt(numMatch[1], 10) : null;
}

/**
 * Searches for a player/member on SCVCC using the Member/Guest autocomplete web service.
 */
async function searchPlayerOnScvcc(playerName, memberId = '8916615', chatId = null) {
  if (!playerName) return null;
  const urls = getScvccUrls(chatId);
  const filterUrl = `${urls.host}/a_master/net/ResourceBookingMgr/booking/bookingwindows/PlayerWebService.asmx/FilterPeople`;
  try {
    const res = await (facade.call('authFetch', authFetch))(filterUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': `${urls.dialogUrl}?p=rbmPop&tt=MakebookingTime`
      },
      body: JSON.stringify({
        context: {
          Text: playerName,
          FilterString: playerName,
          NumberOfItems: 0,
          buddiesFilter: false,
          guestsFilter: false,
          guestParents: `${memberId},`
        }
      })
    }, 1, chatId);

    if (!res.ok) return null;
    const data = await res.json();
    if (data?.d?.Items?.length > 0) {
      const memberItem = data.d.Items.find(it => it.Attributes?.pType === 'Member');
      if (memberItem) {
        return {
          name: memberItem.Attributes.DisplayName || memberItem.Attributes.Name || playerName,
          id: memberItem.Value,
          uid: memberItem.Attributes.UID || memberItem.Value.split('_')[0],
          type: 'Member'
        };
      }
      const first = data.d.Items[0];
      return {
        name: first.Attributes?.DisplayName || first.Attributes?.Name || playerName,
        id: first.Value,
        uid: first.Attributes?.UID || first.Value.split('_')[0],
        type: first.Attributes?.pType || 'Guest'
      };
    }
  } catch (err) {
    console.warn(`[scvcc] searchPlayerOnScvcc failed for "${playerName}":`, err.message);
  }

  return {
    name: playerName,
    id: '-9999_Guest',
    uid: '-9999',
    type: 'Guest'
  };
}

function setFormClientState(formData, controlPrefix, value, text) {
  formData.set(controlPrefix, JSON.stringify({ logEntries: [], value, text, enabled: true }));
}

function setPlayerSlotOnFormData(formData, slotNum, playerObj = GUEST_TBA_PLAYER) {
  const pKey = `P${slotNum}`;
  const p = playerObj || GUEST_TBA_PLAYER;
  formData.set(`ctl00$ctrl_MakeBookingTime$${pKey}$PCombo$PlayerName`, p.name);
  formData.set(`ctl00$ctrl_MakeBookingTime$${pKey}$PCombo$PlayerID`, p.id);
  formData.set(`ctl00$ctrl_MakeBookingTime$${pKey}$PCombo$PlayerType`, p.type);
  setFormClientState(formData, `ctl00_ctrl_MakeBookingTime_${pKey}_PCombo_PlayerName_ClientState`, p.id, p.name);
}

function buildBookingFormData(hiddenFields, {
  courtName,
  resourceId,
  targetPartySize,
  targetDateMDY,
  targetTimeFormatted,
  durationVal,
  finalDurationMins,
  guestParentsMemberId = null
}) {
  const formData = new URLSearchParams();
  for (const [k, v] of Object.entries(hiddenFields)) {
    formData.append(k, v);
  }

  formData.set('defaultSM', 'defaultRAMSU|ctl00$ctrl_MakeBookingTime$lbBook');
  formData.set('RadAJAXControlID', 'defaultRAM');
  formData.set('__EVENTTARGET', 'ctl00$ctrl_MakeBookingTime$lbBook');
  formData.set('__EVENTARGUMENT', '');
  formData.set('__ASYNCPOST', 'true');
  formData.set('ctl00$ctrl_MakeBookingTime$drpResourceTypeName$tCombo', 'Tennis Courts');
  formData.set('ctl00$ctrl_MakeBookingTime$drpStartResource$tCombo', courtName);
  setFormClientState(formData, 'ctl00_ctrl_MakeBookingTime_drpStartResource_tCombo_ClientState', resourceId, courtName);
  formData.set('ctl00$ctrl_MakeBookingTime$drpPartySize$tCombo', targetPartySize);
  setFormClientState(formData, 'ctl00_ctrl_MakeBookingTime_drpPartySize_tCombo_ClientState', targetPartySize, targetPartySize);
  if (targetDateMDY) {
    formData.set('ctl00$ctrl_MakeBookingTime$rdDate$tMDateBox', targetDateMDY);
  }
  if (targetTimeFormatted) {
    formData.set('ctl00$ctrl_MakeBookingTime$drpTime$tCombo', targetTimeFormatted);
    setFormClientState(formData, 'ctl00_ctrl_MakeBookingTime_drpTime_tCombo_ClientState', targetTimeFormatted, targetTimeFormatted);
  }
  formData.set('ctl00$ctrl_MakeBookingTime$drpDuration$tCombo', durationVal);
  setFormClientState(formData, 'ctl00_ctrl_MakeBookingTime_drpDuration_tCombo_ClientState', String(finalDurationMins), durationVal);
  if (guestParentsMemberId) {
    formData.set('guestParents', `${guestParentsMemberId},`);
  }
  formData.set('ctl00$ctrl_MakeBookingTime$playersUpdated', '1');

  return formData;
}

async function postRadAjaxDelta(dialogUrl, formData, chatId) {
  const fetchFn = facade.call('authFetch', authFetch);
  const res = await fetchFn(dialogUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-MicrosoftAjax': 'Delta=true',
      'Referer': dialogUrl
    },
    body: formData.toString()
  }, 1, chatId);
  if (!res) {
    throw new Error('Empty response from SCVCC dialog endpoint');
  }
  if (res.ok === false) {
    throw new Error(`SCVCC dialog POST failed (HTTP ${res.status || 'unknown'})`);
  }
  return await res.text();
}

async function submitBookingWithOverride(dialogUrl, formData, chatId, logSuffix = '') {
  let responseText = await postRadAjaxDelta(dialogUrl, formData, chatId);

  if (!responseText.includes('Reservation Received') &&
      !responseText.includes('ReturnbookingTime') &&
      (responseText.includes('OverrideBtn') || responseText.includes('ctl00$ctrl_MakeBookingTime$OverrideBtn'))) {
    console.log(`[scvcc] Restriction notice encountered with Override available${logSuffix}. Submitting administrative override...`);
    const vsMatch = responseText.match(/__VIEWSTATE\|([^|]*)\|/);
    if (vsMatch) formData.set('__VIEWSTATE', vsMatch[1]);
    const cevsMatch = responseText.match(/__CEVIEWSTATE\|([^|]*)\|/);
    if (cevsMatch) formData.set('__CEVIEWSTATE', cevsMatch[1]);

    formData.set('defaultSM', 'defaultRAMSU|ctl00$ctrl_MakeBookingTime$OverrideBtn');
    formData.set('RadAJAXControlID', 'defaultRAM');
    formData.set('__EVENTTARGET', 'ctl00$ctrl_MakeBookingTime$OverrideBtn');
    formData.set('__EVENTARGUMENT', '');
    formData.set('__ASYNCPOST', 'true');
    formData.set('ctl00$ctrl_MakeBookingTime$OverrideBtn', 'Override');

    responseText = await postRadAjaxDelta(dialogUrl, formData, chatId);
  }

  return responseText;
}

function extractDeltaErrorMatch(responseText, includeTbdNotice = false) {
  const candidates = [
    responseText.match(/<span[^>]*class="[^"]*rbm_Error[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
    responseText.match(/<span[^>]*id="ctl00_ctrl_MakeBookingTime_errorLabel"[^>]*>([\s\S]*?)<\/span>/i),
    responseText.match(/alert\(['"]([^'"]+)['"]\)/i),
    includeTbdNotice ? responseText.match(/No "To Be Determined"[^<']+/i) : null
  ];
  for (const m of candidates) {
    if (m && (m[1] || m[0]).replace(/<[^>]+>/g, '').trim()) {
      return m;
    }
  }
  return null;
}

function parseAndResolvePlayerList(players) {
  const list = Array.isArray(players)
    ? [...players]
    : (typeof players === 'string'
      ? players.split(/[,&+]|\band\b/i).map(p => p.trim()).filter(Boolean)
      : []);
  return list.map(p => namesStore.resolveFullName(p));
}

/**
 * Performs a single attempt to cancel a court reservation on SCVCC.
 */
async function attemptCancelCourtReservation(reservationId, chatId = null) {
  const urls = getScvccUrls(chatId);
  const cancelDialogUrl = `${urls.dialogUrl}?p=rbmPop&tt=MakebookingTime&NoModResize=1&NoNav=1&ShowFooter=False&bookingTimeid=${encodeURIComponent(reservationId)}&classid=1`;
  const fetchFn = facade.call('authFetch', authFetch);

  let getRes;
  try {
    getRes = await fetchFn(cancelDialogUrl, {}, 1, chatId);
  } catch (err) {
    console.warn(`[scvcc] Failed to open cancellation dialog for reservation ${reservationId}:`, err.message);
    return { success: false, message: `⚠️ Failed to open cancellation dialog for reservation \`${reservationId}\`: ${err.message}` };
  }
  if (!getRes || getRes.ok === false) {
    return { success: false, message: `Failed to open cancellation dialog (HTTP ${getRes?.status || 'unknown'})` };
  }
  const html = await getRes.text();
  if (html.includes('class="login-content"') || html.includes('member-login') || html.includes('login=expired')) {
    console.warn(`[scvcc] Session expired while opening cancellation dialog for reservation ${reservationId}.`);
    return { success: false, message: `⚠️ SCVCC session expired while opening cancellation dialog for reservation \`${reservationId}\`.` };
  }

  const getErrorMatch = !/lbCancel/i.test(html) ? extractDeltaErrorMatch(html, false) : null;
  if (getErrorMatch) {
    const errText = (getErrorMatch[1] || getErrorMatch[0]).replace(/<[^>]+>/g, '').trim();
    if (errText && !errText.toLowerCase().includes('success')) {
      console.warn(`[scvcc] Cancellation dialog error for reservation ${reservationId}:`, errText);
      return { success: false, message: `⚠️ Could not cancel reservation \`${reservationId}\`: ${errText}` };
    }
  }

  const fields = extractFormFields(html);
  const formData = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    formData.append(k, v);
  }
  formData.set('defaultSM', 'defaultRAMSU|ctl00$ctrl_MakeBookingTime$lbCancel');
  formData.set('RadAJAXControlID', 'defaultRAM');
  formData.set('__EVENTTARGET', 'ctl00$ctrl_MakeBookingTime$lbCancel');
  formData.set('__EVENTARGUMENT', '');
  formData.set('__ASYNCPOST', 'true');

  let delta;
  try {
    delta = await postRadAjaxDelta(cancelDialogUrl, formData, chatId);
  } catch (err) {
    console.warn(`[scvcc] Cancellation POST failed for reservation ${reservationId}:`, err.message);
    return { success: false, message: `⚠️ Could not cancel reservation \`${reservationId}\`: ${err.message}` };
  }

  if (!delta || !delta.trim()) {
    console.warn(`[scvcc] Empty response when cancelling reservation ${reservationId}.`);
    return { success: false, message: `⚠️ Could not cancel reservation \`${reservationId}\`: Empty response from SCVCC.` };
  }

  if (delta.includes('class="login-content"') || delta.includes('member-login') || delta.includes('login=expired')) {
    console.warn(`[scvcc] Session expired during cancellation POST for reservation ${reservationId}.`);
    return { success: false, message: `⚠️ SCVCC session expired while cancelling reservation \`${reservationId}\`.` };
  }

  const errorMatch = extractDeltaErrorMatch(delta, false);
  const rawErrorText = errorMatch ? (errorMatch[1] || errorMatch[0]).replace(/<[^>]+>/g, '').trim() : null;
  const errorText = (rawErrorText && !rawErrorText.toLowerCase().includes('success')) ? rawErrorText : null;
  const hasExplicitConfirm =
    delta.includes('ReturnbookingTime') ||
    delta.includes('showConfirm') ||
    delta.includes('Reservation Received') ||
    delta.includes('Reservation Cancelled') ||
    delta.includes('Booking Cancelled') ||
    /cancel(?:led|ed)\s+successfully/i.test(delta);
  const hasExplicitError = Boolean(errorText) || delta.includes('rbm_Error') || delta.includes('errorBox') || /\berror\b/i.test(delta);

  if (errorText || (hasExplicitError && !hasExplicitConfirm)) {
    console.warn(`[scvcc] SCVCC rejected cancellation for reservation ${reservationId}:`, errorText || delta.slice(0, 300));
    return {
      success: false,
      message: `⚠️ Could not cancel reservation \`${reservationId}\`${errorText ? `: ${errorText}` : '.'}`
    };
  }

  if (!hasExplicitConfirm) {
    try {
      const verifyRes = await fetchFn(cancelDialogUrl, {}, 1, chatId);
      if (verifyRes && verifyRes.ok !== false) {
        const verifyHtml = await verifyRes.text();
        if (verifyHtml.includes('class="login-content"') || verifyHtml.includes('member-login') || verifyHtml.includes('login=expired')) {
          console.warn(`[scvcc] Session expired while verifying cancellation for reservation ${reservationId}.`);
          return { success: false, message: `⚠️ Could not verify cancellation for reservation \`${reservationId}\` (session expired).` };
        }
        if (/ctl00(?:\$|_)ctrl_MakeBookingTime(?:\$|_)lbCancel/i.test(verifyHtml)) {
          console.warn(`[scvcc] Cancellation unconfirmed and reservation ${reservationId} still appears active at SCVCC. Delta snippet:`, delta.slice(0, 300));
          return {
            success: false,
            message: `⚠️ Could not cancel reservation \`${reservationId}\` (reservation still appears active at SCVCC).`
          };
        }
      }
    } catch (verifyErr) {
      console.warn(`[scvcc] Failed to verify cancellation status for reservation ${reservationId}:`, verifyErr.message);
      return {
        success: false,
        message: `⚠️ Could not confirm cancellation for reservation \`${reservationId}\`: ${verifyErr.message}`
      };
    }
  }

  return { success: true, message: `✅ Successfully cancelled court reservation \`${reservationId}\` at SCVCC.` };
}

/**
 * Cancels a court reservation on SCVCC, retrying once if the initial attempt fails.
 */
async function cancelCourtReservation(reservationId, chatId = null) {
  if (!reservationId) {
    return { success: false, message: '⚠️ Reservation ID is required to cancel a booking.' };
  }

  let res;
  try {
    res = await attemptCancelCourtReservation(reservationId, chatId);
  } catch (err) {
    res = { success: false, message: `⚠️ Could not cancel reservation \`${reservationId}\`: ${err.message}` };
  }
  if (res && res.success) {
    return res;
  }

  console.warn(`[scvcc] Cancellation attempt 1 failed for reservation ${reservationId} (${res?.message || 'unknown error'}). Retrying once...`);
  if (process.env.NODE_ENV !== 'test') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    return await attemptCancelCourtReservation(reservationId, chatId);
  } catch (err) {
    return { success: false, message: `⚠️ Could not cancel reservation \`${reservationId}\`: ${err.message}` };
  }
}

/**
 * Modifies an existing court reservation on SCVCC.
 */
async function modifyCourtBooking({
  reservationId,
  when = null,
  date = null,
  time = null,
  court = null,
  duration = null,
  partySize = null,
  players = null,
  requester = null,
  requestedBy = null,
  sport = 'tennis',
  chatId = null
} = {}) {
  if (!reservationId) {
    return {
      success: false,
      message: '⚠️ Reservation ID is required to modify a court booking.'
    };
  }

  const urls = getScvccUrls(chatId);
  const dialogUrl = `${urls.dialogUrl}?p=rbmPop&tt=MakebookingTime&NoModResize=1&NoNav=1&ShowFooter=False&bookingTimeid=${encodeURIComponent(reservationId)}&classid=1`;
  const fetchFn = facade.call('authFetch', authFetch);
  const dialogRes = await fetchFn(dialogUrl, {}, 1, chatId);
  if (!dialogRes.ok) {
    return {
      success: false,
      message: `Failed to open reservation dialog for #${reservationId} (HTTP ${dialogRes.status})`
    };
  }

  const dialogHtml = await dialogRes.text();
  const hiddenFields = extractFormFields(dialogHtml);

  const existingCourt = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$drpStartResource$tCombo');
  const existingDate = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$rdDate$tMDateBox');
  const existingTime = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$drpTime$tCombo');
  const existingDuration = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$drpDuration$tCombo');
  const existingPartySize = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$drpPartySize$tCombo');

  const existingP1 = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerName');
  const existingP2 = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$P2$PCombo$PlayerName');
  const existingP3 = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$P3$PCombo$PlayerName');
  const existingP4 = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$P4$PCombo$PlayerName');
  const memberId = readDialogField(hiddenFields, dialogHtml, 'ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerID') || '8916615';

  // 1. Resolve target date
  let targetDateMDY = existingDate;
  if (date) {
    targetDateMDY = resolveDateToMDY(date);
  } else if (when) {
    const whenDate = resolveDateToMDY(when);
    if (whenDate && whenDate !== 'today') {
      targetDateMDY = whenDate;
    }
  }

  // 2. Resolve target time
  let targetTimeFormatted = existingTime;
  if (time) {
    targetTimeFormatted = normalizeGridTime(time);
  } else if (when) {
    const timeMatch = when.match(/(?:\b(?:around|about|approx|approximately|at|near|~)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    if (timeMatch) {
      targetTimeFormatted = normalizeGridTime(timeMatch[1]);
    }
  }

  // 3. Resolve target court and resourceId
  let targetCourtName = existingCourt || 'Court 1';
  if (court) {
    targetCourtName = formatCourtLabel(court);
  }
  const targetResourceId = COURT_RESOURCE_IDS[targetCourtName.toLowerCase().trim()] || '1';

  // 4. Resolve duration
  const durationExplicit = duration !== null && duration !== undefined && String(duration).trim() !== '';
  let durationVal = existingDuration || '90 Minutes';
  if (durationExplicit) {
    const durNum = parseScvccDurationMinutes(duration) || 90;
    durationVal = `${durNum} Minutes`;
  }
  const finalDurationMins = parseScvccDurationMinutes(durationVal) || 90;

  // 5. Resolve party size
  let isSingles = false;
  if (partySize) {
    isSingles = partySize.toLowerCase() === 'singles';
  } else if (existingPartySize) {
    isSingles = existingPartySize.toLowerCase() === 'singles';
  }
  const targetPartySize = isSingles ? 'Singles' : 'Doubles';
  const maxPlayers = isSingles ? 2 : 4;

  // 6. Resolve players
  const assignedPlayers = [];
  let p1Obj = null;

  if (players && players.length > 0) {
    const playerList = parseAndResolvePlayerList(players);
    let p1Name = requester || requestedBy || playerList.shift() || existingP1 || 'Immaneni, Pramod';
    p1Name = namesStore.resolveFullName(p1Name);

    p1Obj = await searchPlayerOnScvcc(p1Name, memberId, chatId);
    assignedPlayers.push(p1Obj.name);

    for (let slot = 2; slot <= maxPlayers; slot++) {
      const specified = playerList[slot - 2] ? playerList[slot - 2].trim() : null;
      if (specified) {
        const pObj = await searchPlayerOnScvcc(specified, memberId, chatId);
        assignedPlayers.push(pObj.name);
      } else {
        assignedPlayers.push('Guest TBA');
      }
    }
  } else {
    if (existingP1) assignedPlayers.push(existingP1);
    if (existingP2 && (!isSingles || assignedPlayers.length < maxPlayers)) assignedPlayers.push(existingP2);
    if (!isSingles) {
      if (existingP3) assignedPlayers.push(existingP3);
      if (existingP4) assignedPlayers.push(existingP4);
    }
  }

  // 7. Build formData
  const formData = buildBookingFormData(hiddenFields, {
    courtName: targetCourtName,
    resourceId: targetResourceId,
    targetPartySize,
    targetDateMDY,
    targetTimeFormatted,
    durationVal,
    finalDurationMins
  });

  if (players && players.length > 0 && p1Obj) {
    setPlayerSlotOnFormData(formData, 1, p1Obj);
    for (let slot = 2; slot <= maxPlayers; slot++) {
      const pName = assignedPlayers[slot - 1];
      if (pName && pName !== 'Guest TBA') {
        const pObj = await searchPlayerOnScvcc(pName, memberId, chatId);
        setPlayerSlotOnFormData(formData, slot, pObj);
      } else {
        setPlayerSlotOnFormData(formData, slot, GUEST_TBA_PLAYER);
      }
    }
  }

  // 8. Submit POST request (with admin override retry if triggered)
  const responseText = await submitBookingWithOverride(dialogUrl, formData, chatId, ' during modify');

  const resMatch = responseText.match(/ReturnbookingTime\((\d+)\)/);
  let updatedReservationId = resMatch ? resMatch[1] : reservationId;

  const isConfirmed = Boolean(resMatch) ||
    responseText.includes('Reservation Received') ||
    responseText.includes('showConfirm') ||
    !responseText.includes('rbm_Error');

  const errorMatch = extractDeltaErrorMatch(responseText, false);
  if (!isConfirmed && errorMatch) {
    const errorText = errorMatch[1].replace(/<[^>]+>/g, '').trim();
    return {
      success: false,
      message: `⚠️ SCVCC Reservation Notice: ${errorText || 'Could not update reservation.'}`
    };
  }

  // 9. Verify persisted duration when slot fields or duration changed.
  // Clubessential's drpTime/rdDate/drpStartResource AutoPostBack handlers run during a single-step
  // non-override lbBook postback and can reset drpDuration (e.g. to 30 Minutes).
  const timeChanged = Boolean(targetTimeFormatted && (existingTime ? existingTime.toLowerCase().trim() !== targetTimeFormatted.toLowerCase().trim() : Boolean(time || when)));
  const dateChanged = Boolean(targetDateMDY && (existingDate ? existingDate.trim() !== targetDateMDY.trim() : Boolean(date || when)));
  const courtChanged = Boolean(court && targetCourtName && (!existingCourt || existingCourt.toLowerCase().trim() !== targetCourtName.toLowerCase().trim()));
  const partyChanged = Boolean(partySize && targetPartySize && (!existingPartySize || existingPartySize.toLowerCase().trim() !== targetPartySize.toLowerCase().trim()));
  const slotChanged = timeChanged || dateChanged || courtChanged || partyChanged;
  const playersChanged = Boolean(players && players.length > 0);

  let actualDurationVal = durationVal;
  let durationMismatchWarning = null;

  if (updatedReservationId && (durationExplicit || slotChanged)) {
    const buildVerifyUrl = (resId) => `${urls.dialogUrl}?p=rbmPop&tt=MakebookingTime&NoModResize=1&NoNav=1&ShowFooter=False&bookingTimeid=${encodeURIComponent(resId)}&classid=1`;
    try {
      const verifyUrl = buildVerifyUrl(updatedReservationId);
      const verifyRes = await fetchFn(verifyUrl, {}, 1, chatId);
      if (verifyRes && verifyRes.ok) {
        const verifyHtml = await verifyRes.text();
        const verifyFields = extractFormFields(verifyHtml);
        const verifyDuration = readDialogField(verifyFields, verifyHtml, 'ctl00$ctrl_MakeBookingTime$drpDuration$tCombo');
        const verifyDurationMins = parseScvccDurationMinutes(verifyDuration);

        if (verifyDurationMins && verifyDurationMins !== finalDurationMins) {
          actualDurationVal = verifyDuration;
          console.log(`[scvcc] Duration after modify (#${updatedReservationId}) is "${verifyDuration}" instead of requested "${durationVal}". Submitting duration-only follow-up...`);

          const verifyCourt = readDialogField(verifyFields, verifyHtml, 'ctl00$ctrl_MakeBookingTime$drpStartResource$tCombo') || targetCourtName;
          const verifyDate = readDialogField(verifyFields, verifyHtml, 'ctl00$ctrl_MakeBookingTime$rdDate$tMDateBox') || targetDateMDY;
          const verifyTime = readDialogField(verifyFields, verifyHtml, 'ctl00$ctrl_MakeBookingTime$drpTime$tCombo') || targetTimeFormatted;
          const verifyPartySize = readDialogField(verifyFields, verifyHtml, 'ctl00$ctrl_MakeBookingTime$drpPartySize$tCombo') || targetPartySize;
          const verifyResourceId = COURT_RESOURCE_IDS[verifyCourt.toLowerCase().trim()] || targetResourceId;

          const followUpFormData = buildBookingFormData(verifyFields, {
            courtName: verifyCourt,
            resourceId: verifyResourceId,
            targetPartySize: verifyPartySize,
            targetDateMDY: verifyDate,
            targetTimeFormatted: verifyTime,
            durationVal,
            finalDurationMins
          });

          const followUpResp = await submitBookingWithOverride(verifyUrl, followUpFormData, chatId, ' during duration follow-up');
          const followUpResMatch = followUpResp.match(/ReturnbookingTime\((\d+)\)/);
          if (followUpResMatch) {
            updatedReservationId = followUpResMatch[1];
          }
          const followUpExplicitSuccess = Boolean(followUpResMatch) ||
            followUpResp.includes('Reservation Received') ||
            followUpResp.includes('showConfirm');
          const followUpErrMatch = extractDeltaErrorMatch(followUpResp, false);
          const followUpErrText = (!followUpExplicitSuccess && followUpErrMatch)
            ? (followUpErrMatch[1] || followUpErrMatch[0]).replace(/<[^>]+>/g, '').trim()
            : null;

          if (followUpErrText) {
            if (!slotChanged && !playersChanged) {
              return {
                success: false,
                reservationId: updatedReservationId,
                duration: actualDurationVal,
                message: `⚠️ SCVCC Reservation Notice: ${followUpErrText || 'Could not update reservation duration.'}`
              };
            }
            durationMismatchWarning = `⚠️ Requested duration *${durationVal}*, but SCVCC kept *${actualDurationVal}* (${followUpErrText}).`;
          } else {
            let finalDuration = null;
            try {
              const postFollowUpRes = await fetchFn(buildVerifyUrl(updatedReservationId), {}, 1, chatId);
              if (postFollowUpRes && postFollowUpRes.ok) {
                const postFollowUpHtml = await postFollowUpRes.text();
                const postFollowUpFields = extractFormFields(postFollowUpHtml);
                finalDuration = readDialogField(postFollowUpFields, postFollowUpHtml, 'ctl00$ctrl_MakeBookingTime$drpDuration$tCombo');
              }
            } catch (reVerifyErr) {
              console.warn(`[scvcc] Post-followup duration verify failed for #${updatedReservationId}:`, reVerifyErr.message);
            }

            const finalVerifyMins = parseScvccDurationMinutes(finalDuration);
            if (finalVerifyMins && finalVerifyMins !== finalDurationMins) {
              actualDurationVal = finalDuration;
              if (!slotChanged && !playersChanged) {
                return {
                  success: false,
                  reservationId: updatedReservationId,
                  duration: actualDurationVal,
                  message: `⚠️ SCVCC saved duration as *${actualDurationVal}* instead of requested *${durationVal}* for reservation \`${updatedReservationId}\`.`
                };
              }
              durationMismatchWarning = `⚠️ Requested duration *${durationVal}*, but SCVCC saved *${actualDurationVal}*.`;
            } else if (finalDuration) {
              actualDurationVal = finalDuration;
            } else if (followUpExplicitSuccess) {
              actualDurationVal = durationVal;
            }
          }
        } else if (verifyDuration) {
          actualDurationVal = verifyDuration;
        }
      }
    } catch (verifyErr) {
      console.warn(`[scvcc] Duration verification/follow-up failed for #${updatedReservationId}:`, verifyErr.message);
      if (actualDurationVal !== durationVal) {
        if (!slotChanged && !playersChanged) {
          return {
            success: false,
            reservationId: updatedReservationId,
            duration: actualDurationVal,
            message: `⚠️ SCVCC saved duration as *${actualDurationVal}* instead of requested *${durationVal}* (${verifyErr.message}).`
          };
        }
        durationMismatchWarning = `⚠️ Requested duration *${durationVal}*, but SCVCC kept *${actualDurationVal}* (${verifyErr.message}).`;
      }
    }
  }

  const displayDate = targetDateMDY ? formatDisplayDate(targetDateMDY) : 'scheduled date';
  const confirmLines = [
    `✅ Successfully updated court reservation \`${updatedReservationId}\` at SCVCC:`,
    targetDateMDY ? `📅 *Date:* ${displayDate} (${targetDateMDY})` : null,
    targetTimeFormatted ? `⏰ *Time:* ${targetTimeFormatted}` : null,
    `🏟️ *Court:* ${targetCourtName}`,
    assignedPlayers.length > 0 ? `👥 *Players:* ${assignedPlayers.join(', ')}` : null,
    `⏱️ *Duration:* ${actualDurationVal} (${targetPartySize})`,
    durationMismatchWarning
  ].filter(Boolean);

  return {
    success: true,
    reservationId: updatedReservationId,
    court: targetCourtName,
    oldCourt: existingCourt,
    date: targetDateMDY,
    oldDate: existingDate,
    time: targetTimeFormatted,
    oldTime: existingTime,
    players: assignedPlayers,
    duration: actualDurationVal,
    ...(durationMismatchWarning ? { requestedDuration: durationVal, durationMismatch: true } : {}),
    partySize: targetPartySize,
    message: confirmLines.join('\n')
  };
}

function buildCourtSelectionHelpers({ courtPreference, courtPreferences, excludeCourts, chatId }) {
  const effectivePreferences = (Array.isArray(courtPreference) && courtPreference.length > 0)
    ? courtPreference
    : (Array.isArray(courtPreferences) && courtPreferences.length > 0
      ? courtPreferences
      : groupsConfig.getBookingCourtPreference(chatId));

  const getPreferenceRank = (courtObj) => {
    if (!effectivePreferences || effectivePreferences.length === 0) return 999999;
    const cName = (courtObj.court || '').toLowerCase().trim();
    const cNum = (courtObj.court || '').match(/\d+/)?.[0];
    const rId = String(courtObj.resourceId || '');

    for (let i = 0; i < effectivePreferences.length; i++) {
      const pref = String(effectivePreferences[i]).toLowerCase().trim();
      const prefNum = pref.match(/\d+/)?.[0];
      if (pref === cName || pref.replace(/\s+/g, '') === cName.replace(/\s+/g, '')) return i;
      if (rId && pref === rId) return i;
      if (cNum && (pref === cNum || prefNum === cNum)) return i;
    }
    return 999999;
  };

  const excludeSet = new Set();
  (Array.isArray(excludeCourts) ? excludeCourts : [excludeCourts])
    .filter(Boolean)
    .forEach(c => {
      const s = String(c).toLowerCase().trim();
      excludeSet.add(s);
      const numMatch = s.match(/\b\d+\b/);
      if (numMatch) {
        excludeSet.add(numMatch[0]);
        excludeSet.add(`court ${numMatch[0]}`);
      }
    });

  const isExcludedCourt = (cName) => {
    if (!cName || excludeSet.size === 0) return false;
    const s = String(cName).toLowerCase().trim();
    if (excludeSet.has(s)) return true;
    const numMatch = s.match(/\b\d+\b/);
    if (numMatch && excludeSet.has(numMatch[0])) return true;
    return false;
  };

  return { getPreferenceRank, isExcludedCourt };
}

function selectBestCourtForBooking(availability, targetTimeFormatted, { court, strictCourt = false, requiredMins, chatId, getPreferenceRank, isExcludedCourt }) {
  const matchingSlots = availability.slots.filter(s => s.time === targetTimeFormatted && !s.clubClosed);

  // 1. If a specific court was requested, try it before other available courts
  if (court) {
    const cLower = court.toLowerCase().trim();
    for (const slot of matchingSlots) {
      const found = slot.courts.find(c => (c.court.toLowerCase() === cLower || c.court.toLowerCase().includes(cLower)) && !isExcludedCourt(c.court));
      if (!found) continue;
      if (found.clubClosed) continue;

      const normalMins = found.status === 'available' ? (found.availableMinutes || 0) : 0;
      const overrideMins = found.overrideAvailableMinutes || 0;
      const hasPlayers = Array.isArray(found.prebookedPlayers) && found.prebookedPlayers.length > 0;
      const hasBlockTitle = Boolean(found.blockTitle && found.blockTitle.trim());

      if (found.status === 'available') {
        if (normalMins >= requiredMins) {
          console.log(`[scvcc] Specific requested court ${court} is available (${normalMins}m availability), selecting it first...`);
          return { ...found, availableMinutes: normalMins };
        }
        if (overrideMins >= requiredMins) {
          console.log(`[scvcc] Specific requested court ${court} has ${normalMins}m normal availability, but ${overrideMins}m with unblocked override, selecting it...`);
          return { ...found, availableMinutes: overrideMins, isOverride: true };
        }
        console.log(`[scvcc] Specific requested court ${court} has only ${Math.max(normalMins, overrideMins)}m available (< ${requiredMins}m required), trying other available courts...`);
      } else if (!hasPlayers && !hasBlockTitle) {
        if (overrideMins >= requiredMins) {
          console.log(`[scvcc] Specific requested court ${court} is unbooked/blocked (${found.status}, ${overrideMins}m available), selecting it first via admin override...`);
          return { ...found, availableMinutes: overrideMins, isOverride: true };
        }
        console.log(`[scvcc] Specific requested court ${court} is unbooked/blocked but has only ${overrideMins}m available (< ${requiredMins}m required), trying other available courts...`);
      } else {
        console.log(`[scvcc] Specific requested court ${court} is unavailable/booked (${found.status}, players: ${found.prebookedPlayers?.join(', ') || 'none'}, blockTitle: ${found.blockTitle || 'none'}), trying other available courts...`);
      }
    }
    if (strictCourt) {
      console.log(`[scvcc] Strict court mode enabled for ${court}; not falling back to other courts.`);
      return null;
    }
  }

  // 2. Try to find an officially open/available court
  for (const slot of matchingSlots) {
    const openCourts = slot.courts
      .filter((c) => {
        if (c.status !== 'available' || c.clubClosed) return false;
        if (isExcludedCourt(c.court)) return false;
        const effectiveMins = Math.max(c.availableMinutes || 0, c.overrideAvailableMinutes || 0);
        return effectiveMins >= requiredMins;
      })
      .sort((a, b) => {
        const rankA = getPreferenceRank(a);
        const rankB = getPreferenceRank(b);
        if (rankA !== rankB) return rankA - rankB;
        const minsA = Math.max(a.availableMinutes || 0, a.overrideAvailableMinutes || 0);
        const minsB = Math.max(b.availableMinutes || 0, b.overrideAvailableMinutes || 0);
        return (minsB - minsA) || a.court.localeCompare(b.court);
      });

    if (openCourts.length > 0) {
      const picked = openCourts[0];
      const bestMins = Math.max(picked.availableMinutes || 0, picked.overrideAvailableMinutes || 0);
      return {
        ...picked,
        availableMinutes: bestMins,
        isOverride: Boolean(picked.isOverride || (picked.availableMinutes < requiredMins && picked.overrideAvailableMinutes >= requiredMins))
      };
    }
  }

  // 3. Fallback: unbooked blocked courts with no title and no players (supervisor override)
  for (const slot of matchingSlots) {
    const unbookedBlockedCourts = slot.courts
      .filter((c) => {
        if (c.status === 'available' || c.clubClosed) return false;
        if (isIgnoredCourt(c.court, chatId)) return false;
        if (isExcludedCourt(c.court)) return false;
        const hasPlayers = Array.isArray(c.prebookedPlayers) && c.prebookedPlayers.length > 0;
        const hasBlockTitle = Boolean(c.blockTitle && c.blockTitle.trim());
        if (hasPlayers || hasBlockTitle) return false;
        return (c.overrideAvailableMinutes || 0) >= requiredMins;
      })
      .sort((a, b) => {
        const rankA = getPreferenceRank(a);
        const rankB = getPreferenceRank(b);
        if (rankA !== rankB) return rankA - rankB;
        return (b.overrideAvailableMinutes - a.overrideAvailableMinutes) || a.court.localeCompare(b.court);
      });

    if (unbookedBlockedCourts.length > 0) {
      const picked = unbookedBlockedCourts[0];
      const selected = { ...picked, availableMinutes: picked.overrideAvailableMinutes, isOverride: true };
      console.log(`[scvcc] Selected unbooked court ${selected.court} (${selected.status}, ${selected.availableMinutes}m available, no players, no title) using administrative override...`);
      return selected;
    }
  }

  return null;
}

/**
 * Books a court on Silver Creek Valley Country Club.
 */
async function bookCourt({
  when,
  date = null,
  time = null,
  court = null,
  strictCourt = false,
  duration = null,
  partySize = 'Doubles',
  players = [],
  requester = null,
  requestedBy = null,
  sport = 'tennis',
  chatId = null,
  courtPreference = null,
  courtPreferences = null,
  excludeCourts = [],
  minAvailableMinutes = null
} = {}) {
  // 1. Resolve date and time
  let targetWhen = when || (date ? date : 'today');
  let targetTime = time;

  if (!targetTime && targetWhen) {
    const timeMatch = targetWhen.match(/(?:\b(?:around|about|approx|approximately|at|near|~)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
    if (timeMatch) {
      targetTime = timeMatch[1];
      targetWhen = targetWhen.replace(timeMatch[0], '').replace(/\b(?:on|for|at|around|about|in)\b/gi, '').trim() || 'today';
    }
  }

  const targetDateMDY = date ? resolveDateToMDY(date) : resolveDateToMDY(targetWhen);
  const targetTimeFormatted = targetTime ? normalizeGridTime(targetTime) : null;

  if (!targetTimeFormatted) {
    return {
      success: false,
      message: '⚠️ Please specify a start time for the court booking (e.g. `!bookcourt 6pm tomorrow` or `!bookcourt Court 2 9am Saturday`).'
    };
  }

  if (chatId && !groupsConfig.isCourtBookingEnabled(chatId)) {
    return {
      success: false,
      message: '⚠️ Court booking is not enabled for this group.'
    };
  }

  const displayDate = formatDisplayDate(targetDateMDY);

  // 2. Query court availability to find an open court slot & determine max available duration
  const checkAvailFn = facade.call('checkCourtAvailability', checkCourtAvailability);
  const availability = await checkAvailFn({
    when: targetDateMDY,
    time: targetTimeFormatted,
    court: null,
    sport,
    chatId
  });

  const closedInfo = detectClubClosed({ avail: availability, time: targetTimeFormatted, chatId });
  if (closedInfo.clubClosed) {
    const titleSuffix = closedInfo.title ? ` (${closedInfo.title})` : '';
    return {
      success: false,
      clubClosed: true,
      clubClosedTitle: closedInfo.title || null,
      date: targetDateMDY,
      time: targetTimeFormatted,
      message: `🚫 Club is closed at SCVCC on *${displayDate}* at *${targetTimeFormatted}*${titleSuffix}.`
    };
  }

  if (!availability.success || availability.slots.length === 0) {
    return {
      success: false,
      courtUnavailable: true,
      message: `❌ Could not find available courts at SCVCC for *${displayDate}* at *${targetTimeFormatted}*.`
    };
  }

  const requiredMins = minAvailableMinutes !== null && minAvailableMinutes !== undefined
    ? minAvailableMinutes
    : (duration ? parseInt(String(duration).match(/\d+/)?.[0] || '90', 10) : 90);

  const { getPreferenceRank, isExcludedCourt } = buildCourtSelectionHelpers({
    courtPreference,
    courtPreferences,
    excludeCourts,
    chatId
  });

  const selectedCourt = selectBestCourtForBooking(availability, targetTimeFormatted, {
    court,
    strictCourt,
    requiredMins,
    chatId,
    getPreferenceRank,
    isExcludedCourt
  });

  if (!selectedCourt) {
    if (court && strictCourt) {
      const courtLabel = formatCourtLabel(court);
      return {
        success: false,
        courtUnavailable: true,
        message: `❌ *${courtLabel}* is not available at SCVCC on *${displayDate}* at *${targetTimeFormatted}* with at least ${requiredMins} minutes open.`
      };
    }
    return {
      success: false,
      courtUnavailable: true,
      message: `❌ No courts are available at SCVCC on *${displayDate}* at *${targetTimeFormatted}*. All courts are reserved or booked.`
    };
  }

  const resourceId = selectedCourt.resourceId || COURT_RESOURCE_IDS[selectedCourt.court.toLowerCase()] || '1';
  const resourceTypeId = selectedCourt.resourceType || '1';
  const courtName = selectedCourt.court;
  const availableMins = selectedCourt.availableMinutes || 60;

  // 3. Choose duration: default to 90 minutes unless available duration is shorter
  let finalDurationMins = 90;
  let durationNotice = '';

  if (duration) {
    const durNumMatch = String(duration).match(/\b(30|60|90|120)\b/);
    const reqMins = durNumMatch ? parseInt(durNumMatch[1], 10) : 90;
    if (availableMins > 0 && reqMins > availableMins) {
      finalDurationMins = availableMins;
      durationNotice = ` (adjusted from ${reqMins}m to ${availableMins}m based on court availability)`;
    } else {
      finalDurationMins = reqMins;
    }
  } else if (availableMins >= 90) {
    finalDurationMins = 90;
  } else if (availableMins >= 60) {
    finalDurationMins = 60;
  } else if (availableMins >= 30) {
    finalDurationMins = 30;
  } else {
    finalDurationMins = 60;
  }

  const durationVal = `${finalDurationMins} Minutes`;

  // Parse specified players and resolve canonical names / aliases to full names
  let playerList = parseAndResolvePlayerList(players);

  // Determine Player 1 (the requesting player)
  let p1Name = requester || requestedBy || null;
  if (!p1Name || p1Name === 'Someone') {
    if (playerList.length > 0) {
      p1Name = playerList.shift();
    }
  } else {
    p1Name = namesStore.resolveFullName(p1Name);
    const p1Lower = p1Name.toLowerCase();
    playerList = playerList.filter(p => p.toLowerCase() !== p1Lower);
  }

  // Note: SCVCC does not allow TBD on Doubles. If 2 or fewer players, Singles must be used.
  const totalCount = 1 + playerList.length;
  const isSingles = (partySize && partySize.toLowerCase() === 'singles') || totalCount <= 2;
  const targetPartySize = isSingles ? 'Singles' : 'Doubles';
  const maxPlayers = isSingles ? 2 : 4;
  const xsome = String(maxPlayers);

  console.log(`[scvcc] Initiating booking for ${courtName} (resourceId: ${resourceId}) on ${targetDateMDY} at ${targetTimeFormatted} for ${durationVal} (party: ${targetPartySize})...`);

  // 4. Open MakebookingTime dialog to retrieve form fields and member ID
  const urls = getScvccUrls(chatId);
  const dialogUrl = `${urls.dialogUrl}?p=rbmPop&tt=MakebookingTime&NoModResize=1&NoNav=1&ShowFooter=False&resourceTypeid=${resourceTypeId}&resourceID=${resourceId}&date=${encodeURIComponent(targetDateMDY)}&time=${encodeURIComponent(targetTimeFormatted)}&xsome=${xsome}&classid=1`;
  const dialogRes = await (facade.call('authFetch', authFetch))(dialogUrl, {}, 1, chatId);
  if (!dialogRes.ok) {
    throw new Error(`Failed to load SCVCC booking dialog: HTTP ${dialogRes.status}`);
  }

  const dialogHtml = await dialogRes.text();
  const hiddenFields = extractFormFields(dialogHtml);

  const memberName = dialogHtml.match(/name="ctl00\$ctrl_MakeBookingTime\$P1\$PCombo\$PlayerName"[^>]*value="([^"]+)"/i)?.[1] || 'Immaneni, Pramod';
  const memberId = dialogHtml.match(/name="ctl00\$ctrl_MakeBookingTime\$P1\$PCombo\$PlayerID"[^>]*value="([^"]+)"/i)?.[1] || '8916615';

  if (!p1Name) {
    p1Name = memberName;
  }

  // Resolve P1
  const assignedPlayers = [];
  const p1Obj = isMemberMatch(p1Name, memberName)
    ? { name: memberName, id: `${memberId}_Member`, uid: memberId, type: 'Member' }
    : await searchPlayerOnScvcc(p1Name, memberId, chatId);

  // 5. Construct form submission payload with RadAjaxManager delta postback
  const formData = buildBookingFormData(hiddenFields, {
    courtName,
    resourceId,
    targetPartySize,
    targetDateMDY,
    targetTimeFormatted,
    durationVal,
    finalDurationMins,
    guestParentsMemberId: memberId
  });

  setPlayerSlotOnFormData(formData, 1, p1Obj);
  assignedPlayers.push(p1Obj.name);

  for (let slot = 2; slot <= maxPlayers; slot++) {
    const specifiedName = playerList[slot - 2] ? playerList[slot - 2].trim() : null;
    if (specifiedName) {
      const pObj = await searchPlayerOnScvcc(specifiedName, memberId, chatId);
      setPlayerSlotOnFormData(formData, slot, pObj);
      assignedPlayers.push(pObj.name);
    } else {
      setPlayerSlotOnFormData(formData, slot, GUEST_TBA_PLAYER);
      assignedPlayers.push('Guest TBA');
    }
  }

  // 6. Submit booking AJAX POST request (with admin override retry if triggered)
  const responseText = await submitBookingWithOverride(dialogUrl, formData, chatId);

  const resMatch = responseText.match(/ReturnbookingTime\((\d+)\)/);
  const reservationId = resMatch ? resMatch[1] : null;
  const isConfirmed = Boolean(reservationId) ||
    responseText.includes('Reservation Received') ||
    responseText.includes('showConfirm');

  const errorMatch = extractDeltaErrorMatch(responseText, true);
  let errorText = null;
  if (errorMatch) {
    const rawError = (errorMatch[1] || errorMatch[0]).replace(/<[^>]+>/g, '').trim();
    if (rawError && !rawError.toLowerCase().includes('success')) {
      errorText = rawError;
    }
  }

  if (errorText || !isConfirmed) {
    const verifySheet = await checkAvailFn({
      when: targetDateMDY,
      time: targetTimeFormatted,
      court: courtName,
      sport,
      chatId
    });
    const verifiedCourt = verifySheet?.slots?.[0]?.courts?.find(c => c.court.toLowerCase() === courtName.toLowerCase());
    const isNowBooked = verifiedCourt && verifiedCourt.status !== 'available';

    if (!isNowBooked) {
      console.warn(`[scvcc] Booking failed for ${courtName} on ${targetDateMDY} at ${targetTimeFormatted}:`, errorText || 'Not confirmed');
      return {
        success: false,
        message: `⚠️ SCVCC Reservation Notice: ${errorText || 'The club booking system did not confirm the reservation.'}`
      };
    }
  }

  const displayPlayers = assignedPlayers.map(formatPlayerNameFirstLast);

  console.log(`[scvcc] Successfully booked ${courtName} (id: ${reservationId || 'N/A'}) on ${targetDateMDY} at ${targetTimeFormatted} (${durationVal}) for ${displayPlayers.join(', ')} (requester: ${formatPlayerNameFirstLast(p1Name)})!`);

  const isOverride = Boolean(selectedCourt.isOverride) || selectedCourt.status !== 'available' || responseText.includes('OverrideBtn');
  if (isOverride) {
    console.log(`[scvcc] Court ${courtName} on ${targetDateMDY} at ${targetTimeFormatted} was booked using administrative override.`);
  }

  const confirmMsg = [
    `✅ *Court Confirmed & Booked!*`,
    `🏟 *Court:* ${courtName}${(court && selectedCourt.court.toLowerCase() !== court.toLowerCase().trim() && !selectedCourt.court.toLowerCase().includes(court.toLowerCase().trim())) ? ` *(Requested ${court} unavailable)*` : ''}`,
    `📅 *Date:* ${displayDate}`,
    `⏰ *Time:* ${targetTimeFormatted} (${durationVal})${durationNotice}`,
    `👥 *Players:* ${displayPlayers.join(', ')}`,
    `🎾 *Party:* ${targetPartySize}`,
    `📍 *Location:* Silver Creek Valley Country Club`,
    reservationId ? `🔖 *Reservation ID:* \`${reservationId}\`` : null
  ].filter(Boolean).join('\n');

  return {
    success: true,
    reservationId,
    court: courtName,
    date: targetDateMDY,
    displayDate,
    time: targetTimeFormatted,
    duration: durationVal,
    partySize: targetPartySize,
    players: displayPlayers,
    requester: formatPlayerNameFirstLast(p1Name),
    member: formatPlayerNameFirstLast(memberName),
    isOverride,
    message: confirmMsg
  };
}

module.exports = {
  extractFormFields,
  searchPlayerOnScvcc,
  cancelCourtReservation,
  modifyCourtBooking,
  bookCourt
};
