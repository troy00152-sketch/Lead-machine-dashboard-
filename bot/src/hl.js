/**
 * hl.js — HighLevel API client (v2, services.leadconnectorhq.com).
 *
 * Auth: private-integration (PIT) Bearer token + Version headers, per spec.
 * The token and location ID come from config (env) — never hardcoded.
 * fetch is injectable so tests can run with a mock and zero live calls.
 */
'use strict';

/**
 * Normalize a phone value to 10 US digits, or null when it is not a
 * usable number. Accepts E.164, dashed, parenthesized, and bare-digit
 * shapes; a leading US country 1 is stripped. Used for fromNumber
 * validation and for comparing a candidate destination against the
 * seller's own number (same digits, different punctuation, must match).
 */
function normalizePhoneDigits(value) {
  if (value === undefined || value === null) return null;
  let d = String(value).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/** One dndSettings channel entry; the key case varies (SMS/Sms/sms). */
function dndSetting(contact, channel) {
  const ds = contact && contact.dndSettings;
  if (!ds || typeof ds !== 'object') return null;
  const want = String(channel).toLowerCase();
  for (const k of Object.keys(ds)) {
    if (k.toLowerCase() === want) return ds[k];
  }
  return null;
}

/**
 * True when the contact's SMS DND is permanent (STOP_KEYWORD opt-out).
 * HL 401s the WHOLE contact PUT when the body includes `sms` for such
 * a contact (proven Nov 24–26, DND API repair) — the seal body must
 * OMIT sms entirely. The permanent block is already the strongest
 * outbound SMS block and stays untouched.
 */
function isSmsDndPermanent(contact) {
  const s = dndSetting(contact, 'sms');
  if (!s || typeof s !== 'object') return false;
  if (String(s.status || '').toLowerCase() === 'permanent') return true;
  return /STOP_KEYWORD/i.test(String(s.message || ''));
}

/**
 * The proven HL seal form: master toggle OFF + per-channel boxes
 * CHECKED + inbound block ON. A bare PUT {dnd:true} does NOT seal in
 * HL — workflows, the bot guard, and the HL UI all still see the
 * contact as reachable. When SMS is permanent the `sms` key is
 * omitted entirely (see isSmsDndPermanent) — never touched, never 401'd.
 */
function hlSealBody(smsPermanent) {
  const dndSettings = { Call: { status: 'active' }, Email: { status: 'active' } };
  if (!smsPermanent) dndSettings.SMS = { status: 'active' };
  return {
    dnd: false,
    dndSettings,
    inboundDndSettings: { all: { status: 'active' } },
  };
}

/** First present (non-empty) value among the given keys of an object. */
function firstPresent(obj, keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/** Only the owner-ish fields of an appointment object, for assignee logs. */
function assigneeSnapshot(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const k of ['id', 'assignedUserId', 'assigned_user_id', 'userId', 'user_id', 'assignedTo', 'owner']) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  if (obj.user && typeof obj.user === 'object' && obj.user.id !== undefined) out['user.id'] = obj.user.id;
  if (Array.isArray(obj.assignedUsers)) out.assignedUsers = obj.assignedUsers;
  return out;
}

class HighLevelClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.base = (config.hlBaseUrl || 'https://services.leadconnectorhq.com').replace(/\/$/, '');
  }

  async request(path, { method = 'GET', version, body, query } = {}) {
    let url = `${this.base}${path}`;
    if (query) {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
      ).toString();
      if (qs) url += `?${qs}`;
    }
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.hlToken}`,
        Version: version,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response — json stays null */
    }
    if (!res.ok) {
      const err = new Error(
        `HL API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`
      );
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /** GET /contacts/{id} → the contact object. */
  async getContact(contactId) {
    const data = await this.request(`/contacts/${contactId}`, {
      version: this.config.hlVersionContacts,
    });
    return data && data.contact ? data.contact : data;
  }

  /**
   * Full HL seal — replaces the old bare PUT {dnd:true}, which HL
   * ignores for workflows / the bot guard / the UI, leaving the
   * contact textable after a seal. GETs the contact first, then PUTs
   * master-OFF + per-channel active (omitting `sms` when SMS DND is
   * permanent — including it 401s the whole PUT) + inbound block ON,
   * then adds the `dnc` tag. The tag write is best-effort: a tag
   * failure is logged, never allowed to fail a seal that already
   * landed (handler.js applySilenceWithDnd also tags `dnc`
   * separately, so the tag is attempted twice — redundant, harmless).
   * Contacts version 2021-07-28 throughout.
   */
  async setDnd(contactId) {
    const contact = await this.getContact(contactId);
    const permanentSms = isSmsDndPermanent(contact);
    const sealed = await this.request(`/contacts/${contactId}`, {
      method: 'PUT',
      version: this.config.hlVersionContacts,
      body: hlSealBody(permanentSms),
    });
    try {
      await this.addTags(contactId, ['dnc']);
    } catch (e) {
      console.log(
        '[custom-bot] setDnd tag dnc failed (seal itself landed)',
        contactId,
        e && e.message ? e.message : e
      );
    }
    return sealed;
  }

  /** Add tags to a contact (e.g. `dnc`). */
  async addTags(contactId, tags) {
    return this.request(`/contacts/${contactId}/tags`, {
      method: 'POST',
      version: this.config.hlVersionContacts,
      body: { tags },
    });
  }

  /** Most recent conversation for a contact (used when the webhook lacks an id). */
  async findConversationId(contactId) {
    const data = await this.request('/conversations/search', {
      version: this.config.hlVersionConversations,
      query: { locationId: this.config.hlLocationId, contactId },
    });
    const convs = (data && data.conversations) || [];
    return convs.length ? convs[0].id : null;
  }

  /**
   * Messages of a conversation, oldest → newest, normalized to
   * { id, direction: 'inbound'|'outbound', body, type } plus the number
   * fields when the API carries them. The number fields are preserved
   * for reply routing (the handler learns the triggering inbound's
   * destination from them); the LLM-context mapping and the guards read
   * only direction/body, so the extra fields disturb nothing.
   * The API's exact From/To field names are NOT confirmed from public
   * docs, so candidates are read defensively and normalized to digits;
   * toNumber/fromNumber are null when no usable value is present.
   */
  async getMessages(conversationId, limit = 100) {
    const data = await this.request(`/conversations/${conversationId}/messages`, {
      version: this.config.hlVersionConversations,
      query: { limit },
    });
    const raw =
      (data && data.messages && data.messages.messages) ||
      (data && data.messages) ||
      [];
    return raw
      .map((m) => {
        const toRaw = firstPresent(m, ['to', 'toNumber', 'to_number', 'recipient', 'destination']);
        const fromRaw = firstPresent(m, ['from', 'fromNumber', 'from_number', 'sender']);
        return {
          id: m.id,
          direction:
            m.direction === 'inbound' || m.type === 1 || m.messageType === 'inbound'
              ? 'inbound'
              : 'outbound',
          body: m.body || m.message || '',
          type: m.type || m.messageType || '',
          dateAdded: m.dateAdded || m.dateUpdated || null,
          to: toRaw,
          from: fromRaw,
          toNumber: normalizePhoneDigits(toRaw),
          fromNumber: normalizePhoneDigits(fromRaw),
        };
      })
      .reverse(); // HL returns newest first; we want chronological
  }

  /**
   * Send an SMS via the Conversations API.
   * Reply-number rule (Oct 27, 2026, corrected twice): a FIXED fromNumber
   * is BANNED — it pinned every market's replies to the Indianapolis
   * number. A DYNAMIC per-message fromNumber, learned from the
   * triggering inbound, is REQUIRED: HighLevel routes a reply from the
   * thread's original number when fromNumber is absent (Priority 3,
   * "last-used number"), but an explicitly supplied API fromNumber wins
   * (Priority 1, per HighLevel's own "How the 'From' Number Is Chosen
   * for SMS"). Callers pass the inbound's destination number; when it
   * cannot be learned, fromNumber is omitted and the reply falls back
   * to thread routing — never to a configured number, never to silence.
   * The number is emitted E.164 (+1), matching the previously working
   * sender format; invalid values are dropped, never sent raw.
   */
  async sendSms({ contactId, conversationId, message, fromNumber }) {
    const body = { type: 'SMS', contactId, message };
    if (conversationId) body.conversationId = conversationId;
    const digits = normalizePhoneDigits(fromNumber);
    if (digits) body.fromNumber = `+1${digits}`;
    return this.request('/conversations/messages', {
      method: 'POST',
      version: this.config.hlVersionConversations,
      body,
    });
  }

  /**
   * Free slots on a calendar between two epochs (ms).
   * HL returns an object keyed by date: { 'YYYY-MM-DD': { slots: [ISO, ...] } }.
   * Normalized here to a sorted array of ISO start strings.
   */
  async getFreeSlots(calendarId, startMs, endMs) {
    const data = await this.request(`/calendars/${calendarId}/free-slots`, {
      version: this.config.hlVersionCalendars,
      query: {
        startDate: startMs,
        endDate: endMs,
        timezone: this.config.timezone,
      },
    });
    const slots = [];
    if (data && typeof data === 'object') {
      for (const key of Object.keys(data)) {
        const entry = data[key];
        const list = Array.isArray(entry) ? entry : (entry && entry.slots) || [];
        for (const s of list) {
          if (typeof s === 'string') slots.push(s);
          else if (s && s.startTime) slots.push(s.startTime);
        }
      }
    }
    return slots.sort();
  }

  /** Book an appointment. slotMinutes: HL calendar slot length (30 here).
   * ignoreDateRange bypasses the calendar's own bookable date range —
   * needed ONLY for far-out slots verified against real events (Oct 24,
   * 8:35 PM lesson): the free-slots feed stops past ~5 days, so a
   * December booking verified conflict-free must not be refused for
   * sitting outside the feed's range. Defaults false. */
  async createAppointment({ contactId, startISO, endISO, title, ignoreDateRange = false }) {
    const body = {
      calendarId: this.config.calendarId,
      locationId: this.config.hlLocationId,
      contactId,
      startTime: startISO,
      endTime: endISO,
      title,
      appointmentStatus: 'confirmed',
      ignoreDateRange,
      toNotify: true,
    };
    // Assignee: without assignedUserId the appointment is invisible in
    // user-filtered calendar views (Oct 24: phone app showed no events).
    // Only include when configured, so local/test configs without a user ID
    // keep the previous behavior.
    if (this.config.userId) body.assignedUserId = this.config.userId;
    const created = await this.request('/calendars/events/appointments', {
      method: 'POST',
      version: this.config.hlVersionCalendars,
      body,
    });
    // Oct 27 live finding: HL sometimes drops assignedUserId on create —
    // Cleveland/KC test bookings and a real Guillermo booking all came back
    // with a blank owner, which hides them from user-filtered views and the
    // phone app (calendar view shows them; user view does not). Verify the
    // assignee stuck; if not, force it with a PUT. Never fail the booking
    // itself over the assignee — log loudly instead.
    //
    // Oct 27 EVENING finding (2nd live proof, Florida): the PUT returned no
    // error and logged "forced via PUT", yet the owner stayed BLANK in the
    // list view and absent from user-filtered views and the phone app.
    // Root gaps: the PUT response was never inspected, and nothing ever
    // re-read the appointment to prove the owner stuck. So now: send both
    // candidate owner fields (assignedUserId, the create-time field, plus
    // userId, the alternate shape a GET object may carry), fall back to
    // assignedUserId-only if the combined PUT is rejected, then RE-READ
    // the appointment and log exactly what persisted. The re-read line is
    // the proof — a PUT with no error is not.
    if (this.config.userId) {
      const createdId = created && (created.id || created.eventId || created.appointmentId);
      const createdAssignee =
        created && (created.assignedUserId || created.assigned_user_id || (created.user && created.user.id));
      if (createdId && String(createdAssignee || '') !== String(this.config.userId)) {
        try {
          const putResponse = await this.request(`/calendars/events/appointments/${createdId}`, {
            method: 'PUT',
            version: this.config.hlVersionCalendars,
            body: { assignedUserId: this.config.userId, userId: this.config.userId },
          });
          console.log('[custom-bot] appointment assignee forced via PUT', createdId);
          console.log(
            '[custom-bot] appointment assignee PUT response',
            createdId,
            JSON.stringify(assigneeSnapshot(putResponse))
          );
        } catch (e) {
          console.log('[custom-bot] ASSIGNEE-FAILED', createdId, e && e.message ? e.message : e);
          try {
            await this.request(`/calendars/events/appointments/${createdId}`, {
              method: 'PUT',
              version: this.config.hlVersionCalendars,
              body: { assignedUserId: this.config.userId },
            });
            console.log('[custom-bot] appointment assignee forced via PUT (assignedUserId-only retry)', createdId);
          } catch (e2) {
            console.log('[custom-bot] ASSIGNEE-RETRY-FAILED', createdId, e2 && e2.message ? e2.message : e2);
          }
        }
        try {
          const reread = await this.request(`/calendars/events/appointments/${createdId}`, {
            version: this.config.hlVersionCalendars,
          });
          const stuck =
            reread &&
            (reread.assignedUserId || reread.assigned_user_id || (reread.user && reread.user.id) || reread.userId);
          console.log(
            '[custom-bot] appointment assignee re-read',
            createdId,
            JSON.stringify(assigneeSnapshot(reread))
          );
          if (String(stuck || '') !== String(this.config.userId)) {
            console.log(
              '[custom-bot] ASSIGNEE-NOT-PERSISTED',
              createdId,
              'expected',
              this.config.userId,
              'got',
              stuck || null
            );
          }
        } catch (e) {
          console.log('[custom-bot] ASSIGNEE-VERIFY-FAILED', createdId, e && e.message ? e.message : e);
        }
      } else if (!createdId) {
        console.log('[custom-bot] ASSIGNEE-UNVERIFIED no appointment id in create response');
      }
    } else {
      console.log(
        '[custom-bot] BOOKING-NO-ASSIGNEE-CONFIGURED HL_USER_ID empty; booking will be invisible in user-filtered views'
      );
    }
    return created;
  }

  /**
   * ALL events on one calendar in a window (no contact filter, no
   * future filter — the caller decides). Used for far-out availability:
   * when the free-slots feed has no data for a date, a slot is free
   * iff no live event overlaps it. Cancelled/invalid events never block.
   */
  async getCalendarEvents(calendarId, startMs, endMs) {
    const data = await this.request('/calendars/events', {
      version: this.config.hlVersionCalendars,
      query: {
        locationId: this.config.hlLocationId,
        calendarId,
        startTime: startMs,
        endTime: endMs,
      },
    });
    const raw = (data && (data.events || data.appointments)) || (Array.isArray(data) ? data : []);
    return raw
      .map((e) => ({
        id: e.id,
        calendarId: e.calendarId || e.calendar_id,
        status: String(e.appointmentStatus || e.status || '').toLowerCase(),
        startTime: e.startTime || e.start_time || null,
        endTime: e.endTime || e.end_time || null,
      }))
      .filter((e) => {
        if (!e.id || !e.startTime || !e.endTime) return false;
        if (e.calendarId && String(e.calendarId) !== String(calendarId)) return false;
        if (e.status === 'cancelled' || e.status === 'invalid') return false;
        return true;
      });
  }

  /**
   * The contact's upcoming (future, not cancelled/invalid) appointments on
   * one calendar. Used for quiet-after-booking, reschedule, and cancel.
   * Filters client-side: the events list is queried by location + calendar +
   * window, then narrowed to this contact. Failures are the caller's to
   * handle (the handler treats them as "no known booking", never as a
   * reason to silence or mis-book).
   */
  async getUpcomingAppointments(calendarId, contactId, nowMs = Date.now()) {
    const data = await this.request('/calendars/events', {
      version: this.config.hlVersionCalendars,
      query: {
        locationId: this.config.hlLocationId,
        calendarId,
        startTime: nowMs,
        // Oct 25 lesson: a 30-day window made far-out bookings invisible —
        // the Dec 15 booking (51 days out) came back as "existing=0" even
        // though it sat Confirmed on the calendar, so booked-seller
        // behaviors treated a booked seller as unbooked. Booked-seller
        // rules (no-reschedule, price pointer, quiet) all key on this
        // list, so the window must cover the calendar's real booking
        // horizon: 365 days.
        endTime: nowMs + 365 * 24 * 60 * 60 * 1000,
      },
    });
    const raw = (data && (data.events || data.appointments)) || (Array.isArray(data) ? data : []);
    return raw
      .map((e) => ({
        id: e.id,
        calendarId: e.calendarId || e.calendar_id,
        contactId: e.contactId || e.contact_id || (e.contact && e.contact.id) || null,
        title: e.title || '',
        status: String(e.appointmentStatus || e.status || '').toLowerCase(),
        startTime: e.startTime || e.start_time || null,
        endTime: e.endTime || e.end_time || null,
      }))
      .filter((e) => {
        if (!e.id) return false;
        if (e.contactId && String(e.contactId) !== String(contactId)) return false;
        if (e.calendarId && String(e.calendarId) !== String(calendarId)) return false;
        if (e.status === 'cancelled' || e.status === 'invalid') return false;
        if (!e.startTime) return false;
        return new Date(e.startTime).getTime() > nowMs;
      });
  }

  /**
   * The contact's PAST (already ended, not cancelled/invalid) appointments
   * on one calendar, in the trailing window (default 90 days).
   * APPOINTMENT-REPLY rule (Nov 7, 2026, Troy): a seller Troy already had
   * an appointment with gets total bot silence + a notification instead of
   * a reply — so the handler must know about PAST appointments, not just
   * the upcoming ones getUpcomingAppointments returns.
   * Matching is POSITIVE only: contactId, the contact's email, their
   * phone digits, or their street address appearing in the event's
   * title/notes/address. An event carrying none of those NEVER matches —
   * unlike the future-booking check, which lets contact-less events
   * through (a lenient miss there only risks a wrong silence; here it
   * would silence every seller). /calendars/events takes epoch-ms
   * startTime/endTime and rides the 2021-04-15 calendars version.
   * Failures are the caller's to handle (the handler treats them as
   * "no known past appointment", never as a reason to silence).
   */
  async getPastAppointments(calendarId, contact, nowMs = Date.now(), windowMs = 90 * 24 * 60 * 60 * 1000) {
    const data = await this.request('/calendars/events', {
      version: this.config.hlVersionCalendars,
      query: {
        locationId: this.config.hlLocationId,
        calendarId,
        startTime: nowMs - windowMs,
        endTime: nowMs,
      },
    });
    const raw = (data && (data.events || data.appointments)) || (Array.isArray(data) ? data : []);
    const contactId = contact && contact.id ? String(contact.id) : null;
    const email = contact && contact.email ? String(contact.email).trim().toLowerCase() : null;
    const phone = normalizePhoneDigits(
      contact && (contact.phone || contact.phoneNumber || contact.mobile || contact.phone_number)
    );
    const address = contact && contact.address1 ? String(contact.address1).trim().toLowerCase() : null;
    return raw
      .map((e) => ({
        id: e.id,
        calendarId: e.calendarId || e.calendar_id,
        contactId: e.contactId || e.contact_id || (e.contact && e.contact.id) || null,
        email:
          firstPresent(e, ['email', 'contactEmail', 'attendeeEmail']) ||
          (e.contact && e.contact.email) ||
          null,
        phone: normalizePhoneDigits(
          firstPresent(e, ['phone', 'contactPhone', 'attendeePhone']) ||
            (e.contact && e.contact.phone)
        ),
        title: e.title || '',
        notes: e.notes || e.description || '',
        address: e.address || e.location || '',
        status: String(e.appointmentStatus || e.status || '').toLowerCase(),
        startTime: e.startTime || e.start_time || null,
        endTime: e.endTime || e.end_time || null,
      }))
      .filter((e) => {
        if (!e.id) return false;
        if (e.calendarId && String(e.calendarId) !== String(calendarId)) return false;
        if (e.status === 'cancelled' || e.status === 'invalid') return false;
        if (!e.startTime || !e.endTime) return false;
        const start = new Date(e.startTime).getTime();
        const end = new Date(e.endTime).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        if (end > nowMs) return false; // past only — a future booking is the BOOKED-SILENT rule's job
        if (start < nowMs - windowMs) return false; // trailing 90-day window
        if (contactId && e.contactId && String(e.contactId) === contactId) return true;
        if (email && e.email && String(e.email).trim().toLowerCase() === email) return true;
        if (phone && e.phone && e.phone === phone) return true;
        if (address) {
          const hay = `${e.title} ${e.notes} ${e.address}`.toLowerCase();
          if (hay.includes(address)) return true;
        }
        return false;
      });
  }

  /**
   * Cancel an appointment by marking it 'cancelled' (the HL-native status
   * change — same vocabulary as create's 'confirmed'). The record stays
   * auditable; it no longer blocks the slot. Never hard-delete: a deleted
   * booking leaves no trail for the seller or the team.
   */
  async cancelAppointment(eventId) {
    return this.request(`/calendars/events/appointments/${eventId}`, {
      method: 'PUT',
      version: this.config.hlVersionCalendars,
      body: { appointmentStatus: 'cancelled' },
    });
  }

  /**
   * Opportunity pipeline endpoints (Oct 30, 2026 — pipeline auto-move).
   * These ride the same 2021-07-28 version header as the contacts
   * endpoints. All response shapes are read defensively: the pipeline
   * layer treats a missing list as empty, never as a crash.
   */

  /** GET /opportunities/pipelines?locationId= → { pipelines: [{ id, name, stages: [{ id, name }] }] } */
  async getPipelines(locationId) {
    return this.request('/opportunities/pipelines', {
      version: this.config.hlVersionOpportunities,
      query: { locationId },
    });
  }

  /** GET /opportunities/search → { opportunities: [{ id, pipelineId, pipelineStageId, status, contactId }] } */
  async searchOpportunities({ locationId, contactId, pipelineId }) {
    return this.request('/opportunities/search', {
      version: this.config.hlVersionOpportunities,
      query: { locationId, contact_id: contactId, pipeline_id: pipelineId },
    });
  }

  /** POST /opportunities/ → the created opportunity. */
  async createOpportunity(body) {
    return this.request('/opportunities/', {
      method: 'POST',
      version: this.config.hlVersionOpportunities,
      body,
    });
  }

  /** PUT /opportunities/{id} → the updated opportunity. */
  async updateOpportunity(opportunityId, body) {
    return this.request(`/opportunities/${opportunityId}`, {
      method: 'PUT',
      version: this.config.hlVersionOpportunities,
      body,
    });
  }
}

/** Pull a numeric custom-field value off a contact by ID, or by key/name match. */
function customFieldValue(contact, fieldId, keyHints) {
  if (!contact || !Array.isArray(contact.customFields)) return null;
  let field = null;
  if (fieldId) field = contact.customFields.find((cf) => cf.id === fieldId);
  if (!field && keyHints && keyHints.length) {
    field = contact.customFields.find((cf) => {
      const key = String(cf.key || cf.name || '').toLowerCase();
      return keyHints.some((h) => key.includes(h));
    });
  }
  if (!field) return null;
  const raw =
    field.value !== undefined && field.value !== null && field.value !== ''
      ? field.value
      : field.fieldValue;
  if (raw === undefined || raw === null || raw === '') return null;
  const num = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(num) ? num : null;
}

/** Ballpark from the contact's MAO/LAO fields. Both must exist, LAO <= MAO. */
function getBallpark(contact, config) {
  const mao = customFieldValue(contact, config.maoFieldId, ['mao']);
  const lao = customFieldValue(contact, config.laoFieldId, ['lao']);
  if (mao == null || lao == null) return null;
  if (lao > mao) return null;
  return { lao, mao };
}

// Listing-verified marker contract (Nov 13, 2026, auto-pricing rollout):
// a contact's price counts as VERIFIED only when the listed-first gate
// actually ran and returned not-listed. The rollout stamps that with
// either a tag ('priced-verified' / 'listing-verified') or a marker
// custom field (id via config.pricedVerifiedFieldId, else key/name
// match on 'listing verified' / 'priced verified' / 'listing status')
// holding an explicit clear value. ANYTHING else — field absent, value
// 'unknown', value 'listed' — is NOT verified. This mirrors the pricing
// engine's rule: PRICED_LISTING_UNVERIFIED / write_eligible=false is
// never treated as cleared.
const PRICED_VERIFIED_TAGS = ['priced-verified', 'listing-verified'];
const VERIFIED_FIELD_VALUES = [
  'true', 'yes', 'verified', 'not listed', 'not_listed', 'not-listed',
  'clear', 'cleared', 'pass',
];

function contactListingVerified(contact, config) {
  if (!contact) return false;
  const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
  if (PRICED_VERIFIED_TAGS.some((t) => tags.includes(t))) return true;
  if (Array.isArray(contact.customFields)) {
    let field = null;
    if (config && config.pricedVerifiedFieldId) {
      field = contact.customFields.find((cf) => cf.id === config.pricedVerifiedFieldId);
    }
    if (!field) {
      field = contact.customFields.find((cf) => {
        const key = String(cf.key || cf.name || '').toLowerCase().replace(/_/g, ' ');
        return key.includes('listing verified') || key.includes('priced verified')
          || key.includes('listing status');
      });
    }
    if (field) {
      const raw = field.value !== undefined && field.value !== null && field.value !== ''
        ? field.value : field.fieldValue;
      if (raw !== undefined && raw !== null
        && VERIFIED_FIELD_VALUES.includes(String(raw).trim().toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The lead's verified auto-priced numbers, or null. Requires ALL of:
 * MAO + LAO on file (the ballpark), an ARV on file, and the
 * listing-verified marker. The handler's priced-offer path states the
 * LAO (the opening offer) from this — and states nothing when this
 * returns null, so a number is never invented and an unverified listing
 * status is never treated as cleared.
 */
function getVerifiedPrice(contact, config) {
  const ballpark = getBallpark(contact, config);
  if (!ballpark) return null;
  const arv = customFieldValue(contact, config && config.arvFieldId, ['arv']);
  if (arv == null) return null;
  if (!contactListingVerified(contact, config)) return null;
  return { lao: ballpark.lao, mao: ballpark.mao, arv };
}

module.exports = { HighLevelClient, customFieldValue, getBallpark, getVerifiedPrice, contactListingVerified, normalizePhoneDigits, isSmsDndPermanent, hlSealBody };
